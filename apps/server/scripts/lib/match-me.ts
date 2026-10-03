/**
 * `pnpm dev:match-me`: gives one real development user a match. It adds synthetic users to the
 * user's pool (fillers, so rarity statistics look like a real pool, plus a few lookalikes who share
 * the user's rarest interests and most answers) and runs one matching run for that pool × mode.
 * The run itself is the real service: the database trigger still decides on every pair.
 */
import type { Band, Locale, Mode } from '@samesync/shared';
import { utcDate } from '@samesync/shared';
import type { AnswerValue, UserStatus } from '@samesync/shared/api';
import { translatorFor } from '@samesync/shared/i18n/static';
import type pg from 'pg';
import { localized, type ContentStore } from '../../src/content/store';
import type { MatchingRepository } from '../../src/db/repositories/matching';
import type { MatchingParams } from '../../src/domain/matching/params';
import { userIneligibility } from '../../src/domain/matching/plan';
import { parseTeaser, renderTeaser } from '../../src/domain/matching/teaser';
import type { Ineligibility } from '../../src/domain/matching/types';
import type { MatchingService, RunOutcome } from '../../src/services/matching';
import {
  generateLookalikes,
  generateProfiles,
  insertSyntheticUsers,
  type CompatibleWith,
} from './synthetic';

export interface MatchMeOptions {
  publicId: string;
  /** Synthetic users the pool × mode should have at least (fillers are added up to this). */
  poolSize: number;
  lookalikes: number;
  /** Lift the free-tier limits for this one run. */
  ignoreLimits: boolean;
  /** Keep the real waiting thresholds for tiers 2 and 3 (by default any tier may match now). */
  strict: boolean;
  seed: number;
}

export type MatchMeResult =
  | { status: 'user_not_found' }
  | { status: 'user_not_ready'; reason: string }
  | {
      status: 'matched' | 'not_matched';
      pool: { band: Band; locale: Locale };
      mode: Mode;
      userId: string;
      added: { fillers: number; lookalikes: number };
      run: RunOutcome;
      /** Why the user was skipped by the run, when that is the case. */
      ineligible: Ineligibility | null;
      match: { id: string; tier: number; alias: string; teaser: string } | null;
    };

interface UserRow {
  id: string;
  locale: Locale;
  mode: Mode | null;
  status: UserStatus;
  synthetic: boolean;
  birth_date: string | null;
  band: Band | null;
  gender: string | null;
  seeking: string[] | null;
  dating_age_min: number | null;
  dating_age_max: number | null;
}

