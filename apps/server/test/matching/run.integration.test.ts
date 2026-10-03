/**
 * The matching run against a real database, as the app role: matches, game shells and
 * notifications are created together, a drop runs once, an interrupted run is resumed without
 * duplicates, and the database trigger has the last word on every pair.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createMatchingRepository,
  type MatchingRepository,
} from '../../src/db/repositories/matching';
import type { PoolScope } from '../../src/domain/matching/types';
import { inProcessPlanner, type MatchPlanner } from '../../src/jobs/matching-planner';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertMatch } from '../support/matches';
import {
  answersFor,
  buildMatching,
  hoursAgo,
  insertPerson,
  itemsOf,
  realScope,
} from '../support/population';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
let scope: PoolScope;
let niche: string[];
beforeEach(async () => {
  testDb = await createTestDatabase();
  scope = await realScope();
  niche = itemsOf(scope, 'niche');
});
afterEach(() => testDb.drop());

const ADULT_RU = { band: 'adult', locale: 'ru' } as const;
const SLOT = new Date('2026-10-03T10:00:00Z');
const run = (service: Awaited<ReturnType<typeof buildMatching>>['service'], slot = SLOT) =>
  service.run({ pool: ADULT_RU, mode: 'friends', slot });

/** Two people who share the niche item `item` and disagree on one of six common takes. */
async function insertPair(item: string, over = {}) {
  const a = await insertPerson(testDb.appPool, {
    items: [item],
    answers: answersFor(scope, 'AAAAAD'),
    ...over,
  });
  const b = await insertPerson(testDb.appPool, {
    items: [item],
    answers: answersFor(scope, 'AAAAAA'),
    ...over,
  });
  return [a, b] as const;
}

const rows = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  (await testDb.ownerPool.query<T>(sql, params)).rows;
const count = async (table: string) =>
  Number((await rows<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0]?.n);

