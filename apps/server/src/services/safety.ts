/**
 * Reports, blocks and freezes (PLAN.md Phase 5).
 *
 * Safety:
 * - A report or a block is only ever about the other person of a match the caller is in, read
 *   through the participant scope; the database checks that again (migration 0014).
 * - A block ends the chat inside the database and the pair is never matched again (Q9); the
 *   blocked person gets the same neutral notice as after any ending, never who or why.
 * - Enough distinct reporters within the window freeze the reported account at once (Q18): the
 *   status change closes their matches and cancels their notifications in the same transaction
 *   (CLAUDE.md invariant 4), the relay and the APIs refuse them (invariant 9), and only an admin
 *   can undo it. Every freeze is audited, with the bot itself as the actor of an automatic one.
 * - Admins are told at once about a report of age misrepresentation and about every automatic
 *   freeze; they see support codes, never names.
 * - Nothing here logs a note, a message or a name: IDs and counts only.
 */
import type { Band } from '@samesync/shared';
import type { MatchSummary, ReportRequest, ReportResponse } from '@samesync/shared/api';
import { v7 as uuidv7 } from 'uuid';
import type { Clock } from '../clock';
import type { ContentStore } from '../content/store';
import type { AdminRepository } from '../db/repositories/admin';
import type { MatchesRepository } from '../db/repositories/matches';
import type { SafetyRepository } from '../db/repositories/safety';
import type { UsersRepository } from '../db/repositories/users';
import type { FilterEventKind, ReportReason } from '../db/schema/safety';
import type { SafetyParams } from '../domain/safety/params';
import { alertsAdminsAtOnce, shouldEscalate, shouldFreeze } from '../domain/safety/reports';
import type { ValidatedInitData } from '../http/auth/init-data';
import type { Logger } from '../logger';
import type { AdminNotifier } from './admin-alerts';
import { loadCurrentUser } from './current-user';
import { ServiceError } from './errors';
import { UUID, presentMatch } from './matches';

export type ReportOutcome =
  /** Stored. `frozen`: this report tipped the reported person into an automatic freeze. */
  | { status: 'stored'; alias: string; frozen: boolean }
  /** This person reported this match before: nothing new is counted. */
  | { status: 'duplicate'; alias: string }
  /** Not the caller's match, or not readable. */
  | { status: 'unavailable' };

export type BlockOutcome =
  | { status: 'blocked'; alias: string }
  | { status: 'already'; alias: string }
  | { status: 'unavailable' };

/** Who freezes or unfreezes: an admin by Telegram ID, or the system (a report threshold). */
export type Actor = { admin: number } | { system: true };

