/**
 * Reports, blocks, filter hits and freezes (PLAN.md Phase 5).
 *
 * Safety: every read of a match starts from a participant, with the same scope as the matches
 * repository (the caller is in the match, it was not closed for a band change, both live bands
 * equal its band). The writes pass the triggers of migration 0014: a report is about the two
 * people of one match, and a block closes the pair's open match inside the database. A freeze is
 * a status change, so the state-change trigger of migration 0005 closes every open match of the
 * user and cancels their pending notifications in the same transaction (CLAUDE.md invariant 4).
 * The other person's Telegram ID and name never leave this module.
 */
import type { Band, Locale, MatchStatus } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../client';
import { pgErrorOf } from '../errors';
import { blocks, filterEvents, outbox, reports, users } from '../schema/index';
import type { FilterEventKind, ReportReason } from '../schema/safety';
import { READABLE_MATCH, readableBy } from './matches';
import { notificationKey } from './outbox';

/** A match from the side of one of its participants, with what a report or a block needs. */
export interface Participation {
  matchId: string;
  status: MatchStatus;
  band: Band;
  locale: Locale;
  counterpartId: string;
  /** How the other person appears to the caller, as a content alias ID. */
  counterpartAlias: string;
  counterpartStatus: UserStatus;
  /** From the other person's birth date right now. */
  counterpartLiveBand: Band | null;
}

/** One message of the evidence snapshot a report keeps (Q20). */
export interface EvidenceLine {
  /** Who wrote it: the person reported, or the one who reported them. */
  from: 'reporter' | 'reported';
  /** Null once the retention purge removed it. */
  text: string | null;
  verdict: 'delivered' | 'blocked_by_filter' | 'rejected';
  reason: string | null;
  /** ISO 8601. */
  at: string;
}

export interface SafetyRepository {
  /** Null if the match isn't the caller's or isn't readable. */
  participantOf(userId: string, matchId: string): Promise<Participation | null>;
  /** The latest messages of the match in both directions, oldest first. */
  evidence(matchId: string, reportedId: string, limit: number): Promise<EvidenceLine[]>;
  /** `reporterId` null is a system report. `duplicate`: this reporter reported this match before. */
  createReport(input: {
    id: string;
    reporterId: string | null;
    reportedId: string;
    matchId: string;
    reason: ReportReason;
    note: string | null;
    evidence: EvidenceLine[];
    now: Date;
  }): Promise<{ status: 'stored'; seq: number } | { status: 'duplicate' } | { status: 'refused' }>;
  /** People who reported `reportedId` since `since`, each counted once; dismissed reports don't count. */
  distinctReporters(reportedId: string, since: Date): Promise<number>;
  hasOpenSystemReport(reportedId: string, matchId: string): Promise<boolean>;
  recordFilterEvent(input: {
    userId: string;
    matchId: string | null;
    kind: FilterEventKind;
    now: Date;
  }): Promise<void>;
  /** Contact hits (everything but `non_text`) of one user since `since`. */
  contactHitsSince(userId: string, since: Date): Promise<number>;
  /**
   * One transaction: the block, which makes the database close the pair's open match with
   * `blocked` and cancel its pending notifications, and one neutral notice to the blocked person
   * when it is this block that ends the chat. `exists`: the pair was blocked in this direction
   * before.
   */
  block(input: {
    blockerId: string;
    blockedId: string;
    matchId: string;
    now: Date;
  }): Promise<'blocked' | 'exists' | 'refused'>;
  /**
   * Freezes an active account: the status change closes its open matches and cancels its pending
   * notifications (the trigger), and the one notice that says so is queued in the same
   * transaction. False if the account was not active.
   */
  freeze(userId: string, now: Date): Promise<boolean>;
  /** A frozen account is active again. Old matches stay closed. False if it was not frozen. */
  unfreeze(userId: string): Promise<boolean>;
}

const REPORT_REFUSED = 'SS050';
const BLOCK_REFUSED = 'SS060';
const REPORT_UNIQUE = 'reports_reporter_match_unique';

interface ParticipationRow extends Record<string, unknown> {
  id: string;
  status: MatchStatus;
  band: Band;
  locale: Locale;
  counterpart_id: string;
  counterpart_alias: string;
  counterpart_status: UserStatus;
  counterpart_band: Band | null;
}

interface EvidenceRow extends Record<string, unknown> {
  reported: boolean;
  body: string | null;
  verdict: EvidenceLine['verdict'];
  reason: string | null;
  at_ms: number;
}

