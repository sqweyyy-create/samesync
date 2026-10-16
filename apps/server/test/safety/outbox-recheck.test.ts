/**
 * SAFETY SUITE — the outbox sender re-checks everything right before a Telegram call (CLAUDE.md
 * invariants 1, 3 and 9). A notification that was fine when it was queued is dropped, with the
 * reason recorded, if by send time the match is closed, a live band no longer equals the match
 * band, or a user is frozen. The states below are built with the triggers switched off, to prove
 * the sender does not rely on them. This holds for every kind of notification, the game's and the
 * chat's too. The one notification that carries a username is sent only between two adults who
 * both consented (invariant 6).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NotificationKind } from '../../src/domain/notifications';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertGame } from '../support/games';
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

describe('the game notifications are re-checked like every other', () => {
  const GAME_KINDS = ['game_turn', 'game_reminder', 'game_results', 'game_expired'] as const;

  /** Two matched users with a game, and one pending notification of `kind` for each of them. */
  async function queuedGame(kind: NotificationKind, band: 'adult' | 'u18' = 'adult') {
    const birthDate = birthDateYearsAgo(band === 'adult' ? 25 : 16);
    const a = await insertActiveUser(testDb.appPool, { birthDate });
    const b = await insertActiveUser(testDb.appPool, { birthDate });
    const match = await insertMatch(testDb.appPool, { a: a.id, b: b.id, band });
    await insertGame(testDb.appPool, match.id);
    // The state each kind is about: results are ready, or the game ran out of time.
    if (kind === 'game_results') {
      await raw('UPDATE games SET a_done_at = now(), b_done_at = now() WHERE match_id = $1', [
        match.id,
      ]);
      await raw(
        `UPDATE matches SET status = 'results_ready', results_ready_at = now(),
           chat_deadline_at = now() + interval '48 hours' WHERE id = $1`,
        [match.id],
      );
    }
    if (kind === 'game_expired') {
      await raw(
        "UPDATE matches SET status = 'expired', close_reason = 'expired', closed_at = now() WHERE id = $1",
        [match.id],
      );
    }
    const toA = await insertOutbox(testDb.appPool, { userId: a.id, matchId: match.id, kind });
    const toB = await insertOutbox(testDb.appPool, { userId: b.id, matchId: match.id, kind });
    return { a, b, match, toA, toB };
  }

  it.each(GAME_KINDS)('%s is sent while everything still holds', async (kind) => {
    const { a, b, toA, toB } = await queuedGame(kind);
    const sentTo = await sendAll();
    expect(sentTo).toEqual(expect.arrayContaining([a.telegramId, b.telegramId]));
    for (const row of [toA, toB]) {
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({ status: 'sent' });
    }
  });

  it.each(GAME_KINDS)(
    '%s is dropped for both users when a live band differs from the match band, with a stale cache',
    async (kind) => {
      const { a, b, toA, toB } = await queuedGame(kind, 'u18');
      await raw('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(18), a.id]);
      const sentTo = await sendAll();
      expect(sentTo).not.toContain(a.telegramId);
      expect(sentTo).not.toContain(b.telegramId);
      for (const row of [toA, toB]) {
        expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'band_mismatch',
        });
      }
    },
  );

  it.each(GAME_KINDS)('%s is dropped to and about a frozen user', async (kind) => {
    const { a, b, toA, toB } = await queuedGame(kind);
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

  it('a game notification of a match closed for a band change is never sent', async () => {
    const { a, b, toA, toB } = await queuedGame('game_turn', 'u18');
    await testDb.ownerPool.query(
      "SELECT admin_set_birth_date($1, $2::date, 777, 'age correction')",
      [a.id, birthDateYearsAgo(18)],
    );
    // The state-change trigger already cancelled both rows in the same transaction.
    for (const row of [toA, toB]) {
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'band_change',
      });
    }
    const sentTo = await sendAll();
    expect(sentTo).not.toContain(a.telegramId);
    expect(sentTo).not.toContain(b.telegramId);
  });
});

