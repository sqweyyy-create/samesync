/**
 * Safety records (PLAN.md Phase 5): reports about a person in a match, and the hits of the u18
 * contact filter. Migration 0014 adds the triggers: a report is about the two people of one match,
 * never changes except for its resolution, and its evidence can only be removed (Q20).
 * Blocks live in matching.ts: they are checked by the match trigger since Phase 2 and written from
 * Phase 5, and the trigger of migration 0014 closes the pair's open match when one is inserted.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { matches } from './matching';
import { users } from './users';

export const REPORT_REASONS = [
  'spam',
  'harassment',
  'sexual',
  'age_misrepresentation',
  'contact_sharing',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const reportReasonEnum = pgEnum('report_reason', REPORT_REASONS);

export const REPORT_STATUSES = ['open', 'dismissed', 'actioned'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export const reportStatusEnum = pgEnum('report_status', REPORT_STATUSES);

/** What the contact filter found, or that something other than text was sent (u18 only). */
export const FILTER_EVENT_KINDS = [
  'url',
  'handle',
  'phone',
  'email',
  'social',
  'non_text',
] as const;
export type FilterEventKind = (typeof FILTER_EVENT_KINDS)[number];
export const filterEventKindEnum = pgEnum('filter_event_kind', FILTER_EVENT_KINDS);

/** The longest note a reporter may add. */
export const REPORT_NOTE_MAX_LENGTH = 500;

export const reports = pgTable(
  'reports',
  {
    id: uuid('id').primaryKey(),
    /** A short number for the admin commands (`/report_view 42`). */
    seq: bigint('seq', { mode: 'number' }).notNull().generatedAlwaysAsIdentity(),
    /** Null for a system report (the contact filter's escalation). */
    reporterId: uuid('reporter_id').references(() => users.id),
    reportedId: uuid('reported_id')
      .notNull()
      .references(() => users.id),
    matchId: uuid('match_id')
      .notNull()
      .references(() => matches.id),
    reason: reportReasonEnum('reason').notNull(),
    note: text('note'),
    /** A snapshot of the last messages of the match, in both directions. Null once purged (Q20). */
    evidence: jsonb('evidence'),
    status: reportStatusEnum('status').notNull().default('open'),
    /** The admin who resolved it (a Telegram ID). */
    resolvedBy: bigint('resolved_by', { mode: 'number' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One counted report per reporter per match. (NULL reporters are distinct: system reports.)
    unique('reports_reporter_match_unique').on(t.reporterId, t.reportedId, t.matchId),
    check('reports_not_self', sql`${t.reporterId} IS NULL OR ${t.reporterId} <> ${t.reportedId}`),
    check(
      'reports_resolution',
      sql`(${t.status} = 'open') = (${t.resolvedAt} IS NULL) AND (${t.status} = 'open') = (${t.resolvedBy} IS NULL)`,
    ),
    check(
      'reports_note_length',
      sql`${t.note} IS NULL OR char_length(${t.note}) BETWEEN 1 AND ${sql.raw(String(REPORT_NOTE_MAX_LENGTH))}`,
    ),
    index('reports_reported_idx').on(t.reportedId, t.createdAt),
    index('reports_open_idx')
      .on(t.createdAt)
      .where(sql`${t.status} = 'open'`),
    index('reports_match_idx').on(t.matchId),
  ],
);

/** One row per thing the u18 filter stopped: the counters that escalate to a system report. */
export const filterEvents = pgTable(
  'filter_events',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Null when the message had no chat yet (something other than text, refused before routing). */
    matchId: uuid('match_id').references(() => matches.id),
    kind: filterEventKindEnum('kind').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('filter_events_user_time_idx').on(t.userId, t.createdAt)],
);
