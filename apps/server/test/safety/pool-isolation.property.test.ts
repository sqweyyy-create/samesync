/**
 * SAFETY SUITE — pool isolation in the matching engine (CLAUDE.md invariants 1, 5, 8 and 9).
 * fast-check builds random populations that mix bands, locales, modes, statuses, birth dates
 * around the 14th and 18th birthdays and around the two-year gap, dating preferences, blocks and
 * earlier matches. The engine is run for every pool × mode over the WHOLE mixed population, as if
 * the database query had returned everybody, and every planned pair is checked against rules
 * written out again here, independently of the engine's own code. This holds at every tier.
 */
import {
  ageOn,
  bandFor,
  birthDatesWithinYears,
  type Band,
  type Locale,
  type Mode,
} from '@samesync/shared';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MATCHING_PARAMS } from '../../src/domain/matching/params';
import { planPool } from '../../src/domain/matching/plan';
import type {
  MatchCandidate,
  PlannedPair,
  PoolScope,
  Stance,
} from '../../src/domain/matching/types';
import { HOUR, NOW, SCOPE, TAKES, TODAY, bornYearsAgo, planInput } from '../support/matching';

const RUNS: ReadonlyArray<{ band: Band; locale: Locale; mode: Mode }> = [
  { band: 'u18', locale: 'ru', mode: 'friends' },
  { band: 'u18', locale: 'en', mode: 'friends' },
  { band: 'adult', locale: 'ru', mode: 'friends' },
  { band: 'adult', locale: 'en', mode: 'friends' },
  { band: 'adult', locale: 'ru', mode: 'dating' },
  { band: 'adult', locale: 'en', mode: 'dating' },
];
const DAY = 24 * HOUR;

/**
 * A catalog of mostly niche items, so that small random pools produce every kind of overlap:
 * a shared rare item (tier 1), a shared category (tier 2) and a shared domain (tier 3).
 */
const WIDE_SCOPE: PoolScope = {
  ...SCOPE,
  items: ['music', 'games', 'shows'].flatMap((domain) =>
    Array.from({ length: 12 }, (_, i) => ({
      id: `i.${domain}.p${String(i).padStart(2, '0')}`,
      categoryId: `c.${domain}.c${i % 3}`,
      domain: domain as PoolScope['items'][number]['domain'],
      popularity: (i < 8 ? 'niche' : i < 11 ? 'known' : 'mainstream') as 'niche',
    })),
  ),
};
const ITEM_IDS = WIDE_SCOPE.items.map((i) => i.id);

/** Birth dates that sit on the edges: around 14, around 18, and u18 ages a day or two apart. */
const birthDate = fc
  .oneof(
    fc.record({ years: fc.constantFrom(14, 18), days: fc.integer({ min: -3, max: 3 }) }),
    fc.record({ years: fc.constantFrom(14, 15, 16, 17), days: fc.integer({ min: -2, max: 2 }) }),
    fc.record({ years: fc.integer({ min: 12, max: 32 }), days: fc.integer({ min: 0, max: 364 }) }),
  )
  .map(({ years, days }) => bornYearsAgo(years, days));

/** Mostly the common value, sometimes one of the others: keeps most users matchable. */
const mostly = <T>(common: T, ...rare: T[]) =>
  fc.oneof(
    { weight: 8, arbitrary: fc.constant(common) },
    { weight: 2, arbitrary: fc.constantFrom(common, ...rare) },
  );

const stance = fc.constantFrom<Stance | null>(
  'agree',
  'agree',
  'agree',
  'disagree',
  'disagree',
  null,
);

const user = fc
  .record({
    birthDate,
    locale: fc.constantFrom<Locale>('ru', 'ru', 'en'),
    mode: fc.constantFrom<Mode | null>('friends', 'friends', 'friends', 'dating', 'dating', null),
    status: mostly<MatchCandidate['status']>(
      'active',
      'frozen',
      'onboarding',
      'waitlisted',
      'deleted',
      'ineligible',
    ),
    botReachable: mostly(true, false),
    idleDays: mostly(0, 1, 13, 15, 30),
    waitedHours: fc.constantFrom(0, 1, 23, 24, 30, 71, 72, 100, 400),
    gender: fc.constantFrom<string | null>('g.man', 'g.man', 'g.woman', 'g.woman', null),
    seeking: fc.constantFrom<string[] | null>(
      ['g.man'],
      ['g.woman'],
      ['g.man', 'g.woman'],
      ['g.man', 'g.woman'],
      [],
      null,
    ),
    ageRange: fc.option(
      fc.record({ min: fc.integer({ min: 18, max: 26 }), span: fc.integer({ min: 0, max: 20 }) }),
      { freq: 8 },
    ),
    recentMatches: mostly(0, 1, 2, 3, 4),
    openMatches: mostly(0, 1, 4, 5, 6),
    items: fc.subarray(ITEM_IDS, { minLength: 0, maxLength: 5 }),
    stances: fc.array(stance, { minLength: TAKES.length, maxLength: TAKES.length }),
  })
  .map((u): Omit<MatchCandidate, 'id'> => ({
    birthDate: u.birthDate,
    locale: u.locale,
    mode: u.mode,
    status: u.status,
    botReachable: u.botReachable,
    synthetic: false,
    lastActiveAt: NOW - u.idleDays * DAY,
    waitingSince: NOW - u.waitedHours * HOUR,
    gender: u.gender,
    seeking: u.seeking,
    datingAgeMin: u.ageRange?.min ?? null,
    datingAgeMax: u.ageRange ? u.ageRange.min + u.ageRange.span : null,
    recentMatches: u.recentMatches,
    openMatches: u.openMatches,
    aliasesInUse: [],
    items: u.items,
    answers: u.stances.flatMap((s, i) => (s ? [[TAKES[i]!.id, s] as const] : [])),
  }));

