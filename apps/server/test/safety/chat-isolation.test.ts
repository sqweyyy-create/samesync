/**
 * SAFETY SUITE — the chat (CLAUDE.md invariants 1, 2, 3, 4, 5, 6 and 9; PLAN.md §3 layer 2).
 * A message goes from one user to the other, and a reveal shows each of them the other's username.
 * The first part skips the app and attacks the database directly as the app role: only a
 * participant of a match whose chat is open can store a message, both live bands must equal the
 * match band even when the cached `age_band` is stale, nothing is stored in a u18 match, a stored
 * message never changes, a chat starts only with a delivered message, usernames can be revealed
 * only between two adults who both consented, and a consent can be taken back only until then.
 * The second part drives the real relay through the bot and the API: it reads both users again
 * immediately before every Telegram call, so nothing is relayed to or from a frozen user or across
 * bands, and a match whose live bands no longer fit is closed by the very message that finds out.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRevealRepository } from '../../src/db/repositories/reveal';
import { createRevealService } from '../../src/services/reveal';
import {
  activeMatchOf,
  consentRows,
  insertBlock,
  insertChat,
  insertConsent,
  insertDeliveredMessage,
  insertMessage,
  messageRows,
  startChat,
  telegramUser,
} from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { memoryLogger } from '../support/fixtures';
import { insertGame } from '../support/games';
import {
  insertActiveUser,
  insertMatch,
  insertOutbox,
  matchRow,
  outboxRow,
  withoutTriggers,
} from '../support/matches';
import { lastIncomingId, textUpdate } from '../support/telegram';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const refused = (rule: string) => ({ code: 'SS030', message: `message rejected: ${rule}` });
const revealRefused = (rule: string) => ({ code: 'SS040', message: `reveal rejected: ${rule}` });
const statusRefused = (rule: string) => ({
  code: 'SS012',
  message: `match status rejected: ${rule}`,
});
const DENIED = { code: '42501' };
const UNKNOWN_MATCH = '00000000-0000-7000-8000-000000000000';

const chat = (over: Parameters<typeof insertChat>[1] = {}) => insertChat(testDb.appPool, over);
const say = (matchId: string, senderId: string, over = {}) =>
  insertMessage(testDb.appPool, { matchId, senderId, ...over });
const messageCount = async (matchId: string) =>
  (await messageRows(testDb.ownerPool, matchId)).length;

/** Changes a user without firing a trigger: the cached band and the user's matches stay as they are. */
const tamper = (userId: string, set: string, value: string) =>
  withoutTriggers(testDb.ownerPool, (client) =>
    client.query(`UPDATE users SET ${set} = $2 WHERE id = $1`, [userId, value]),
  );