export function createSafetyRepository(db: Db): SafetyRepository {
  return {
    async participantOf(userId, matchId) {
      const mine = sql`(m.user_a_id = ${userId}::uuid)`;
      const result = await db.execute<ParticipationRow>(sql`
        SELECT m.id, m.status, m.band, m.locale,
          CASE WHEN ${mine} THEN m.user_b_id ELSE m.user_a_id END AS counterpart_id,
          CASE WHEN ${mine} THEN m.alias_b ELSE m.alias_a END AS counterpart_alias,
          CASE WHEN ${mine} THEN ub.status ELSE ua.status END AS counterpart_status,
          CASE WHEN ${mine} THEN vc_band(ub.birth_date, vc_today()) ELSE vc_band(ua.birth_date, vc_today()) END
            AS counterpart_band
        FROM ${READABLE_MATCH}
        WHERE ${readableBy(userId)} AND m.id = ${matchId}::uuid`);
      const row = result.rows[0];
      if (!row) return null;
      return {
        matchId: row.id,
        status: row.status,
        band: row.band,
        locale: row.locale,
        counterpartId: row.counterpart_id,
        counterpartAlias: row.counterpart_alias,
        counterpartStatus: row.counterpart_status,
        counterpartLiveBand: row.counterpart_band,
      };
    },

    async evidence(matchId, reportedId, limit) {
      const result = await db.execute<EvidenceRow>(sql`
        SELECT sender_id = ${reportedId}::uuid AS reported, body, verdict, reason,
          (extract(epoch FROM created_at) * 1000)::float8 AS at_ms
        FROM (
          SELECT * FROM messages WHERE match_id = ${matchId}::uuid
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        ) latest
        ORDER BY created_at, id`);
      return result.rows.map((r) => ({
        from: r.reported ? 'reported' : 'reporter',
        text: r.body,
        verdict: r.verdict,
        reason: r.reason,
        at: new Date(r.at_ms).toISOString(),
      }));
    },

    async createReport({ id, reporterId, reportedId, matchId, reason, note, evidence, now }) {
      try {
        const [row] = await db
          .insert(reports)
          .values({ id, reporterId, reportedId, matchId, reason, note, evidence, createdAt: now })
          .returning({ seq: reports.seq });
        return row ? { status: 'stored', seq: row.seq } : { status: 'refused' };
      } catch (error) {
        const pgError = pgErrorOf(error);
        if (pgError?.code === '23505' && pgError.constraint === REPORT_UNIQUE) {
          return { status: 'duplicate' };
        }
        if (pgError?.code === REPORT_REFUSED) return { status: 'refused' };
        throw error;
      }
    },

    async distinctReporters(reportedId, since) {
      const result = await db.execute<{ n: number }>(sql`
        SELECT count(DISTINCT reporter_id)::int AS n FROM reports
        WHERE reported_id = ${reportedId}::uuid AND reporter_id IS NOT NULL
          AND status <> 'dismissed' AND created_at > ${since.toISOString()}::timestamptz`);
      return result.rows[0]?.n ?? 0;
    },

    async hasOpenSystemReport(reportedId, matchId) {
      const rows = await db
        .select({ id: reports.id })
        .from(reports)
        .where(
          and(
            eq(reports.reportedId, reportedId),
            eq(reports.matchId, matchId),
            sql`${reports.reporterId} IS NULL`,
            eq(reports.status, 'open'),
          ),
        )
        .limit(1);
      return rows.length > 0;
    },

    async recordFilterEvent({ userId, matchId, kind, now }) {
      await db.insert(filterEvents).values({ id: uuidv7(), userId, matchId, kind, createdAt: now });
    },

    async contactHitsSince(userId, since) {
      const result = await db.execute<{ n: number }>(sql`
        SELECT count(*)::int AS n FROM filter_events
        WHERE user_id = ${userId}::uuid AND kind <> 'non_text'
          AND created_at > ${since.toISOString()}::timestamptz`);
      return result.rows[0]?.n ?? 0;
    },

    async block({ blockerId, blockedId, matchId, now }) {
      try {
        const outcome = await db.transaction(async (tx) => {
          // Whether the chat is still going on: the trigger of the block closes it, and only
          // then is the blocked person told that it has ended. A match that had ended before
          // keeps its reason, and nobody is told anything new.
          const open = await tx.execute<{ open: boolean }>(sql`
            SELECT status IN ('pending_game', 'results_ready', 'active') AS open
            FROM matches WHERE id = ${matchId}::uuid FOR UPDATE`);
          const inserted = await tx
            .insert(blocks)
            .values({ blockerId, blockedId, matchId, createdAt: now })
            .onConflictDoNothing()
            .returning({ blockerId: blocks.blockerId });
          if (inserted.length === 0) return 'exists' as const;
          if (open.rows[0]?.open) {
            await tx
              .insert(outbox)
              .values({
                id: uuidv7(),
                userId: blockedId,
                kind: 'chat_ended',
                matchId,
                dedupeKey: notificationKey('chat_ended', matchId, blockedId),
                nextAttemptAt: now,
                createdAt: now,
              })
              .onConflictDoNothing({ target: outbox.dedupeKey });
          }
          return 'blocked' as const;
        });
        if (outcome === 'blocked') {
          // After the transaction, so that it never holds the match and a user row at once.
          await db
            .update(users)
            .set({ activeMatchId: null })
            .where(and(eq(users.id, blockerId), eq(users.activeMatchId, matchId)));
        }
        return outcome;
      } catch (error) {
        if (pgErrorOf(error)?.code === BLOCK_REFUSED) return 'refused';
        throw error;
      }
    },

    async freeze(userId, now) {
      return db.transaction(async (tx) => {
        const frozen = await tx
          .update(users)
          .set({ status: 'frozen' })
          .where(and(eq(users.id, userId), eq(users.status, 'active')))
          .returning({ id: users.id });
        if (frozen.length === 0) return false;
        // After the status change: the trigger has cancelled what was pending for the user, and
        // this one notice is what they still get.
        await tx.insert(outbox).values({
          id: uuidv7(),
          userId,
          kind: 'account_frozen',
          matchId: null,
          dedupeKey: `account_frozen:${userId}:${now.getTime()}`,
          nextAttemptAt: now,
          createdAt: now,
        });
        return true;
      });
    },

    async unfreeze(userId) {
      const rows = await db
        .update(users)
        .set({ status: 'active' })
        .where(and(eq(users.id, userId), eq(users.status, 'frozen')))
        .returning({ id: users.id });
      return rows.length > 0;
    },
  };
}