describe('a matching run', () => {
  it('creates the match, its game shell and one notification per user, and records the run', async () => {
    const [a, b] = await insertPair(niche[0]!);
    // Both agree on the first five takes; the teaser names the one fewest people agree with.
    const rarestAgree = [...scope.takes.slice(0, 5)].sort(
      (x, y) => x.priorAgree - y.priorAgree || (x.id < y.id ? -1 : 1),
    )[0]!.id;
    const { service } = await buildMatching(testDb);
    const outcome = await run(service);
    expect(outcome).toMatchObject({
      status: 'done',
      poolSize: 2,
      eligibleUsers: 2,
      pairsCreated: 1,
      pairsRejected: 0,
      tierCounts: { 1: 1, 2: 0, 3: 0 },
    });

    const [match] = await rows<Record<string, unknown>>('SELECT * FROM matches');
    expect(match).toMatchObject({
      band: 'adult',
      locale: 'ru',
      mode: 'friends',
      user_a_id: a.id < b.id ? a.id : b.id,
      user_b_id: a.id < b.id ? b.id : a.id,
      tier: 1,
      status: 'pending_game',
      teaser: {
        interest: { kind: 'item', id: niche[0] },
        take: { id: rarestAgree, value: 'agree' },
      },
    });
    expect(match?.['alias_a']).not.toBe(match?.['alias_b']);
    const deadline = (match?.['game_deadline_at'] as Date).getTime();
    expect(deadline - (match?.['created_at'] as Date).getTime()).toBe(48 * 3_600_000);

    expect(await rows('SELECT match_id FROM games')).toEqual([{ match_id: match?.['id'] }]);
    const outbox = await rows<{ user_id: string; dedupe_key: string }>(
      'SELECT user_id, kind, match_id, status, dedupe_key FROM outbox ORDER BY user_id',
    );
    expect(outbox).toHaveLength(2);
    expect(outbox.map((o) => o.user_id).sort()).toEqual([a.id, b.id].sort());
    for (const o of outbox) {
      expect(o).toMatchObject({
        kind: 'match_created',
        match_id: match?.['id'],
        status: 'pending',
      });
      expect(o.dedupe_key).toBe(`match_created:${String(match?.['id'])}:${o.user_id}`);
    }

    const [recorded] = await rows('SELECT * FROM match_runs');
    expect(recorded).toMatchObject({
      band: 'adult',
      locale: 'ru',
      mode: 'friends',
      pool_size: 2,
      eligible_users: 2,
      pairs_created: 1,
      pairs_rejected: 0,
      tier_counts: { '1': 1 },
    });
    expect(recorded?.['finished_at']).not.toBeNull();
    expect(match?.['run_id']).toBe(recorded?.['id']);
  });

  it('saves the pool statistics, per pool', async () => {
    await insertPair(niche[0]!);
    const { service } = await buildMatching(testDb);
    await run(service);
    const [stat] = await rows(
      "SELECT n_users, pool_size FROM feature_stats WHERE band = 'adult' AND locale = 'ru' AND feature_key = $1",
      [niche[0]],
    );
    expect(stat).toEqual({ n_users: 2, pool_size: 2 });
    expect(await count("feature_stats WHERE band = 'u18' OR locale = 'en'")).toBe(0);
    // A second run replaces the rows instead of adding to them.
    const before = await count('feature_stats');
    await run(service, new Date('2026-10-03T17:00:00Z'));
    expect(await count('feature_stats')).toBe(before);
  });

  it('is idempotent: the same drop never runs twice', async () => {
    await insertPair(niche[0]!);
    await insertPair(niche[1]!);
    const { service } = await buildMatching(testDb);
    const first = await run(service);
    expect(first).toMatchObject({ status: 'done', pairsCreated: 2 });
    const again = await run(service);
    expect(again).toEqual({ status: 'already_done', runId: (first as { runId: string }).runId });
    expect(await count('matches')).toBe(2);
    expect(await count('outbox')).toBe(4);
    expect(await count('match_runs')).toBe(1);
  });

  it('never matches the same pair again in a later drop (Q9)', async () => {
    await insertPair(niche[0]!);
    const { service } = await buildMatching(testDb);
    await run(service);
    const later = await run(service, new Date('2026-10-03T17:00:00Z'));
    expect(later).toMatchObject({ status: 'done', pairsCreated: 0, pairsRejected: 0 });
    expect(await count('matches')).toBe(1);
    expect(await count('outbox')).toBe(2);
  });

  it('only lets one of two concurrent runs work (advisory lock)', async () => {
    await insertPair(niche[0]!);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const planning = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const slowPlanner: MatchPlanner = {
      async plan(input) {
        entered();
        await gate;
        return inProcessPlanner.plan(input);
      },
    };
    const slow = await buildMatching(testDb, { planner: slowPlanner });
    const fast = await buildMatching(testDb);
    const first = run(slow.service);
    await planning;
    expect(await run(fast.service)).toEqual({ status: 'locked' });
    // Another pool × mode is not blocked by it.
    expect(
      await fast.service.run({
        pool: { band: 'adult', locale: 'en' },
        mode: 'friends',
        slot: SLOT,
      }),
    ).toMatchObject({ status: 'done' });
    release();
    expect(await first).toMatchObject({ status: 'done', pairsCreated: 1 });
    expect(await count('matches')).toBe(1);
  });

  it('resumes an interrupted run without duplicates or second matches', async () => {
    const people = [
      ...(await insertPair(niche[0]!)),
      ...(await insertPair(niche[1]!)),
      ...(await insertPair(niche[2]!)),
    ];
    // The process "dies" on the second pair: an error that is not a database refusal.
    const real = createMatchingRepository(testDb.db);
    let calls = 0;
    const crashing: MatchingRepository = {
      ...real,
      createMatch(input) {
        if (++calls === 2) return Promise.reject(new Error('process killed'));
        return real.createMatch(input);
      },
    };
    const broken = await buildMatching(testDb, { repo: crashing });
    await expect(run(broken.service)).rejects.toThrow('process killed');
    expect(await count('matches')).toBe(1);
    expect(await rows('SELECT finished_at FROM match_runs')).toEqual([{ finished_at: null }]);

    const { service } = await buildMatching(testDb);
    expect(await run(service)).toMatchObject({ status: 'done', pairsCreated: 2 });
    expect(await count('matches')).toBe(3);
    expect(await count('match_runs')).toBe(1);
    expect(await rows('SELECT pairs_created, tier_counts FROM match_runs')).toEqual([
      { pairs_created: 3, tier_counts: { '1': 3 } },
    ]);
    // Everybody is in exactly one match and has exactly one pending notification.
    const perUser = await rows<{ user_id: string; matches: string; notifications: string }>(
      `SELECT u.id AS user_id,
         (SELECT count(*) FROM matches m WHERE u.id IN (m.user_a_id, m.user_b_id)) AS matches,
         (SELECT count(*) FROM outbox o WHERE o.user_id = u.id) AS notifications
       FROM users u`,
    );
    expect(perUser).toHaveLength(people.length);
    for (const user of perUser) expect(user).toMatchObject({ matches: '1', notifications: '1' });
    expect(await run(service)).toMatchObject({ status: 'already_done' });
  });

  it('skips a pair the database refuses, counts it, and creates the others', async () => {
    const [a] = await insertPair(niche[0]!);
    await insertPair(niche[1]!);
    // Between planning and inserting, one user is frozen: the trigger must refuse that match.
    const racing: MatchPlanner = {
      async plan(input) {
        const result = await inProcessPlanner.plan(input);
        await testDb.ownerPool.query("UPDATE users SET status = 'frozen' WHERE id = $1", [a.id]);
        return result;
      },
    };
    const { service, logLines } = await buildMatching(testDb, { planner: racing });
    expect(await run(service)).toMatchObject({
      status: 'done',
      pairsCreated: 1,
      pairsRejected: 1,
    });
    expect(await count('matches')).toBe(1);
    expect(await count('outbox')).toBe(2);
    expect(await rows('SELECT pairs_created, pairs_rejected FROM match_runs')).toEqual([
      { pairs_created: 1, pairs_rejected: 1 },
    ]);
    const warning = logLines().find((l) => l.includes('planned pair was not created'));
    expect(warning).toContain('match rejected: not_active');
    expect(warning).not.toContain(a.id);
  });

  it('loads the pool page by page', async () => {
    for (let i = 0; i < 3; i++) await insertPair(niche[i]!);
    const { service } = await buildMatching(testDb, { pageSize: 2 });
    expect(await run(service)).toMatchObject({ status: 'done', poolSize: 6, pairsCreated: 3 });
  });
});

