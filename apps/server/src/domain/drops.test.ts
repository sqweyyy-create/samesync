import { describe, expect, it } from 'vitest';
import { latestDropSlot } from './drops';

const iso = (date: Date) => date.toISOString();
const MOSCOW = { times: ['13:00', '20:00'], timeZone: 'Europe/Moscow' };

describe('latestDropSlot', () => {
  it('finds the most recent drop in the pool time zone (Moscow is UTC+3)', () => {
    const slot = (now: string) => iso(latestDropSlot(new Date(now), MOSCOW));
    expect(slot('2026-10-03T10:00:00Z')).toBe('2026-10-03T10:00:00.000Z'); // 13:00 exactly
    expect(slot('2026-10-03T11:30:00Z')).toBe('2026-10-03T10:00:00.000Z'); // 14:30
    expect(slot('2026-10-03T17:00:00Z')).toBe('2026-10-03T17:00:00.000Z'); // 20:00 exactly
    expect(slot('2026-10-03T22:30:00Z')).toBe('2026-10-03T17:00:00.000Z'); // 01:30 next day
  });

  it('goes back to yesterday before the first drop of the day', () => {
    // 12:59 in Moscow: the last drop was yesterday at 20:00.
    expect(iso(latestDropSlot(new Date('2026-10-03T09:59:59Z'), MOSCOW))).toBe(
      '2026-10-02T17:00:00.000Z',
    );
  });

  it('works in UTC and with a single or unordered list of times', () => {
    const utc = { times: ['20:00', '13:00'], timeZone: 'UTC' };
    expect(iso(latestDropSlot(new Date('2026-10-03T13:00:01Z'), utc))).toBe(
      '2026-10-03T13:00:00.000Z',
    );
    expect(
      iso(latestDropSlot(new Date('2026-10-03T08:00:00Z'), { times: ['09:30'], timeZone: 'UTC' })),
    ).toBe('2026-10-02T09:30:00.000Z');
  });

  it('follows daylight saving time in zones that have it', () => {
    const berlin = { times: ['13:00'], timeZone: 'Europe/Berlin' };
    // Winter time (UTC+1) the day before the switch, summer time (UTC+2) from 2026-03-29.
    expect(iso(latestDropSlot(new Date('2026-03-28T20:00:00Z'), berlin))).toBe(
      '2026-03-28T12:00:00.000Z',
    );
    expect(iso(latestDropSlot(new Date('2026-03-29T20:00:00Z'), berlin))).toBe(
      '2026-03-29T11:00:00.000Z',
    );
    // And back on 2026-10-25.
    expect(iso(latestDropSlot(new Date('2026-10-25T20:00:00Z'), berlin))).toBe(
      '2026-10-25T12:00:00.000Z',
    );
  });

  it('never returns a slot in the future', () => {
    for (let hour = 0; hour < 48; hour++) {
      const now = new Date(Date.UTC(2026, 9, 3, hour, 17));
      expect(latestDropSlot(now, MOSCOW).getTime()).toBeLessThanOrEqual(now.getTime());
    }
  });

  it('needs at least one time', () => {
    expect(() => latestDropSlot(new Date(), { times: [], timeZone: 'UTC' })).toThrow();
  });
});
