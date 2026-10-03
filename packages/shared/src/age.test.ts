import { describe, expect, it } from 'vitest';
import {
  ageOn,
  bandFor,
  birthDateProblem,
  birthDatesWithinYears,
  nthBirthday,
  parseIsoDate,
  utcDate,
} from './age';

describe('ageOn', () => {
  it.each([
    ['day before the 14th birthday', '2012-06-15', '2026-06-14', 13],
    ['on the 14th birthday', '2012-06-15', '2026-06-15', 14],
    ['day after the 14th birthday', '2012-06-15', '2026-06-16', 14],
    ['day before the 18th birthday', '2008-06-15', '2026-06-14', 17],
    ['on the 18th birthday', '2008-06-15', '2026-06-15', 18],
    ['day after the 18th birthday', '2008-06-15', '2026-06-16', 18],
    ['year-end birthday, day before', '2008-12-31', '2026-12-30', 17],
    ['year-end birthday', '2008-12-31', '2026-12-31', 18],
    ['new-year birthday', '2009-01-01', '2027-01-01', 18],
  ])('%s', (_label, birth, on, expected) => {
    expect(ageOn(birth, on)).toBe(expected);
  });

  describe('Feb 29 births (Q15: birthday on Mar 1 in non-leap years)', () => {
    it.each([
      ['non-leap Feb 28', '2008-02-29', '2026-02-28', 17],
      ['non-leap Mar 1', '2008-02-29', '2026-03-01', 18],
      ['leap Feb 28', '2008-02-29', '2028-02-28', 19],
      ['leap Feb 29', '2008-02-29', '2028-02-29', 20],
      ['14th birthday in a non-leap year', '2012-02-29', '2026-03-01', 14],
      ['day before it', '2012-02-29', '2026-02-28', 13],
    ])('%s', (_label, birth, on, expected) => {
      expect(ageOn(birth, on)).toBe(expected);
    });
  });

  it('throws for a date before the birth date (there is no age)', () => {
    expect(() => ageOn('2010-06-15', '2010-06-14')).toThrow(/before the birth date/);
    expect(ageOn('2010-06-15', '2010-06-15')).toBe(0);
  });

  it('throws on invalid dates instead of guessing', () => {
    expect(() => ageOn('2010-02-30', '2026-01-01')).toThrow(/not a valid/);
    expect(() => ageOn('2010-01-01', '01.01.2026')).toThrow(/not a valid/);
  });
});

describe('bandFor', () => {
  it.each([
    [13, null],
    [14, 'u18'],
    [17, 'u18'],
    [18, 'adult'],
    [99, 'adult'],
  ] as const)('age %i → %s', (age, band) => {
    expect(bandFor(age)).toBe(band);
  });
});

describe('birthDateProblem', () => {
  const today = '2026-10-03';
  it('accepts a plausible past date, including today', () => {
    expect(birthDateProblem('2008-06-15', today)).toBeNull();
    expect(birthDateProblem(today, today)).toBeNull();
  });
  it('rejects future, implausible and malformed dates', () => {
    expect(birthDateProblem('2026-10-04', today)).toBe('future');
    expect(birthDateProblem('1900-01-01', today)).toBe('implausible');
    expect(birthDateProblem('2010-02-29', today)).toBe('invalid');
    expect(birthDateProblem('2010-13-01', today)).toBe('invalid');
    expect(birthDateProblem('15.06.2008', today)).toBe('invalid');
  });
});

describe('parseIsoDate and utcDate', () => {
  it('parses real dates only', () => {
    expect(parseIsoDate('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(parseIsoDate('2023-02-29')).toBeNull();
    expect(parseIsoDate('2023-04-31')).toBeNull();
  });
  it('uses the UTC calendar date', () => {
    expect(utcDate(new Date('2026-10-02T23:30:00-03:00'))).toBe('2026-10-03');
    expect(utcDate(new Date('2026-10-03T01:30:00+03:00'))).toBe('2026-10-02');
  });
});

describe('nthBirthday', () => {
  it.each([
    ['2010-06-15', 2, '2012-06-15'],
    ['2008-02-29', 2, '2010-03-01'],
    ['2008-02-29', 4, '2012-02-29'],
    ['2009-12-31', 18, '2027-12-31'],
  ])('%s + %i years → %s', (birth, n, expected) => {
    expect(nthBirthday(birth, n)).toBe(expected);
  });

  it('is the first day the age reaches n', () => {
    for (const birth of ['2010-06-15', '2008-02-29', '2011-03-01', '2009-12-31']) {
      const second = nthBirthday(birth, 2);
      expect(ageOn(birth, second)).toBe(2);
      expect(ageOn(birth, shift(second, -1))).toBe(1);
    }
  });
});

/** `date` moved by `days` (UTC calendar). */
function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return utcDate(d);
}

describe('birthDatesWithinYears (Q14: at most 2 calendar years apart)', () => {
  it.each([
    ['the same day', '2010-06-15', '2010-06-15', true],
    ['one day apart', '2010-06-15', '2010-06-16', true],
    ['exactly two years apart', '2010-06-15', '2012-06-15', true],
    ['two years and a day apart', '2010-06-15', '2012-06-16', false],
    ['one day short of two years', '2010-06-15', '2012-06-14', true],
    ['three years apart', '2010-06-15', '2013-06-15', false],
    ['Feb 29, up to Mar 1 two years later', '2008-02-29', '2010-03-01', true],
    ['Feb 29, Mar 2 two years later', '2008-02-29', '2010-03-02', false],
    ['Feb 29 to Feb 29 four years later', '2008-02-29', '2012-02-29', false],
    ['across a year end', '2009-12-31', '2011-12-31', true],
    ['across a year end, one day more', '2009-12-31', '2012-01-01', false],
  ])('%s', (_label, a, b, expected) => {
    expect(birthDatesWithinYears(a, b, 2)).toBe(expected);
    expect(birthDatesWithinYears(b, a, 2)).toBe(expected);
  });

  it('means the older person had not turned `years` the day before the younger was born', () => {
    // Every day within about 3.5 years after each start date, including Feb 29 births.
    for (const earlier of ['2008-02-29', '2008-03-01', '2009-12-31', '2010-06-15', '2012-02-28']) {
      for (let days = 1; days <= 1300; days++) {
        const later = shift(earlier, days);
        const expected = ageOn(earlier, shift(later, -1)) < 2;
        expect([later, birthDatesWithinYears(earlier, later, 2)]).toEqual([later, expected]);
      }
    }
  });

  it('throws on invalid dates instead of guessing', () => {
    expect(() => birthDatesWithinYears('2010-02-30', '2010-06-15', 2)).toThrow(/not a valid/);
  });
});
