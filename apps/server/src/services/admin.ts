/**
 * What the admin commands do (PLAN.md Phase 5). The bot checks the allowlist before anything
 * here runs, and again on every button press; this service trusts the admin ID it is given and
 * writes an `admin_actions` row for every action, viewing a report's evidence included.
 * Admins get support codes, statuses, bands and counts: never a name, a username or a message
 * outside the evidence a report kept.
 */
import { birthDateProblem, utcDate } from '@samesync/shared';
import type { Clock } from '../clock';
import type {
  AdminRepository,
  AdminUserView,
  PoolStats,
  ReportDetails,
  ReportLine,
} from '../db/repositories/admin';
import type { ReportStatus } from '../db/schema/safety';
import type { Logger } from '../logger';
import type { SafetyService } from './safety';

const PUBLIC_ID = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const TELEGRAM_ID = /^\d{1,20}$/;

export type ResolveOutcome =
  | { status: 'resolved'; result: Exclude<ReportStatus, 'open'>; matchClosed: boolean }
  | { status: 'already'; current: ReportStatus }
  | { status: 'not_found' };

export type FreezeOutcome =
  | { status: 'frozen'; user: AdminUserView }
  | { status: 'not_active'; user: AdminUserView }
  | { status: 'not_found' };

export type UnfreezeOutcome =
  | { status: 'unfrozen'; user: AdminUserView }
  | { status: 'not_frozen'; user: AdminUserView }
  | { status: 'not_found' };

export type BirthDateOutcome =
  | { status: 'changed'; user: AdminUserView; before: AdminUserView }
  | { status: 'same'; user: AdminUserView }
  | { status: 'invalid'; user: AdminUserView }
  | { status: 'not_found' };

export interface AdminService {
  /** The user a command names: a support code, or a Telegram ID. */
  lookup(ref: string): Promise<AdminUserView | null>;
  reports(scope: 'open' | 'all'): Promise<ReportLine[]>;
  /** A report with its evidence. Looking at it is audited. */
  viewReport(seq: number, adminTelegramId: number): Promise<ReportDetails | null>;
  /** `action` also closes the reported match, if it is still open, and tells both people. */
  resolve(
    seq: number,
    verdict: 'dismiss' | 'action',
    note: string | null,
    adminTelegramId: number,
  ): Promise<ResolveOutcome>;
  freeze(ref: string, reason: string, adminTelegramId: number): Promise<FreezeOutcome>;
  unfreeze(ref: string, note: string | null, adminTelegramId: number): Promise<UnfreezeOutcome>;
  /** Only `admin_set_birth_date()` can change a birth date (CLAUDE.md invariant 7). */
  setBirthDate(
    ref: string,
    birthDate: string,
    reason: string,
    adminTelegramId: number,
  ): Promise<BirthDateOutcome>;
  stats(): Promise<PoolStats[]>;
  /** An answer to a support request; delivered by the outbox. */
  reply(
    ref: string,
    text: string,
    adminTelegramId: number,
  ): Promise<{ status: 'queued'; user: AdminUserView } | { status: 'not_found' }>;
}

export const REPORT_LIST_LIMIT = 20;

export function createAdminService(deps: {
  admin: AdminRepository;
  safety: Pick<SafetyService, 'freeze' | 'unfreeze'>;
  clock: Clock;
  logger: Logger;
}): AdminService {
  const { admin, safety, clock, logger } = deps;

  async function lookup(ref: string): Promise<AdminUserView | null> {
    const trimmed = ref.trim();
    const code = trimmed.toUpperCase();
    if (PUBLIC_ID.test(code)) {
      const user = await admin.userByPublicId(code);
      if (user) return user;
    }
    if (TELEGRAM_ID.test(trimmed)) return admin.userByTelegramId(Number(trimmed));
    return null;
  }

  return {
    lookup,
    reports: (scope) => admin.listReports(scope, REPORT_LIST_LIMIT),

    async viewReport(seq, adminTelegramId) {
      const report = await admin.reportBySeq(seq);
      if (!report) return null;
      await admin.audit({
        adminTelegramId,
        action: 'view_report',
        targetUserId: report.reportedId,
        after: { seq },
        reason: 'review',
      });
      return report;
    },

    async resolve(seq, verdict, note, adminTelegramId) {
      const report = await admin.reportBySeq(seq);
      if (!report) return { status: 'not_found' };
      const result = verdict === 'dismiss' ? 'dismissed' : 'actioned';
      const resolved = await admin.resolveReport(seq, result, adminTelegramId, clock.now());
      if (resolved.status !== 'resolved') return resolved;
      const matchClosed =
        verdict === 'action' ? await admin.closeReported(report.matchId, clock.now()) : false;
      await admin.audit({
        adminTelegramId,
        action: 'resolve_report',
        targetUserId: report.reportedId,
        before: { seq, status: 'open' },
        after: { seq, status: result, matchClosed },
        reason: note ?? verdict,
      });
      logger.info({ seq, result, matchClosed }, 'report resolved');
      return { status: 'resolved', result, matchClosed };
    },

    async freeze(ref, reason, adminTelegramId) {
      const user = await lookup(ref);
      if (!user) return { status: 'not_found' };
      const outcome = await safety.freeze(user.id, { admin: adminTelegramId }, reason);
      if (outcome === 'not_active') return { status: 'not_active', user };
      return { status: 'frozen', user: (await admin.userById(user.id)) ?? user };
    },

    async unfreeze(ref, note, adminTelegramId) {
      const user = await lookup(ref);
      if (!user) return { status: 'not_found' };
      const outcome = await safety.unfreeze(user.id, adminTelegramId, note ?? 'unfreeze');
      if (outcome === 'not_frozen') return { status: 'not_frozen', user };
      return { status: 'unfrozen', user: (await admin.userById(user.id)) ?? user };
    },

    async setBirthDate(ref, birthDate, reason, adminTelegramId) {
      const before = await lookup(ref);
      if (!before) return { status: 'not_found' };
      if (birthDateProblem(birthDate, utcDate(clock.now())))
        return { status: 'invalid', user: before };
      if (before.birthDate === birthDate) return { status: 'same', user: before };
      // The function writes the audit row itself, and the band change closes cross-band matches
      // in the same transaction (invariant 4).
      const outcome = await admin.setBirthDate(before.id, birthDate, adminTelegramId, reason);
      if (outcome === 'not_found') return { status: 'not_found' };
      if (outcome === 'invalid') return { status: 'invalid', user: before };
      logger.info({ userId: before.id }, 'birth date corrected by an admin');
      return { status: 'changed', user: (await admin.userById(before.id)) ?? before, before };
    },

    stats: () => admin.stats(),

    async reply(ref, text, adminTelegramId) {
      const user = await lookup(ref);
      if (!user) return { status: 'not_found' };
      await admin.queueSupportReply(user.id, text, clock.now());
      await admin.audit({
        adminTelegramId,
        action: 'support_reply',
        targetUserId: user.id,
        after: { length: [...text].length },
        reason: 'support',
      });
      return { status: 'queued', user };
    },
  };
}
