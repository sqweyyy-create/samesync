/**
 * Delivers queued bot messages (PLAN.md Phase 2, "Outbox sender").
 *
 * Safety (CLAUDE.md invariant 3): right before every Telegram call it reads the recipient, the
 * match and the other participant again and re-checks match state, both live bands and freeze
 * status. A message that no longer passes is cancelled with the reason and never sent.
 *
 * Delivery is at-least-once: a row is leased, sent, then marked sent. If the process dies between
 * Telegram's answer and that last write, the row is sent again after its lease. Telegram offers no
 * idempotency key, so the alternative would be to lose notifications instead.
 */
import type { Locale } from '@samesync/shared';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { Clock } from '../clock';
import { aliasLabel, type ContentStore } from '../content/store';
import type { ClaimedMessage, OutboxRepository } from '../db/repositories/outbox';
import type { UsersRepository } from '../db/repositories/users';
import { parseTeaser, renderTeaser } from '../domain/matching/teaser';
import {
  MAX_SEND_ATTEMPTS,
  dropReason,
  hoursLeft,
  isQuietHour,
  retryDelayMs,
  type NotificationKind,
  type SendContext,
} from '../domain/notifications';
import type { Logger } from '../logger';

/** The one Bot API call the sender makes. Never forwardMessage or copyMessage. */
export interface TelegramSender {
  sendMessage(
    chatId: number,
    text: string,
    options: {
      reply_markup: { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> };
      disable_notification?: boolean;
    },
  ): Promise<unknown>;
}