export interface SafetyService {
  /** The other person of one of the caller's matches, as an alias; null if there is none. */
  counterpart(userId: string, matchId: string): Promise<{ alias: string } | null>;
  report(input: {
    reporterId: string;
    matchId: string;
    reason: ReportReason;
    note?: string | null;
  }): Promise<ReportOutcome>;
  block(input: { blockerId: string; matchId: string }): Promise<BlockOutcome>;
  /** The relay reports a hit of the u18 filter: counted, and escalated to a system report. */
  filterHit(input: {
    userId: string;
    matchId: string | null;
    kind: FilterEventKind;
  }): Promise<void>;
  freeze(userId: string, by: Actor, reason: string): Promise<'frozen' | 'not_active'>;
  unfreeze(
    userId: string,
    adminTelegramId: number,
    reason: string,
  ): Promise<'unfrozen' | 'not_frozen'>;
  /** `POST /api/matches/:id/report`. */
  reportFromApp(
    auth: ValidatedInitData,
    matchId: string,
    request: ReportRequest,
  ): Promise<ReportResponse>;
  /** `POST /api/matches/:id/block`: answers with the match as it is afterwards. */
  blockFromApp(auth: ValidatedInitData, matchId: string): Promise<MatchSummary>;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

export function createSafetyService(deps: {
  safety: SafetyRepository;
  admin: AdminRepository;
  users: UsersRepository;
  matches: MatchesRepository;
  content: ContentStore;
  notifier: AdminNotifier;
  clock: Clock;
  logger: Logger;
  params: SafetyParams;
  /** The Telegram ID the audit names for an automatic freeze: the bot's own. */
  systemActorId: () => number;
}): SafetyService {
  const { safety, admin, notifier, clock, logger, params } = deps;

  async function freeze(userId: string, by: Actor, reason: string) {
    const frozen = await safety.freeze(userId, clock.now());
    if (!frozen) return 'not_active' as const;
    await admin.audit({
      adminTelegramId: 'admin' in by ? by.admin : deps.systemActorId(),
      action: 'admin' in by ? 'freeze' : 'auto_freeze',
      targetUserId: userId,
      before: { status: 'active' },
      after: { status: 'frozen' },
      reason,
    });
    logger.info({ userId, by: 'admin' in by ? 'admin' : 'system' }, 'account frozen');
    return 'frozen' as const;
  }

  /** Freezes the reported person when enough different people reported them (Q18). */
  async function freezeIfReported(reportedId: string, band: Band | null): Promise<boolean> {
    const now = clock.now();
    const since = new Date(now.getTime() - params.freezeWindowDays * DAY);
    const distinct = await safety.distinctReporters(reportedId, since);
    if (!shouldFreeze(distinct, band, params)) return false;
    const outcome = await freeze(
      reportedId,
      { system: true },
      `${distinct} reports from distinct users in ${params.freezeWindowDays} days`,
    );
    if (outcome !== 'frozen') return false;
    const user = await admin.userById(reportedId);
    if (user) {
      await notifier.notify((t) =>
        t('admin.alert.frozen', {
          code: user.publicId,
          count: distinct,
          days: params.freezeWindowDays,
        }),
      );
    }
    return true;
  }

  return {
    async counterpart(userId, matchId) {
      const p = await safety.participantOf(userId, matchId);
      return p ? { alias: p.counterpartAlias } : null;
    },

    async report({ reporterId, matchId, reason, note }) {
      const p = await safety.participantOf(reporterId, matchId);
      if (!p) return { status: 'unavailable' };
      const now = clock.now();
      const evidence = await safety.evidence(matchId, p.counterpartId, params.evidenceMessages);
      const stored = await safety.createReport({
        id: uuidv7(),
        reporterId,
        reportedId: p.counterpartId,
        matchId,
        reason,
        note: note?.trim() ? note.trim() : null,
        evidence,
        now,
      });
      if (stored.status === 'duplicate') return { status: 'duplicate', alias: p.counterpartAlias };
      if (stored.status === 'refused') {
        logger.warn({ reporterId, matchId }, 'report refused by the db');
        return { status: 'unavailable' };
      }
      logger.info({ seq: stored.seq, matchId, reason }, 'report stored');
      if (alertsAdminsAtOnce(reason)) {
        const line = await admin.reportBySeq(stored.seq);
        if (line) {
          await notifier.notify((t) =>
            t('admin.alert.report', {
              seq: line.seq,
              reason: t(`report.reason.${reason}`),
              reported: line.reportedCode,
              band: t(line.reportedBand ? `admin.band.${line.reportedBand}` : 'admin.band.none'),
              reporter: line.reporterCode ?? t('admin.reports.system'),
            }),
          );
        }
      }
      const frozen = await freezeIfReported(p.counterpartId, p.counterpartLiveBand);
      return { status: 'stored', alias: p.counterpartAlias, frozen };
    },

    async block({ blockerId, matchId }) {
      const p = await safety.participantOf(blockerId, matchId);
      if (!p) return { status: 'unavailable' };
      const outcome = await safety.block({
        blockerId,
        blockedId: p.counterpartId,
        matchId,
        now: clock.now(),
      });
      if (outcome === 'refused') {
        logger.warn({ blockerId, matchId }, 'block refused by the db');
        return { status: 'unavailable' };
      }
      if (outcome === 'exists') return { status: 'already', alias: p.counterpartAlias };
      logger.info({ blockerId, matchId }, 'user blocked');
      return { status: 'blocked', alias: p.counterpartAlias };
    },

    async filterHit({ userId, matchId, kind }) {
      const now = clock.now();
      await safety.recordFilterEvent({ userId, matchId, kind, now });
      if (kind === 'non_text' || matchId === null) return;
      const since = new Date(now.getTime() - params.filterWindowHours * HOUR);
      const hits = await safety.contactHitsSince(userId, since);
      if (!shouldEscalate(hits, params)) return;
      if (await safety.hasOpenSystemReport(userId, matchId)) return;
      const evidence = await safety.evidence(matchId, userId, params.evidenceMessages);
      const stored = await safety.createReport({
        id: uuidv7(),
        reporterId: null,
        reportedId: userId,
        matchId,
        reason: 'contact_sharing',
        note: null,
        evidence,
        now,
      });
      if (stored.status === 'stored') {
        logger.info({ seq: stored.seq, userId, matchId, hits }, 'system report stored');
      }
    },

    freeze,

    async unfreeze(userId, adminTelegramId, reason) {
      if (!(await safety.unfreeze(userId))) return 'not_frozen';
      await admin.audit({
        adminTelegramId,
        action: 'unfreeze',
        targetUserId: userId,
        before: { status: 'frozen' },
        after: { status: 'active' },
        reason,
      });
      logger.info({ userId }, 'account unfrozen');
      return 'unfrozen';
    },

    async reportFromApp(auth, matchId, request) {
      const user = await loadCurrentUser(deps, auth);
      if (user.status === 'frozen' || user.status === 'deleted')
        throw new ServiceError('forbidden');
      if (!UUID.test(matchId)) throw new ServiceError('not_found');
      const outcome = await this.report({
        reporterId: user.id,
        matchId,
        reason: request.reason,
        note: request.note ?? null,
      });
      if (outcome.status === 'unavailable') throw new ServiceError('not_found');
      return { status: outcome.status };
    },

    async blockFromApp(auth, matchId) {
      const user = await loadCurrentUser(deps, auth);
      if (user.status === 'frozen' || user.status === 'deleted')
        throw new ServiceError('forbidden');
      if (!UUID.test(matchId)) throw new ServiceError('not_found');
      const outcome = await this.block({ blockerId: user.id, matchId });
      if (outcome.status === 'unavailable') throw new ServiceError('not_found');
      const view = await deps.matches.getForParticipant(user.id, matchId);
      if (!view) throw new ServiceError('not_found');
      return presentMatch(view, user.locale, deps.content);
    },
  };
}
