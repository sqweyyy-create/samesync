/**
 * The rules of the chat relay (pure; PLAN.md Phase 4). The relay service reads the state of a
 * match and its two users, and these functions decide: where a message goes, whether it may be
 * relayed at all, and what the recipient gets. `refusal` is applied again immediately before
 * every Telegram call (CLAUDE.md invariant 3).
 */
import type { Band, Locale, MatchStatus } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { chatOpenIn, type ChatParams } from './params';

/** One side of a chat as the relay sees it. Bands come from `birth_date`, never from the cache. */
export interface ChatParty {
  id: string;
  status: UserStatus;
  liveBand: Band | null;
  locale: Locale;
}

/** Everything the relay checks, read in one query right before a message is stored or sent. */
export interface ChatContext {
  matchId: string;
  status: MatchStatus;
  band: Band;
  locale: Locale;
  /** A block between the two users, in either direction. */
  blocked: boolean;
  sender: ChatParty;
  recipient: ChatParty & { telegramId: number; botReachable: boolean; synthetic: boolean };
  /** Content alias IDs: how each side appears to the other. */
  senderAlias: string;
  recipientAlias: string;
}

/** Why a message is not relayed. Anything unknown or missing is a refusal (fail closed). */
export type RelayRefusal =
  /** The game is not finished: there is no chat yet. */
  | 'chat_not_open'
  /** The match has expired or was closed. */
  | 'chat_ended'
  | 'sender_not_active'
  | 'recipient_not_active'
  /** A live band differs from the band of the match: the match has to close (invariant 4). */
  | 'band_mismatch'
  /** No chat in the u18 band until the contact filter exists (Phase 5). */
  | 'u18_chat_closed'
  | 'blocked'
  | 'locale_mismatch';

/**
 * Null means the message may go from `sender` to `recipient` right now. The caller has already
 * made sure that the sender is a participant: a context only exists for one.
 */
export function refusal(
  context: ChatContext,
  params: Pick<ChatParams, 'requireSameLocale'>,
): RelayRefusal | null {
  const { sender, recipient } = context;
  if (context.status === 'pending_game') return 'chat_not_open';
  if (context.status !== 'results_ready' && context.status !== 'active') return 'chat_ended';
  // Frozen, deleted and every other non-active status: nothing is relayed to or from them.
  if (sender.status !== 'active') return 'sender_not_active';
  if (recipient.status !== 'active') return 'recipient_not_active';
  // Both live bands must equal the match band, even if the age-transition job hasn't run yet.
  if (sender.liveBand !== context.band || recipient.liveBand !== context.band) {
    return 'band_mismatch';
  }
  if (!chatOpenIn(context.band)) return 'u18_chat_closed';
  if (context.blocked) return 'blocked';
  if (
    params.requireSameLocale &&
    (sender.locale !== context.locale || recipient.locale !== context.locale)
  ) {
    return 'locale_mismatch';
  }
  return null;
}

/** What a user sent, reduced to what the relay may look at. */
export interface IncomingContent {
  /** The text of a text message; null for anything else (photo, voice, sticker, file…). */
  text: string | null;
  /** Whether Telegram attached entities to the text (links, mentions, formatting…). */
  hasEntities: boolean;
}

export type TextProblem = 'not_text' | 'empty' | 'too_long';

/** Characters as the database counts them (code points), so both limits agree. */
export const textLength = (text: string): number => [...text].length;

/** Plain text only, in both pools (Q19), and not longer than the limit. */
export function textProblem(
  content: IncomingContent,
  params: Pick<ChatParams, 'maxLength'>,
): TextProblem | null {
  if (content.text === null) return 'not_text';
  // A NUL character is not text: Telegram never sends one, and the database can't store one.
  if (content.text.includes('\u0000')) return 'not_text';
  if (content.text.trim() === '') return 'empty';
  if (textLength(content.text) > params.maxLength) return 'too_long';
  return null;
}

/**
 * The contact filter of the u18 pool (Phase 5): looks at a message and at what the sender wrote
 * just before it. A hit, and any error it throws, means the message is not delivered.
 */