describe('the chat notifications are re-checked like every other', () => {
  const CHAT_KINDS = [
    'chat_reminder',
    'chat_expired',
    'chat_ended',
    'reveal_request',
    'reveal_done',
  ] as const;
  type ChatKind = (typeof CHAT_KINDS)[number];

  const consent = (matchId: string, userId: string, revealed: boolean) =>
    raw(
      `INSERT INTO reveal_consents (match_id, user_id, consented_at, revealed_at)
       VALUES ($1, $2, now(), CASE WHEN $3 THEN now() END)`,
      [matchId, userId, revealed],
    );

  /**
   * Two matched users whose game is finished, in the state a notification of `kind` is about,
   * with that notification pending for each of them. A reveal request only goes to the one who
   * has not consented: user B.
   */
  async function queuedChat(kind: ChatKind, band: 'adult' | 'u18' = 'adult') {
    const birthDate = birthDateYearsAgo(band === 'adult' ? 25 : 16);
    const first = await insertActiveUser(testDb.appPool, { birthDate });
    const second = await insertActiveUser(testDb.appPool, { birthDate });
    const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id, band });
    const [a, b] = first.id === match.userA ? [first, second] : [second, first];
    await insertGame(testDb.appPool, match.id);
    await raw('UPDATE games SET a_done_at = now(), b_done_at = now() WHERE match_id = $1', [
      match.id,
    ]);
    await raw(
      `UPDATE matches SET status = 'results_ready', results_ready_at = now(),
         chat_deadline_at = now() + interval '48 hours' WHERE id = $1`,
      [match.id],
    );
    if (kind === 'chat_expired') {
      await raw(
        "UPDATE matches SET status = 'expired', close_reason = 'expired', closed_at = now() WHERE id = $1",
        [match.id],
      );
    }
    if (kind === 'chat_ended') {
      await raw(
        "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
        [match.id],
      );
    }
    // Written with the triggers off: for a u18 match the database itself would refuse them.
    if (kind === 'reveal_request') await consent(match.id, a.id, false);
    if (kind === 'reveal_done') {
      await consent(match.id, a.id, true);
      await consent(match.id, b.id, true);
    }
    const recipients = kind === 'reveal_request' ? [b] : [a, b];
    const rows = [];
    for (const user of recipients) {
      rows.push({
        user,
        ...(await insertOutbox(testDb.appPool, { userId: user.id, matchId: match.id, kind })),
      });
    }
    return { a, b, match, rows };
  }

  /** Sends everything due. Telegram knows a username for every account in `named`. */
  async function sendChat(named: Array<{ telegramId: number }> = []) {
    const usernames = new Map(named.map((u) => [u.telegramId, `name_of_${u.telegramId}`]));
    const { sender, calls, asked } = await buildSender(testDb, {
      now: new Date(Date.now() + 60_000),
      usernames,
    });
    for (let round = 0; round < 20; round++) {
      const { sent, cancelled, failed, retried } = await sender.tick();
      if (sent + cancelled + failed + retried === 0) break;
    }
    return { sentTo: calls.map((c) => c.payload.chat_id), calls, asked };
  }

  it.each(CHAT_KINDS)('%s is sent while everything still holds', async (kind) => {
    const { a, b, rows } = await queuedChat(kind);
    const { sentTo } = await sendChat([a, b]);
    for (const row of rows) {
      expect(sentTo).toContain(row.user.telegramId);
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({ status: 'sent' });
    }
  });

  it.each(CHAT_KINDS)(
    '%s is dropped when a live band differs from the match band, with a stale cache',
    async (kind) => {
      const { a, b, rows } = await queuedChat(kind);
      // An adult match one of whose users is 16 by birth date; `age_band` still says adult.
      await raw('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(16), a.id]);
      const { sentTo, asked } = await sendChat([a, b]);
      expect(sentTo).not.toContain(a.telegramId);
      expect(sentTo).not.toContain(b.telegramId);
      expect(asked).toEqual([]);
      for (const row of rows) {
        expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'band_mismatch',
        });
      }
    },
  );

  it.each(CHAT_KINDS)('%s is dropped to and about a frozen user', async (kind) => {
    const { a, b, rows } = await queuedChat(kind);
    await raw("UPDATE users SET status = 'frozen' WHERE id = $1", [a.id]);
    const { sentTo, asked } = await sendChat([a, b]);
    expect(sentTo).not.toContain(a.telegramId);
    expect(sentTo).not.toContain(b.telegramId);
    expect(asked).toEqual([]);
    for (const row of rows) {
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: row.user.id === a.id ? 'recipient_frozen' : 'counterpart_not_active',
      });
    }
  });

  it.each(['reveal_request', 'reveal_done'] as const)(
    '%s is never sent in a u18 match, even if consent rows existed, and Telegram is not asked for a username',
    async (kind) => {
      const { a, b, rows } = await queuedChat(kind, 'u18');
      const { sentTo, asked, calls } = await sendChat([a, b]);
      expect(sentTo).not.toContain(a.telegramId);
      expect(sentTo).not.toContain(b.telegramId);
      expect(asked).toEqual([]);
      expect(JSON.stringify(calls)).not.toContain('name_of_');
      for (const row of rows) {
        expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'reveal_not_allowed',
        });
      }
    },
  );

  it('a request to consent goes to one person once per match, whatever was queued after it', async () => {
    const { b, match, rows } = await queuedChat('reveal_request');
    const { sentTo } = await sendChat([b]);
    expect(sentTo).toEqual([b.telegramId]);
    // A consent that was taken back and given again (Q38) queues a question of its own.
    const again = await insertOutbox(testDb.appPool, {
      userId: b.id,
      matchId: match.id,
      kind: 'reveal_request',
      dedupeKey: `reveal_request:${match.id}:${b.id}:again`,
    });
    expect((await sendChat([b])).sentTo).toEqual([]);
    expect(await outboxRow(testDb.ownerPool, rows[0]!.id)).toMatchObject({ status: 'sent' });
    expect(await outboxRow(testDb.ownerPool, again.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'already_asked',
    });
  });

  it('a username is sent only for a reveal the database recorded for both', async () => {
    // One consent only; then two consents that are not marked revealed.
    for (const consents of [1, 2]) {
      const { a, b, match, rows } = await queuedChat('chat_reminder');
      await consent(match.id, a.id, false);
      if (consents === 2) await consent(match.id, b.id, false);
      const done = [];
      for (const user of [a, b]) {
        done.push(
          await insertOutbox(testDb.appPool, {
            userId: user.id,
            matchId: match.id,
            kind: 'reveal_done',
          }),
        );
      }
      const { asked, calls } = await sendChat([a, b]);
      expect(asked).toEqual([]);
      expect(JSON.stringify(calls)).not.toContain('name_of_');
      for (const row of done) {
        expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'outdated',
        });
      }
      // The reminder of the same chat is unaffected.
      expect(await outboxRow(testDb.ownerPool, rows[0]!.id)).toMatchObject({ status: 'sent' });
    }
  });

  it('the reveal message carries the other person username, read at that moment, and only that', async () => {
    const { a, b, rows } = await queuedChat('reveal_done');
    const { calls, asked } = await sendChat([a, b]);
    expect(asked.sort()).toEqual([a.telegramId, b.telegramId].sort());
    const toA = calls.find((c) => c.payload.chat_id === a.telegramId);
    const toB = calls.find((c) => c.payload.chat_id === b.telegramId);
    expect(toA?.payload.text).toContain(`@name_of_${b.telegramId}`);
    expect(toA?.payload.text).not.toContain(`name_of_${a.telegramId}`);
    expect(toB?.payload.text).toContain(`@name_of_${a.telegramId}`);
    expect(toB?.payload.text).not.toContain(`name_of_${b.telegramId}`);
    expect(rows).toHaveLength(2);
  });

  it('nothing is revealed to someone whose counterpart has no username right now', async () => {
    const { a, b, rows } = await queuedChat('reveal_done');
    // Telegram knows a username for B only.
    const { sentTo, calls } = await sendChat([b]);
    expect(sentTo).toEqual([a.telegramId]);
    expect(calls[0]?.payload.text).toContain(`@name_of_${b.telegramId}`);
    const toB = rows.find((r) => r.user.id === b.id)!;
    expect(await outboxRow(testDb.ownerPool, toB.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'username_missing',
    });
  });

  it('reminds both people of a u18 match to write, like in any other, now that the chat is open there', async () => {
    const { a, b, rows } = await queuedChat('chat_reminder', 'u18');
    const { sentTo } = await sendChat();
    expect(sentTo).toEqual(expect.arrayContaining([a.telegramId, b.telegramId]));
    for (const row of rows) {
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({ status: 'sent' });
    }
  });

  it('"this chat has ended" is said about a chat the other person left or blocked, or an admin acted on, and no other', async () => {
    for (const reason of ['blocked', 'reported']) {
      const { b, match } = await queuedChat('chat_reminder');
      await raw(
        "UPDATE matches SET status = 'closed', close_reason = $2, closed_at = now() WHERE id = $1",
        [match.id, reason],
      );
      const ended = await insertOutbox(testDb.appPool, {
        userId: b.id,
        matchId: match.id,
        kind: 'chat_ended',
      });
      const { sentTo } = await sendChat();
      expect(sentTo).toContain(b.telegramId);
      expect(await outboxRow(testDb.ownerPool, ended.id)).toMatchObject({ status: 'sent' });
    }
    for (const reason of ['admin', 'band_change', 'frozen', 'deleted']) {
      const { a, b, match, rows } = await queuedChat('chat_reminder');
      await raw(
        "UPDATE matches SET status = 'closed', close_reason = $2, closed_at = now() WHERE id = $1",
        [match.id, reason],
      );
      const ended = await insertOutbox(testDb.appPool, {
        userId: b.id,
        matchId: match.id,
        kind: 'chat_ended',
      });
      const { sentTo } = await sendChat();
      expect(sentTo).not.toContain(a.telegramId);
      expect(sentTo).not.toContain(b.telegramId);
      expect(await outboxRow(testDb.ownerPool, ended.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'outdated',
      });
      expect(await outboxRow(testDb.ownerPool, rows[0]!.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'match_closed',
      });
    }
  });
});