const population = fc
  .tuple(
    // At least 30 users: fast-check prefers short arrays, and a handful of users rarely match.
    fc.array(user, { minLength: 30, maxLength: 80 }),
    fc.array(fc.tuple(fc.nat(79), fc.nat(79)), { maxLength: 25 }),
    fc.integer({ min: 0, max: 2 ** 31 - 1 }),
  )
  .map(([users, excluded, seed]) => {
    const withIds = users.map((u, i): MatchCandidate => ({
      ...u,
      id: `user-${String(i).padStart(3, '0')}`,
    }));
    const excludedPairs = excluded
      .filter(([a, b]) => a !== b && a < withIds.length && b < withIds.length)
      .map(([a, b]) => [withIds[a]!.id, withIds[b]!.id] as const);
    return { users: withIds, excludedPairs, seed };
  });

// --- The rules, written out independently of the engine --------------------------------------

/** Band from the birth date alone; null under 14. */
function bandOf(u: MatchCandidate): Band | null {
  return bandFor(ageOn(u.birthDate, TODAY));
}
const ageOf = (u: MatchCandidate) => ageOn(u.birthDate, TODAY);
const hoursWaited = (u: MatchCandidate) => (NOW - u.waitingSince) / HOUR;
const acceptedTier = (u: MatchCandidate) =>
  hoursWaited(u) >= 72 ? 3 : hoursWaited(u) >= 24 ? 2 : 1;

function expectPairObeysEveryRule(
  pair: PlannedPair,
  run: (typeof RUNS)[number],
  users: ReadonlyMap<string, MatchCandidate>,
  excludedPairs: ReadonlyArray<readonly [string, string]>,
): void {
  const a = users.get(pair.userA)!;
  const b = users.get(pair.userB)!;
  const context = { pair, run, a, b };
  expect(a, 'unknown user A').toBeDefined();
  expect(b, 'unknown user B').toBeDefined();
  expect(pair.userA < pair.userB, 'user A must be the lower ID').toBe(true);

  for (const u of [a, b]) {
    // Same band (from the birth date), locale and mode as the run: no cross-pool contact.
    expect({ ...context, band: bandOf(u) }).toMatchObject({ band: run.band });
    expect({ ...context, locale: u.locale }).toMatchObject({ locale: run.locale });
    expect({ ...context, mode: u.mode }).toMatchObject({ mode: run.mode });
    // Not frozen, deleted, waitlisted or still onboarding.
    expect({ ...context, status: u.status }).toMatchObject({ status: 'active' });
    expect({ ...context, reachable: u.botReachable }).toMatchObject({ reachable: true });
    expect(NOW - u.lastActiveAt).toBeLessThanOrEqual(14 * DAY);
    expect(u.recentMatches).toBeLessThan(DEFAULT_MATCHING_PARAMS.dailyLimit);
    expect(u.openMatches).toBeLessThan(DEFAULT_MATCHING_PARAMS.openLimit);
  }

  if (run.band === 'u18') {
    expect({ ...context, mode: run.mode }).toMatchObject({ mode: 'friends' });
    expect({
      ...context,
      within: birthDatesWithinYears(a.birthDate, b.birthDate, 2),
    }).toMatchObject({ within: true });
  }
  if (run.mode === 'dating') {
    expect({ ...context, band: run.band }).toMatchObject({ band: 'adult' });
    expect(a.seeking).toContain(b.gender);
    expect(b.seeking).toContain(a.gender);
    expect(ageOf(b)).toBeGreaterThanOrEqual(a.datingAgeMin!);
    expect(ageOf(b)).toBeLessThanOrEqual(a.datingAgeMax!);
    expect(ageOf(a)).toBeGreaterThanOrEqual(b.datingAgeMin!);
    expect(ageOf(a)).toBeLessThanOrEqual(b.datingAgeMax!);
  }

  // Never a blocked pair or a rematch.
  const key = [a.id, b.id].sort().join('|');
  expect(excludedPairs.map((p) => [...p].sort().join('|'))).not.toContain(key);

  // At least five takes both answered, at least one of them a disagreement.
  const theirs = new Map(b.answers);
  const common = a.answers.filter(([q]) => theirs.has(q));
  expect(common.length).toBeGreaterThanOrEqual(5);
  expect(common.some(([q, value]) => theirs.get(q) !== value)).toBe(true);

  // Tier 1 is open to everyone; a broader tier only once both have waited for it.
  expect([1, 2, 3]).toContain(pair.tier);
  if (pair.tier > 1)
    expect(Math.min(acceptedTier(a), acceptedTier(b))).toBeGreaterThanOrEqual(pair.tier);
  expect(pair.aliasA).not.toBe(pair.aliasB);
  expect(pair.teaser.interest !== null || pair.teaser.take !== null).toBe(true);
}

