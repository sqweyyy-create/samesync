/**
 * Matching tables (PLAN.md §4). Safety lives in the database: migration 0005 adds the triggers that
 * re-derive both users' bands from `birth_date` on every match insert, keep a match's identity
 * columns immutable, and close matches when a user's band changes or the user is frozen.
 */
import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  bandEnum,
  localeEnum,
  matchCloseReasonEnum,
  matchStatusEnum,
  modeEnum,
  outboxKindEnum,
  outboxStatusEnum,
} from './enums';
import { users } from './users';

const OPEN = sql`('pending_game', 'results_ready', 'active')`;

/** Rarity statistics per pool (band × locale), refreshed by every matching run. Never across bands. */
export const featureStats = pgTable(
  'feature_stats',
  {
    band: bandEnum('band').notNull(),
    locale: localeEnum('locale').notNull(),
    featureKey: text('feature_key').notNull(),
    nUsers: integer('n_users').notNull(),
    poolSize: integer('pool_size').notNull(),
    weight: doublePrecision('weight').notNull(),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.band, t.locale, t.featureKey] })],
);

/** One row per matching run, for audit and tuning. `slot` is the drop the run belongs to. */
export const matchRuns = pgTable(
  'match_runs',
  {
    id: uuid('id').primaryKey(),
    band: bandEnum('band').notNull(),
    locale: localeEnum('locale').notNull(),
    mode: modeEnum('mode').notNull(),
    slot: timestamp('slot', { withTimezone: true }).notNull(),
    seed: integer('seed').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    poolSize: integer('pool_size'),
    eligibleUsers: integer('eligible_users'),
    pairsCreated: integer('pairs_created').notNull().default(0),
    pairsRejected: integer('pairs_rejected').notNull().default(0),
    tierCounts: jsonb('tier_counts'),
  },
  (t) => [
    // A drop runs at most once per pool × mode: the key that makes reruns idempotent.
    unique('match_runs_slot_unique').on(t.band, t.locale, t.mode, t.slot),
    check('match_runs_mode_band', sql`${t.mode} = 'friends' OR ${t.band} = 'adult'`),
  ],
);

export const matches = pgTable(
  'matches',
  {
    id: uuid('id').primaryKey(),
    band: bandEnum('band').notNull(),
    locale: localeEnum('locale').notNull(),
    mode: modeEnum('mode').notNull(),
    userAId: uuid('user_a_id')
      .notNull()
      .references(() => users.id),
    userBId: uuid('user_b_id')
      .notNull()
      .references(() => users.id),
    runId: uuid('run_id').references(() => matchRuns.id),
    tier: smallint('tier').notNull(),
    score: doublePrecision('score').notNull(),
    /** Content IDs only; the text is rendered in the reader's locale. */
    teaser: jsonb('teaser').notNull(),
    /** Content alias IDs: how user A (B) appears to the other participant. */
    aliasA: text('alias_a').notNull(),
    aliasB: text('alias_b').notNull(),
    status: matchStatusEnum('status').notNull().default('pending_game'),
    closeReason: matchCloseReasonEnum('close_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    gameDeadlineAt: timestamp('game_deadline_at', { withTimezone: true }).notNull(),
    resultsReadyAt: timestamp('results_ready_at', { withTimezone: true }),
    chatDeadlineAt: timestamp('chat_deadline_at', { withTimezone: true }),
    firstMessageAt: timestamp('first_message_at', { withTimezone: true }),
    closedAt: timestamp('closed_at', { withTimezone: true }),
  },
  (t) => [
    check('matches_user_order', sql`${t.userAId} < ${t.userBId}`),
    // Q9: a pair is matched at most once, ever.
    unique('matches_pair_unique').on(t.userAId, t.userBId),
    check('matches_mode_band', sql`${t.mode} = 'friends' OR ${t.band} = 'adult'`),
    check('matches_tier_range', sql`${t.tier} BETWEEN 1 AND 3`),
    check('matches_aliases_differ', sql`${t.aliasA} <> ${t.aliasB}`),
    check(
      'matches_closed_fields',
      sql`(${t.status} IN ('expired', 'closed')) = (${t.closeReason} IS NOT NULL) AND (${t.status} IN ('expired', 'closed')) = (${t.closedAt} IS NOT NULL)`,
    ),
    check(
      'matches_expired_reason',
      sql`(${t.status} = 'expired') = coalesce(${t.closeReason} = 'expired', false)`,
    ),
    index('matches_user_b_idx').on(t.userBId),
    index('matches_open_a_idx')
      .on(t.userAId)
      .where(sql`${t.status} IN ${OPEN}`),
    index('matches_open_b_idx')
      .on(t.userBId)
      .where(sql`${t.status} IN ${OPEN}`),
  ],
);

/** Game shell: one row per match, created in the match transaction. Phase 3 adds the rest. */
export const games = pgTable('games', {
  matchId: uuid('match_id')
    .primaryKey()
    .references(() => matches.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Checked in both directions by the matches insert trigger. Written from Phase 5. */
export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id),
    matchId: uuid('match_id').references(() => matches.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    check('blocks_not_self', sql`${t.blockerId} <> ${t.blockedId}`),
    index('blocks_blocked_idx').on(t.blockedId),
  ],
);

/**
 * Pending bot messages. `payload` holds i18n keys and params, never rendered text; the sender
 * renders in the recipient's locale after re-checking safety (CLAUDE.md invariant 3).
 */
export const outbox = pgTable(
  'outbox',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    kind: outboxKindEnum('kind').notNull(),
    matchId: uuid('match_id').references(() => matches.id),
    payload: jsonb('payload').notNull().default({}),
    dedupeKey: text('dedupe_key').notNull().unique(),
    status: outboxStatusEnum('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** Why a row was dropped without sending (closed match, band mismatch, frozen user…). */
    cancelReason: text('cancel_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'outbox_cancel_reason',
      sql`(${t.status} = 'cancelled') = (${t.cancelReason} IS NOT NULL)`,
    ),
    check('outbox_sent_at', sql`(${t.status} = 'sent') = (${t.sentAt} IS NOT NULL)`),
    check('outbox_match_kind', sql`${t.kind} <> 'match_created' OR ${t.matchId} IS NOT NULL`),
    index('outbox_due_idx')
      .on(t.nextAttemptAt)
      .where(sql`${t.status} = 'pending'`),
    index('outbox_user_pending_idx')
      .on(t.userId)
      .where(sql`${t.status} = 'pending'`),
    index('outbox_match_idx').on(t.matchId),
  ],
);