export type ContactFilter = (input: {
  text: string;
  matchId: string;
  senderId: string;
}) => Promise<{ hit: boolean; kind?: string }>;

export type Screening =
  { pass: true } | { pass: false; verdict: 'rejected' | 'blocked_by_filter'; reason: string };

/**
 * The screening hook: the last look at a message before it is stored and sent. In Phase 4 it
 * enforces plain text. For the u18 band it also demands the contact filter, and there is none
 * yet, so nothing passes: Phase 5 plugs the filter in here.
 */
export async function screen(
  input: { band: Band; content: IncomingContent; matchId: string; senderId: string },
  hooks: { contactFilter?: ContactFilter } = {},
): Promise<Screening> {
  const { band, content } = input;
  if (content.text === null) return { pass: false, verdict: 'rejected', reason: 'not_text' };
  if (band === 'adult') {
    // Entities are simply not passed on: the recipient gets the characters and nothing else.
    return { pass: true };
  }
  // u18: no formatting entities, and every message goes through the contact filter (invariant 5).
  if (content.hasEntities) return { pass: false, verdict: 'rejected', reason: 'entities' };
  if (!hooks.contactFilter)
    return { pass: false, verdict: 'rejected', reason: 'no_contact_filter' };
  try {
    const result = await hooks.contactFilter({
      text: content.text,
      matchId: input.matchId,
      senderId: input.senderId,
    });
    if (result.hit) {
      return { pass: false, verdict: 'blocked_by_filter', reason: result.kind ?? 'contact' };
    }
  } catch {
    // A filter that fails is a filter that said no.
    return { pass: false, verdict: 'rejected', reason: 'filter_error' };
  }
  return { pass: true };
}

/**
 * What the recipient gets: the sender's alias, a line break and the text. Nothing else is ever
 * part of a relayed message (CLAUDE.md invariant 6): no name, no username, no ID, no markup.
 */
export function relayText(aliasLabel: string, text: string): string {
  return `${aliasLabel}\n${text}`;
}

/** Where a message goes. */
export type Route =
  /** `via` says how it was decided: an explicit choice, a reply, the active chat, the only chat. */
  | { kind: 'match'; matchId: string; via: 'explicit' | 'reply' | 'pointer' | 'only' }
  /** Several chats are open and nothing says which one is meant: the sender has to choose. */
  | { kind: 'pick' }
  /** There is no chat to write in. */
  | { kind: 'none' };

/**
 * Q24 (decided): a reply goes to the chat of the message it answers; anything else goes to the
 * active chat. Without an active chat the only open chat is taken, and with several the sender is
 * asked.
 * The active chat is taken as it is, open or not: the relay checks every target anyway, and when
 * that chat has ended the sender is told so. Their text is never moved to another chat instead.
 */
export function chooseRoute(input: {
  /** An explicit choice: the Mini App names the match, and so does the picker. */
  explicitMatchId?: string | null;
  /** The match of the message this one replies to, when that is a message of one of their chats. */
  replyMatchId: string | null;
  /** `users.active_match_id`. */
  activeMatchId: string | null;
  /** The sender's matches whose chat is open. */
  openChats: readonly string[];
}): Route {
  if (input.explicitMatchId) {
    return { kind: 'match', matchId: input.explicitMatchId, via: 'explicit' };
  }
  if (input.replyMatchId) return { kind: 'match', matchId: input.replyMatchId, via: 'reply' };
  if (input.activeMatchId) return { kind: 'match', matchId: input.activeMatchId, via: 'pointer' };
  const [only, ...others] = input.openChats;
  if (only === undefined) return { kind: 'none' };
  if (others.length === 0) return { kind: 'match', matchId: only, via: 'only' };
  return { kind: 'pick' };
}

/**
 * Whether the sender is told where a message went ("→ alias"). Only when it went somewhere else
 * than the latest message in their bot chat: a run of messages in one chat stays quiet, and a
 * switch between chats is always visible.
 */
export function needsEcho(route: Route, lastChatMatchId: string | null): boolean {
  if (route.kind !== 'match' || route.via === 'explicit') return false;
  return lastChatMatchId !== null && lastChatMatchId !== route.matchId;
}
