import { BANDS, LOCALES, MATCH_CLOSE_REASONS, MATCH_STATUSES, MODES } from '@samesync/shared';
import { DOMAINS, POPULARITY } from '@samesync/content';
import { pgEnum } from 'drizzle-orm/pg-core';

export const localeEnum = pgEnum('locale', LOCALES);
export const bandEnum = pgEnum('band', BANDS);
export const modeEnum = pgEnum('mode', MODES);
export const answerValueEnum = pgEnum('answer_value', ['agree', 'disagree', 'skip']);
export const domainEnum = pgEnum('interest_domain', DOMAINS);
export const popularityEnum = pgEnum('popularity', POPULARITY);

/** Full status list from the PLAN.md §4 data model. */
export const userStatusEnum = pgEnum('user_status', [
  'onboarding',
  'active',
  'waitlisted',
  'ineligible',
  'frozen',
  'deleted',
]);

export const matchStatusEnum = pgEnum('match_status', MATCH_STATUSES);
export const matchCloseReasonEnum = pgEnum('match_close_reason', MATCH_CLOSE_REASONS);

export const outboxStatusEnum = pgEnum('outbox_status', ['pending', 'sent', 'failed', 'cancelled']);
/** One value per notification type; later phases add theirs. */
export const OUTBOX_KINDS = [
  'match_created',
  // Phase 3, the game: the other player finished first; both finished; one reminder before the
  // deadline; the game was not played in time.
  'game_turn',
  'game_results',
  'game_reminder',
  'game_expired',
] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];
export const outboxKindEnum = pgEnum('outbox_kind', OUTBOX_KINDS);
