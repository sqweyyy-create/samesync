import { describe, expect, it } from 'vitest';
import {
  MAX_SEND_ATTEMPTS,
  NOTIFICATION_KINDS,
  dropReason,
  hoursLeft,
  isQuietHour,
  localHour,
  retryDelayMs,
  type NotificationKind,
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
  recipientDone: false,
  gameDeadlineAt: Date.UTC(2026, 9, 6, 12),
  closeReason: null,
  chatDeadlineAt: null,
  reveal: { recipientConsented: false, counterpartConsented: false, revealed: false },
  counterpart: { telegramId: 43, synthetic: false },
};
const reason = (
  r: Partial<typeof recipient> | null,
  m: Partial<typeof match> | null = {},
  kind: NotificationKind = 'match_created',
) =>
  dropReason(kind, {
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

describe('dropReason for the game notifications', () => {
  /** A match state in which a message of each kind is still right. */
  const VALID: Record<NotificationKind, Partial<typeof match>> = {
    match_created: {},
    game_turn: {},
    game_reminder: {},
    game_results: { status: 'results_ready', recipientDone: true },
    game_expired: { status: 'expired', recipientDone: false },
    chat_reminder: { status: 'results_ready' },
    chat_expired: { status: 'expired', closeReason: 'expired' },
    chat_ended: { status: 'closed', closeReason: 'left' },
    reveal_request: {
      status: 'active',
      reveal: { recipientConsented: false, counterpartConsented: true, revealed: false },
    },
    reveal_done: {
      status: 'active',
      reveal: { recipientConsented: true, counterpartConsented: true, revealed: true },
    },
  };

  it('sends "your turn" and the reminder only while the game is on and the recipient has not played', () => {
    for (const kind of ['game_turn', 'game_reminder'] as const) {
      expect(reason({}, {}, kind)).toBeNull();
      expect(reason({}, { recipientDone: true }, kind)).toBe('outdated');
      expect(reason({}, { status: 'results_ready', recipientDone: true }, kind)).toBe('outdated');
      expect(reason({}, { status: 'active', recipientDone: true }, kind)).toBe('outdated');
      expect(reason({}, { status: 'expired' }, kind)).toBe('match_closed');
      expect(reason({}, { status: 'closed' }, kind)).toBe('match_closed');
      // A match without a game has nobody to remind.
      expect(reason({}, { recipientDone: null }, kind)).toBe('outdated');
    }
  });

  it('sends "results are ready" only for an open match whose game is finished', () => {
    expect(reason({}, { status: 'results_ready', recipientDone: true }, 'game_results')).toBeNull();
    expect(reason({}, { status: 'active', recipientDone: true }, 'game_results')).toBeNull();
    expect(reason({}, { status: 'pending_game' }, 'game_results')).toBe('outdated');
    expect(reason({}, { status: 'closed' }, 'game_results')).toBe('match_closed');
    expect(reason({}, { status: 'expired' }, 'game_results')).toBe('match_closed');
  });

  it('sends the expiry notice only for an expired match', () => {
    expect(reason({}, { status: 'expired' }, 'game_expired')).toBeNull();
    for (const status of ['pending_game', 'results_ready', 'active', 'closed'] as const) {
      expect(reason({}, { status }, 'game_expired')).toBe('outdated');
    }
  });

  it.each(NOTIFICATION_KINDS)(
    'never sends %s across bands, to or about a frozen user, or to a synthetic one',
    (kind) => {
      const valid = VALID[kind];
      expect(reason({}, valid, kind)).toBeNull();
      expect(reason({ liveBand: 'u18' }, valid, kind)).toBe('band_mismatch');
      expect(reason({}, { ...valid, counterpartLiveBand: 'u18' }, kind)).toBe('band_mismatch');
      expect(reason({}, { ...valid, counterpartLiveBand: null }, kind)).toBe('band_mismatch');
      expect(reason({ status: 'frozen' }, valid, kind)).toBe('recipient_frozen');
      expect(reason({}, { ...valid, counterpartStatus: 'frozen' }, kind)).toBe(
        'counterpart_not_active',
      );
      expect(reason({ synthetic: true }, valid, kind)).toBe('synthetic_user');
      expect(reason({ botReachable: false }, valid, kind)).toBe('bot_unreachable');
      expect(reason({}, { ...valid, counterpartAlias: null }, kind)).toBe('not_participant');
      expect(reason({}, null, kind)).toBe('match_missing');
    },
  );
});

describe('dropReason for the chat notifications', () => {
  it('reminds about the first message only while nobody has written, where a chat is possible', () => {
    expect(reason({}, { status: 'results_ready' }, 'chat_reminder')).toBeNull();
    expect(reason({}, { status: 'active' }, 'chat_reminder')).toBe('outdated');
    expect(reason({}, { status: 'pending_game' }, 'chat_reminder')).toBe('outdated');
    expect(reason({}, { status: 'expired' }, 'chat_reminder')).toBe('match_closed');
    expect(reason({}, { status: 'closed' }, 'chat_reminder')).toBe('match_closed');
    // Nobody can write in a u18 chat yet, so nobody is told to.
    expect(
      reason(
        { liveBand: 'u18' },
        { status: 'results_ready', band: 'u18', counterpartLiveBand: 'u18' },
        'chat_reminder',
      ),
    ).toBe('outdated');
  });

  it('sends the chat expiry notice only for an expired match', () => {
    expect(reason({}, { status: 'expired', closeReason: 'expired' }, 'chat_expired')).toBeNull();
    for (const status of ['pending_game', 'results_ready', 'active', 'closed'] as const) {
      expect(reason({}, { status }, 'chat_expired')).toBe('outdated');
    }
  });

  it('says that a chat has ended only when the other person left it', () => {
    expect(reason({}, { status: 'closed', closeReason: 'left' }, 'chat_ended')).toBeNull();
    for (const closeReason of ['band_change', 'frozen', 'blocked', 'admin', 'deleted'] as const) {
      expect(reason({}, { status: 'closed', closeReason }, 'chat_ended')).toBe('outdated');
    }
    expect(reason({}, { status: 'expired', closeReason: 'expired' }, 'chat_ended')).toBe(
      'outdated',
    );
    expect(reason({}, { status: 'active' }, 'chat_ended')).toBe('outdated');
  });

  const asked = { recipientConsented: false, counterpartConsented: true, revealed: false };
  const done = { recipientConsented: true, counterpartConsented: true, revealed: true };
  const u18 = { band: 'u18' as const, counterpartLiveBand: 'u18' as const };

  it('asks for consent only while the other consent stands and the recipient has not answered', () => {
    for (const status of ['results_ready', 'active'] as const) {
      expect(reason({}, { status, reveal: asked }, 'reveal_request')).toBeNull();
    }
    expect(reason({}, { status: 'active' }, 'reveal_request')).toBe('outdated');
    expect(
      reason(
        {},
        { status: 'active', reveal: { ...asked, recipientConsented: true } },
        'reveal_request',
      ),
    ).toBe('outdated');
    expect(reason({}, { status: 'active', reveal: done }, 'reveal_request')).toBe('outdated');
    expect(reason({}, { status: 'pending_game', reveal: asked }, 'reveal_request')).toBe(
      'outdated',
    );
    expect(reason({}, { status: 'closed', reveal: asked }, 'reveal_request')).toBe('match_closed');
  });

  it('sends a username only for a reveal recorded for both, in an open chat', () => {
    for (const status of ['results_ready', 'active'] as const) {
      expect(reason({}, { status, reveal: done }, 'reveal_done')).toBeNull();
    }
    expect(reason({}, { status: 'active', reveal: asked }, 'reveal_done')).toBe('outdated');
    expect(
      reason({}, { status: 'active', reveal: { ...done, revealed: false } }, 'reveal_done'),
    ).toBe('outdated');
    expect(
      reason(
        {},
        { status: 'active', reveal: { ...done, recipientConsented: false } },
        'reveal_done',
      ),
    ).toBe('outdated');
    expect(reason({}, { status: 'closed', reveal: done }, 'reveal_done')).toBe('match_closed');
    expect(reason({}, { status: 'expired', reveal: done }, 'reveal_done')).toBe('match_closed');
  });

  it.each(['reveal_request', 'reveal_done'] as const)(
    'never sends %s in a u18 match, whatever the consent rows say',
    (kind) => {
      for (const reveal of [asked, done]) {
        expect(reason({ liveBand: 'u18' }, { status: 'active', ...u18, reveal }, kind)).toBe(
          'reveal_not_allowed',
        );
      }
      // And never to or about someone who is under 18 by birth date in an "adult" match.
      const valid = kind === 'reveal_request' ? asked : done;
      expect(reason({ liveBand: 'u18' }, { status: 'active', reveal: valid }, kind)).toBe(
        'band_mismatch',
      );
      expect(
        reason({}, { status: 'active', reveal: valid, counterpartLiveBand: 'u18' }, kind),
      ).toBe('band_mismatch');
    },
  );
});

describe('hoursLeft', () => {
  const deadline = Date.UTC(2026, 9, 6, 12);
  it('rounds up to whole hours and never goes below one', () => {
    expect(hoursLeft(new Date(deadline - 12 * 3_600_000), deadline)).toBe(12);
    expect(hoursLeft(new Date(deadline - 11.2 * 3_600_000), deadline)).toBe(12);
    expect(hoursLeft(new Date(deadline - 60_000), deadline)).toBe(1);
    expect(hoursLeft(new Date(deadline + 60_000), deadline)).toBe(1);
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
