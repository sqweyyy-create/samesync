/**
 * SAFETY SUITE — ages and bands agree between TypeScript (ageOn/bandFor) and SQL
 * (vc_age_years/vc_band), so the app and the DB triggers always put a user in the same band.
 * The same holds for the u18 two-year rule (birthDatesWithinYears / vc_within_years, Q14).
 */
import { ageOn, bandFor, birthDatesWithinYears, utcDate } from '@samesync/shared';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const DAY = 86_400_000;
const iso = (ms: number) => utcDate(new Date(ms));

/** Birth dates 1900–2100; "on" dates from the birth date up to 130 years later. */
const randomPair = fc
  .tuple(
    fc.integer({ min: Date.UTC(1900, 0, 1), max: Date.UTC(2100, 11, 31) }),
    fc.integer({ min: 0, max: 130 * 366 }),
  )
  .map(([birth, offsetDays]) => [iso(birth), iso(birth + offsetDays * DAY)] as const);

/** Pairs on and around birthdays: the day before, of and after, `years` later. */
const birthdayPair = fc
  .tuple(
    fc.integer({ min: Date.UTC(1950, 0, 1), max: Date.UTC(2030, 11, 31) }),
    fc.integer({ min: 0, max: 90 }),
    fc.constantFrom(-1, 0, 1),
  )
  // A date before the birth date has no age (covered separately below).
  .filter(([, years, shift]) => years > 0 || shift >= 0)
  .map(([birthMs, years, shift]) => {
    const on = new Date(birthMs);
    on.setUTCFullYear(on.getUTCFullYear() + years);
    return [iso(birthMs), iso(on.getTime() + shift * DAY)] as const;
  });

/** Feb 29 births checked around Feb 28 / Feb 29 / Mar 1 of every kind of year. */
const leapPair = fc
  .tuple(
    fc.constantFrom(1904, 1960, 1996, 2000, 2004, 2008, 2012, 2016, 2020, 2024),
    fc.integer({ min: 0, max: 100 }),
    fc.constantFrom('02-28', '02-29', '03-01'),
  )
  .filter(([, years, day]) => years > 0 || day !== '02-28')
  .map(([year, years, day]) => {
    const onYear = year + years;
    const onDay = day === '02-29' && !isLeap(onYear) ? '03-01' : day;
    return [`${year}-02-29`, `${onYear}-${onDay}`] as const;
  });

function isLeap(y: number) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

async function sqlAges(pairs: ReadonlyArray<readonly [string, string]>) {
  const { rows } = await testDb.appPool.query<{ age: number; band: string | null }>(
    `SELECT vc_age_years(b::date, o::date) AS age, vc_band(b::date, o::date)::text AS band
       FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(b, o, n) ORDER BY n`,
    [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
  );
  return rows;
}

async function expectParity(pairs: ReadonlyArray<readonly [string, string]>) {
  const rows = await sqlAges(pairs);
  pairs.forEach(([birth, on], i) => {
    const ts = ageOn(birth, on);
    expect({ birth, on, age: rows[i]?.age, band: rows[i]?.band }).toEqual({
      birth,
      on,
      age: ts,
      band: bandFor(ts),
    });
  });
}

describe('ageOn() equals vc_age_years() and bandFor() equals vc_band()', () => {
  it('on ≥ 1,000 random (birth, on) pairs', async () => {
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(randomPair, { minLength: 250, maxLength: 250 }), async (pairs) => {
        checked += pairs.length;
        await expectParity(pairs);
      }),
      { numRuns: 6 },
    );
    expect(checked).toBeGreaterThanOrEqual(1000);
  });

  it('on and around birthdays, including the 14th and 18th', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(birthdayPair, { minLength: 200, maxLength: 200 }), expectParity),
      { numRuns: 5 },
    );
  });

  it('for Feb 29 births in leap and non-leap years', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(leapPair, { minLength: 100, maxLength: 100 }), expectParity),
      { numRuns: 5 },
    );
  });

  it('on fixed edge dates', async () => {
    await expectParity([
      ['2012-06-15', '2026-06-14'],
      ['2012-06-15', '2026-06-15'],
      ['2008-06-15', '2026-06-14'],
      ['2008-06-15', '2026-06-15'],
      ['2008-02-29', '2026-02-28'],
      ['2008-02-29', '2026-03-01'],
      ['2008-02-29', '2028-02-29'],
      ['2000-02-29', '2100-02-28'],
      ['2000-02-29', '2100-03-01'],
      ['2008-12-31', '2026-12-31'],
      ['2009-01-01', '2026-12-31'],
    ]);
  });

  it('agree that a date before the birth date has no age (SQL NULL, TS throws)', async () => {
    const rows = await sqlAges([
      ['2010-06-15', '2010-06-14'],
      ['2008-02-29', '2008-02-28'],
    ]);
    expect(rows).toEqual([
      { age: null, band: null },
      { age: null, band: null },
    ]);
    expect(() => ageOn('2010-06-15', '2010-06-14')).toThrow();
  });

  it('vc_today() is the UTC calendar date', async () => {
    const { rows } = await testDb.appPool.query<{ today: string }>(
      'SELECT vc_today()::text AS today',
    );
    const before = utcDate(new Date(Date.now() - 1000));
    const after = utcDate(new Date(Date.now() + 1000));
    expect([before, after]).toContain(rows[0]?.today);
  });
});

