/**
 * One matching run for one pool × mode (PLAN.md Phase 2): take the pool's advisory lock, load the
 * pool, plan the pairs (in a worker thread), then create each match with its notifications in a
 * transaction of its own.
 *
 * Safety: the plan is only a proposal. Every match insert passes the database trigger, which
 * re-derives both users' bands from their birth dates, and a pair it rejects is skipped and
 * counted. A run for a drop (`slot`) happens once: a rerun does nothing, and a run that died
 * midway is resumed without giving anyone a second match.
 *
 * Every match gets its game in the same transaction (PLAN.md Phase 3): the questions are picked
 * from the answers both users have at that moment.
 */
import { utcDate, type Mode } from '@samesync/shared';
import type pg from 'pg';
import type { Clock } from '../clock';
import type { ContentStore } from '../content/store';
import { pgErrorOf } from '../db/errors';
import {
  GameNotPossibleError,
  type MatchingRepository,
  type RunSummary,
} from '../db/repositories/matching';
import { DEFAULT_GAME_PARAMS, type GameParams } from '../domain/game/params';
import { commonTakes, selectGame } from '../domain/game/select';
import { GAME_DEADLINE_HOURS, type MatchingParams } from '../domain/matching/params';
import { featureKey } from '../domain/matching/rarity';
import type { MatchCandidate, PoolKey, Tier } from '../domain/matching/types';
import { hashString } from '../domain/random';
import { LOCK, withAdvisoryLock } from '../jobs/advisory-lock';
import type { MatchPlanner } from '../jobs/matching-planner';
import type { Logger } from '../logger';

export interface MatchingServiceDeps {
  /** Holds the advisory lock for the length of a run. */
  pool: pg.Pool;
  repo: MatchingRepository;
  content: ContentStore;
  planner: MatchPlanner;
  clock: Clock;
  logger: Logger;
  params: MatchingParams;
  /** Defaults to `DEFAULT_GAME_PARAMS`. */
  game?: Pick<GameParams, 'questionCount'>;
  /** While false, u18 pools are never matched (CLAUDE.md invariant 12). */
  u18PoolEnabled: boolean;
  /** False in production: synthetic users are ignored entirely. */
  allowSynthetic: boolean;
  pageSize?: number;
}

export interface RunRequest {
  pool: PoolKey;
  mode: Mode;
  /** The drop this run belongs to; a manual run passes the current time. */
  slot: Date;
  /** Per-run overrides, for dev tooling only. */
  params?: Partial<MatchingParams>;
}

export type RunOutcome =
  | { status: 'disabled' }
  | { status: 'locked' }
  | { status: 'already_done'; runId: string }
  | ({ status: 'done'; runId: string } & RunSummary);

export interface MatchingService {
  run(request: RunRequest): Promise<RunOutcome>;
}

const HOUR = 3_600_000;
/**
 * Database refusals that concern one pair only: the insert trigger (SS010), a pair matched in the
 * meantime (unique), a broken constraint, or a deadlock with a concurrent user update. Anything
 * else aborts the run, which is then resumed on the next tick.
 */
const PAIR_LEVEL_ERRORS = new Set(['SS010', '23505', '23514', '40P01', '40001']);

export function createMatchingService(deps: MatchingServiceDeps): MatchingService {
  const { repo, content, planner, clock, logger } = deps;
  const pageSize = deps.pageSize ?? 500;
  const { questionCount } = deps.game ?? DEFAULT_GAME_PARAMS;
  // Matching guarantees `minCommonTakes` takes in common: a game can't need more than that.
  if (questionCount > deps.params.minCommonTakes) {
    throw new Error('a game has more questions than a matched pair is sure to have in common');
  }

  async function loadPool(poolKey: PoolKey, now: Date): Promise<MatchCandidate[]> {
    const users: MatchCandidate[] = [];
    for (let after: string | null = null; ;) {
      const page = await repo.loadPoolPage(poolKey, after, pageSize, now);
      users.push(...page);
      if (page.length < pageSize) return users;
      after = page[page.length - 1]!.id;
    }
  }

  async function runLocked({ pool, mode, slot, params }: RunRequest): Promise<RunOutcome> {
    const now = clock.now();
    const seed = hashString(`${pool.band}:${pool.locale}:${mode}:${slot.toISOString()}`) >>> 1;
    const run = await repo.beginRun({ pool, mode, slot, seed, now });
    if (run.finished) return { status: 'already_done', runId: run.id };

    const users = await loadPool(pool, now);
    const [excludedPairs, alreadyMatched] = await Promise.all([
      repo.loadExcludedPairs(users.map((u) => u.id)),
      repo.usersMatchedInRun(run.id),
    ]);
    const scope = content.matchScope({ ...pool, mode });
    const plan = await planner.plan({
      pool,
      mode,
      today: utcDate(now),
      now: now.getTime(),
      seed: run.seed,
      users,
      scope,
      excludedPairs,
      alreadyMatched,
      params: { ...deps.params, ...params },
      allowSynthetic: deps.allowSynthetic,
    });
    await repo.saveFeatureStats(pool, plan.stats, now);
    // How the pool is split on each take, for picking the most debatable closing question.
    const weights = new Map(plan.stats.map((stat) => [stat.key, stat.weight]));
    const agreeShare = (questionId: string) => {
      const weight = weights.get(featureKey.take(questionId, 'agree'));
      return weight === undefined ? undefined : Math.exp(-weight);
    };

    const tierCounts: Record<Tier, number> = { 1: 0, 2: 0, 3: 0 };
    let pairsCreated = 0;
    let pairsRejected = 0;
    const gameDeadline = new Date(now.getTime() + GAME_DEADLINE_HOURS * HOUR);
    for (const pair of plan.pairs) {
      try {
        await repo.createMatch({
          runId: run.id,
          pool,
          mode,
          pair,
          now,
          gameDeadline,
          pickGame: (a, b) =>
            selectGame(
              commonTakes(scope.takes, a, b, agreeShare),
              questionCount,
              hashString(`${run.seed}:${pair.userA}:${pair.userB}`),
            ),
        });
        pairsCreated++;
        tierCounts[pair.tier]++;
      } catch (error) {
        const pgError = pgErrorOf(error);
        const noGame = error instanceof GameNotPossibleError;
        if (!noGame && (!pgError || !PAIR_LEVEL_ERRORS.has(pgError.code))) throw error;
        pairsRejected++;
        // The trigger's message names the rule ("match rejected: band"); it holds no user data.
        logger.warn(
          noGame
            ? { runId: run.id, reason: 'no_game' }
            : { runId: run.id, code: pgError?.code, reason: pgError?.message },
          'planned pair was not created',
        );
      }
    }

    const summary: RunSummary = {
      poolSize: plan.poolSize,
      eligibleUsers: plan.eligibleUsers,
      pairsCreated,
      pairsRejected,
      tierCounts,
    };
    await repo.finishRun(run.id, summary, clock.now());
    logger.info({ runId: run.id, ...pool, mode, ...summary }, 'matching run finished');
    return { status: 'done', runId: run.id, ...summary };
  }

  return {
    async run(request) {
      const { pool, mode } = request;
      if (pool.band === 'u18' && mode !== 'friends') throw new Error('u18 pools are friends-only');
      if (pool.band === 'u18' && !deps.u18PoolEnabled) return { status: 'disabled' };
      const locked = await withAdvisoryLock(deps.pool, LOCK.matching(pool, mode), () =>
        runLocked(request),
      );
      return locked.acquired ? locked.value : { status: 'locked' };
    },
  };
}
