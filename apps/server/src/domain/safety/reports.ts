/**
 * Pure rules of reports and freezes (PLAN.md Phase 5, Q18).
 */
import type { Band } from '@samesync/shared';
import type { ReportReason } from '../../db/schema/safety';
import type { SafetyParams } from './params';

export { REPORT_REASONS, type ReportReason } from '../../db/schema/safety';

/** The chat button for each reason: short, so that a match ID still fits into 64 bytes. */
export const REPORT_ACTIONS = {
  rep_spam: 'spam',
  rep_harassment: 'harassment',
  rep_sexual: 'sexual',
  rep_age: 'age_misrepresentation',
  rep_contact: 'contact_sharing',
  rep_other: 'other',
} as const satisfies Record<string, ReportReason>;
export type ReportAction = keyof typeof REPORT_ACTIONS;

export const isReportAction = (action: string): action is ReportAction =>
  Object.hasOwn(REPORT_ACTIONS, action);

export const actionOfReason = (reason: ReportReason): ReportAction =>
  (Object.entries(REPORT_ACTIONS) as Array<[ReportAction, ReportReason]>).find(
    ([, r]) => r === reason,
  )![0];

/** How many distinct reporters freeze a user of `band`. An unknown band gets the strictest rule. */
export function freezeThreshold(band: Band | null, params: SafetyParams): number {
  return band === null ? params.freezeReporters.u18 : params.freezeReporters[band];
}

/** Whether `distinctReporters` reports within the window freeze a user of `band`. */
export const shouldFreeze = (
  distinctReporters: number,
  band: Band | null,
  params: SafetyParams,
): boolean => distinctReporters >= freezeThreshold(band, params);

/** Whether `hits` contact-filter hits within the window call for a system report. */
export const shouldEscalate = (hits: number, params: SafetyParams): boolean =>
  hits >= params.filterHitsForReport;

/** Reports from admins immediately, whatever the count (PLAN.md Phase 5). */
export const alertsAdminsAtOnce = (reason: ReportReason): boolean =>
  reason === 'age_misrepresentation';
