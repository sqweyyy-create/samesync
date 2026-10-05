/**
 * The chat relay (PLAN.md Phase 4): takes a message one user wrote and hands it to the other user
 * of the match as a new message of the bot. Bot messages, the Mini App's "Написать" and the dev
 * tooling all go through `send`.
 *
 * Safety:
 * - The recipient gets a new plain-text `sendMessage` that contains the sender's alias and the
 *   text, and nothing else: no `parse_mode`, no entities, never `forwardMessage` or `copyMessage`
 *   (CLAUDE.md invariant 6). The only other thing sent with it is the reply button.
 * - A message is stored before it is sent, so the database triggers of migration 0010 have agreed
 *   to it. Then, immediately before every Telegram call, the match and both users are read again:
 *   both active, both live bands equal to the band of the match, the chat still open, no block
 *   (invariant 3). A retry is checked again like a first try.
 * - Any refusal and any error means the message is not delivered (invariant 10).
 * - Nothing is relayed in a u18 match: twice here (the chat is not open for the band, and the
 *   screening hook has no contact filter to ask) and once more in the database.
 * - A user who is not active can't send, whatever their matches look like (invariant 9).
 *
 * The pipeline follows PLAN.md, with the text check moved to the front (a photo needs no routing):
 * text, sender, target, validation and rate limit, screening, store, send, start of the chat.
 *
 * Phase 5 plugs in here: the contact filter goes into `contactFilter`, the block is already
 * checked (`blocks`, which nothing writes yet), and the report button joins `keyboard`.
 */
import type { Locale } from '@samesync/shared';
import { translatorFor } from '@samesync/shared/i18n/static';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../clock';
import { aliasText, type ContentStore } from '../content/store';
import type { ChatRepository, ChatUser } from '../db/repositories/chat';
import type { UsersRepository } from '../db/repositories/users';
import { encodeCallback } from '../domain/chat/callbacks';
import { chatOpenIn, type ChatParams } from '../domain/chat/params';
import {
  chooseRoute,
  needsEcho,
  refusal,
  relayText,
  screen,
  textProblem,
  type ChatContext,
  type ContactFilter,
  type IncomingContent,
  type RelayRefusal,
  type TextProblem,
} from '../domain/chat/relay';
import type { Logger } from '../logger';
import { classifyTelegramError } from './telegram-errors';

/** An inline button of the bot that reports back to it. */
export interface CallbackButton {
  text: string;
  callback_data: string;
}

/** The one Bot API call the relay makes. Never forwardMessage or copyMessage. */
export interface RelayTelegram {
  sendMessage(
    chatId: number,
    text: string,
    options: {
      reply_markup?: { inline_keyboard: CallbackButton[][] };
      /** A relayed message is text: no page preview is built from what it mentions. */
      link_preview_options: { is_disabled: true };
    },
  ): Promise<{ message_id: number }>;
}

export interface RelayInput {
  /** The sender, already identified: by Telegram for a bot message, by initData for the API. */
  senderId: string;
  content: IncomingContent;
  /** The sender's own Telegram message; null from the Mini App and from dev tooling. */
  tgMessageId: number | null;
  /** The message this one replies to, if it is a reply. */
  replyToTgMessageId?: number | null;
  /** An explicit target: the Mini App names the match, and so does the picker. */
  matchId?: string | null;
}

/** A chat as its participant may see it: the match and the other person's alias (a content ID). */
export interface ChatRef {
  matchId: string;
  alias: string;
}

export type RelayRefusedReason =
  | TextProblem
  | RelayRefusal
  | 'rate_limited'
  /** Not the sender's match, or no such match: both look the same. */
  | 'not_found'
  /** The screening hook said no. */
  | 'screened'
  /** Telegram did not take the message, or the recipient can't be reached. */
  | 'not_delivered';

export type RelayResult =
  | {
      status: 'delivered';
      messageId: string;
      matchId: string;
      /** The other person's alias as the sender sees it. */
      alias: string;
      /** Whether the sender should be told where the message went. */
      echo: boolean;
      /** Whether this message started the chat. */
      first: boolean;
    }
  /** This Telegram message was relayed before: nothing was sent again. */
  | { status: 'duplicate' }
  /** Several chats are open and nothing says which one is meant. */
  | { status: 'pick'; chats: ChatRef[] }
  /** There is no chat to write in. */
  | { status: 'none' }
  | {
      status: 'refused';
      reason: RelayRefusedReason;
      /** Set when the active chat is over: the sender's other open chats, to choose from. */
      others?: ChatRef[];
    };

export interface RelayService {
  send(input: RelayInput): Promise<RelayResult>;
  /** The user's open chats, after closing any whose live bands no longer fit (invariant 4). */
  chatsOf(user: ChatUser): Promise<ChatRef[]>;
  /** The reply button under a relayed message, in the recipient's language. */
  keyboard(matchId: string, locale: Locale): CallbackButton[][];
}