export async function matchMe(
  deps: {
    /** App-role connection: the same privileges the server has. */
    db: pg.Pool;
    content: ContentStore;
    matching: MatchingService;
    repo: MatchingRepository;
    params: MatchingParams;
    now: Date;
  },
  options: MatchMeOptions,
): Promise<MatchMeResult> {
  const { db, content, now } = deps;
  const found = await db.query<UserRow>(
    `SELECT id, locale, mode, status, synthetic, birth_date::text AS birth_date,
       vc_band(birth_date, vc_today()) AS band, gender, seeking, dating_age_min, dating_age_max
     FROM users WHERE public_id = $1`,
    [options.publicId],
  );
  const user = found.rows[0];
  if (!user) return { status: 'user_not_found' };
  if (user.synthetic) return { status: 'user_not_ready', reason: 'this is a synthetic user' };
  if (user.status !== 'active' || !user.band || !user.mode || !user.birth_date) {
    return {
      status: 'user_not_ready',
      reason: `the account is "${user.status}", not active: finish onboarding in the Mini App first`,
    };
  }
  const pool = { band: user.band, locale: user.locale };
  const mode = user.mode;
  const scope = content.matchScope({ ...pool, mode });

  const [items, answers, existing] = await Promise.all([
    db.query<{ item_id: string }>('SELECT item_id FROM user_interests WHERE user_id = $1', [
      user.id,
    ]),
    db.query<{ question_id: string; value: AnswerValue }>(
      'SELECT question_id, value FROM answers WHERE user_id = $1',
      [user.id],
    ),
    db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM users
       WHERE synthetic AND status = 'active' AND locale = $1 AND mode = $2 AND age_band = $3`,
      [pool.locale, mode, pool.band],
    ),
  ]);

  const compatibleWith: CompatibleWith = {
    birthDate: user.birth_date,
    gender: user.gender,
    seeking: user.seeking,
    datingAge:
      user.dating_age_min !== null && user.dating_age_max !== null
        ? { min: user.dating_age_min, max: user.dating_age_max }
        : null,
  };
  const generate = { pool, mode, now, compatibleWith };
  const fillers = generateProfiles(scope, {
    ...generate,
    n: Math.max(0, options.poolSize - (existing.rows[0]?.n ?? 0)),
    seed: options.seed,
  });
  const lookalikes = generateLookalikes(
    scope,
    { ...generate, n: options.lookalikes, seed: options.seed + 1 },
    {
      items: items.rows.map((r) => r.item_id),
      answers: answers.rows.map((r) => [r.question_id, r.value] as const),
    },
  );
  await insertSyntheticUsers(db, pool, mode, [...fillers, ...lookalikes], now);

  const params = {
    ...(options.strict ? {} : { tier2AfterHours: 0, tier3AfterHours: 0 }),
    ...(options.ignoreLimits ? { dailyLimit: 1_000_000, openLimit: 1_000_000 } : {}),
  };
  const run = await deps.matching.run({ pool, mode, slot: now, params });

  const base = {
    pool,
    mode,
    userId: user.id,
    added: { fillers: fillers.length, lookalikes: lookalikes.length },
    run,
  };
  if (run.status !== 'done')
    return { status: 'not_matched', ...base, ineligible: null, match: null };

  const created = await db.query<{ id: string; tier: number; teaser: unknown; alias: string }>(
    `SELECT id, tier, teaser, CASE WHEN user_a_id = $2 THEN alias_b ELSE alias_a END AS alias
     FROM matches WHERE run_id = $1 AND (user_a_id = $2 OR user_b_id = $2)`,
    [run.runId, user.id],
  );
  const row = created.rows[0];
  if (row) {
    const alias = content.alias(row.alias);
    return {
      status: 'matched',
      ...base,
      ineligible: null,
      match: {
        id: row.id,
        tier: row.tier,
        alias: alias ? `${alias.emoji} ${localized(alias.text, user.locale)}` : row.alias,
        teaser: renderTeaser(
          parseTeaser(row.teaser),
          user.locale,
          content.teaser,
          translatorFor(user.locale).t,
        ),
      },
    };
  }

  // Not matched: say whether the run skipped the user, and why.
  let ineligible: Ineligibility | null = null;
  for (let after: string | null = null; ;) {
    const page = await deps.repo.loadPoolPage(pool, after, 500, now);
    const me = page.find((candidate) => candidate.id === user.id);
    if (me) {
      ineligible = userIneligibility(me, {
        pool,
        mode,
        today: utcDate(now),
        now: now.getTime(),
        params: { ...deps.params, ...params },
        allowSynthetic: true,
      });
      break;
    }
    if (page.length < 500) break;
    after = page[page.length - 1]!.id;
  }
  return { status: 'not_matched', ...base, ineligible, match: null };
}

/** What to tell the developer for each reason a user was skipped. */
export const INELIGIBLE_HINT: Record<Ineligibility, string> = {
  not_active: 'the account is not active',
  other_pool: 'the account is not in this pool',
  other_mode: 'the account is in another mode',
  synthetic: 'synthetic users are ignored here',
  unreachable:
    'the bot cannot message this user (bot_reachable is false): send /start to the bot first',
  inactive: 'the Mini App was not opened for more than 14 days: open it once',
  daily_limit: 'the daily limit of new matches is reached: add --ignore-limits',
  open_limit: 'the limit of open matches is reached: add --ignore-limits',
  already_matched: 'already matched in this run',
  incomplete_dating_profile: 'the dating profile is incomplete: save the mode again in settings',
  empty_profile: 'the profile has no answers or interests in this pool',
};
