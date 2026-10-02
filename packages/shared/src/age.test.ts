import { describe, expect, it } from 'vitest';
import { ageOn, bandFor, birthDateProblem, parseIsoDate, utcDate } from './age';

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