describe('who gets matched', () => {
  it('excludes users the bot cannot reach, inactive users and non-active statuses', async () => {
    await insertPair(niche[0]!, { botReachable: false });
    await insertPair(niche[1]!, { lastActiveAt: hoursAgo(15 * 24) });
    await insertPair(niche[2]!, { status: 'frozen' });
    await insertPair(niche[3]!, { status: 'waitlisted' });
    const [ok1, ok2] = await insertPair(niche[4]!);
    const { service } = await buildMatching(testDb);
    expect(await run(service)).toMatchObject({ status: 'done', poolSize: 6, eligibleUsers: 2 });
    const matched = await rows<{ user_a_id: string; user_b_id: string }>(
      'SELECT user_a_id, user_b_id FROM matches',
    );
    expect(matched.flatMap((m) => [m.user_a_id, m.user_b_id]).sort()).toEqual(
      [ok1.id, ok2.id].sort(),
    );
  });

  it('applies the free-tier limits: 5 open matches, 3 new matches in 24 hours', async () => {
    const [busy, partner] = await insertPair(niche[0]!);
    const others = await Promise.all(
      Array.from({ length: 5 }, () => insertPerson(testDb.appPool, {})),
    );
    for (const other of others) await insertMatch(testDb.appPool, { a: busy.id, b: other.id });
    const { service } = await buildMatching(testDb);
    expect(await run(service)).toMatchObject({ status: 'done', pairsCreated: 0 });

    // Closing them frees the open-match limit, but three were created in the last 24 hours.
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now()",
    );
    expect(await run(service, new Date('2026-10-03T17:00:00Z'))).toMatchObject({
      pairsCreated: 0,
    });
    // With the limits raised for one run (as the dev tooling does), the pair is matched.
    const lifted = await service.run({
      pool: ADULT_RU,
      mode: 'friends',
      slot: new Date('2026-10-03T18:00:00Z'),
      params: { dailyLimit: 100, openLimit: 100 },
    });
    expect(lifted).toMatchObject({ pairsCreated: 1 });
    const [created] = await rows<{ user_a_id: string; user_b_id: string }>(
      "SELECT user_a_id, user_b_id FROM matches WHERE status = 'pending_game'",
    );
    expect([created?.user_a_id, created?.user_b_id].sort()).toEqual([busy.id, partner.id].sort());
  });

  it('falls back to a broader match only after the waiting time (tier 2)', async () => {
    const known = itemsOf(scope, 'known');
    const sameCategory = scope.items.filter(
      (i) => i.categoryId === scope.items.find((x) => x.id === known[0])!.categoryId,
    );
    const pair = (onboardedAt: Date) =>
      Promise.all([
        insertPerson(testDb.appPool, {
          items: [sameCategory[0]!.id],
          answers: answersFor(scope, 'AAAAAD'),
          onboardedAt,
        }),
        insertPerson(testDb.appPool, {
          items: [sameCategory[1]!.id],
          answers: answersFor(scope, 'AAAAAA'),
          onboardedAt,
        }),
      ]);
    await pair(hoursAgo(1));
    const { service } = await buildMatching(testDb);
    expect(await run(service)).toMatchObject({ pairsCreated: 0 });
    await testDb.ownerPool.query('UPDATE users SET onboarded_at = $1', [hoursAgo(30)]);
    expect(await run(service, new Date('2026-10-03T17:00:00Z'))).toMatchObject({
      pairsCreated: 1,
      tierCounts: { 1: 0, 2: 1, 3: 0 },
    });
    expect(await rows('SELECT tier, teaser FROM matches')).toMatchObject([
      { tier: 2, teaser: { interest: { kind: 'category', id: sameCategory[0]!.categoryId } } },
    ]);
  });

  it('matches dating users only when preferences and age ranges fit both ways', async () => {
    const dating = await realScope({ mode: 'dating' });
    const item = itemsOf(dating, 'niche')[0]!;
    // Everyone has waited long enough for every tier, so only the dating rules decide.
    const person = (gender: string, seeking: string[], pattern: string, over = {}) =>
      insertPerson(testDb.appPool, {
        mode: 'dating',
        gender,
        seeking,
        items: [item],
        answers: answersFor(dating, pattern),
        onboardedAt: hoursAgo(100),
        ...over,
      });
    const man = await person('g.man', ['g.woman'], 'AAAAAD');
    // She would fit, but only accepts 30–40 and he is 25.
    await person('g.woman', ['g.man'], 'AAAAAA', { datingAge: { min: 30, max: 40 } });
    // Not looking for men.
    await person('g.woman', ['g.woman'], 'AAAAAA');
    const { service } = await buildMatching(testDb);
    const first = await service.run({ pool: ADULT_RU, mode: 'dating', slot: SLOT });
    expect(first).toMatchObject({ status: 'done', eligibleUsers: 3, pairsCreated: 0 });

    const fits = await person('g.woman', ['g.man'], 'AAAAAA', { datingAge: { min: 20, max: 30 } });
    const second = await service.run({
      pool: ADULT_RU,
      mode: 'dating',
      slot: new Date('2026-10-03T17:00:00Z'),
    });
    expect(second).toMatchObject({ pairsCreated: 1, pairsRejected: 0 });
    const [match] = await rows<{ user_a_id: string; user_b_id: string; mode: string }>(
      'SELECT user_a_id, user_b_id, mode FROM matches',
    );
    expect(match?.mode).toBe('dating');
    expect([match?.user_a_id, match?.user_b_id].sort()).toEqual([man.id, fits.id].sort());
  });
});

