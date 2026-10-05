/**
 * The chat of a match (PLAN.md Phase 4): what the relay reads before a message goes out, and what
 * it writes.
 *
 * Safety: every read starts from a user who is in the match, and re-derives both users' bands from
 * `birth_date`. A match whose live bands differ from its band is reported as not `consistent`, and
 * nothing else of it is returned: not even the other person's alias. Every write passes the
 * triggers of migration 0010, which check the same rules again inside the database.
 * The other person's Telegram ID leaves this module only inside `ChatContext`, for the one call
 * that delivers a message to them. It is never part of anything shown to a user.
 */
import { OPEN_MATCH_STATUSES, type Band, type Locale, type MatchStatus } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { ChatContext } from '../../domain/chat/relay';
import type { Db } from '../client';
import { pgErrorOf } from '../errors';
import { matches, messages, outbox, users } from '../schema/index';
import { notificationKey } from './outbox';

/** The sender of a message: the caller's own row, with what routing needs. */
export interface ChatUser {
  id: string;
  locale: Locale;
  status: UserStatus;
  /** From `birth_date` right now. */
  liveBand: Band | null;
  activeMatchId: string | null;
}

/** One of the caller's matches whose chat is open (`results_ready` or `active`). */
export interface OpenChat {
  matchId: string;
  status: MatchStatus;
  band: Band;
  /** Both live bands equal the band of the match. A chat that is not must be closed, not shown. */
  consistent: boolean;
  /** How the other person appears to the caller, as a content alias ID; null unless consistent. */
  counterpartAlias: string | null;
}

export type StoreOutcome =
  | { status: 'stored' }
  /** The same Telegram message of this sender is already stored: an update delivered twice. */
  | { status: 'duplicate' }
  /** A trigger of migration 0010 refused; `rule` is the rule it names. */
  | { status: 'refused'; rule: string };

export interface ChatRepository {
  /** The user behind a Telegram account; null for an account the bot doesn't know. */
  user(telegramId: number): Promise<ChatUser | null>;
  /** The same for a user who is already identified (the API, dev tooling). */
  userById(userId: string): Promise<ChatUser | null>;
  /** The caller's matches whose chat is open, newest first. */
  openChats(userId: string): Promise<OpenChat[]>;
  /**
   * The match a message in the caller's bot chat belongs to: a message they sent, or one that was
   * relayed to them. Null for any other message.
   */
  matchOfMessage(userId: string, tgMessageId: number): Promise<string | null>;
  /** Whether this Telegram message of the caller was accepted for delivery. */
  wasRelayed(userId: string, tgMessageId: number): Promise<boolean>;
  /** The match of the latest delivered message in the caller's bot chat, in either direction. */
  lastChatMatch(userId: string): Promise<string | null>;
  /** Everything the relay checks for one message; null if `senderId` is not in the match. */
  context(senderId: string, matchId: string): Promise<ChatContext | null>;
  /** How many messages the sender has had accepted since `since`. */
  acceptedSince(senderId: string, since: Date): Promise<number>;
  /** Stores an accepted message. The insert trigger decides once more. */
  store(input: {
    id: string;
    matchId: string;
    senderId: string;
    body: string;
    senderTgMessageId: number | null;
    now: Date;
    purgeAfter: Date;
  }): Promise<StoreOutcome>;
  markDelivered(id: string, at: Date, recipientTgMessageId: number | null): Promise<void>;
  markRejected(id: string, reason: string): Promise<void>;
  /** Records the bot's copy of a message that was sent from the Mini App. */
  setSenderMessage(id: string, tgMessageId: number): Promise<void>;
  /**
   * The first delivered message starts the chat: the match becomes `active` and loses its
   * deadline. False if it had already started, or if the status trigger refused.
   */
  startChat(matchId: string, now: Date): Promise<boolean>;
  setActiveMatch(userId: string, matchId: string | null): Promise<void>;
  /**
   * A live band no longer equals the band of the match (CLAUDE.md invariant 4). The match is
   * closed first, with its unsent notifications cancelled: that needs nothing but the match.
   * Then both users' cached bands are rewritten, which makes the state-change trigger close every
   * other open match of whoever changed band. `unreconciled` lists the users whose cache could
   * not be written (the hourly age-transition job tries again); the match is closed regardless.
   */
  closeForBandChange(matchId: string, now: Date): Promise<{ unreconciled: string[] }>;
  /**
   * The caller leaves one of their open chats: the match closes with reason `left`, its unsent
   * notifications are cancelled, and the other person gets one neutral notice. False if it is not
   * an open chat of theirs.
   */
  leave(userId: string, matchId: string, now: Date): Promise<boolean>;
  /**
   * Expires chats nobody wrote in before their deadline (Q2): the match becomes `expired`, its
   * other pending notifications are cancelled, and both users get one notice. A chat with a
   * delivered message never expires, and one with a message on its way is left for the next run.
   * Returns how many expired.
   */
  expireSilent(now: Date, limit: number): Promise<number>;
  /**
   * Queues the one reminder (Q2) for both users of every chat nobody has written in and whose
   * deadline is at most `leadMs` away, in the bands that can chat. Returns how many were queued.
   */
  remindSilent(now: Date, leadMs: number, limit: number, bands: readonly Band[]): Promise<number>;
  /**
   * Starts the chats that have a delivered message but are still `results_ready`: what is left
   * when the process stopped between delivering a first message and recording the start.
   */
  startDelivered(now: Date, limit: number): Promise<number>;
  /** Removes the text of messages whose retention period is over (Q20). Returns how many. */
  purgeBodies(now: Date, limit: number): Promise<number>;
}

