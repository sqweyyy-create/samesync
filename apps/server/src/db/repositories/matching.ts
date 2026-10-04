/**
 * Queries of a matching run. Every candidate query takes a PoolKey and filters by the band derived
 * from `birth_date` in SQL (PLAN.md §3 layer 4); the cached `age_band` only narrows the index scan.
 */
import { OPEN_MATCH_STATUSES, type Locale, type Mode } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { GameSelection } from '../../domain/game/select';
import type {
  FeatureStat,
  MatchCandidate,
  PlannedPair,
  PoolKey,
  Stance,
  Tier,
} from '../../domain/matching/types';
import type { Db } from '../client';
import { answers, featureStats, games, matchRuns, matches, outbox } from '../schema/index';

/**
 * Thrown inside `createMatch` when the two users' answers no longer make a game (they changed
 * since the pair was planned). The transaction is rolled back and the run skips the pair.
 */
export class GameNotPossibleError extends Error {
  override name = 'GameNotPossibleError';
  constructor() {
    super('the pair has no game: too few takes in common, or no disagreement');
  }
}

/** Picks a pair's game from both users' current answers (skips left out), or null. */
export type PickGame = (
  answersA: ReadonlyMap<string, Stance>,
  answersB: ReadonlyMap<string, Stance>,
) => GameSelection | null;

export interface RunRecord {
  id: string;
  seed: number;
  /** True when this drop already ran to the end: nothing more to do. */
  finished: boolean;
}

export interface RunSummary {
  poolSize: number;
  eligibleUsers: number;
  pairsCreated: number;
  pairsRejected: number;
  tierCounts: Record<Tier, number>;
}

export interface MatchingRepository {
  /**
   * Starts the run of one drop (`slot`) for a pool × mode, or returns the run that already exists
   * for it. An unfinished run (the process died midway) is picked up again with its seed.
   */
  beginRun(input: {
    pool: PoolKey;
    mode: Mode;
    slot: Date;
    seed: number;
    now: Date;
  }): Promise<RunRecord>;
  finishRun(runId: string, summary: RunSummary, now: Date): Promise<void>;
  /** Users who already got a match in this run (only non-empty when a run is resumed). */
  usersMatchedInRun(runId: string): Promise<string[]>;
  /** One page of the pool's active users with their profiles, ordered by ID. */
  loadPoolPage(
    pool: PoolKey,
    after: string | null,
    limit: number,
    now: Date,
  ): Promise<MatchCandidate[]>;
  /** Pairs among `userIds` that were matched before (Q9) or have a block in either direction. */
  loadExcludedPairs(userIds: readonly string[]): Promise<Array<[string, string]>>;
  saveFeatureStats(pool: PoolKey, stats: readonly FeatureStat[], now: Date): Promise<void>;
  /**
   * One transaction per pair: the match (checked by the insert trigger), its game and one
   * notification per user. Either all of it exists or none of it. The game is picked inside the
   * transaction from the answers both users have right then, and keeps them as a snapshot.
   * Throws `GameNotPossibleError` if `pickGame` finds no game.
   */
  createMatch(input: {
    runId: string;
    pool: PoolKey;
    mode: Mode;
    pair: PlannedPair;
    now: Date;
    gameDeadline: Date;
    pickGame: PickGame;
  }): Promise<string>;
}

interface PoolRow extends Record<string, unknown> {
  id: string;
  birth_date: string;
  locale: Locale;
  mode: Mode | null;
  status: UserStatus;
  bot_reachable: boolean;
  synthetic: boolean;
  last_active_at: number;
  waiting_since: number;
  gender: string | null;
  seeking: string[] | null;
  dating_age_min: number | null;
  dating_age_max: number | null;
  recent_matches: number;
  open_matches: number;
  aliases_in_use: string[];
  items: string[];
  answers: string[];
}

