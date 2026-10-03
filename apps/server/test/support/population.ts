/** People with real profiles (answers and interests from the seeded content) for matching tests. */
import type { AnswerValue } from '@samesync/shared/api';
import type pg from 'pg';
import { systemClock, type Clock } from '../../src/clock';
import { createMatchingRepository } from '../../src/db/repositories/matching';
import { DEFAULT_MATCHING_PARAMS, type MatchingParams } from '../../src/domain/matching/params';
import type { PoolScope } from '../../src/domain/matching/types';
import { inProcessPlanner, type MatchPlanner } from '../../src/jobs/matching-planner';
import type { Logger } from '../../src/logger';
import { createMatchingService, type MatchingServiceDeps } from '../../src/services/matching';
import { realContent } from './app';
import type { TestDatabase } from './db';
import { memoryLogger } from './fixtures';
import { insertActiveUser } from './matches';
import { birthDateYearsAgo, type InsertUser } from './users';

export const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000);

/** The real catalog and deck of a pool × mode (adult, ru, friends unless said otherwise). */
export async function realScope(
  over: Partial<{ band: 'u18' | 'adult'; locale: 'ru' | 'en'; mode: 'friends' | 'dating' }> = {},
): Promise<PoolScope> {
  return (await realContent()).matchScope({
    band: 'adult',
    locale: 'ru',
    mode: 'friends',
    ...over,
  });
}

/** Items of one curator popularity, e.g. the niche ones that make a tier 1 match. */
export const itemsOf = (scope: PoolScope, popularity: 'niche' | 'known' | 'mainstream') =>
  scope.items.filter((i) => i.popularity === popularity).map((i) => i.id);

/**
 * Answers to the first takes of `scope`, one character each: `A` agree, `D` disagree, `S` skip,
 * `-` not answered.
 */
export function answersFor(scope: PoolScope, pattern: string): Array<[string, AnswerValue]> {
  const values = { A: 'agree', D: 'disagree', S: 'skip' } as const;
  return [...pattern].flatMap((char, i): Array<[string, AnswerValue]> => {
    const take = scope.takes[i];
    if (!take) throw new Error('pattern is longer than the deck');
    return char in values ? [[take.id, values[char as keyof typeof values]]] : [];
  });
}

export interface PersonInput extends InsertUser {
  items?: readonly string[];
  answers?: ReadonlyArray<readonly [string, AnswerValue]>;
}

/** An active, onboarded user (adult, ru, friends by default) with interests and answers. */
export async function insertPerson(
  pool: pg.Pool,
  { items = [], answers = [], ...user }: PersonInput = {},
): Promise<{ id: string; telegramId: number }> {
  const person = await insertActiveUser(pool, { birthDate: birthDateYearsAgo(25), ...user });
  if (items.length > 0) {
    await pool.query(
      'INSERT INTO user_interests (user_id, item_id, added_at) SELECT $1, unnest($2::text[]), now()',
      [person.id, items],
    );
  }
  if (answers.length > 0) {
    await pool.query(
      `INSERT INTO answers (user_id, question_id, value, content_release, answered_at)
       SELECT $1, q, v::answer_value,
         (SELECT version FROM content_releases ORDER BY applied_at DESC LIMIT 1), now()
       FROM unnest($2::text[], $3::text[]) AS t(q, v)`,
      [person.id, answers.map((a) => a[0]), answers.map((a) => a[1])],
    );
  }
  return person;
}

export interface TestMatching {
  service: ReturnType<typeof createMatchingService>;
  repo: ReturnType<typeof createMatchingRepository>;
  logger: Logger;
  logLines: () => string[];
}

/** The real matching service on a test database, planning in-process unless told otherwise. */
export async function buildMatching(
  testDb: TestDatabase,
  over: Partial<
    Pick<MatchingServiceDeps, 'repo' | 'u18PoolEnabled' | 'allowSynthetic' | 'pageSize'>
  > & { planner?: MatchPlanner; params?: Partial<MatchingParams>; clock?: Clock } = {},
): Promise<TestMatching> {
  const { logger, lines } = memoryLogger();
  const repo = over.repo ?? createMatchingRepository(testDb.db);
  const service = createMatchingService({
    pool: testDb.appPool,
    repo,
    content: await realContent(),
    planner: over.planner ?? inProcessPlanner,
    // Real time: the database triggers use the real date (vc_today()).
    clock: over.clock ?? systemClock,
    logger,
    params: { ...DEFAULT_MATCHING_PARAMS, ...over.params },
    u18PoolEnabled: over.u18PoolEnabled ?? true,
    allowSynthetic: over.allowSynthetic ?? true,
    ...(over.pageSize ? { pageSize: over.pageSize } : {}),
  });
  return { service, repo: createMatchingRepository(testDb.db), logger, logLines: lines };
}
