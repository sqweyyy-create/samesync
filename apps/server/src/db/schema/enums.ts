import { BANDS, LOCALES, MATCH_CLOSE_REASONS, MATCH_STATUSES, MODES } from '@samesync/shared';
import { DOMAINS, POPULARITY } from '@samesync/content';
import { pgEnum } from 'drizzle-orm/pg-core';
import { NOTIFICATION_KINDS } from '../../domain/notifications';

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
/** One value per notification type (domain/notifications.ts). */
export const outboxKindEnum = pgEnum('outbox_kind', NOTIFICATION_KINDS);
