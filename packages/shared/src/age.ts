/**
 * Ages and age bands (CLAUDE.md safety invariants). The SQL twin is `vc_age_years()`; a property
 * test checks that both agree (apps/server/test/safety/age-sql-parity.test.ts).
 *
 * Rules (PLAN.md Q15, decided): ages use UTC calendar dates, and a Feb 29 birthday falls on Mar 1
 * in non-leap years, which is what Postgres `age()` does.
 */
import type { Band } from './domain';

export const MIN_AGE = 14;
export const ADULT_AGE = 18;
/** Older than this is treated as a typo, not a real birth date. */
export const MAX_AGE = 120;

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
}

/** Parses a real calendar date in `YYYY-MM-DD` form; anything else (2026-02-30) is null. */
export function parseIsoDate(value: string): CalendarDate | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null;
  return { year, month, day };
}

/** Today's date in UTC as `YYYY-MM-DD`. */
export function utcDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const pad2 = (n: number) => String(n).padStart(2, '0');

function compare(a: CalendarDate, b: CalendarDate): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

function mustParse(value: string): CalendarDate {
  const date = parseIsoDate(value);
  if (!date) throw new Error(`not a valid YYYY-MM-DD date: ${value}`);
  return date;
}

/**
 * Completed years between `birthDate` and `onDate` (both `YYYY-MM-DD`). Throws if `onDate` is
 * before `birthDate`: there is no age then (the SQL twin returns NULL).
 */
export function ageOn(birthDate: string, onDate: string): number {
  const birth = mustParse(birthDate);
  const on = mustParse(onDate);
  if (compare(on, birth) < 0) throw new Error(`${onDate} is before the birth date ${birthDate}`);
  let { month, day } = birth;
  if (month === 2 && day === 29 && !isLeapYear(on.year)) {
    month = 3;
    day = 1;
  }
  const hadBirthday = on.month > month || (on.month === month && on.day >= day);
  return on.year - birth.year - (hadBirthday ? 0 : 1);
}

/** The `n`th birthday as `YYYY-MM-DD`, by the same Q15 rule as `ageOn` (Feb 29 → Mar 1). */
export function nthBirthday(birthDate: string, n: number): string {
  const birth = mustParse(birthDate);
  const year = birth.year + n;
  const moved = birth.month === 2 && birth.day === 29 && !isLeapYear(year);
  const month = moved ? 3 : birth.month;
  const day = moved ? 1 : birth.day;
  return [String(year).padStart(4, '0'), pad2(month), pad2(day)].join('-');
}

/**
 * True when two birth dates are at most `years` calendar years apart (PLAN.md Q14: the gap never
 * changes over time). The younger person is born no later than the older one's `years`-th
 * birthday. The SQL twin is `vc_within_years()`; a property test checks that both agree.
 */
export function birthDatesWithinYears(a: string, b: string, years: number): boolean {
  mustParse(a);
  mustParse(b);
  // ISO dates with 4-digit years sort as text.
  const [earlier, later] = a <= b ? [a, b] : [b, a];
  return later <= nthBirthday(earlier, years);
}

/** How far the default partner age range reaches on each side of the user's own age (Q12). */
export const DATING_AGE_SPREAD = 5;

/** Default partner age range in dating mode (Q12): own age ±5 years, never below 18. */
export function defaultDatingAgeRange(age: number): { min: number; max: number } {
  return {
    min: Math.max(ADULT_AGE, age - DATING_AGE_SPREAD),
    max: Math.min(MAX_AGE, Math.max(ADULT_AGE, age + DATING_AGE_SPREAD)),
  };
}

/** `u18` for 14–17, `adult` for 18+, null below 14 (no profile, no matching). */
export function bandFor(age: number): Band | null {
  if (age >= ADULT_AGE) return 'adult';
  if (age >= MIN_AGE) return 'u18';
  return null;
}

export type BirthDateProblem = 'invalid' | 'future' | 'implausible';

/** Why a submitted birth date can't be accepted, or null if it can. */
export function birthDateProblem(birthDate: string, today: string): BirthDateProblem | null {
  const birth = parseIsoDate(birthDate);
  if (!birth) return 'invalid';
  if (compare(birth, mustParse(today)) > 0) return 'future';
  if (ageOn(birthDate, today) > MAX_AGE) return 'implausible';
  return null;
}