describe('birthDatesWithinYears() equals vc_within_years() (Q14: at most 2 calendar years apart)', () => {
  async function expectSameGapRule(pairs: ReadonlyArray<readonly [string, string]>) {
    const { rows } = await testDb.appPool.query<{ within: boolean; reversed: boolean }>(
      `SELECT vc_within_years(a::date, b::date, 2) AS within, vc_within_years(b::date, a::date, 2) AS reversed
         FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(a, b, n) ORDER BY n`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1])],
    );
    pairs.forEach(([a, b], i) => {
      const ts = birthDatesWithinYears(a, b, 2);
      expect({ a, b, within: rows[i]?.within, reversed: rows[i]?.reversed }).toEqual({
        a,
        b,
        within: ts,
        reversed: ts,
      });
    });
  }

  /** Two birth dates up to about four years apart, in either order. */
  const nearbyBirthDates = fc
    .tuple(
      fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2016, 11, 31) }),
      fc.integer({ min: -4 * 366, max: 4 * 366 }),
    )
    .map(([first, offsetDays]) => [iso(first), iso(first + offsetDays * DAY)] as const);

  /** The other birth date lands exactly 2 years later, give or take a day. */
  const aroundTwoYears = fc
    .tuple(
      fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2016, 11, 31) }),
      fc.constantFrom(-1, 0, 1),
    )
    .map(([first, shift]) => {
      const later = new Date(first);
      later.setUTCFullYear(later.getUTCFullYear() + 2);
      return [iso(first), iso(later.getTime() + shift * DAY)] as const;
    });

  it('on ≥ 1,000 random pairs of birth dates', async () => {
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.array(nearbyBirthDates, { minLength: 250, maxLength: 250 }),
        async (pairs) => {
          checked += pairs.length;
          await expectSameGapRule(pairs);
        },
      ),
      { numRuns: 5 },
    );
    expect(checked).toBeGreaterThanOrEqual(1000);
  });

  it('exactly at the two-year boundary', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(aroundTwoYears, { minLength: 200, maxLength: 200 }),
        expectSameGapRule,
      ),
      { numRuns: 5 },
    );
  });

  it('on fixed edge dates, including Feb 29 births', async () => {
    await expectSameGapRule([
      ['2010-06-15', '2010-06-15'],
      ['2010-06-15', '2012-06-15'],
      ['2010-06-15', '2012-06-16'],
      ['2008-02-29', '2010-02-28'],
      ['2008-02-29', '2010-03-01'],
      ['2008-02-29', '2010-03-02'],
      ['2008-02-28', '2010-02-28'],
      ['2008-02-28', '2010-03-01'],
      ['2010-03-01', '2012-02-29'],
      ['2010-03-01', '2012-03-01'],
      ['2010-03-01', '2012-03-02'],
      ['2009-12-31', '2011-12-31'],
      ['2009-12-31', '2012-01-01'],
    ]);
    expect(birthDatesWithinYears('2008-02-29', '2010-03-01', 2)).toBe(true);
    expect(birthDatesWithinYears('2008-02-29', '2010-03-02', 2)).toBe(false);
  });
});