const OPEN = sql.join(
  OPEN_MATCH_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

/** Dedupe key of the "new match" notification: one per match and user, whatever is retried. */
export const matchCreatedKey = (matchId: string, userId: string) =>
  `match_created:${matchId}:${userId}`;

function toCandidate(row: PoolRow): MatchCandidate {
  return {
    id: row.id,
    birthDate: row.birth_date,
    locale: row.locale,
    mode: row.mode,
    status: row.status,
    botReachable: row.bot_reachable,
    synthetic: row.synthetic,
    lastActiveAt: row.last_active_at,
    waitingSince: row.waiting_since,
    gender: row.gender,
    seeking: row.seeking,
    datingAgeMin: row.dating_age_min,
    datingAgeMax: row.dating_age_max,
    recentMatches: row.recent_matches,
    openMatches: row.open_matches,
    aliasesInUse: row.aliases_in_use,
    items: row.items,
    answers: row.answers.map((entry) => {
      const cut = entry.lastIndexOf('=');
      return [entry.slice(0, cut), entry.slice(cut + 1) as Stance] as const;
    }),
  };
}

export function createMatchingRepository(db: Db): MatchingRepository {
  return {
    async beginRun({ pool, mode, slot, seed, now }) {
      const [created] = await db
        .insert(matchRuns)
        .values({
          id: uuidv7(),
          band: pool.band,
          locale: pool.locale,
          mode,
          slot,
          seed,
          startedAt: now,
        })
        .onConflictDoNothing({
          target: [matchRuns.band, matchRuns.locale, matchRuns.mode, matchRuns.slot],
        })
        .returning({ id: matchRuns.id, seed: matchRuns.seed });
      if (created) return { ...created, finished: false };
      const [existing] = await db
        .select({ id: matchRuns.id, seed: matchRuns.seed, finishedAt: matchRuns.finishedAt })
        .from(matchRuns)
        .where(
          and(
            eq(matchRuns.band, pool.band),
            eq(matchRuns.locale, pool.locale),
            eq(matchRuns.mode, mode),
            eq(matchRuns.slot, slot),
          ),
        );
      if (!existing) throw new Error('match run vanished between insert and select');
      return { id: existing.id, seed: existing.seed, finished: existing.finishedAt !== null };
    },

    async finishRun(runId, summary, now) {
      // Created pairs and tiers are counted from the matches themselves, so a run that was
      // interrupted and resumed still ends with the right totals.
      await db.execute(sql`
        UPDATE match_runs SET
          finished_at = ${now.toISOString()}::timestamptz,
          pool_size = ${summary.poolSize},
          eligible_users = ${summary.eligibleUsers},
          pairs_rejected = pairs_rejected + ${summary.pairsRejected},
          pairs_created = (SELECT count(*) FROM matches WHERE run_id = ${runId}::uuid),
          tier_counts = (
            SELECT coalesce(jsonb_object_agg(t.tier::text, t.n), '{}'::jsonb)
            FROM (
              SELECT tier, count(*) AS n FROM matches WHERE run_id = ${runId}::uuid GROUP BY tier
            ) t
          )
        WHERE id = ${runId}::uuid`);
    },

    async usersMatchedInRun(runId) {
      const rows = await db
        .select({ a: matches.userAId, b: matches.userBId })
        .from(matches)
        .where(eq(matches.runId, runId));
      return rows.flatMap((r) => [r.a, r.b]);
    },

    async loadPoolPage(pool, after, limit, now) {
      const nowIso = now.toISOString();
      const result = await db.execute<PoolRow>(sql`
        SELECT u.id, u.birth_date::text AS birth_date, u.locale, u.mode, u.status,
          u.bot_reachable, u.synthetic,
          (extract(epoch FROM u.last_active_at) * 1000)::float8 AS last_active_at,
          (extract(epoch FROM greatest(
            coalesce(u.onboarded_at, u.created_at),
            coalesce(ms.last_match_at, '-infinity'::timestamptz)
          )) * 1000)::float8 AS waiting_since,
          u.gender, u.seeking, u.dating_age_min, u.dating_age_max,
          coalesce(ms.recent, 0)::int AS recent_matches,
          coalesce(ms.open, 0)::int AS open_matches,
          coalesce(ms.aliases, '{}') AS aliases_in_use,
          coalesce(
            (SELECT array_agg(ui.item_id) FROM user_interests ui WHERE ui.user_id = u.id),
            '{}'
          ) AS items,
          coalesce(
            (SELECT array_agg(a.question_id || '=' || a.value::text)
               FROM answers a WHERE a.user_id = u.id AND a.value <> 'skip'),
            '{}'
          ) AS answers
        FROM users u
        LEFT JOIN LATERAL (
          SELECT max(m.created_at) AS last_match_at,
            count(*) FILTER (
              WHERE m.created_at > ${nowIso}::timestamptz - interval '24 hours'
            ) AS recent,
            count(*) FILTER (WHERE m.status IN (${OPEN})) AS open,
            array_agg(CASE WHEN m.user_a_id = u.id THEN m.alias_b ELSE m.alias_a END)
              FILTER (WHERE m.status IN (${OPEN})) AS aliases
          FROM matches m
          WHERE m.user_a_id = u.id OR m.user_b_id = u.id
        ) ms ON true
        WHERE u.status = 'active'
          AND u.locale = ${pool.locale}
          AND u.age_band = ${pool.band}
          -- The live band decides; the cached column above only lets the index narrow the scan.
          AND vc_band(u.birth_date, vc_today()) = ${pool.band}
          AND (${after}::uuid IS NULL OR u.id > ${after}::uuid)
        ORDER BY u.id
        LIMIT ${limit}`);
      return result.rows.map(toCandidate);
    },

    async loadExcludedPairs(userIds) {
      if (userIds.length < 2) return [];
      // One array parameter, however large the pool is.
      const ids = sql`${`{${userIds.join(',')}}`}::uuid[]`;
      const result = await db.execute<{ a: string; b: string }>(sql`
        SELECT user_a_id AS a, user_b_id AS b FROM matches
        WHERE user_a_id = ANY(${ids}) AND user_b_id = ANY(${ids})
        UNION ALL
        SELECT blocker_id, blocked_id FROM blocks
        WHERE blocker_id = ANY(${ids}) AND blocked_id = ANY(${ids})`);
      return result.rows.map((r) => [r.a, r.b]);
    },

    async saveFeatureStats(pool, stats, now) {
      if (stats.length === 0) return;
      const mine = and(eq(featureStats.band, pool.band), eq(featureStats.locale, pool.locale));
      await db.transaction(async (tx) => {
        // Replace only the keys of this run's scope: the other mode's run keeps its own.
        await tx.delete(featureStats).where(
          and(
            mine,
            inArray(
              featureStats.featureKey,
              stats.map((s) => s.key),
            ),
          ),
        );
        await tx.insert(featureStats).values(
          stats.map((s) => ({
            band: pool.band,
            locale: pool.locale,
            featureKey: s.key,
            nUsers: s.n,
            poolSize: s.total,
            weight: s.weight,
            computedAt: now,
          })),
        );
      });
    },

    async createMatch({ runId, pool, mode, pair, now, gameDeadline, pickGame }) {
      const matchId = uuidv7();
      await db.transaction(async (tx) => {
        await tx.insert(matches).values({
          id: matchId,
          band: pool.band,
          locale: pool.locale,
          mode,
          userAId: pair.userA,
          userBId: pair.userB,
          runId,
          tier: pair.tier,
          score: pair.score,
          teaser: pair.teaser,
          aliasA: pair.aliasA,
          aliasB: pair.aliasB,
          createdAt: now,
          gameDeadlineAt: gameDeadline,
        });
        const answered = await tx
          .select({ userId: answers.userId, questionId: answers.questionId, value: answers.value })
          .from(answers)
          .where(and(inArray(answers.userId, [pair.userA, pair.userB]), ne(answers.value, 'skip')));
        const of = (userId: string) =>
          new Map(
            answered
              .filter((row) => row.userId === userId)
              .map((row) => [row.questionId, row.value as Stance]),
          );
        const game = pickGame(of(pair.userA), of(pair.userB));
        if (!game) throw new GameNotPossibleError();
        await tx.insert(games).values({
          matchId,
          questionIds: game.questionIds,
          closingQuestionId: game.closingQuestionId,
          answersA: game.answersA,
          answersB: game.answersB,
          createdAt: now,
        });
        await tx.insert(outbox).values(
          [pair.userA, pair.userB].map((userId) => ({
            id: uuidv7(),
            userId,
            kind: 'match_created' as const,
            matchId,
            dedupeKey: matchCreatedKey(matchId, userId),
            nextAttemptAt: now,
            createdAt: now,
          })),
        );
      });
      return matchId;
    },
  };
}
