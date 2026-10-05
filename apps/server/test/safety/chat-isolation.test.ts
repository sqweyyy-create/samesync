/**
 * SAFETY SUITE — the chat (CLAUDE.md invariants 1, 2, 3, 4, 5, 6 and 9; PLAN.md §3 layer 2).
 * A message goes from one user to the other, and a reveal shows each of them the other's username.
 * The first part skips the app and attacks the database directly as the app role: only a
 * participant of a match whose chat is open can store a message, both live bands must equal the
 * match band even when the cached `age_band` is stale, nothing is stored in a u18 match, a stored
 * message never changes, a chat starts only with a delivered message, and usernames can be
 * revealed only between two adults who both consented.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  consentRows,
  insertBlock,
  insertChat,
  insertConsent,
  insertDeliveredMessage,
  insertMessage,
  messageRows,
  startChat,
} from '../support/chat';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertGame } from '../support/games';
import { insertActiveUser, insertMatch, matchRow, withoutTriggers } from '../support/matches';
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
  const reveal = (matchId: string) =>
    testDb.appPool.query(
      'UPDATE reveal_consents SET revealed_at = now() WHERE match_id = $1 AND revealed_at IS NULL',
      [matchId],
    );

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

  it('cannot be rewritten or deleted by the app', async () => {
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
    await expect(
      testDb.appPool.query('DELETE FROM reveal_consents WHERE match_id = $1', [matchId]),
    ).rejects.toMatchObject(DENIED);
    // The trigger refuses even the owner: a second consent can't be made out of the first.
    await expect(
      testDb.ownerPool.query('UPDATE reveal_consents SET user_id = $2 WHERE match_id = $1', [
        matchId,
        b,
      ]),
    ).rejects.toMatchObject({ code: 'SS041' });
  });
});
