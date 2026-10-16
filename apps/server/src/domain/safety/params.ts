/**
 * Tunable numbers of the safety tooling (PLAN.md Phase 5). Provisional unless a decided question
 * says otherwise (Q18, Q20), and passed in as data, like the chat and matching parameters.
 */
import type { Band } from '@samesync/shared';

export interface SafetyParams {
  /** Distinct reporters within the window that freeze an account, per band (Q18, provisional). */
  freezeReporters: Readonly<Record<Band, number>>;
  /** The window those reports are counted in, in days (Q18, provisional). */
  freezeWindowDays: number;
  /** Contact-filter hits of one user within `filterWindowHours` that create a system report. */
  filterHitsForReport: number;
  filterWindowHours: number;
  /** The filter also looks at this many earlier messages of the sender in the same chat. */
  filterRecentMessages: number;
  /** How many of the latest messages of a chat a report keeps as evidence. */
  evidenceMessages: number;
  /** Evidence is removed this long after the report was resolved (Q20, provisional). */
  evidenceRetentionDays: number;
  /** Support requests one user may send per hour. */
  supportPerHour: number;
}

export const DEFAULT_SAFETY_PARAMS: SafetyParams = {
  freezeReporters: { adult: 3, u18: 2 },
  freezeWindowDays: 30,
  filterHitsForReport: 3,
  filterWindowHours: 24,
  filterRecentMessages: 3,
  evidenceMessages: 20,
  evidenceRetentionDays: 90,
  supportPerHour: 5,
};