describe('storing a message', () => {
  it('is possible for each participant while the chat is open, before and after it has started', async () => {
    const { matchId, a, b } = await chat();
    await say(matchId, a);
    const first = await insertDeliveredMessage(testDb.appPool, { matchId, senderId: b });
    await startChat(testDb.appPool, matchId);
    await say(matchId, a, { body: 'и тебе привет' });
    const rows = await messageRows(testDb.ownerPool, matchId);
    expect(rows.map((r) => [r.sender_id, r.delivered])).toEqual([
      [a, false],
      [b, true],
      [a, false],
    ]);
    expect(rows[1]?.id).toBe(first.id);
  });

  it('is refused for anyone who is not in the match', async () => {
    const { matchId } = await chat();
    const stranger = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    await expect(say(matchId, stranger.id)).rejects.toMatchObject(refused('not_participant'));
    // A participant of another chat is still a stranger here.
    const other = await chat();
    await expect(say(matchId, other.a)).rejects.toMatchObject(refused('not_participant'));
    await expect(say(UNKNOWN_MATCH, other.a)).rejects.toMatchObject(refused('unknown_match'));
    expect(await messageCount(matchId)).toBe(0);
  });

  it('is refused while the game is still being played', async () => {
    const first = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const second = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    await insertGame(testDb.appPool, match.id);
    await expect(say(match.id, first.id)).rejects.toMatchObject(refused('chat_not_open'));
  });

  it.each([
    ["status = 'closed', close_reason = 'left', closed_at = now()"],
    ["status = 'expired', close_reason = 'expired', closed_at = now()"],
    ["status = 'closed', close_reason = 'band_change', closed_at = now()"],
    ["status = 'closed', close_reason = 'blocked', closed_at = now()"],
  ])('is refused once the match is over (%s)', async (change) => {
    const { matchId, a, b } = await chat();
    await testDb.appPool.query(`UPDATE matches SET ${change} WHERE id = $1`, [matchId]);
    await expect(say(matchId, a)).rejects.toMatchObject(refused('chat_not_open'));
    await expect(say(matchId, b)).rejects.toMatchObject(refused('chat_not_open'));
    expect(await messageCount(matchId)).toBe(0);
  });

  it('is refused in both directions as soon as one of the two is frozen', async () => {
    const { matchId, a, b } = await chat();
    await testDb.appPool.query("UPDATE users SET status = 'frozen' WHERE id = $1", [a]);
    // The freeze closed the match in its own transaction (invariant 4).
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'frozen',
    });
    await expect(say(matchId, a)).rejects.toMatchObject(refused('chat_not_open'));
    await expect(say(matchId, b)).rejects.toMatchObject(refused('chat_not_open'));
  });

  it.each(['frozen', 'deleted', 'waitlisted', 'onboarding'])(
    'is refused in both directions for a %s user, even if their match were still open',
    async (status) => {
      const { matchId, a, b } = await chat();
      // The state the close trigger prevents: a non-active user in an open match.
      await tamper(b, 'status', status);
      expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
      await expect(say(matchId, a)).rejects.toMatchObject(refused('not_active'));
      await expect(say(matchId, b)).rejects.toMatchObject(refused('not_active'));
      expect(await messageCount(matchId)).toBe(0);
    },
  );

  it('is refused when a live band differs from the match band, although the cached band still agrees', async () => {
    const { matchId, a, b } = await chat();
    // An adult match one of whose users is 16 by birth date; `age_band` still says adult.
    await tamper(a, 'birth_date', birthDateYearsAgo(16));
    const { rows } = await testDb.ownerPool.query<{ age_band: string }>(
      'SELECT age_band FROM users WHERE id = $1',
      [a],
    );
    expect(rows[0]?.age_band).toBe('adult');
    await expect(say(matchId, a)).rejects.toMatchObject(refused('band'));
    await expect(say(matchId, b)).rejects.toMatchObject(refused('band'));
    expect(await messageCount(matchId)).toBe(0);
  });

  it('is refused after an admin corrected a birth date, which closed the match', async () => {
    const { matchId, a, b } = await chat();
    await testDb.ownerPool.query('SELECT admin_set_birth_date($1, $2, 1, $3)', [
      a,
      birthDateYearsAgo(16),
      'test: wrong year',
    ]);
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    await expect(say(matchId, a)).rejects.toMatchObject(refused('chat_not_open'));
    await expect(say(matchId, b)).rejects.toMatchObject(refused('chat_not_open'));
  });

  it('is refused in a u18 match: there is no contact filter yet', async () => {
    // A legitimate u18 match: both 16, friends mode, its game finished.
    const { matchId, a, b } = await chat({ years: 16 });
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({ status: 'results_ready' });
    await expect(say(matchId, a)).rejects.toMatchObject(refused('u18_chat_closed'));
    await expect(say(matchId, b)).rejects.toMatchObject(refused('u18_chat_closed'));
    // Not as an accepted message, and not as a record of a refused one either.
    await expect(say(matchId, a, { verdict: 'rejected', reason: 'test' })).rejects.toMatchObject(
      refused('u18_chat_closed'),
    );
    expect(await messageCount(matchId)).toBe(0);
  });

  it('is refused between two users one of whom blocked the other, in either direction', async () => {
    for (const blockerIsA of [true, false]) {
      const { matchId, a, b } = await chat();
      await insertBlock(testDb.ownerPool, blockerIsA ? a : b, blockerIsA ? b : a);
      await expect(say(matchId, a)).rejects.toMatchObject(refused('blocked'));
      await expect(say(matchId, b)).rejects.toMatchObject(refused('blocked'));
    }
  });

  it('never starts as delivered', async () => {
    const { matchId, a } = await chat();
    await expect(say(matchId, a, { deliveredAt: new Date() })).rejects.toMatchObject(
      refused('already_delivered'),
    );
    await expect(
      say(matchId, a, { deliveredAt: new Date(), recipientTgMessageId: 7 }),
    ).rejects.toMatchObject(refused('already_delivered'));
    await expect(say(matchId, a, { recipientTgMessageId: 7 })).rejects.toMatchObject(
      refused('already_delivered'),
    );
    // Later, too, a message at the recipient needs a delivery.
    const { id } = await say(matchId, a);
    await expect(
      testDb.appPool.query('UPDATE messages SET recipient_tg_message_id = 7 WHERE id = $1', [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'messages_recipient_message' });
  });

  it('keeps the text within the limit and the reason with the verdict', async () => {
    const { matchId, a } = await chat();
    await expect(say(matchId, a, { body: '' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'messages_body_length',
    });
    await expect(say(matchId, a, { body: 'я'.repeat(2001) })).rejects.toMatchObject({
      code: '23514',
      constraint: 'messages_body_length',
    });
    await say(matchId, a, { body: 'я'.repeat(2000) });
    await expect(say(matchId, a, { reason: 'why' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'messages_reason',
    });
    await expect(say(matchId, a, { verdict: 'rejected' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'messages_reason',
    });
  });

  it('stores one message per Telegram message of a sender', async () => {
    const { matchId, a, b } = await chat();
    await say(matchId, a, { senderTgMessageId: 41 });
    await expect(say(matchId, a, { senderTgMessageId: 41 })).rejects.toMatchObject({
      code: '23505',
      constraint: 'messages_sender_message_unique',
    });
    // The other person's message 41 is another message.
    await say(matchId, b, { senderTgMessageId: 41 });
  });
});

describe('a stored message', () => {
  const update = (id: string, set: string) =>
    testDb.appPool.query(`UPDATE messages SET ${set} WHERE id = $1`, [id]);
  const guarded = { code: 'SS031' };

  it('can lose its text, and never get another one', async () => {
    const { matchId, a } = await chat();
    const { id } = await say(matchId, a);
    await expect(update(id, "body = 'переписано'")).rejects.toMatchObject(guarded);
    await update(id, 'body = NULL');
    await expect(update(id, "body = 'вернулось'")).rejects.toMatchObject(guarded);
    expect((await messageRows(testDb.ownerPool, matchId))[0]?.body).toBeNull();
  });

  it('is delivered once, with one message at the recipient', async () => {
    const { matchId, a } = await chat();
    const { id } = await say(matchId, a);
    await update(id, 'delivered_at = now(), recipient_tg_message_id = 9');
    await expect(update(id, "delivered_at = now() + interval '1 hour'")).rejects.toMatchObject(
      guarded,
    );
    await expect(update(id, 'delivered_at = NULL')).rejects.toMatchObject(guarded);
    await expect(update(id, 'recipient_tg_message_id = 10')).rejects.toMatchObject(guarded);
    await expect(update(id, 'sender_tg_message_id = 5')).resolves.toBeDefined();
    await expect(update(id, 'sender_tg_message_id = 6')).rejects.toMatchObject(guarded);
  });

  it('can be marked as not delivered only before it reached anyone, and never the other way', async () => {
    const { matchId, a } = await chat();
    const failed = await say(matchId, a);
    await update(failed.id, "verdict = 'rejected', reason = 'send_failed'");
    await expect(update(failed.id, "verdict = 'delivered', reason = NULL")).rejects.toMatchObject(
      guarded,
    );
    await expect(update(failed.id, "reason = 'other'")).rejects.toMatchObject(guarded);
    // A rejected message was never delivered.
    await expect(update(failed.id, 'delivered_at = now()')).rejects.toMatchObject({
      code: '23514',
      constraint: 'messages_delivered',
    });

    const arrived = await insertDeliveredMessage(testDb.appPool, { matchId, senderId: a });
    await expect(
      update(arrived.id, "verdict = 'rejected', reason = 'send_failed'"),
    ).rejects.toMatchObject(guarded);
    await expect(
      update(arrived.id, "verdict = 'blocked_by_filter', reason = 'url'"),
    ).rejects.toMatchObject(guarded);
  });

  it('keeps its sender, its match and its time, whoever asks', async () => {
    const { matchId, a, b } = await chat();
    const other = await chat();
    const { id } = await say(matchId, a);
    // The app role has no right to these columns at all.
    await expect(update(id, `sender_id = '${b}'`)).rejects.toMatchObject(DENIED);
    await expect(update(id, `match_id = '${other.matchId}'`)).rejects.toMatchObject(DENIED);
    await expect(update(id, 'created_at = now()')).rejects.toMatchObject(DENIED);
    await expect(update(id, 'purge_after = now()')).rejects.toMatchObject(DENIED);
    await expect(
      testDb.appPool.query('DELETE FROM messages WHERE id = $1', [id]),
    ).rejects.toMatchObject(DENIED);
    // And the trigger refuses even the owner.
    for (const set of [
      `sender_id = '${b}'`,
      `match_id = '${other.matchId}'`,
      'created_at = now()',
    ]) {
      await expect(
        testDb.ownerPool.query(`UPDATE messages SET ${set} WHERE id = $1`, [id]),
      ).rejects.toMatchObject(guarded);
    }
  });
});

describe('the start of a chat', () => {
  it('needs a delivered message', async () => {
    const { matchId, a } = await chat();
    await expect(startChat(testDb.appPool, matchId)).rejects.toMatchObject(
      statusRefused('no_message'),
    );
    // Accepted but not delivered, or not delivered at all, is not a start.
    await say(matchId, a);
    const failed = await say(matchId, a);
    await testDb.appPool.query(
      "UPDATE messages SET verdict = 'rejected', reason = 'send_failed' WHERE id = $1",
      [failed.id],
    );
    await expect(startChat(testDb.appPool, matchId)).rejects.toMatchObject(
      statusRefused('no_message'),
    );
    await insertDeliveredMessage(testDb.appPool, { matchId, senderId: a });
    await startChat(testDb.appPool, matchId);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');
  });

  it('is only possible from results_ready, with its first message and without a deadline', async () => {
    const first = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const second = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const playing = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    await expect(startChat(testDb.appPool, playing.id)).rejects.toMatchObject(
      statusRefused('not_results_ready'),
    );

    const { matchId, a } = await chat();
    await insertDeliveredMessage(testDb.appPool, { matchId, senderId: a });
    await expect(
      testDb.appPool.query("UPDATE matches SET status = 'active' WHERE id = $1", [matchId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'matches_active_fields' });
    await expect(
      testDb.appPool.query(
        "UPDATE matches SET status = 'active', first_message_at = now() WHERE id = $1",
        [matchId],
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'matches_active_fields' });
    await startChat(testDb.appPool, matchId);
    // Started is started: the game and the results never come back.
    await expect(
      testDb.appPool.query(
        `UPDATE matches SET status = 'results_ready', chat_deadline_at = now() WHERE id = $1`,
        [matchId],
      ),
    ).rejects.toMatchObject(statusRefused('not_pending_game'));
  });

  it('is refused when one of the two is not active, or by birth date not in the match band', async () => {
    const frozen = await chat();
    await insertDeliveredMessage(testDb.appPool, { matchId: frozen.matchId, senderId: frozen.a });
    await tamper(frozen.b, 'status', 'frozen');
    await expect(startChat(testDb.appPool, frozen.matchId)).rejects.toMatchObject(
      statusRefused('not_active'),
    );

    const moved = await chat();
    await insertDeliveredMessage(testDb.appPool, { matchId: moved.matchId, senderId: moved.a });
    await tamper(moved.b, 'birth_date', birthDateYearsAgo(16));
    await expect(startChat(testDb.appPool, moved.matchId)).rejects.toMatchObject(
      statusRefused('band'),
    );
  });

  it('ends expiry: a chat that has started, or has a delivered message, cannot expire', async () => {
    const expire = (matchId: string) =>
      testDb.appPool.query(
        "UPDATE matches SET status = 'expired', close_reason = 'expired', closed_at = now() WHERE id = $1",
        [matchId],
      );
    const silent = await chat();
    await say(silent.matchId, silent.a);
    await expire(silent.matchId);
    expect((await matchRow(testDb.ownerPool, silent.matchId))?.status).toBe('expired');

    const written = await chat();
    await insertDeliveredMessage(testDb.appPool, { matchId: written.matchId, senderId: written.a });
    await expect(expire(written.matchId)).rejects.toMatchObject(statusRefused('chat_started'));
    await startChat(testDb.appPool, written.matchId);
    await expect(expire(written.matchId)).rejects.toMatchObject(statusRefused('chat_started'));
    // It can still be closed, e.g. when someone leaves.
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [written.matchId],
    );
  });
});

describe('consent to reveal usernames', () => {
  const consent = (matchId: string, userId: string) =>
    insertConsent(testDb.appPool, matchId, userId);
  /** The reveal and the withdrawal as the app writes them. */
  const REVEAL =
    'UPDATE reveal_consents SET revealed_at = now() WHERE match_id = $1 AND revealed_at IS NULL';
  const WITHDRAW =
    'DELETE FROM reveal_consents WHERE match_id = $1 AND user_id = $2 AND revealed_at IS NULL';
  const reveal = (matchId: string) => testDb.appPool.query(REVEAL, [matchId]);
  const withdraw = (matchId: string, userId: string) =>
    testDb.appPool.query(WITHDRAW, [matchId, userId]);
  const WITHDRAWAL_REFUSED = {
    code: 'SS042',
    message: 'reveal_consents: a consent cannot be withdrawn after the reveal',
  };

  /** The error a query that is still waiting for a lock will end with, caught right away. */
  const outcomeOf = (query: Promise<unknown>) =>
    query.then(
      () => new Error('the query went through'),
      (error: unknown) => error,
    );

  /** Resolves once a session of this database is waiting for a lock another session holds. */
  async function waitForLockWait(): Promise<void> {
    for (let tries = 0; tries < 250; tries++) {
      const { rows } = await testDb.ownerPool.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting FROM pg_locks l
         JOIN pg_stat_activity s ON s.pid = l.pid
         WHERE NOT l.granted AND s.datname = $1`,
        [testDb.name],
      );
      if ((rows[0]?.waiting ?? 0) > 0) return;
      await sleep(20);
    }
    throw new Error('no session is waiting for a lock');
  }

  it('can be given by each participant of an adult chat, once', async () => {
    const { matchId, a, b } = await chat();
    await consent(matchId, a);
    await consent(matchId, b);
    await expect(consent(matchId, a)).rejects.toMatchObject({ code: '23505' });
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual(
      [a, b].sort().map((user_id) => ({ user_id, revealed: false })),
    );
  });

  it('is impossible in a u18 match', async () => {
    const { matchId, a, b } = await chat({ years: 16 });
    await expect(consent(matchId, a)).rejects.toMatchObject(revealRefused('not_adult'));
    await expect(consent(matchId, b)).rejects.toMatchObject(revealRefused('not_adult'));
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('is impossible when one of the two is under 18 by birth date, whatever the match and the cache say', async () => {
    const { matchId, a, b } = await chat();
    await tamper(b, 'birth_date', birthDateYearsAgo(17));
    await expect(consent(matchId, a)).rejects.toMatchObject(revealRefused('band'));
    await expect(consent(matchId, b)).rejects.toMatchObject(revealRefused('band'));
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('is refused for strangers, unknown matches, and chats that are not open', async () => {
    const { matchId, a } = await chat();
    const other = await chat();
    await expect(consent(matchId, other.a)).rejects.toMatchObject(revealRefused('not_participant'));
    await expect(consent(UNKNOWN_MATCH, a)).rejects.toMatchObject(revealRefused('unknown_match'));

    const first = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const second = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const playing = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    await expect(consent(playing.id, first.id)).rejects.toMatchObject(
      revealRefused('chat_not_open'),
    );

    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [matchId],
    );
    await expect(consent(matchId, a)).rejects.toMatchObject(revealRefused('chat_not_open'));
  });

  it('is refused for a frozen user and for a blocked pair', async () => {
    const frozen = await chat();
    await tamper(frozen.a, 'status', 'frozen');
    await expect(consent(frozen.matchId, frozen.a)).rejects.toMatchObject(
      revealRefused('not_active'),
    );
    await expect(consent(frozen.matchId, frozen.b)).rejects.toMatchObject(
      revealRefused('not_active'),
    );

    const blocked = await chat();
    await insertBlock(testDb.ownerPool, blocked.a, blocked.b);
    await expect(consent(blocked.matchId, blocked.b)).rejects.toMatchObject(
      revealRefused('blocked'),
    );
  });

  it('never starts as revealed', async () => {
    const { matchId, a } = await chat();
    await expect(
      testDb.appPool.query(
        'INSERT INTO reveal_consents (match_id, user_id, consented_at, revealed_at) VALUES ($1, $2, now(), now())',
        [matchId, a],
      ),
    ).rejects.toMatchObject(revealRefused('not_mutual'));
  });

  it('reveals only when both have consented, and only once', async () => {
    const { matchId, a, b } = await chat();
    await consent(matchId, a);
    await expect(reveal(matchId)).rejects.toMatchObject(revealRefused('not_mutual'));
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: a, revealed: false }]);

    await consent(matchId, b);
    await reveal(matchId);
    expect((await consentRows(testDb.ownerPool, matchId)).map((r) => r.revealed)).toEqual([
      true,
      true,
    ]);
    await expect(
      testDb.appPool.query('UPDATE reveal_consents SET revealed_at = NULL WHERE match_id = $1', [
        matchId,
      ]),
    ).rejects.toMatchObject({ code: 'SS041' });
    await expect(
      testDb.appPool.query(
        "UPDATE reveal_consents SET revealed_at = now() + interval '1 day' WHERE match_id = $1",
        [matchId],
      ),
    ).rejects.toMatchObject({ code: 'SS041' });
  });

  it('does not reveal once the chat is over, a user is frozen, or one of them is no longer an adult by birth date', async () => {
    const both = async () => {
      const c = await chat();
      await consent(c.matchId, c.a);
      await consent(c.matchId, c.b);
      return c;
    };
    const left = await both();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [left.matchId],
    );
    await expect(reveal(left.matchId)).rejects.toMatchObject(revealRefused('chat_not_open'));

    const frozen = await both();
    await tamper(frozen.b, 'status', 'frozen');
    await expect(reveal(frozen.matchId)).rejects.toMatchObject(revealRefused('not_active'));

    const minor = await both();
    await tamper(minor.a, 'birth_date', birthDateYearsAgo(17));
    await expect(reveal(minor.matchId)).rejects.toMatchObject(revealRefused('band'));

    const blocked = await both();
    await insertBlock(testDb.ownerPool, blocked.b, blocked.a);
    await expect(reveal(blocked.matchId)).rejects.toMatchObject(revealRefused('blocked'));

    for (const c of [left, frozen, minor, blocked]) {
      expect((await consentRows(testDb.ownerPool, c.matchId)).map((r) => r.revealed)).toEqual([
        false,
        false,
      ]);
    }
  });

  it('cannot be rewritten by the app', async () => {
    const { matchId, a, b } = await chat();
    await consent(matchId, a);
    await expect(
      testDb.appPool.query('UPDATE reveal_consents SET consented_at = now() WHERE match_id = $1', [
        matchId,
      ]),
    ).rejects.toMatchObject(DENIED);
    await expect(
      testDb.appPool.query('UPDATE reveal_consents SET user_id = $2 WHERE match_id = $1', [
        matchId,
        b,
      ]),
    ).rejects.toMatchObject(DENIED);
    // The trigger refuses even the owner: a second consent can't be made out of the first.
    await expect(
      testDb.ownerPool.query('UPDATE reveal_consents SET user_id = $2 WHERE match_id = $1', [
        matchId,
        b,
      ]),
    ).rejects.toMatchObject({ code: 'SS041' });
  });

  // Q38 (decided): a consent can be taken back until the reveal has happened, never afterwards.
  it('can be withdrawn until the reveal, and given again', async () => {
    const { matchId, a, b } = await chat();
    await consent(matchId, a);
    await consent(matchId, b);
    const withdrawn = await withdraw(matchId, a);
    expect(withdrawn.rowCount).toBe(1);
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: b, revealed: false }]);
    // With one consent left there is nothing to reveal.
    await expect(reveal(matchId)).rejects.toMatchObject(revealRefused('not_mutual'));
    // A new consent is a new row, and the reveal works with it.
    await consent(matchId, a);
    await reveal(matchId);
    expect((await consentRows(testDb.ownerPool, matchId)).map((r) => r.revealed)).toEqual([
      true,
      true,
    ]);
  });

  it('can be withdrawn in a chat that has ended: the rule is about the reveal only', async () => {
    const { matchId, a } = await chat();
    await consent(matchId, a);
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [matchId],
    );
    expect((await withdraw(matchId, a)).rowCount).toBe(1);
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('cannot be withdrawn once the reveal has happened, by anyone', async () => {
    const { matchId, a, b } = await chat();
    await consent(matchId, a);
    await consent(matchId, b);
    await reveal(matchId);
    // The withdrawal as the app writes it finds nothing to remove…
    for (const userId of [a, b]) {
      expect((await withdraw(matchId, userId)).rowCount).toBe(0);
    }
    // …and a delete that does not look at `revealed_at` is refused by the trigger, for the app
    // role and for the owner alike.
    for (const userId of [a, b]) {
      await expect(
        testDb.appPool.query('DELETE FROM reveal_consents WHERE match_id = $1 AND user_id = $2', [
          matchId,
          userId,
        ]),
      ).rejects.toMatchObject(WITHDRAWAL_REFUSED);
    }
    await expect(
      testDb.appPool.query('DELETE FROM reveal_consents WHERE match_id = $1', [matchId]),
    ).rejects.toMatchObject(WITHDRAWAL_REFUSED);
    await expect(
      testDb.ownerPool.query('DELETE FROM reveal_consents WHERE match_id = $1', [matchId]),
    ).rejects.toMatchObject(WITHDRAWAL_REFUSED);
    // Not even when the chat is over: the record of the reveal stays.
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [matchId],
    );
    await expect(
      testDb.appPool.query('DELETE FROM reveal_consents WHERE match_id = $1', [matchId]),
    ).rejects.toMatchObject(WITHDRAWAL_REFUSED);
    expect((await consentRows(testDb.ownerPool, matchId)).map((r) => r.revealed)).toEqual([
      true,
      true,
    ]);
  });

  it('refuses the later of a withdrawal and a reveal that cross, in both orders', async () => {
    // The withdrawal is under way (its transaction is open) when the reveal arrives: the reveal
    // waits for it, then finds one consent and is refused. Nothing is revealed to anyone.
    {
      const { matchId, a, b } = await chat();
      await consent(matchId, a);
      await consent(matchId, b);
      const withdrawing = await testDb.appPool.connect();
      try {
        await withdrawing.query('BEGIN');
        expect((await withdrawing.query(WITHDRAW, [matchId, a])).rowCount).toBe(1);
        const revealing = outcomeOf(reveal(matchId));
        await waitForLockWait();
        await withdrawing.query('COMMIT');
        expect(await revealing).toMatchObject(revealRefused('not_mutual'));
      } finally {
        withdrawing.release();
      }
      expect(await consentRows(testDb.ownerPool, matchId)).toEqual([
        { user_id: b, revealed: false },
      ]);
    }
    // The reveal is under way when the withdrawal arrives: the withdrawal waits for it, then
    // finds a revealed consent and is refused. Both consents stay revealed.
    {
      const { matchId, a, b } = await chat();
      await consent(matchId, a);
      await consent(matchId, b);
      const revealing = await testDb.appPool.connect();
      try {
        await revealing.query('BEGIN');
        await revealing.query(REVEAL, [matchId]);
        // Without "revealed_at IS NULL": the trigger alone decides.
        const withdrawing = outcomeOf(
          testDb.appPool.query('DELETE FROM reveal_consents WHERE match_id = $1 AND user_id = $2', [
            matchId,
            a,
          ]),
        );
        await waitForLockWait();
        await revealing.query('COMMIT');
        expect(await withdrawing).toMatchObject(WITHDRAWAL_REFUSED);
      } finally {
        revealing.release();
      }
      expect((await consentRows(testDb.ownerPool, matchId)).map((r) => r.revealed)).toEqual([
        true,
        true,
      ]);
      // The withdrawal as the app writes it finds nothing to remove either.
      expect((await withdraw(matchId, a)).rowCount).toBe(0);
    }
  });
});

/**
 * Makes a user 16 or 17 by birth date behind the back of every trigger: the cached band and the
 * user's matches stay adult. The username the bot stored for the adult goes too, as it would for
 * any row that is under 18 (the CHECK on `username` would refuse the row otherwise).
 */
const makeMinor = (userId: string, years: 16 | 17 = 16) =>
  withoutTriggers(testDb.ownerPool, (client) =>
    client.query('UPDATE users SET birth_date = $2, username = NULL WHERE id = $1', [
      userId,
      birthDateYearsAgo(years),
    ]),
  );

/**
 * Two adults who are chatting, as the bot sees them. `fox` is user A of the match (🦊 Лиса to the
 * other one) and `owl` is user B (🦉 Сова). Each has already written once.
 */
async function talking(options: Parameters<typeof buildChatApp>[1] = {}) {
  const app = await buildChatApp(testDb, options);
  const c = await chat();
  const fox = telegramUser({ id: c.a, telegramId: c.telegramA });
  const owl = telegramUser({ id: c.b, telegramId: c.telegramB });
  await app.handle(textUpdate(fox, 'привет'));
  const foxMessage = lastIncomingId();
  await app.handle(textUpdate(owl, 'и тебе привет'));
  const rows = await messageRows(testDb.ownerPool, c.matchId);
  app.telegram.clear();
  return {
    ...c,
    app,
    fox,
    owl,
    /** A message of each of them, as it sits in the other one's bot chat: to reply to. */
    inOwlChat: Number(rows[0]?.recipient_tg_message_id),
    inFoxChat: Number(rows[1]?.recipient_tg_message_id),
    foxMessage,
  };
}
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const ENDED = 'Этот чат завершён. Сообщение не доставлено.';

describe('the relay and a band change', () => {
  it('refuses the next message and closes the match when a live band has changed, before any job ran', async () => {
    const { app, matchId, a, b, fox, owl } = await talking();
    const pending = await insertOutbox(testDb.appPool, {
      userId: b,
      matchId,
      kind: 'reveal_request',
    });
    // By birth date the sender is 16 now; the cached band and the match still say adult.
    await makeMinor(a);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');

    await app.handle(textUpdate(fox, 'это не должно дойти'));
    expect(texts(app, owl.id)).toEqual([]);
    expect(texts(app, fox.id)).toEqual([ENDED]);
    // The message that found out closed the match, in the same breath.
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    expect(await outboxRow(testDb.ownerPool, pending.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'band_change',
    });
    const cache = await testDb.ownerPool.query<{ age_band: string }>(
      'SELECT age_band FROM users WHERE id = $1',
      [a],
    );
    expect(cache.rows[0]?.age_band).toBe('u18');
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);

    // And nothing comes back the other way either.
    app.telegram.clear();
    await app.handle(textUpdate(owl, 'ты тут?'));
    expect(texts(app, fox.id)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);
  });

  it('does the same when it is the recipient whose band changed, by reply and by the API', async () => {
    const byReply = await talking();
    await makeMinor(byReply.b, 17);
    await byReply.app.handle(textUpdate(byReply.fox, 'ответ', { replyTo: byReply.inFoxChat }));
    expect(texts(byReply.app, byReply.owl.id)).toEqual([]);
    expect(texts(byReply.app, byReply.fox.id)).toEqual([ENDED]);
    expect(await matchRow(testDb.ownerPool, byReply.matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });

    const byApi = await talking();
    await makeMinor(byApi.b, 17);
    const response = await byApi.app
      .as({ id: byApi.fox.id, first_name: 'Dev' })
      .post(`/api/matches/${byApi.matchId}/messages`, { text: 'из приложения' });
    // The match is no longer readable for either of them: it looks like it never existed.
    expect(response.status).toBe(404);
    expect(byApi.app.telegram.calls).toEqual([]);
    expect(await matchRow(testDb.ownerPool, byApi.matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
  });

  it('closes the match even when the cached band cannot be rewritten', async () => {
    const { app, matchId, a, fox, owl } = await talking();
    // The stored username makes the row invalid as a u18 row: writing the cache fails its CHECK.
    await tamper(a, 'birth_date', birthDateYearsAgo(16));
    const before = await testDb.ownerPool.query<{ username: string | null }>(
      'SELECT username FROM users WHERE id = $1',
      [a],
    );
    expect(before.rows[0]?.username).not.toBeNull();

    await app.handle(textUpdate(fox, 'это не должно дойти'));
    expect(texts(app, owl.id)).toEqual([]);
    expect(texts(app, fox.id)).toEqual([ENDED]);
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    expect(app.logLines().join('\n')).toContain('cached band not rewritten');
  });

  it('closes such a match as soon as its participant touches the chat at all, and never shows its alias', async () => {
    const { app, matchId, a, fox } = await talking();
    await makeMinor(a);
    await app.handle(textUpdate(fox, '/chats'));
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    expect(JSON.stringify(app.telegram.calls)).not.toContain('Сова');
  });

  it('refuses after an admin corrected a birth date: the correction itself closed the match', async () => {
    const { app, matchId, a, fox, owl, inOwlChat } = await talking();
    await testDb.ownerPool.query('SELECT admin_set_birth_date($1, $2, 1, $3)', [
      a,
      birthDateYearsAgo(16),
      'test: wrong year',
    ]);
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });

    await app.handle(textUpdate(fox, 'я всё ещё тут'));
    await app.handle(textUpdate(owl, 'и я', { replyTo: inOwlChat }));
    await app.handle(textUpdate(owl, 'алло'));
    expect(texts(app, owl.id).every((t) => !t.startsWith('🦊'))).toBe(true);
    expect(texts(app, fox.id).every((t) => !t.startsWith('🦉'))).toBe(true);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);
    // The API agrees: the match is gone for both.
    for (const who of [fox, owl]) {
      const response = await app
        .as({ id: who.id, first_name: 'Dev' })
        .post(`/api/matches/${matchId}/messages`, { text: 'привет' });
      expect(response.status).toBe(404);
    }
    expect(app.telegram.of('sendMessage').every((c) => typeof c.payload['text'] === 'string')).toBe(
      true,
    );
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);
  });
});

describe('the relay and a frozen user', () => {
  it('relays nothing to or from a frozen user: the freeze closed the chat', async () => {
    const { app, matchId, a, fox, owl, inOwlChat } = await talking();
    await testDb.appPool.query("UPDATE users SET status = 'frozen' WHERE id = $1", [a]);
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'frozen',
    });

    await app.handle(textUpdate(fox, 'я заморожен'));
    expect(texts(app, owl.id)).toEqual([]);
    expect(texts(app, fox.id)).toEqual(['Сейчас отправлять сообщения нельзя.']);

    app.telegram.clear();
    await app.handle(textUpdate(owl, 'ответ', { replyTo: inOwlChat }));
    await app.handle(textUpdate(owl, 'и ещё'));
    expect(texts(app, fox.id)).toEqual([]);
    expect(texts(app, owl.id)).toEqual([ENDED, ENDED]);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);

    // The API refuses a frozen account outright.
    const response = await app
      .as({ id: fox.id, first_name: 'Dev' })
      .post(`/api/matches/${matchId}/messages`, { text: 'привет' });
    expect(response.status).toBe(403);
  });

  it.each(['frozen', 'deleted', 'waitlisted'])(
    'relays nothing to or from a %s user even if their match were still open',
    async (status) => {
      const { app, matchId, a, fox, owl } = await talking();
      // The state the close trigger prevents: a non-active user in an open chat.
      await tamper(a, 'status', status);
      expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');

      await app.handle(textUpdate(fox, 'от меня'));
      await app.handle(textUpdate(owl, 'ко мне'));
      expect(texts(app, owl.id).every((t) => !t.startsWith('🦊'))).toBe(true);
      expect(texts(app, fox.id).every((t) => !t.startsWith('🦉'))).toBe(true);
      expect(texts(app, fox.id)).toEqual(['Сейчас отправлять сообщения нельзя.']);
      expect(texts(app, owl.id)).toEqual([ENDED]);
      expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);
    },
  );

  it('checks again right before the Telegram call: a freeze between two tries stops the second', async () => {
    const c = await chat();
    const fox = telegramUser({ id: c.a, telegramId: c.telegramA });
    const owl = telegramUser({ id: c.b, telegramId: c.telegramB });
    // The recipient is frozen while the relay waits to try the delivery again.
    const app = await buildChatApp(testDb, {
      onRetryWait: async () => {
        await testDb.appPool.query("UPDATE users SET status = 'frozen' WHERE id = $1", [c.b]);
      },
    });
    let attempts = 0;
    app.telegram.answer = (call) => {
      if (call.payload['chat_id'] !== owl.id) return { ok: true };
      attempts++;
      return { ok: false, error_code: 429, description: 'Too Many Requests', retry_after: 1 };
    };
    await app.handle(textUpdate(fox, 'успею?'));
    expect(attempts).toBe(1);
    expect(await messageRows(testDb.ownerPool, c.matchId)).toEqual([
      expect.objectContaining({ verdict: 'rejected', delivered: false }),
    ]);
    expect((await matchRow(testDb.ownerPool, c.matchId))?.close_reason).toBe('frozen');
  });
});

describe('the relay and other people', () => {
  it('never writes into a match the sender is not in, whatever their active chat points to', async () => {
    const { app, a, fox } = await talking();
    const others = await talking();
    // Nothing in the database stops the pointer from naming any match: the relay must not care.
    await testDb.appPool.query('UPDATE users SET active_match_id = $2 WHERE id = $1', [
      a,
      others.matchId,
    ]);
    others.app.telegram.clear();
    await app.handle(textUpdate(fox, 'не моё'));
    await app.handle(textUpdate(fox, 'и это', { replyTo: others.inFoxChat }));
    for (const stranger of [others.fox, others.owl]) {
      expect(texts(app, stranger.id)).toEqual([]);
      expect(texts(others.app, stranger.id)).toEqual([]);
    }
    expect(await messageRows(testDb.ownerPool, others.matchId)).toHaveLength(2);
    // The bogus pointer is gone after its first use.
    expect(await activeMatchOf(testDb.ownerPool, a)).not.toBe(others.matchId);
  });

  it('relays nothing between two users one of whom blocked the other', async () => {
    const { app, matchId, a, b, fox, owl } = await talking();
    await insertBlock(testDb.ownerPool, b, a);
    await app.handle(textUpdate(fox, 'от заблокированного'));
    await app.handle(textUpdate(owl, 'заблокированному'));
    expect(texts(app, owl.id)).toEqual([ENDED]);
    expect(texts(app, fox.id)).toEqual([ENDED]);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);
  });

  it('gives the recipient the alias and the text only, whatever the sender account looks like', async () => {
    const { app, fox, owl } = await talking();
    await app.handle(textUpdate(fox, 'ещё одно'));
    const [call] = app.telegram.calls;
    expect(app.telegram.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(Object.keys(call?.payload ?? {}).sort()).toEqual([
      'chat_id',
      'link_preview_options',
      'reply_markup',
      'text',
    ]);
    expect(call?.payload['text']).toBe('🦊 Лиса\nещё одно');
    const sent = JSON.stringify(call);
    for (const secret of [fox.first_name, fox.last_name, fox.username, String(fox.id)]) {
      expect(sent).not.toContain(secret);
    }
    expect(call?.payload['chat_id']).toBe(owl.id);
  });
});

describe('a withdrawal that crosses the other person consent (Q38)', () => {
  const FOX_NAME = 'fox_handle_for_telegram';
  const OWL_NAME = 'owl_handle_for_telegram';

  it('reveals nothing, sends no username, and asks the one who withdrew instead', async () => {
    const { app, matchId, a, b, fox, owl } = await talking();
    app.telegram.usernames.set(fox.id, FOX_NAME);
    app.telegram.usernames.set(owl.id, OWL_NAME);
    expect(await app.reveal.consent(a, matchId)).toEqual({ status: 'waiting', alias: 'a.owl' });

    // The owl's consent through the real service, with the fox's withdrawal landing in the
    // middle of it: after the owl's consent is stored and the match was read with the fox's
    // consent still in it, right before the reveal.
    let crossed = false;
    const racing = createRevealService({
      reveal: createRevealRepository(testDb.db),
      usernames: {
        current: async (account) => {
          if (!crossed) {
            crossed = true;
            expect(await app.reveal.withdraw(a, matchId)).toEqual({
              status: 'withdrawn',
              alias: 'a.owl',
            });
          }
          return app.usernames.current(account);
        },
      },
      clock: app.clock,
      logger: memoryLogger().logger,
    });
    expect(await racing.consent(b, matchId)).toEqual({ status: 'waiting', alias: 'a.fox' });
    expect(crossed).toBe(true);
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: b, revealed: false }]);

    // The question the fox's consent had queued for the owl is outdated; the owl's consent asks
    // the fox; no username goes anywhere.
    await app.sender.tick();
    const everything = JSON.stringify(app.telegram.calls);
    expect(everything).not.toContain(FOX_NAME);
    expect(everything).not.toContain(OWL_NAME);
    expect(texts(app, owl.id)).toEqual([]);
    expect(texts(app, fox.id)).toEqual([
      '🦉 Сова предлагает обменяться никами в Telegram. Ники откроются, только если согласятся обе стороны.',
    ]);
    const { rows } = await testDb.ownerPool.query<{
      kind: string;
      status: string;
      cancel_reason: string | null;
      to_fox: boolean;
    }>(
      `SELECT kind::text AS kind, status::text AS status, cancel_reason, user_id = $2 AS to_fox
       FROM outbox WHERE match_id = $1 ORDER BY created_at`,
      [matchId, a],
    );
    expect(rows).toEqual([
      { kind: 'reveal_request', status: 'cancelled', cancel_reason: 'outdated', to_fox: false },
      { kind: 'reveal_request', status: 'sent', cancel_reason: null, to_fox: true },
    ]);
  });
});