function planEverything(p: {
  users: MatchCandidate[];
  excludedPairs: (readonly [string, string])[];
  seed: number;
}) {
  const byId = new Map(p.users.map((u) => [u.id, u]));
  const matchedSomewhere: string[] = [];
  const tiers = { 1: 0, 2: 0, 3: 0 };
  for (const run of RUNS) {
    // The whole population goes in, whatever the pool: the engine must sort it out itself.
    const { pairs } = planPool(
      planInput(p.users, {
        pool: { band: run.band, locale: run.locale },
        mode: run.mode,
        scope: WIDE_SCOPE,
        excludedPairs: p.excludedPairs,
        seed: p.seed,
      }),
    );
    const inThisRun = pairs.flatMap((pair) => [pair.userA, pair.userB]);
    expect(new Set(inThisRun).size, 'at most one match per user per run').toBe(inThisRun.length);
    for (const pair of pairs) {
      expectPairObeysEveryRule(pair, run, byId, p.excludedPairs);
      tiers[pair.tier]++;
    }
    matchedSomewhere.push(...inThisRun);
  }
  // A user belongs to exactly one pool × mode, so they are matched at most once over all runs.
  expect(new Set(matchedSomewhere).size).toBe(matchedSomewhere.length);
  return tiers;
}

describe('every planned pair stays inside its pool and obeys every hard filter', () => {
  it('for random mixed populations (new ones on every test run)', () => {
    fc.assert(
      fc.property(population, (p) => void planEverything(p)),
      { numRuns: 300 },
    );
  });

  it('at every tier: a fixed set of populations that produces tier 1, 2 and 3 pairs', () => {
    const tiers = { 1: 0, 2: 0, 3: 0 };
    fc.assert(
      fc.property(population, (p) => {
        const seen = planEverything(p);
        tiers[1] += seen[1];
        tiers[2] += seen[2];
        tiers[3] += seen[3];
      }),
      { numRuns: 300, seed: 20261003 },
    );
    expect(tiers[1]).toBeGreaterThan(20);
    expect(tiers[2]).toBeGreaterThan(20);
    expect(tiers[3]).toBeGreaterThan(20);
  });

  it('for a population built so that only the pool boundaries keep people apart', () => {
    // Everyone has the same tastes and has waited long enough for tier 3. Each "odd" user
    // disagrees with each "even" one on one take, so any two of them could be matched: the only
    // things in the way are band, locale, mode, the u18 birth date gap, dating preferences and
    // a frozen account.
    const make = (id: number, over: Partial<MatchCandidate>): MatchCandidate => ({
      id: `fixed-${id}`,
      birthDate: bornYearsAgo(25),
      locale: 'ru',
      mode: 'friends',
      status: 'active',
      botReachable: true,
      synthetic: false,
      lastActiveAt: NOW,
      waitingSince: NOW - 500 * HOUR,
      gender: null,
      seeking: null,
      datingAgeMin: null,
      datingAgeMax: null,
      recentMatches: 0,
      openMatches: 0,
      aliasesInUse: [],
      items: ['i.games.indie_a', 'i.music.star'],
      answers: TAKES.slice(0, 6).map((t, i) => [t.id, id % 2 && i === 5 ? 'disagree' : 'agree']),
      ...over,
    });
    const dating = { mode: 'dating' as const, datingAgeMin: 18, datingAgeMax: 99 };
    const users = [
      make(0, { birthDate: bornYearsAgo(17) }), // u18 ru, 17
      make(1, { birthDate: bornYearsAgo(14) }), // u18 ru, 14: three years from the 17-year-old
      make(2, { birthDate: bornYearsAgo(18) }), // adult ru friends, turned 18 today
      make(3, { birthDate: bornYearsAgo(17), locale: 'en' }), // u18 en
      make(4, { locale: 'en' }), // adult en friends
      make(5, {}), // adult ru friends
      make(6, { ...dating, gender: 'g.man', seeking: ['g.woman'] }), // adult ru dating
      make(7, { ...dating, gender: 'g.man', seeking: ['g.man'] }), // adult ru dating, incompatible
      make(8, { ...dating, gender: 'g.woman', seeking: ['g.man'], locale: 'en' }), // other locale
      make(9, { status: 'frozen' }), // adult ru friends, frozen
    ];
    const all = RUNS.flatMap((run) =>
      planPool(
        planInput(users, { pool: { band: run.band, locale: run.locale }, mode: run.mode }),
      ).pairs.map((pair) => [pair.userA, pair.userB].sort()),
    );
    // Only the two active adults in ru friends mode can meet: the 18-year-old and the 25-year-old.
    expect(all).toEqual([[users[2]!.id, users[5]!.id].sort()]);
  });
});
