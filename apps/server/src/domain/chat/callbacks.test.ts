import { describe, expect, it } from 'vitest';
import { CHAT_ACTIONS, encodeCallback, parseCallback } from './callbacks';

const MATCH = '01a10238-d68a-76a8-87cc-960f650dd8c3';

describe('button data of the chat', () => {
  it.each(CHAT_ACTIONS)('round-trips %s within the 64 bytes Telegram allows', (action) => {
    const data = encodeCallback(action, MATCH);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(parseCallback(data)).toEqual({ action, matchId: MATCH });
  });

  it.each([
    undefined,
    '',
    'c',
    'c:to',
    `c:to:${MATCH}:more`,
    `x:to:${MATCH}`,
    `c:delete:${MATCH}`,
    `c:TO:${MATCH}`,
    'c:to:not-a-uuid',
    `c:to:${MATCH} `,
    `c:to:${MATCH.slice(0, -1)}`,
    'c:to:../../etc/passwd',
    `c:to:${MATCH}`.padEnd(65, 'x'),
  ])('refuses %j', (data) => {
    expect(parseCallback(data)).toBeNull();
  });
});
