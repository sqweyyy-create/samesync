import { describe, expect, it } from 'vitest';
import {
  MAX_SEND_ATTEMPTS,
  dropReason,
  isQuietHour,
  localHour,
  retryDelayMs,
  type SendContext,
} from './notifications';

const recipient: NonNullable<SendContext['recipient']> = {
  telegramId: 42,
  locale: 'ru',
  status: 'active',
  botReachable: true,
  synthetic: false,
  timezone: 'Europe/Moscow',
  liveBand: 'adult',
};
const match: NonNullable<SendContext['match']> = {
  id: 'm1',
  status: 'pending_game',
  band: 'adult',
  teaser: {},
  counterpartAlias: 'a.fox',
  counterpartStatus: 'active',
  counterpartLiveBand: 'adult',
};
const reason = (r: Partial<typeof recipient> | null, m: Partial<typeof match> | null = {}) =>
  dropReason({
    recipient: r && { ...recipient, ...r },
    match: m && { ...match, ...m },
  });

describe('dropReason: the checks made right before a notification is sent', () => {
  it('lets a message through when everything still holds', () => {
    expect(reason({})).toBeNull();
    expect(reason({}, { status: 'results_ready' })).toBeNull();
    expect(reason({}, { status: 'active' })).toBeNull();
  });

  it.each([
    ['a closed match', {}, { status: 'closed' as const }, 'match_closed'],
    ['an expired match', {}, { status: 'expired' as const }, 'match_closed'],
    [
      'a recipient who is an adult now in a u18 match',
      {},
      { band: 'u18' as const, counterpartLiveBand: 'u18' as const },
      'band_mismatch',
    ],
    [
      'a counterpart who is an adult now in a u18 match',
      { liveBand: 'u18' as const },
      { band: 'u18' as const },
      'band_mismatch',
    ],
    ['a recipient with no band', { liveBand: null }, {}, 'band_mismatch'],
    ['a counterpart with no band', {}, { counterpartLiveBand: null }, 'band_mismatch'],
    ['a frozen recipient', { status: 'frozen' as const }, {}, 'recipient_frozen'],
    ['a deleted recipient', { status: 'deleted' as const }, {}, 'recipient_not_active'],
    [
      'a frozen counterpart',
      {},
      { counterpartStatus: 'frozen' as const },
      'counterpart_not_active',
    ],
    ['a synthetic recipient', { synthetic: true }, {}, 'synthetic_user'],
    ['a recipient the bot cannot reach', { botReachable: false }, {}, 'bot_unreachable'],
    ['a recipient who is not in the match', {}, { counterpartAlias: null }, 'not_participant'],
  ])('drops a message for %s', (_label, r, m, expected) => {
    expect(reason(r, m)).toBe(expected);
  });

  it('drops a message whose recipient or match no longer exists (fail closed)', () => {
    expect(reason(null)).toBe('recipient_missing');
    expect(reason({}, null)).toBe('match_missing');
  });

  it('never sends to a synthetic user, whatever else is true', () => {
    expect(reason({ synthetic: true, status: 'frozen' }, { status: 'closed' })).toBe(
      'synthetic_user',
    );
  });
});

describe('quiet hours (Q22: sent silently between 23:00 and 08:00 local time, never held)', () => {
  const at = (iso: string) => new Date(iso);

  it.each([
    ['22:59', '2026-10-03T19:59:00Z', false],
    ['23:00', '2026-10-03T20:00:00Z', true],
    ['03:30', '2026-10-04T00:30:00Z', true],
    ['07:59', '2026-10-04T04:59:00Z', true],
    ['08:00', '2026-10-04T05:00:00Z', false],
    ['14:00', '2026-10-03T11:00:00Z', false],
  ])('%s in Moscow', (_local, utc, quiet) => {
    expect(isQuietHour(at(utc), 'Europe/Moscow', 'UTC')).toBe(quiet);
  });

  it('uses the user time zone, not the server one', () => {
    // 20:00 UTC is 23:00 in Moscow, 13:00 in Los Angeles and 05:00 the next day in Tokyo.
    const now = at('2026-10-03T20:00:00Z');
    expect(localHour(now, 'America/Los_Angeles')).toBe(13);
    expect(isQuietHour(now, 'America/Los_Angeles', 'UTC')).toBe(false);
    expect(isQuietHour(now, 'Asia/Tokyo', 'UTC')).toBe(true);
  });

  it('falls back to the pool time zone when the user has none or an unknown one', () => {
    const now = at('2026-10-03T20:30:00Z');
    expect(isQuietHour(now, null, 'Europe/Moscow')).toBe(true);
    expect(isQuietHour(now, null, 'UTC')).toBe(false);
    expect(isQuietHour(now, 'Not/AZone', 'Europe/Moscow')).toBe(true);
    expect(isQuietHour(now, 'Not/AZone', 'Also/Wrong')).toBe(false);
  });
});

describe('retry backoff', () => {
  it('doubles from 30 seconds and is capped at an hour', () => {
    expect([1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000]);
    expect(retryDelayMs(20)).toBe(3_600_000);
    expect(MAX_SEND_ATTEMPTS).toBe(6);
  });
});
