/**
 * The anonymous chat of a match (PLAN.md §4). `messages` holds what was relayed: the bot sends
 * every one of them as a new plain-text message of its own, never a forward or a copy.
 * `reveal_consents` holds each adult's agreement to exchange usernames.
 * Migration 0010 adds the triggers: who may store a message (both users' bands are re-derived from
 * `birth_date`, and nothing is stored in a u18 match until the contact filter exists), that a
 * stored message never changes, and that usernames are revealed only in the adult band after both
 * users consented.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { matches } from './matching';
import { users } from './users';

/**
 * What became of a message: accepted for delivery, stopped by the contact filter (Phase 5), or
 * not delivered. An accepted message has really reached the recipient once `delivered_at` is set.
 */
export const messageVerdictEnum = pgEnum('message_verdict', [
  'delivered',
  'blocked_by_filter',
  'rejected',
]);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey(),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id),
    /** The text as written. Null once the retention purge has removed it (Q20). */
    body: text('body'),
    verdict: messageVerdictEnum('verdict').notNull(),
    /** Why a message was not delivered. */
    reason: text('reason'),
    /**
     * The message in the sender's bot chat: their own message, or the bot's copy of a message sent
     * from the Mini App. A reply to it is routed to this match.
     */
    senderTgMessageId: bigint('sender_tg_message_id', { mode: 'number' }),
    /** The bot's message in the recipient's chat: a reply to it is routed back to this match. */
    recipientTgMessageId: bigint('recipient_tg_message_id', { mode: 'number' }),
    /**
     * When Telegram accepted the message for the recipient. The chat of a match has started once
     * one of its messages has this: until then the match can still expire (Q2).
     */
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When the body is removed (Q20). */
    purgeAfter: timestamp('purge_after', { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      'messages_body_length',
      sql`${t.body} IS NULL OR char_length(${t.body}) BETWEEN 1 AND 2000`,
    ),
    check('messages_reason', sql`(${t.verdict} = 'delivered') = (${t.reason} IS NULL)`),
    // Only an accepted message is delivered, and only a delivered one has a message at the recipient.
    check('messages_delivered', sql`${t.deliveredAt} IS NULL OR ${t.verdict} = 'delivered'`),
    check(
      'messages_recipient_message',
      sql`${t.recipientTgMessageId} IS NULL OR ${t.deliveredAt} IS NOT NULL`,
    ),
    // A Telegram update that is delivered twice is relayed once.
    unique('messages_sender_message_unique').on(t.senderId, t.senderTgMessageId),
    index('messages_match_idx').on(t.matchId, t.createdAt),
    index('messages_recipient_message_idx').on(t.recipientTgMessageId),
    // The per-user rate limit counts a sender's recent messages.
    index('messages_sender_time_idx').on(t.senderId, t.createdAt),
    index('messages_purge_idx')
      .on(t.purgeAfter)
      .where(sql`${t.body} IS NOT NULL`),
  ],
);

/**
 * One row per user who agreed to exchange usernames in a match. Adults only (trigger). The
 * usernames themselves are never stored here: the bot reads them from Telegram when it reveals.
 */
export const revealConsents = pgTable(
  'reveal_consents',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    consentedAt: timestamp('consented_at', { withTimezone: true }).notNull(),
    /** Set on both rows at once, when both users have consented. */
    revealedAt: timestamp('revealed_at', { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.matchId, t.userId] })],
);
