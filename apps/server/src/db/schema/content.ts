/**
 * Content metadata, seeded from content/ by `pnpm content:seed` (owner role). The app role can only
 * read these tables. Texts are not stored here: the server reads them from the content files.
 */
import { sql } from 'drizzle-orm';
import { check, integer, pgTable, real, text, timestamp } from 'drizzle-orm/pg-core';
import { bandEnum, domainEnum, localeEnum, modeEnum, popularityEnum } from './enums';

export const contentReleases = pgTable('content_releases', {
  version: text('version').primaryKey(),
  checksum: text('checksum').notNull(),
  appliedAt: timestamp('applied_at', { withTimezone: true }).notNull().defaultNow(),
});

const lifecycle = {
  revision: integer('revision').notNull(),
  /** The release in which this DB first saw the entry. */
  addedIn: text('added_in').notNull(),
  retiredIn: text('retired_in'),
};

export const questions = pgTable(
  'questions',
  {
    id: text('id').primaryKey(),
    audiences: bandEnum('audiences').array().notNull(),
    modes: modeEnum('modes').array().notNull(),
    locales: localeEnum('locales').array().notNull(),
    priorAgree: real('prior_agree').notNull(),
    ...lifecycle,
  },
  (t) => [check('questions_prior_agree_range', sql`${t.priorAgree} > 0 AND ${t.priorAgree} < 1`)],
);

export const interestCategories = pgTable('interest_categories', {
  id: text('id').primaryKey(),
  domain: domainEnum('domain').notNull(),
  audiences: bandEnum('audiences').array().notNull(),
  locales: localeEnum('locales').array().notNull(),
  ...lifecycle,
});

export const interestItems = pgTable('interest_items', {
  id: text('id').primaryKey(),
  categoryId: text('category_id')
    .notNull()
    .references(() => interestCategories.id),
  popularityPrior: popularityEnum('popularity_prior').notNull(),
  audiences: bandEnum('audiences').array().notNull(),
  locales: localeEnum('locales').array().notNull(),
  ...lifecycle,
});

/** Dating options (Q11): `users.gender` references these IDs. */
export const datingOptions = pgTable('dating_options', {
  id: text('id').primaryKey(),
  ...lifecycle,
});