export interface OutboxSenderDeps {
  outbox: OutboxRepository;
  users: Pick<UsersRepository, 'setBotReachable'>;
  content: ContentStore;
  telegram: TelegramSender;
  clock: Clock;
  logger: Logger;
  miniAppUrl: string;
  /** Time zone assumed for users who never reported one, per locale (the pool's drop zone). */
  fallbackTimeZone: Readonly<Record<Locale, string>>;
  /** Pacing; tests set these to zero. Defaults stay under Telegram's bulk limits. */
  spacingMs?: number;
  perChatMs?: number;
  batchSize?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface TickResult {
  sent: number;
  cancelled: number;
  failed: number;
  retried: number;
}

export interface OutboxSender {
  /** Sends what is due now, in order. Safe to call from several processes at once. */
  tick(): Promise<TickResult>;
}

type Outcome = keyof TickResult | 'rate_limited';

/** How long a claimed row stays invisible to other senders. */
const LEASE_MS = 60_000;

/** The Mini App URL that opens one match (read by the Mini App from `?match=`). */
export function matchUrl(miniAppUrl: string, matchId: string): string {
  const url = new URL(miniAppUrl);
  url.searchParams.set('match', matchId);
  return url.toString();
}

/** What a failed Bot API call means for the row. Works on grammY's errors without importing it. */
function classify(
  error: unknown,
):
  | { kind: 'unreachable' | 'permanent' | 'transient'; detail: string }
  | { kind: 'rate_limited'; detail: string; retryAfterSec: number } {
  const e = error as {
    error_code?: unknown;
    description?: unknown;
    parameters?: { retry_after?: unknown };
  } | null;
  const code = typeof e?.error_code === 'number' ? e.error_code : null;
  // Telegram's descriptions name the problem ("Forbidden: bot was blocked by the user"), not the user.
  const detail =
    code === null
      ? 'network'
      : `${code}: ${typeof e?.description === 'string' ? e.description : ''}`;
  if (code === 403 || (code === 400 && /chat not found/i.test(detail))) {
    return { kind: 'unreachable', detail };
  }
  if (code === 429) {
    const retryAfter = e?.parameters?.retry_after;
    return {
      kind: 'rate_limited',
      detail,
      retryAfterSec: typeof retryAfter === 'number' ? retryAfter : 5,
    };
  }
  if (code !== null && code >= 400 && code < 500 && code !== 401 && code !== 409) {
    return { kind: 'permanent', detail };
  }
  return { kind: 'transient', detail };
}

export function createOutboxSender(deps: OutboxSenderDeps): OutboxSender {
  const { outbox, content, telegram, clock, logger } = deps;
  const spacingMs = deps.spacingMs ?? 40; // about 25 messages a second overall
  const perChatMs = deps.perChatMs ?? 1_000; // 1 message a second per chat
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lastSentTo = new Map<number, number>();

  /** The text and the button of one message, in the recipient's language. */
  function compose(
    kind: NotificationKind,
    recipient: NonNullable<SendContext['recipient']>,
    match: NonNullable<SendContext['match']>,
  ): { text: string; button: { text: string; web_app: { url: string } } } {
    const { locale } = recipient;
    const { t } = translatorFor(locale);
    const toMatch = { url: matchUrl(deps.miniAppUrl, match.id) };
    // The other person appears only under their per-match alias, never by name or username.
    const { emoji, name } = aliasLabel(content, match.counterpartAlias, locale);
    const alias = `${emoji} ${name}`;
    switch (kind) {
      case 'match_created': {
        const teaser = renderTeaser(parseTeaser(match.teaser), locale, content.teaser, t);
        return {
          text: t('bot.match.new', { teaser }),
          button: { text: t('bot.match.open'), web_app: toMatch },
        };
      }
      case 'game_turn':
        return {
          text: t('bot.game.turn', { alias }),
          button: { text: t('bot.game.play'), web_app: toMatch },
        };
      case 'game_reminder':
        return {
          text: t('bot.game.reminder', {
            alias,
            count: hoursLeft(clock.now(), match.gameDeadlineAt),
          }),
          button: { text: t('bot.game.play'), web_app: toMatch },
        };
      case 'game_results':
        return {
          text: t('bot.game.results', { alias }),
          button: { text: t('bot.game.see_results'), web_app: toMatch },
        };
      case 'game_expired':
        // The match is over: the button opens the app, not the match.
        return {
          text: t('bot.game.expired', { alias }),
          button: { text: t('bot.start.open_app'), web_app: { url: deps.miniAppUrl } },
        };
    }
  }

  function render(
    kind: NotificationKind,
    recipient: NonNullable<SendContext['recipient']>,
    match: NonNullable<SendContext['match']>,
  ) {
    return {
      chatId: recipient.telegramId,
      ...compose(kind, recipient, match),
      silent: isQuietHour(clock.now(), recipient.timezone, deps.fallbackTimeZone[recipient.locale]),
    };
  }

  async function deliver(message: ClaimedMessage): Promise<Outcome> {
    // Re-read everything now, not when the message was queued.
    const context = await outbox.sendContext(message);
    const drop = dropReason(message.kind, context);
    if (drop || !context.recipient || !context.match) {
      const reason = drop ?? 'match_missing';
      await outbox.cancel(message.id, reason);
      logger.info({ outboxId: message.id, userId: message.userId, reason }, 'notification dropped');
      return 'cancelled';
    }

    const { chatId, text, button, silent } = render(message.kind, context.recipient, context.match);
    const wait = (lastSentTo.get(chatId) ?? 0) + perChatMs - clock.now().getTime();
    if (wait > 0) await sleep(wait);
    try {
      await telegram.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: [[button]] },
        ...(silent ? { disable_notification: true } : {}),
      });
    } catch (error) {
      const failure = classify(error);
      const log = { outboxId: message.id, userId: message.userId, error: failure.detail };
      if (failure.kind === 'unreachable') {
        // The user blocked the bot or never started it: stop matching them until they come back.
        await deps.users.setBotReachable(chatId, false);
        await outbox.fail(message.id, failure.detail);
        logger.info(log, 'notification not delivered: bot cannot reach the user');
        return 'failed';
      }
      if (failure.kind === 'rate_limited') {
        const at = new Date(clock.now().getTime() + (failure.retryAfterSec + 1) * 1000);
        await outbox.retryAt(message.id, at, failure.detail);
        logger.warn({ ...log, retryAfterSec: failure.retryAfterSec }, 'telegram rate limit hit');
        return 'rate_limited';
      }
      if (failure.kind === 'permanent' || message.attempts >= MAX_SEND_ATTEMPTS) {
        await outbox.fail(message.id, failure.detail);
        logger.error(log, 'notification failed for good');
        return 'failed';
      }
      const at = new Date(clock.now().getTime() + retryDelayMs(message.attempts));
      await outbox.retryAt(message.id, at, failure.detail);
      logger.warn(log, 'notification will be retried');
      return 'retried';
    }
    lastSentTo.set(chatId, clock.now().getTime());
    if (!(await outbox.markSent(message.id, clock.now()))) {
      // The row was cancelled while the call was in flight (e.g. a freeze): nothing to undo.
      logger.warn({ outboxId: message.id }, 'notification sent, but its row was no longer pending');
    }
    return 'sent';
  }

  return {
    async tick() {
      const result: TickResult = { sent: 0, cancelled: 0, failed: 0, retried: 0 };
      const claimed = await outbox.claimDue(clock.now(), deps.batchSize ?? 25, LEASE_MS);
      for (const [index, message] of claimed.entries()) {
        const outcome = await deliver(message);
        if (outcome === 'rate_limited') {
          // Telegram asked us to slow down: leave the rest for a later tick (their lease expires).
          result.retried++;
          break;
        }
        result[outcome]++;
        if (outcome === 'sent' && index < claimed.length - 1 && spacingMs > 0)
          await sleep(spacingMs);
      }
      if (lastSentTo.size > 10_000) lastSentTo.clear();
      return result;
    },
  };
}
