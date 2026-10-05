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
import { aliasText, type ContentStore } from '../content/store';
import type { ClaimedMessage, OutboxRepository } from '../db/repositories/outbox';
import type { UsersRepository } from '../db/repositories/users';
import { encodeCallback } from '../domain/chat/callbacks';
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
import { classifyTelegramError } from './telegram-errors';
import type { Usernames } from './usernames';

/** A button under a notification: it opens the Mini App, or reports back to the bot. */
export type NotificationButton =
  { text: string; web_app: { url: string } } | { text: string; callback_data: string };

/** The one Bot API call the sender makes. Never forwardMessage or copyMessage. */
export interface TelegramSender {
  sendMessage(
    chatId: number,
    text: string,
    options: {
      reply_markup?: { inline_keyboard: NotificationButton[][] };
      disable_notification?: boolean;
    },
  ): Promise<unknown>;
}

export interface OutboxSenderDeps {
  outbox: OutboxRepository;
  users: Pick<UsersRepository, 'setBotReachable'>;
  content: ContentStore;
  telegram: TelegramSender;
  /** Reads the other person's current username for the one message that reveals it. */
  usernames: Usernames;
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

export function createOutboxSender(deps: OutboxSenderDeps): OutboxSender {
  const { outbox, content, telegram, clock, logger } = deps;
  const spacingMs = deps.spacingMs ?? 40; // about 25 messages a second overall
  const perChatMs = deps.perChatMs ?? 1_000; // 1 message a second per chat
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lastSentTo = new Map<number, number>();

  /**
   * The text and the buttons of one message, in the recipient's language. `username` is only
   * there for `reveal_done`, the one message that carries one (CLAUDE.md invariant 6).
   */
  function compose(
    kind: NotificationKind,
    recipient: NonNullable<SendContext['recipient']>,
    match: NonNullable<SendContext['match']>,
    username: string | null,
  ): { text: string; buttons: NotificationButton[] } {
    const { locale } = recipient;
    const { t } = translatorFor(locale);
    const toMatch = { url: matchUrl(deps.miniAppUrl, match.id) };
    const toApp = { text: t('bot.start.open_app'), web_app: { url: deps.miniAppUrl } };
    // The other person appears only under their per-match alias, never by name or username.
    const alias = aliasText(content, match.counterpartAlias, locale);
    switch (kind) {
      case 'match_created': {
        const teaser = renderTeaser(parseTeaser(match.teaser), locale, content.teaser, t);
        return {
          text: t('bot.match.new', { teaser }),
          buttons: [{ text: t('bot.match.open'), web_app: toMatch }],
        };
      }
      case 'game_turn':
        return {
          text: t('bot.game.turn', { alias }),
          buttons: [{ text: t('bot.game.play'), web_app: toMatch }],
        };
      case 'game_reminder':
        return {
          text: t('bot.game.reminder', {
            alias,
            count: hoursLeft(clock.now(), match.gameDeadlineAt),
          }),
          buttons: [{ text: t('bot.game.play'), web_app: toMatch }],
        };
      case 'game_results':
        return {
          text: t('bot.game.results', { alias }),
          buttons: [{ text: t('bot.game.see_results'), web_app: toMatch }],
        };
      case 'game_expired':
        // The match is over: the button opens the app, not the match. A player who had sent
        // their guesses is told that the other person didn't play; "time ran out" is for the
        // one who didn't.
        return {
          text: t(match.recipientDone === true ? 'bot.game.expired.played' : 'bot.game.expired', {
            alias,
          }),
          buttons: [toApp],
        };
      case 'chat_reminder':
        // The button opens the results, where the ready-made first message waits.
        return {
          text: t('bot.chat.reminder', {
            alias,
            count: hoursLeft(clock.now(), match.chatDeadlineAt ?? clock.now().getTime()),
          }),
          buttons: [{ text: t('bot.chat.write'), web_app: toMatch }],
        };
      case 'chat_expired':
        return { text: t('bot.chat.expired', { alias }), buttons: [toApp] };
      case 'chat_ended':
        // Neutral on purpose: it says that the chat is over, never why.
        return { text: t('bot.chat.ended.other', { alias }), buttons: [toApp] };
      case 'reveal_request':
        return {
          text: t('bot.reveal.request', { alias }),
          buttons: [
            { text: t('bot.reveal.agree'), callback_data: encodeCallback('reveal_yes', match.id) },
            { text: t('bot.reveal.not_now'), callback_data: encodeCallback('reveal_no', match.id) },
          ],
        };
      case 'reveal_done':
        return { text: t('bot.reveal.done', { alias, username: username ?? '' }), buttons: [] };
    }
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

    const { recipient, match } = context;
    // The one message that carries a username: adults only, after both consented (dropReason has
    // just checked both against the database). The username is read from Telegram now.
    let username: string | null = null;
    if (message.kind === 'reveal_done') {
      username = match.counterpart ? await deps.usernames.current(match.counterpart) : null;
      if (username === null) {
        await outbox.cancel(message.id, 'username_missing');
        logger.info(
          { outboxId: message.id, userId: message.userId, reason: 'username_missing' },
          'notification dropped',
        );
        return 'cancelled';
      }
    }

    const chatId = recipient.telegramId;
    const { text, buttons } = compose(message.kind, recipient, match, username);
    const silent = isQuietHour(
      clock.now(),
      recipient.timezone,
      deps.fallbackTimeZone[recipient.locale],
    );
    const wait = (lastSentTo.get(chatId) ?? 0) + perChatMs - clock.now().getTime();
    if (wait > 0) await sleep(wait);
    try {
      await telegram.sendMessage(chatId, text, {
        ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
        ...(silent ? { disable_notification: true } : {}),
      });
    } catch (error) {
      const failure = classifyTelegramError(error);
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