describe('the u18 pool', () => {
  const U18_RU = { band: 'u18', locale: 'ru' } as const;
  const kids = async () => {
    const u18 = await realScope({ band: 'u18' });
    const item = itemsOf(u18, 'niche')[0]!;
    // They have waited long enough for every tier, so only the u18 rules decide.
    const kid = (years: number, pattern: string) =>
      insertPerson(testDb.appPool, {
        birthDate: birthDateYearsAgo(years),
        items: [item],
        answers: answersFor(u18, pattern),
        onboardedAt: hoursAgo(100),
      });
    return { kid };
  };

  it('is never matched while U18_POOL_ENABLED is off', async () => {
    const { kid } = await kids();
    await kid(16, 'AAAAAD');
    await kid(16, 'AAAAAA');
    const { service } = await buildMatching(testDb, { u18PoolEnabled: false });
    expect(await service.run({ pool: U18_RU, mode: 'friends', slot: SLOT })).toEqual({
      status: 'disabled',
    });
    expect(await count('matches')).toBe(0);
    expect(await count('match_runs')).toBe(0);
  });

  it('matches u18 users only within 2 calendar years, and never with adults', async () => {
    const { kid } = await kids();
    const seventeen = await kid(17, 'AAAAAD');
    await kid(14, 'AAAAAA'); // three years younger
    const adult = await insertPerson(testDb.appPool, {
      birthDate: birthDateYearsAgo(18),
      items: [itemsOf(await realScope({ band: 'u18' }), 'niche')[0]!],
      answers: answersFor(await realScope({ band: 'u18' }), 'AAAAAA'),
    });
    const { service } = await buildMatching(testDb);
    expect(await service.run({ pool: U18_RU, mode: 'friends', slot: SLOT })).toMatchObject({
      status: 'done',
      poolSize: 2,
      pairsCreated: 0,
    });
    const fifteen = await kid(15, 'AAAAAA');
    expect(
      await service.run({ pool: U18_RU, mode: 'friends', slot: new Date('2026-10-03T17:00:00Z') }),
    ).toMatchObject({ pairsCreated: 1, pairsRejected: 0 });
    const [match] = await rows<{ user_a_id: string; user_b_id: string; band: string }>(
      'SELECT user_a_id, user_b_id, band FROM matches',
    );
    expect(match?.band).toBe('u18');
    expect([match?.user_a_id, match?.user_b_id].sort()).toEqual([seventeen.id, fifteen.id].sort());
    expect([match?.user_a_id, match?.user_b_id]).not.toContain(adult.id);
    await expect(service.run({ pool: U18_RU, mode: 'dating', slot: SLOT })).rejects.toThrow(
      /friends-only/,
    );
  });
});

describe('synthetic users', () => {
  it('are matched in development and ignored in production', async () => {
    await insertPair(niche[0]!, { synthetic: true });
    const production = await buildMatching(testDb, { allowSynthetic: false });
    expect(await run(production.service)).toMatchObject({ poolSize: 0, pairsCreated: 0 });
    const development = await buildMatching(testDb);
    expect(await run(development.service, new Date('2026-10-03T17:00:00Z'))).toMatchObject({
      poolSize: 2,
      pairsCreated: 1,
    });
  });
});