/** A message that was accepted this recently may still be on its way to the recipient. */
const IN_FLIGHT_MS = 120_000;

/** Refusals of the message trigger; the rule follows the colon ("message rejected: band"). */
const MESSAGE_REFUSED = 'SS030';
const SENDER_MESSAGE_UNIQUE = 'messages_sender_message_unique';

const OPEN = sql.join(
  OPEN_MATCH_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/** Both users' bands, from their birth dates right now, equal the band of the match `m`. */
const CONSISTENT = sql`(
    coalesce(vc_band(ua.birth_date, vc_today()) = m.band, false)
    AND coalesce(vc_band(ub.birth_date, vc_today()) = m.band, false)
  )`;

interface UserRow extends Record<string, unknown> {
  id: string;
  locale: Locale;
  status: UserStatus;
  live_band: Band | null;
  active_match_id: string | null;
}

interface ContextRow extends Record<string, unknown> {
  id: string;
  status: MatchStatus;
  band: Band;
  locale: Locale;
  blocked: boolean;
  sender_alias: string;
  recipient_alias: string;
  sender_status: UserStatus;
  sender_band: Band | null;
  sender_locale: Locale;
  recipient_id: string;
  recipient_telegram_id: string | number;
  recipient_status: UserStatus;
  recipient_band: Band | null;
  recipient_locale: Locale;
  recipient_reachable: boolean;
  recipient_synthetic: boolean;
}

export function createChatRepository(db: Db): ChatRepository {
  const selectUser = async (where: ReturnType<typeof sql>): Promise<ChatUser | null> => {
    const result = await db.execute<UserRow>(sql`
      SELECT id, locale, status, active_match_id, vc_band(birth_date, vc_today()) AS live_band
      FROM users WHERE ${where}`);
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      locale: row.locale,
      status: row.status,
      liveBand: row.live_band,
      activeMatchId: row.active_match_id,
    };
  };

  async function startChat(matchId: string, now: Date): Promise<boolean> {
    try {
      // The status trigger checks again: a delivered message, both active, both live bands.
      const started = await db
        .update(matches)
        .set({ status: 'active', firstMessageAt: now, chatDeadlineAt: null })
        .where(and(eq(matches.id, matchId), eq(matches.status, 'results_ready')))
        .returning({ id: matches.id });
      return started.length > 0;
    } catch (error) {
      // SS012: one of the two is no longer active or in the band. The match is closing.
      if (pgErrorOf(error)?.code === 'SS012') return false;
      throw error;
    }
  }

  return {
    user: (telegramId) => selectUser(sql`telegram_id = ${telegramId}`),
    userById: (userId) => selectUser(sql`id = ${userId}::uuid`),

    async openChats(userId) {
      const result = await db.execute<{
        id: string;
        status: MatchStatus;
        band: Band;
        consistent: boolean;
        counterpart_alias: string | null;
      }>(sql`
        SELECT m.id, m.status, m.band, ${CONSISTENT} AS consistent,
          CASE WHEN NOT ${CONSISTENT} THEN NULL
            WHEN m.user_a_id = ${userId}::uuid THEN m.alias_b ELSE m.alias_a END AS counterpart_alias
        FROM matches m
        JOIN users ua ON ua.id = m.user_a_id
        JOIN users ub ON ub.id = m.user_b_id
        WHERE (m.user_a_id = ${userId}::uuid OR m.user_b_id = ${userId}::uuid)
          AND m.status IN ('results_ready', 'active')
        ORDER BY m.created_at DESC, m.id DESC`);
      return result.rows.map((r) => ({
        matchId: r.id,
        status: r.status,
        band: r.band,
        consistent: r.consistent,
        counterpartAlias: r.consistent ? r.counterpart_alias : null,
      }));
    },

    async matchOfMessage(userId, tgMessageId) {
      // Either the caller's own message, or the bot's message that carried the other person's.
      const result = await db.execute<{ match_id: string }>(sql`
        SELECT msg.match_id
        FROM messages msg
        JOIN matches m ON m.id = msg.match_id
        WHERE (m.user_a_id = ${userId}::uuid OR m.user_b_id = ${userId}::uuid)
          AND (
            (msg.sender_id = ${userId}::uuid AND msg.sender_tg_message_id = ${tgMessageId})
            OR (msg.sender_id <> ${userId}::uuid AND msg.recipient_tg_message_id = ${tgMessageId})
          )
        ORDER BY msg.created_at DESC, msg.id DESC
        LIMIT 1`);
      return result.rows[0]?.match_id ?? null;
    },

    async wasRelayed(userId, tgMessageId) {
      const rows = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.senderId, userId),
            eq(messages.senderTgMessageId, tgMessageId),
            eq(messages.verdict, 'delivered'),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async lastChatMatch(userId) {
      const result = await db.execute<{ match_id: string }>(sql`
        SELECT msg.match_id
        FROM messages msg
        JOIN matches m ON m.id = msg.match_id
        WHERE (m.user_a_id = ${userId}::uuid OR m.user_b_id = ${userId}::uuid)
          AND msg.delivered_at IS NOT NULL
        ORDER BY msg.created_at DESC, msg.id DESC
        LIMIT 1`);
      return result.rows[0]?.match_id ?? null;
    },

    async context(senderId, matchId) {
      const mine = sql`(m.user_a_id = ${senderId}::uuid)`;
      const result = await db.execute<ContextRow>(sql`
        SELECT m.id, m.status, m.band, m.locale,
          EXISTS (
            SELECT 1 FROM blocks
            WHERE (blocker_id = m.user_a_id AND blocked_id = m.user_b_id)
               OR (blocker_id = m.user_b_id AND blocked_id = m.user_a_id)
          ) AS blocked,
          CASE WHEN ${mine} THEN m.alias_a ELSE m.alias_b END AS sender_alias,
          CASE WHEN ${mine} THEN m.alias_b ELSE m.alias_a END AS recipient_alias,
          s.status AS sender_status, vc_band(s.birth_date, vc_today()) AS sender_band,
          s.locale AS sender_locale,
          r.id AS recipient_id, r.telegram_id AS recipient_telegram_id,
          r.status AS recipient_status, vc_band(r.birth_date, vc_today()) AS recipient_band,
          r.locale AS recipient_locale, r.bot_reachable AS recipient_reachable,
          r.synthetic AS recipient_synthetic
        FROM matches m
        JOIN users s ON s.id = ${senderId}::uuid
        JOIN users r ON r.id = CASE WHEN ${mine} THEN m.user_b_id ELSE m.user_a_id END
        WHERE m.id = ${matchId}::uuid
          AND (m.user_a_id = ${senderId}::uuid OR m.user_b_id = ${senderId}::uuid)`);
      const row = result.rows[0];
      if (!row) return null;
      return {
        matchId: row.id,
        status: row.status,
        band: row.band,
        locale: row.locale,
        blocked: row.blocked,
        sender: {
          id: senderId,
          status: row.sender_status,
          liveBand: row.sender_band,
          locale: row.sender_locale,
        },
        recipient: {
          id: row.recipient_id,
          telegramId: Number(row.recipient_telegram_id),
          status: row.recipient_status,
          liveBand: row.recipient_band,
          locale: row.recipient_locale,
          botReachable: row.recipient_reachable,
          synthetic: row.recipient_synthetic,
        },
        senderAlias: row.sender_alias,
        recipientAlias: row.recipient_alias,
      };
    },

    async acceptedSince(senderId, since) {
      const result = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM messages
        WHERE sender_id = ${senderId}::uuid AND created_at > ${since.toISOString()}::timestamptz`);
      return result.rows[0]?.n ?? 0;
    },

    async store({ id, matchId, senderId, body, senderTgMessageId, now, purgeAfter }) {
      try {
        await db.insert(messages).values({
          id,
          matchId,
          senderId,
          body,
          verdict: 'delivered',
          senderTgMessageId,
          createdAt: now,
          purgeAfter,
        });
        return { status: 'stored' };
      } catch (error) {
        const pgError = pgErrorOf(error);
        if (pgError?.code === '23505' && pgError.constraint === SENDER_MESSAGE_UNIQUE) {
          return { status: 'duplicate' };
        }
        if (pgError?.code === MESSAGE_REFUSED) {
          return { status: 'refused', rule: pgError.message.split(': ').at(-1) ?? 'unknown' };
        }
        // The driver's error quotes the statement's parameters, and one of them is the text of
        // the message. It must never reach a log (CLAUDE.md, Logs): only its code goes on.
        // eslint-disable-next-line preserve-caught-error -- the cause would carry the text
        throw new Error(
          `storing a message failed (${pgError?.code ?? 'no database error code'}${
            pgError?.constraint ? `, ${pgError.constraint}` : ''
          })`,
        );
      }
    },

    async markDelivered(id, at, recipientTgMessageId) {
      await db
        .update(messages)
        .set({ deliveredAt: at, recipientTgMessageId })
        .where(and(eq(messages.id, id), isNull(messages.deliveredAt)));
    },

    async markRejected(id, reason) {
      await db
        .update(messages)
        .set({ verdict: 'rejected', reason })
        .where(
          and(eq(messages.id, id), eq(messages.verdict, 'delivered'), isNull(messages.deliveredAt)),
        );
    },

    async setSenderMessage(id, tgMessageId) {
      await db
        .update(messages)
        .set({ senderTgMessageId: tgMessageId })
        .where(and(eq(messages.id, id), isNull(messages.senderTgMessageId)));
    },

    startChat,

    async setActiveMatch(userId, matchId) {
      await db
        .update(users)
        .set({ activeMatchId: matchId })
        .where(
          and(eq(users.id, userId), sql`${users.activeMatchId} IS DISTINCT FROM ${matchId}::uuid`),
        );
    },

    async closeForBandChange(matchId, now) {
      // First the match itself: a match whose live bands differ from its band does not stay open,
      // whatever else happens below.
      const users_ = await db.transaction(async (tx) => {
        const closed = await tx.execute<{ id: string }>(sql`
          UPDATE matches m
          SET status = 'closed', close_reason = 'band_change',
            closed_at = ${now.toISOString()}::timestamptz
          FROM users ua, users ub
          WHERE m.id = ${matchId}::uuid AND ua.id = m.user_a_id AND ub.id = m.user_b_id
            AND m.status IN (${OPEN}) AND NOT ${CONSISTENT}
          RETURNING m.id`);
        if (closed.rows.length > 0) {
          await tx
            .update(outbox)
            .set({ status: 'cancelled', cancelReason: 'band_change' })
            .where(and(eq(outbox.matchId, matchId), eq(outbox.status, 'pending')));
        }
        const [match] = await tx
          .select({ a: matches.userAId, b: matches.userBId })
          .from(matches)
          .where(eq(matches.id, matchId));
        return match ? [match.a, match.b] : [];
      });
      // Then the caches, one user at a time, each in its own transaction: the state-change
      // trigger closes the other open matches of a user whose band changed, and cancels their
      // outbox. A row that can't be written (it breaks a CHECK on the new band) is left to the
      // age-transition job and reported; nothing above depends on it.
      const unreconciled: string[] = [];
      for (const userId of users_) {
        try {
          await db
            .update(users)
            .set({ ageBand: sql`vc_band(${users.birthDate}, vc_today())` })
            .where(eq(users.id, userId));
        } catch (error) {
          if (!pgErrorOf(error)) throw error;
          unreconciled.push(userId);
        }
      }
      return { unreconciled };
    },

    async leave(userId, matchId, now) {
      const left = await db.transaction(async (tx) => {
        const closed = await tx.execute<{ user_a_id: string; user_b_id: string }>(sql`
          UPDATE matches
          SET status = 'closed', close_reason = 'left', closed_at = ${now.toISOString()}::timestamptz
          WHERE id = ${matchId}::uuid
            AND (user_a_id = ${userId}::uuid OR user_b_id = ${userId}::uuid)
            AND status IN ('results_ready', 'active')
          RETURNING user_a_id, user_b_id`);
        const match = closed.rows[0];
        if (!match) return false;
        const other = match.user_a_id === userId ? match.user_b_id : match.user_a_id;
        // A reminder, a reveal request: nothing about this match is sent any more.
        await tx
          .update(outbox)
          .set({ status: 'cancelled', cancelReason: 'left' })
          .where(and(eq(outbox.matchId, matchId), eq(outbox.status, 'pending')));
        await tx
          .insert(outbox)
          .values({
            id: uuidv7(),
            userId: other,
            kind: 'chat_ended',
            matchId,
            dedupeKey: notificationKey('chat_ended', matchId, other),
            nextAttemptAt: now,
            createdAt: now,
          })
          .onConflictDoNothing({ target: outbox.dedupeKey });
        return true;
      });
      // After the transaction, so that it never holds the match and a user row at once.
      if (left) {
        await db
          .update(users)
          .set({ activeMatchId: null })
          .where(and(eq(users.id, userId), eq(users.activeMatchId, matchId)));
      }
      return left;
    },

    async expireSilent(now, limit) {
      const at = now.toISOString();
      const inFlightSince = new Date(now.getTime() - IN_FLIGHT_MS).toISOString();
      return db.transaction(async (tx) => {
        const due = await tx.execute<{ id: string }>(sql`
          SELECT m.id FROM matches m
          WHERE m.status = 'results_ready' AND m.chat_deadline_at <= ${at}::timestamptz
            AND NOT EXISTS (
              SELECT 1 FROM messages msg
              WHERE msg.match_id = m.id AND msg.verdict = 'delivered'
                AND (msg.delivered_at IS NOT NULL OR msg.created_at > ${inFlightSince}::timestamptz)
            )
          ORDER BY m.chat_deadline_at, m.id
          LIMIT ${limit}
          FOR UPDATE OF m SKIP LOCKED`);
        if (due.rows.length === 0) return 0;
        const ids = sql`${`{${due.rows.map((m) => m.id).join(',')}}`}::uuid[]`;
        // The rows are locked, so no message can be stored for them any more: what was delivered
        // by now is all there will be, and the status trigger agrees with this condition.
        const expired = await tx.execute<{ id: string; user_a_id: string; user_b_id: string }>(sql`
          UPDATE matches m
          SET status = 'expired', close_reason = 'expired', closed_at = ${at}::timestamptz
          WHERE m.id = ANY(${ids}) AND m.status = 'results_ready'
            AND NOT EXISTS (
              SELECT 1 FROM messages msg WHERE msg.match_id = m.id AND msg.delivered_at IS NOT NULL
            )
          RETURNING m.id, m.user_a_id, m.user_b_id`);
        if (expired.rows.length === 0) return 0;
        const expiredIds = sql`${`{${expired.rows.map((m) => m.id).join(',')}}`}::uuid[]`;
        await tx.execute(sql`
          UPDATE outbox SET status = 'cancelled', cancel_reason = 'expired'
          WHERE status = 'pending' AND match_id = ANY(${expiredIds})`);
        await tx
          .insert(outbox)
          .values(
            expired.rows.flatMap((match) =>
              [match.user_a_id, match.user_b_id].map((userId) => ({
                id: uuidv7(),
                userId,
                kind: 'chat_expired' as const,
                matchId: match.id,
                dedupeKey: notificationKey('chat_expired', match.id, userId),
                nextAttemptAt: now,
                createdAt: now,
              })),
            ),
          )
          .onConflictDoNothing({ target: outbox.dedupeKey });
        return expired.rows.length;
      });
    },

    async remindSilent(now, leadMs, limit, bands) {
      if (bands.length === 0) return 0;
      const from = now.toISOString();
      const until = new Date(now.getTime() + leadMs).toISOString();
      // Both users of a chat nobody has written in, who were never reminded about it.
      const due = await db.execute<{ match_id: string; user_id: string }>(sql`
        SELECT m.id AS match_id, p.user_id
        FROM matches m
        CROSS JOIN LATERAL (VALUES (m.user_a_id), (m.user_b_id)) AS p(user_id)
        WHERE m.status = 'results_ready'
          AND m.band = ANY(${`{${bands.join(',')}}`}::band[])
          AND m.chat_deadline_at > ${from}::timestamptz
          AND m.chat_deadline_at <= ${until}::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM messages msg WHERE msg.match_id = m.id AND msg.verdict = 'delivered'
          )
          AND NOT EXISTS (
            SELECT 1 FROM outbox o
            WHERE o.dedupe_key = 'chat_reminder:' || m.id::text || ':' || p.user_id::text
          )
        ORDER BY m.chat_deadline_at, m.id, p.user_id
        LIMIT ${limit}`);
      if (due.rows.length === 0) return 0;
      const queued = await db
        .insert(outbox)
        .values(
          due.rows.map((row) => ({
            id: uuidv7(),
            userId: row.user_id,
            kind: 'chat_reminder' as const,
            matchId: row.match_id,
            dedupeKey: notificationKey('chat_reminder', row.match_id, row.user_id),
            nextAttemptAt: now,
            createdAt: now,
          })),
        )
        .onConflictDoNothing({ target: outbox.dedupeKey })
        .returning({ id: outbox.id });
      return queued.length;
    },

    async startDelivered(now, limit) {
      const settledBefore = new Date(now.getTime() - IN_FLIGHT_MS).toISOString();
      const left = await db.execute<{ id: string; first_ms: number }>(sql`
        SELECT m.id, (extract(epoch FROM min(msg.delivered_at)) * 1000)::float8 AS first_ms
        FROM matches m
        JOIN messages msg ON msg.match_id = m.id AND msg.delivered_at IS NOT NULL
        WHERE m.status = 'results_ready'
        GROUP BY m.id
        HAVING min(msg.delivered_at) < ${settledBefore}::timestamptz
        ORDER BY m.id
        LIMIT ${limit}`);
      let started = 0;
      // One at a time: the status trigger may refuse one of them (it is closing), not the rest.
      for (const row of left.rows) {
        if (await startChat(row.id, new Date(row.first_ms))) started++;
      }
      return started;
    },

    async purgeBodies(now, limit) {
      const purged = await db.execute<{ id: string }>(sql`
        UPDATE messages SET body = NULL
        WHERE id IN (
          SELECT id FROM messages
          WHERE body IS NOT NULL AND purge_after <= ${now.toISOString()}::timestamptz
          ORDER BY purge_after, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`);
      return purged.rows.length;
    },
  };
}
