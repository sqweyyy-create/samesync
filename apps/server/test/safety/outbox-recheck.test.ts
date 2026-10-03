/**
 * SAFETY SUITE — the outbox sender re-checks everything right before a Telegram call (CLAUDE.md
 * invariants 1, 3 and 9). A notification that was fine when it was queued is dropped, with the
 * reason recorded, if by send time the match is closed, a live band no longer equals the match
 * band, or a user is frozen. The states below are built with the triggers switched off, to prove
 * the sender does not rely on them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db';
import {
  insertActiveUser,
  insertMatch,
  insertOutbox,
  matchRow,
  outboxRow,
  withoutTriggers,
} from '../support/matches';
import { buildSender } from '../support/notify';
import { birthDateYearsAgo, type InsertUser } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

/** A pending "new match" notification for each of two matched users. */
async function queued(
  overA: InsertUser = {},
  overB: InsertUser = {},
  band: 'adult' | 'u18' = 'adult',
) {
  const birthDate = birthDateYearsAgo(band === 'adult' ? 25 : 16);
  const a = await insertActiveUser(testDb.appPool, { birthDate, ...overA });
  const b = await insertActiveUser(testDb.appPool, { birthDate, ...overB });
  const match = await insertMatch(testDb.appPool, { a: a.id, b: b.id, band });
  const toA = await insertOutbox(testDb.appPool, { userId: a.id, matchId: match.id });
  const toB = await insertOutbox(testDb.appPool, { userId: b.id, matchId: match.id });
  return { a, b, match, toA, toB };
}
/** Sends everything that is due, in rounds, and returns the Telegram IDs that got a message. */
async function sendAll() {
  const { sender, calls } = await buildSender(testDb, { now: new Date(Date.now() + 60_000) });
  for (let round = 0; round < 20; round++) {
    const { sent, cancelled, failed, retried } = await sender.tick();
    if (sent + cancelled + failed + retried === 0) break;
  }
  return calls.map((c) => c.payload.chat_id);
}
const raw = (sql: string, params: unknown[]) =>
  withoutTriggers(testDb.ownerPool, (c) => c.query(sql, params));

describe('the outbox sender', () => {
  it('sends when the match is open, both users are active and both are in the match band', async () => {
    const { a, b, toA, toB } = await queued();
    const sentTo = await sendAll();
    expect(sentTo).toEqual(expect.arrayContaining([a.telegramId, b.telegramId]));
    expect(await outboxRow(testDb.ownerPool, toA.id)).toMatchObject({ status: 'sent' });
    expect(await outboxRow(testDb.ownerPool, toB.id)).toMatchObject({ status: 'sent' });
  });

  it('drops both messages of a closed match and records why', async () => {
    const { a, b, match, toA, toB } = await queued();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [match.id],
    );
    const sentTo = await sendAll();
    expect(sentTo).not.toContain(a.telegramId);
    expect(sentTo).not.toContain(b.telegramId);
    for (const row of [toA, toB]) {
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'match_closed',
      });
    }
  });

  it('drops messages when a live band differs from the match band, although the cache is stale', async () => {
    // A u18 match. One user is 18 as of today, but the cached band still says u18 and the match is
    // still open: exactly the state between an 18th birthday and the next age-transition run.
    const { a, b, match, toA, toB } = await queued({}, {}, 'u18');
    await raw('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(18), a.id]);
    const state = await testDb.ownerPool.query<{ age_band: string; live: string }>(
      'SELECT age_band, vc_band(birth_date, vc_today())::text AS live FROM users WHERE id = $1',
      [a.id],
    );
    expect(state.rows[0]).toEqual({ age_band: 'u18', live: 'adult' });
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({ status: 'pending_game' });

    const sentTo = await sendAll();
    // Neither the new adult nor the minor is told about the other.
    expect(sentTo).not.toContain(a.telegramId);
    expect(sentTo).not.toContain(b.telegramId);
    for (const row of [toA, toB]) {
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'band_mismatch',
      });
    }
  });

  it('drops messages to and about a frozen user, even if the freeze did not close the match', async () => {
    const { a, b, toA, toB } = await queued();
    // Frozen with the triggers off: the match is still open and the rows are still pending.
    await raw("UPDATE users SET status = 'frozen' WHERE id = $1", [a.id]);
    const sentTo = await sendAll();
    expect(sentTo).not.toContain(a.telegramId);
    expect(sentTo).not.toContain(b.telegramId);
    expect(await outboxRow(testDb.ownerPool, toA.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'recipient_frozen',
    });
    expect(await outboxRow(testDb.ownerPool, toB.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'counterpart_not_active',
    });
  });

  it('drops a message addressed to someone who is not in the match', async () => {
    const { match } = await queued();
    const stranger = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const row = await insertOutbox(testDb.appPool, { userId: stranger.id, matchId: match.id });
    const sentTo = await sendAll();
    expect(sentTo).not.toContain(stranger.telegramId);
    expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'not_participant',
    });
  });

  it('never sends a dropped message later, whatever changes afterwards', async () => {
    const { a, match, toA } = await queued();
    await raw("UPDATE users SET status = 'frozen' WHERE id = $1", [a.id]);
    await sendAll();
    await raw("UPDATE users SET status = 'active' WHERE id = $1", [a.id]);
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({ status: 'pending_game' });
    expect(await sendAll()).not.toContain(a.telegramId);
    expect(await outboxRow(testDb.ownerPool, toA.id)).toMatchObject({ status: 'cancelled' });
  });

  it('two senders at once never send the same message twice', async () => {
    const pairs = await Promise.all(Array.from({ length: 6 }, () => queued()));
    const first = await buildSender(testDb, { now: new Date(Date.now() + 60_000) });
    const second = await buildSender(testDb, { now: new Date(Date.now() + 60_000) });
    await Promise.all([first.sender.tick(), second.sender.tick()]);
    await Promise.all([first.sender.tick(), second.sender.tick()]);
    const all = [...first.calls, ...second.calls].map((c) => c.payload.chat_id);
    const mine = pairs.flatMap((p) => [p.a.telegramId, p.b.telegramId]);
    for (const telegramId of mine) {
      expect(all.filter((id) => id === telegramId)).toHaveLength(1);
    }
  });
});
