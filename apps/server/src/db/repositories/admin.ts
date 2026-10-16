/**
 * What the admin commands read and write (PLAN.md Phase 5). Admins see support codes, statuses,
 * bands and counts, never a name or a username; the messages of a chat only as the evidence a
 * report kept. Every write of an admin goes with a row of `admin_actions`, which is append-only
 * for the app role.
 */
import type { Band, Locale, Mode } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { and, eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../client';
import { pgErrorOf } from '../errors';
import { adminActions, outbox, reports } from '../schema/index';
import type { ReportReason, ReportStatus } from '../schema/safety';
import { notificationKey } from './outbox';
import type { EvidenceLine } from './safety';

export interface AdminUserView {
  id: string;
  publicId: string;
  telegramId: number;
  status: UserStatus;
  locale: Locale;
  mode: Mode | null;
  /** From the birth date right now. */
  liveBand: Band | null;
  birthDate: string | null;
  createdAt: Date;
  lastActiveAt: Date;
  frozenAt: Date | null;
  reportsAgainst: { open: number; total: number };
  reportsBy: number;
  openMatches: number;
  blocksMade: number;
}

export interface ReportLine {
  seq: number;
  reason: ReportReason;
  status: ReportStatus;
  reportedCode: string;
  /** Null for a system report. */
  reporterCode: string | null;
  createdAt: Date;
}

export interface ReportDetails extends ReportLine {
  id: string;
  matchId: string;
  reportedId: string;
  reportedBand: Band | null;
  note: string | null;
  /** Null once the retention purge removed it. */
  evidence: EvidenceLine[] | null;
}

export interface PoolStats {
  band: Band;
  locale: Locale;
  mode: Mode;
  active: number;
  openMatches: number;
  lastRun: {
    finishedAt: Date;
    pairsCreated: number;
    eligibleUsers: number;
    tierCounts: Record<string, number>;
  } | null;
}

export interface AuditEntry {
  adminTelegramId: number;
  action: string;
  targetUserId: string | null;
  before?: unknown;
  after?: unknown;
  reason: string;
}

export interface AdminRepository {
  userByPublicId(publicId: string): Promise<AdminUserView | null>;
  userByTelegramId(telegramId: number): Promise<AdminUserView | null>;
  userById(userId: string): Promise<AdminUserView | null>;
  listReports(scope: 'open' | 'all', limit: number): Promise<ReportLine[]>;
  reportBySeq(seq: number): Promise<ReportDetails | null>;
  /** Resolves an open report. The update trigger refuses a second resolution. */
  resolveReport(
    seq: number,
    status: Exclude<ReportStatus, 'open'>,
    adminTelegramId: number,
    now: Date,
  ): Promise<
    { status: 'resolved' } | { status: 'already'; current: ReportStatus } | { status: 'not_found' }
  >;
  /**
   * Closes a match an admin acted on (reason `reported`), cancels its pending notifications and
   * tells both people, neutrally, that the chat has ended. False if it was not open.
   */
  closeReported(matchId: string, now: Date): Promise<boolean>;
  audit(entry: AuditEntry): Promise<void>;
  /** admin_set_birth_date(), as the app role (migration 0014). */
  setBirthDate(
    userId: string,
    birthDate: string,
    adminTelegramId: number,
    reason: string,
  ): Promise<'changed' | 'invalid' | 'not_found'>;
  stats(): Promise<PoolStats[]>;
  /** An admin's answer to a support request, delivered by the outbox. */
  queueSupportReply(userId: string, text: string, now: Date): Promise<void>;
  /** user_delete_account(): false if there was nothing to delete. */
  deleteAccount(userId: string): Promise<boolean>;
  /** Removes the evidence of reports resolved before `before` (Q20). Returns how many. */
  purgeEvidence(before: Date, limit: number): Promise<number>;
}

interface UserRow extends Record<string, unknown> {
  id: string;
  public_id: string;
  telegram_id: string | number;
  status: UserStatus;
  locale: Locale;
  mode: Mode | null;
  live_band: Band | null;
  birth_date: string | null;
  created_at_ms: number;
  last_active_at_ms: number;
  frozen_at_ms: number | null;
  reports_open: number;
  reports_total: number;
  reports_by: number;
  open_matches: number;
  blocks_made: number;
}

interface ReportRow extends Record<string, unknown> {
  id: string;
  seq: string | number;
  reason: ReportReason;
  status: ReportStatus;
  match_id: string;
  reported_id: string;
  reported_code: string;
  reported_band: Band | null;
  reporter_code: string | null;
  note: string | null;
  evidence: EvidenceLine[] | null;
  created_at_ms: number;
}

const USER_COLUMNS = sql`
  u.id, u.public_id, u.telegram_id, u.status, u.locale, u.mode, u.birth_date::text AS birth_date,
  vc_band(u.birth_date, vc_today()) AS live_band,
  (extract(epoch FROM u.created_at) * 1000)::float8 AS created_at_ms,
  (extract(epoch FROM u.last_active_at) * 1000)::float8 AS last_active_at_ms,
  (extract(epoch FROM u.frozen_at) * 1000)::float8 AS frozen_at_ms,
  (SELECT count(*)::int FROM reports r WHERE r.reported_id = u.id AND r.status = 'open') AS reports_open,
  (SELECT count(*)::int FROM reports r WHERE r.reported_id = u.id) AS reports_total,
  (SELECT count(*)::int FROM reports r WHERE r.reporter_id = u.id) AS reports_by,
  (SELECT count(*)::int FROM matches m
     WHERE (m.user_a_id = u.id OR m.user_b_id = u.id)
       AND m.status IN ('pending_game', 'results_ready', 'active')) AS open_matches,
  (SELECT count(*)::int FROM blocks b WHERE b.blocker_id = u.id) AS blocks_made`;

const toUser = (r: UserRow): AdminUserView => ({
  id: r.id,
  publicId: r.public_id,
  telegramId: Number(r.telegram_id),
  status: r.status,
  locale: r.locale,
  mode: r.mode,
  liveBand: r.live_band,
  birthDate: r.birth_date,
  createdAt: new Date(r.created_at_ms),
  lastActiveAt: new Date(r.last_active_at_ms),
  frozenAt: r.frozen_at_ms === null ? null : new Date(r.frozen_at_ms),
  reportsAgainst: { open: r.reports_open, total: r.reports_total },
  reportsBy: r.reports_by,
  openMatches: r.open_matches,
  blocksMade: r.blocks_made,
});

const REPORT_COLUMNS = sql`
  r.id, r.seq, r.reason, r.status, r.match_id, r.reported_id, r.note, r.evidence,
  reported.public_id AS reported_code,
  vc_band(reported.birth_date, vc_today()) AS reported_band,
  reporter.public_id AS reporter_code,
  (extract(epoch FROM r.created_at) * 1000)::float8 AS created_at_ms
  FROM reports r
  JOIN users reported ON reported.id = r.reported_id
  LEFT JOIN users reporter ON reporter.id = r.reporter_id`;

const toLine = (r: ReportRow): ReportLine => ({
  seq: Number(r.seq),
  reason: r.reason,
  status: r.status,
  reportedCode: r.reported_code,
  reporterCode: r.reporter_code,
  createdAt: new Date(r.created_at_ms),
});

export function createAdminRepository(db: Db): AdminRepository {
  const selectUser = async (where: ReturnType<typeof sql>): Promise<AdminUserView | null> => {
    const result = await db.execute<UserRow>(
      sql`SELECT ${USER_COLUMNS} FROM users u WHERE ${where}`,
    );
    const row = result.rows[0];
    return row ? toUser(row) : null;
  };

  return {
    userByPublicId: (publicId) => selectUser(sql`u.public_id = ${publicId}`),
    userByTelegramId: (telegramId) => selectUser(sql`u.telegram_id = ${telegramId}`),
    userById: (userId) => selectUser(sql`u.id = ${userId}::uuid`),

    async listReports(scope, limit) {
      const result = await db.execute<ReportRow>(sql`
        SELECT ${REPORT_COLUMNS}
        WHERE ${scope === 'open' ? sql`r.status = 'open'` : sql`true`}
        ORDER BY r.created_at DESC, r.seq DESC
        LIMIT ${limit}`);
      return result.rows.map(toLine);
    },

    async reportBySeq(seq) {
      const result = await db.execute<ReportRow>(sql`
        SELECT ${REPORT_COLUMNS} WHERE r.seq = ${seq}`);
      const row = result.rows[0];
      if (!row) return null;
      return {
        ...toLine(row),
        id: row.id,
        matchId: row.match_id,
        reportedId: row.reported_id,
        reportedBand: row.reported_band,
        note: row.note,
        evidence: row.evidence,
      };
    },

    async resolveReport(seq, status, adminTelegramId, now) {
      const [current] = await db
        .select({ status: reports.status })
        .from(reports)
        .where(eq(reports.seq, seq));
      if (!current) return { status: 'not_found' };
      if (current.status !== 'open') return { status: 'already', current: current.status };
      const resolved = await db
        .update(reports)
        .set({ status, resolvedBy: adminTelegramId, resolvedAt: now })
        .where(and(eq(reports.seq, seq), eq(reports.status, 'open')))
        .returning({ status: reports.status });
      if (resolved.length === 0) {
        const [again] = await db
          .select({ status: reports.status })
          .from(reports)
          .where(eq(reports.seq, seq));
        return { status: 'already', current: again?.status ?? 'open' };
      }
      return { status: 'resolved' };
    },

    async closeReported(matchId, now) {
      return db.transaction(async (tx) => {
        const closed = await tx.execute<{ user_a_id: string; user_b_id: string }>(sql`
          UPDATE matches
          SET status = 'closed', close_reason = 'reported', closed_at = ${now.toISOString()}::timestamptz
          WHERE id = ${matchId}::uuid AND status IN ('pending_game', 'results_ready', 'active')
          RETURNING user_a_id, user_b_id`);
        const match = closed.rows[0];
        if (!match) return false;
        await tx
          .update(outbox)
          .set({ status: 'cancelled', cancelReason: 'reported' })
          .where(and(eq(outbox.matchId, matchId), eq(outbox.status, 'pending')));
        await tx
          .insert(outbox)
          .values(
            [match.user_a_id, match.user_b_id].map((userId) => ({
              id: uuidv7(),
              userId,
              kind: 'chat_ended' as const,
              matchId,
              dedupeKey: notificationKey('chat_ended', matchId, userId),
              nextAttemptAt: now,
              createdAt: now,
            })),
          )
          .onConflictDoNothing({ target: outbox.dedupeKey });
        return true;
      });
    },

    async audit(entry) {
      await db.insert(adminActions).values({
        adminTelegramId: entry.adminTelegramId,
        action: entry.action,
        targetUserId: entry.targetUserId,
        before: entry.before ?? null,
        after: entry.after ?? null,
        reason: entry.reason,
      });
    },

    async setBirthDate(userId, birthDate, adminTelegramId, reason) {
      try {
        await db.execute(
          sql`SELECT admin_set_birth_date(${userId}::uuid, ${birthDate}::date, ${adminTelegramId}, ${reason})`,
        );
        return 'changed';
      } catch (error) {
        const code = pgErrorOf(error)?.code;
        if (code === 'SS002') return 'invalid';
        if (code === 'SS003') return 'not_found';
        throw error;
      }
    },

    async stats() {
      const result = await db.execute<{
        band: Band;
        locale: Locale;
        mode: Mode;
        active: number;
        open_matches: number;
        finished_at_ms: number | null;
        pairs_created: number | null;
        eligible_users: number | null;
        tier_counts: Record<string, number> | null;
      }>(sql`
        WITH pools AS (
          SELECT b.band, l.locale, md.mode
          FROM unnest(enum_range(NULL::band)) AS b(band)
          CROSS JOIN unnest(enum_range(NULL::locale)) AS l(locale)
          CROSS JOIN unnest(enum_range(NULL::mode)) AS md(mode)
          WHERE md.mode = 'friends' OR b.band = 'adult'
        )
        SELECT p.band, p.locale, p.mode,
          (SELECT count(*)::int FROM users u
             WHERE u.status = 'active' AND u.locale = p.locale AND u.mode = p.mode
               AND vc_band(u.birth_date, vc_today()) = p.band) AS active,
          (SELECT count(*)::int FROM matches m
             WHERE m.band = p.band AND m.locale = p.locale AND m.mode = p.mode
               AND m.status IN ('pending_game', 'results_ready', 'active')) AS open_matches,
          (extract(epoch FROM run.finished_at) * 1000)::float8 AS finished_at_ms,
          run.pairs_created, run.eligible_users, run.tier_counts
        FROM pools p
        LEFT JOIN LATERAL (
          SELECT * FROM match_runs r
          WHERE r.band = p.band AND r.locale = p.locale AND r.mode = p.mode
            AND r.finished_at IS NOT NULL
          ORDER BY r.finished_at DESC LIMIT 1
        ) run ON true
        ORDER BY p.locale, p.band, p.mode`);
      return result.rows.map((r) => ({
        band: r.band,
        locale: r.locale,
        mode: r.mode,
        active: r.active,
        openMatches: r.open_matches,
        lastRun:
          r.finished_at_ms === null
            ? null
            : {
                finishedAt: new Date(r.finished_at_ms),
                pairsCreated: r.pairs_created ?? 0,
                eligibleUsers: r.eligible_users ?? 0,
                tierCounts: r.tier_counts ?? {},
              },
      }));
    },

    async queueSupportReply(userId, text, now) {
      const id = uuidv7();
      await db.insert(outbox).values({
        id,
        userId,
        kind: 'support_reply',
        matchId: null,
        payload: { text },
        dedupeKey: `support_reply:${id}`,
        nextAttemptAt: now,
        createdAt: now,
      });
    },

    async deleteAccount(userId) {
      const result = await db.execute<{ deleted: boolean }>(
        sql`SELECT user_delete_account(${userId}::uuid) AS deleted`,
      );
      return result.rows[0]?.deleted === true;
    },

    async purgeEvidence(before, limit) {
      const result = await db.execute<{ id: string }>(sql`
        UPDATE reports SET evidence = NULL
        WHERE id IN (
          SELECT id FROM reports
          WHERE evidence IS NOT NULL AND resolved_at IS NOT NULL
            AND resolved_at <= ${before.toISOString()}::timestamptz
          ORDER BY resolved_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id`);
      return result.rows.length;
    },
  };
}
