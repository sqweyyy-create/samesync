/**
 * The outbox: pending bot messages (PLAN.md §4). Rows are claimed with FOR UPDATE SKIP LOCKED, so
 * two senders never take the same row, and every state change only touches rows that are still
 * pending (a row cancelled by the state-change trigger stays cancelled).
 */
import type { Band, Locale, MatchStatus } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { outbox } from '../schema/index';

export interface ClaimedMessage {
  id: string;
  userId: string;
  kind: 'match_created';
  matchId: string | null;
  attempts: number;
}

/** Everything the sender re-checks right before a Telegram call, read in one query. */
export interface SendContext {
  recipient: {
    telegramId: number;
    locale: Locale;
    status: UserStatus;
    botReachable: boolean;
    synthetic: boolean;
    timezone: string | null;
    /** From `birth_date` right now, not the cached column. */
    liveBand: Band | null;
  } | null;
  match: {
    id: string;
    status: MatchStatus;
    band: Band;
    teaser: unknown;
    /** The alias the recipient sees for the other user; null if the recipient isn't in the match. */
    counterpartAlias: string | null;
    counterpartStatus: UserStatus | null;
    counterpartLiveBand: Band | null;
  } | null;
}

export interface OutboxRepository {
  /**
   * Takes up to `limit` due rows and leases them: `attempts` goes up and `next_attempt_at` moves
   * `leaseMs` ahead, so a crashed sender's rows come back by themselves.
   */
  claimDue(now: Date, limit: number, leaseMs: number): Promise<ClaimedMessage[]>;
  sendContext(message: Pick<ClaimedMessage, 'userId' | 'matchId'>): Promise<SendContext>;
  markSent(id: string, now: Date): Promise<boolean>;
  /** Dropped without sending; `reason` records why (CLAUDE.md invariant 3). */
  cancel(id: string, reason: string): Promise<void>;
  /** Given up for good (e.g. the user blocked the bot). */
  fail(id: string, error: string): Promise<void>;
  retryAt(id: string, at: Date, error: string): Promise<void>;
}

interface ContextRow extends Record<string, unknown> {
  telegram_id: string | number;
  locale: Locale;
  status: UserStatus;
  bot_reachable: boolean;
  synthetic: boolean;
  timezone: string | null;
  live_band: Band | null;
  match_id: string | null;
  match_status: MatchStatus | null;
  match_band: Band | null;
  teaser: unknown;
  counterpart_alias: string | null;
  counterpart_status: UserStatus | null;
  counterpart_band: Band | null;
}

export function createOutboxRepository(db: Db): OutboxRepository {
  const stillPending = (id: string) => and(eq(outbox.id, id), eq(outbox.status, 'pending'));

  return {
    async claimDue(now, limit, leaseMs) {
      const nowIso = now.toISOString();
      const leaseUntil = new Date(now.getTime() + leaseMs).toISOString();
      const result = await db.execute<{
        id: string;
        user_id: string;
        kind: 'match_created';
        match_id: string | null;
        attempts: number;
      }>(sql`
        UPDATE outbox o
        SET attempts = o.attempts + 1, next_attempt_at = ${leaseUntil}::timestamptz
        WHERE o.id IN (
          SELECT id FROM outbox
          WHERE status = 'pending' AND next_attempt_at <= ${nowIso}::timestamptz
          ORDER BY next_attempt_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING o.id, o.user_id, o.kind, o.match_id, o.attempts`);
      return result.rows
        .map((r) => ({
          id: r.id,
          userId: r.user_id,
          kind: r.kind,
          matchId: r.match_id,
          attempts: r.attempts,
        }))
        .sort((a, b) => (a.id < b.id ? -1 : 1));
    },

    async sendContext({ userId, matchId }) {
      const result = await db.execute<ContextRow>(sql`
        SELECT r.telegram_id, r.locale, r.status, r.bot_reachable, r.synthetic, r.timezone,
          vc_band(r.birth_date, vc_today()) AS live_band,
          m.id AS match_id, m.status AS match_status, m.band AS match_band, m.teaser,
          CASE WHEN m.user_a_id = r.id THEN m.alias_b WHEN m.user_b_id = r.id THEN m.alias_a END
            AS counterpart_alias,
          c.status AS counterpart_status,
          vc_band(c.birth_date, vc_today()) AS counterpart_band
        FROM users r
        LEFT JOIN matches m ON m.id = ${matchId}::uuid
        LEFT JOIN users c ON c.id = CASE
          WHEN m.user_a_id = r.id THEN m.user_b_id
          WHEN m.user_b_id = r.id THEN m.user_a_id
        END
        WHERE r.id = ${userId}::uuid`);
      const row = result.rows[0];
      if (!row) return { recipient: null, match: null };
      return {
        recipient: {
          telegramId: Number(row.telegram_id),
          locale: row.locale,
          status: row.status,
          botReachable: row.bot_reachable,
          synthetic: row.synthetic,
          timezone: row.timezone,
          liveBand: row.live_band,
        },
        match:
          row.match_id && row.match_status && row.match_band
            ? {
                id: row.match_id,
                status: row.match_status,
                band: row.match_band,
                teaser: row.teaser,
                counterpartAlias: row.counterpart_alias,
                counterpartStatus: row.counterpart_status,
                counterpartLiveBand: row.counterpart_band,
              }
            : null,
      };
    },

    async markSent(id, now) {
      const rows = await db
        .update(outbox)
        .set({ status: 'sent', sentAt: now, lastError: null })
        .where(stillPending(id))
        .returning({ id: outbox.id });
      return rows.length > 0;
    },

    async cancel(id, reason) {
      await db
        .update(outbox)
        .set({ status: 'cancelled', cancelReason: reason })
        .where(stillPending(id));
    },

    async fail(id, error) {
      await db.update(outbox).set({ status: 'failed', lastError: error }).where(stillPending(id));
    },

    async retryAt(id, at, error) {
      await db.update(outbox).set({ nextAttemptAt: at, lastError: error }).where(stillPending(id));
    },
  };
}