export interface RelayDeps {
  chat: ChatRepository;
  users: Pick<UsersRepository, 'setBotReachable'>;
  content: ContentStore;
  telegram: RelayTelegram;
  clock: Clock;
  logger: Logger;
  params: ChatParams;
  /** Phase 5. Without it nothing passes the screening in the u18 band. */
  contactFilter?: ContactFilter;
  /** Tests replace the wait before a retry. */
  sleep?: (ms: number) => Promise<void>;
}

const MINUTE = 60_000;
const DAY = 86_400_000;
/** One message is tried this often; only a short rate-limit wait is worth another try. */
const MAX_SEND_ATTEMPTS = 2;
const MAX_RETRY_WAIT_SEC = 3;

/** Refusals that mean "this chat is over", as opposed to "not now" or "not you". */
const OVER: ReadonlySet<RelayRefusedReason> = new Set([
  'chat_ended',
  'band_mismatch',
  'blocked',
  'recipient_not_active',
  'not_found',
]);

export function createRelayService(deps: RelayDeps): RelayService {
  const { chat, content, telegram, clock, logger, params } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  function keyboard(matchId: string, locale: Locale): CallbackButton[][] {
    const { t } = translatorFor(locale);
    // Phase 5 adds the report and block buttons as a second row.
    return [[{ text: t('bot.chat.reply'), callback_data: encodeCallback('to', matchId) }]];
  }

  /**
   * Updates the active chat. It is only a routing hint, checked again on every use, so a write
   * that fails must not turn a delivered message, or a clean refusal, into an error.
   */
  async function remember(userId: string, matchId: string | null): Promise<void> {
    try {
      await chat.setActiveMatch(userId, matchId);
    } catch (error) {
      logger.warn({ userId, err: error }, 'active chat not updated');
    }
  }

  /** Invariant 4: the match closes with the message that finds a live band out of place. */
  async function closeForBandChange(matchId: string): Promise<void> {
    const { unreconciled } = await chat.closeForBandChange(matchId, clock.now());
    logger.info({ matchId }, 'chat closed: a live band differs from the match band');
    for (const userId of unreconciled) {
      logger.warn({ userId }, 'cached band not rewritten: left to the age-transition job');
    }
  }

  async function chatsOf(user: ChatUser): Promise<ChatRef[]> {
    const open = await chat.openChats(user.id);
    const refs: ChatRef[] = [];
    for (const c of open) {
      if (!c.consistent || c.counterpartAlias === null) {
        // A live band left the band of the match: it closes now, not when the hourly job runs.
        await closeForBandChange(c.matchId);
        continue;
      }
      if (chatOpenIn(c.band)) refs.push({ matchId: c.matchId, alias: c.counterpartAlias });
    }
    return refs;
  }

  /** The context of a message, with the reason it can't go out, both read right now. */
  async function check(
    senderId: string,
    matchId: string,
  ): Promise<{ context: ChatContext; reason: RelayRefusal | null } | null> {
    const context = await chat.context(senderId, matchId);
    if (!context) return null;
    const reason = refusal(context, params);
    if (reason === 'band_mismatch') await closeForBandChange(matchId);
    return { context, reason };
  }

  /** The Telegram call, re-checked before every try, and the record of the delivery. */
  async function deliver(
    messageId: string,
    senderId: string,
    matchId: string,
    body: string,
  ): Promise<RelayRefusedReason | null> {
    for (let attempt = 1; ; attempt++) {
      const now = await check(senderId, matchId);
      const reason = now ? now.reason : 'not_found';
      if (!now || reason) {
        await chat.markRejected(messageId, reason ?? 'not_found');
        return reason;
      }
      const { recipient, senderAlias } = now.context;
      if (recipient.synthetic) {
        // A dev-tooling user has no Telegram account: the message counts as delivered, unsent.
        await chat.markDelivered(messageId, clock.now(), null);
        return null;
      }
      if (!recipient.botReachable) {
        await chat.markRejected(messageId, 'unreachable');
        return 'not_delivered';
      }
      let sent: { message_id: number };
      try {
        sent = await telegram.sendMessage(
          recipient.telegramId,
          relayText(aliasText(content, senderAlias, recipient.locale), body),
          {
            reply_markup: { inline_keyboard: keyboard(matchId, recipient.locale) },
            link_preview_options: { is_disabled: true },
          },
        );
      } catch (error) {
        const failure = classifyTelegramError(error);
        const log = { messageId, matchId, error: failure.detail };
        if (failure.kind === 'unreachable') {
          // The recipient blocked the bot: stop matching them until they come back.
          await deps.users.setBotReachable(recipient.telegramId, false);
          await chat.markRejected(messageId, 'unreachable');
          logger.info(log, 'message not delivered: the bot cannot reach the recipient');
          return 'not_delivered';
        }
        if (
          failure.kind === 'rate_limited' &&
          failure.retryAfterSec <= MAX_RETRY_WAIT_SEC &&
          attempt < MAX_SEND_ATTEMPTS
        ) {
          await sleep((failure.retryAfterSec + 1) * 1000);
          continue;
        }
        await chat.markRejected(messageId, 'send_failed');
        logger.warn(log, 'message not delivered: the Telegram call failed');
        return 'not_delivered';
      }
      // Outside the try: the message has arrived, and a failure to record that is not a failure
      // to deliver it.
      await chat.markDelivered(messageId, clock.now(), sent.message_id);
      return null;
    }
  }

  async function send(input: RelayInput): Promise<RelayResult> {
    const refused = (reason: RelayRefusedReason, matchId?: string): RelayResult => {
      logger.info({ senderId: input.senderId, matchId, reason }, 'message refused');
      return { status: 'refused', reason };
    };

    // 1. Plain text only, within the limit: decided before anything is read or routed.
    const problem = textProblem(input.content, params);
    if (problem || input.content.text === null) return refused(problem ?? 'not_text');
    const body = input.content.text;

    // 2. The sender. Anyone who is not active sends nothing, whatever their matches look like.
    const user = await chat.userById(input.senderId);
    if (!user) return refused('not_found');
    if (user.status !== 'active') return refused('sender_not_active');

    // 3. The target: an explicit choice, the reply-to mapping, the active chat, the only chat.
    const chats = await chatsOf(user);
    const replyMatchId =
      input.replyToTgMessageId == null
        ? null
        : await chat.matchOfMessage(user.id, input.replyToTgMessageId);
    const route = chooseRoute({
      explicitMatchId: input.matchId ?? null,
      replyMatchId,
      activeMatchId: user.activeMatchId,
      openChats: chats.map((c) => c.matchId),
    });
    if (route.kind === 'pick') return { status: 'pick', chats };
    if (route.kind === 'none') {
      // A user whose only matches are in a band without chat is told that, not "no chats".
      return user.liveBand !== null && !chatOpenIn(user.liveBand)
        ? refused('u18_chat_closed')
        : { status: 'none' };
    }
    const { matchId } = route;

    // 4. Validate against the state of the match and both users, as it is right now.
    const checked = await check(user.id, matchId);
    const reason: RelayRefusedReason | null = checked ? checked.reason : 'not_found';
    if (!checked || reason) {
      logger.info({ senderId: user.id, matchId, reason, via: route.via }, 'message refused');
      if (route.via === 'pointer' && reason && OVER.has(reason)) {
        // The chat they were writing in is over. They are told; the text goes nowhere else.
        await remember(user.id, null);
        return {
          status: 'refused',
          reason,
          others: chats.filter((c) => c.matchId !== matchId),
        };
      }
      return { status: 'refused', reason: reason ?? 'not_found' };
    }
    const { context } = checked;

    const recent = await chat.acceptedSince(user.id, new Date(clock.now().getTime() - MINUTE));
    if (recent >= params.ratePerMinute) return refused('rate_limited', matchId);

    // 5. The screening hook: text only now, the contact filter from Phase 5.
    const screening = await screen(
      { band: context.band, content: input.content, matchId, senderId: user.id },
      deps.contactFilter ? { contactFilter: deps.contactFilter } : {},
    );
    if (!screening.pass) return refused('screened', matchId);

    // 6. Store. The insert trigger re-derives both bands and checks the match once more.
    const lastChatMatch = await chat.lastChatMatch(user.id);
    const messageId = uuidv7();
    const now = clock.now();
    const stored = await chat.store({
      id: messageId,
      matchId,
      senderId: user.id,
      body,
      senderTgMessageId: input.tgMessageId,
      now,
      purgeAfter: new Date(now.getTime() + params.retentionDays * DAY),
    });
    if (stored.status === 'duplicate') return { status: 'duplicate' };
    if (stored.status === 'refused') {
      // The database saw something this code did not: it is right. Look again, for the reason.
      logger.warn({ senderId: user.id, matchId, rule: stored.rule }, 'message refused by the db');
      const again = await check(user.id, matchId);
      return { status: 'refused', reason: again?.reason ?? 'not_delivered' };
    }

    // 7. Send, re-checked immediately before the call, and record the delivery.
    const failed = await deliver(messageId, user.id, matchId, body);
    if (failed) return refused(failed, matchId);

    // 8. The first delivered message starts the chat: the match no longer expires.
    const first = await chat.startChat(matchId, clock.now());
    // Choosing a chat explicitly, or having only one, makes it the active one.
    if (route.via === 'explicit' || route.via === 'only') {
      await remember(user.id, matchId);
    }
    logger.info(
      { messageId, matchId, senderId: user.id, via: route.via, first },
      'message relayed',
    );
    return {
      status: 'delivered',
      messageId,
      matchId,
      alias: context.recipientAlias,
      echo: needsEcho(route, lastChatMatch),
      first,
    };
  }

  return { send, chatsOf, keyboard };
}
