import { BANDS, LOCALES, MODES } from '@samesync/shared';
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
