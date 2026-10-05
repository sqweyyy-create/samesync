/**
 * The chat window (PLAN.md Phase 4, Q2): once results are ready the two have 48 hours to start
 * talking. Both get one reminder before the window closes, a chat nobody wrote in expires exactly
 * once at its deadline, and the first delivered message stops expiry for good. Also here: the
 * retention purge of message texts (Q20).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock';
import { createChatDeadlinesJob, createRetentionJob } from '../../src/jobs/jobs';
import { insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_MINIAPP_URL } from '../support/fixtures';
import { matchRow } from '../support/matches';
import { textUpdate } from '../support/telegram';

// The jobs look at every match there is, so each test gets a database of its own.
let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;

/** A chat nobody has written in, its deadline, and an app whose clock the test moves. */
async function silent(over: Parameters<typeof insertChat>[1] = {}) {
  const chat = await insertChat(testDb.appPool, over);
  const { rows } = await testDb.ownerPool.query<{ at: Date }>(
    'SELECT chat_deadline_at AS at FROM matches WHERE id = $1',
    [chat.matchId],
  );
  // The database keeps microseconds and JavaScript does not: the first millisecond that is
  // certainly not before the deadline.
  const deadline = rows[0]!.at.getTime() + 1;
  const clock = fixedClock(new Date());
  const app = await buildChatApp(testDb, { clock });
  return {
    ...chat,
    app,
    clock,
    deadline,
    fox: telegramUser({ id: chat.a, telegramId: chat.telegramA }),
    owl: telegramUser({ id: chat.b, telegramId: chat.telegramB }),
    at: (ms: number) => clock.set(new Date(ms)),
  };
}

const outboxOf = async (matchId: string) =>
  (
    await testDb.ownerPool.query<{ kind: string; status: string; cancel_reason: string | null }>(
      `SELECT kind::text AS kind, status::text AS status, cancel_reason FROM outbox
       WHERE match_id = $1 ORDER BY kind, user_id`,
      [matchId],
    )
  ).rows;

const openApp = {
  inline_keyboard: [[{ text: 'Открыть SameSync', web_app: { url: TEST_MINIAPP_URL } }]],
};

describe('a chat nobody wrote in', () => {
  it('expires at its deadline, exactly once, and both are told once', async () => {
    const { app, matchId, a, deadline, at, fox, owl } = await silent();
    at(deadline - 2);
    expect(await app.deadlines.run()).toMatchObject({ expired: 0 });
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');

    at(deadline);
    expect(await app.deadlines.run()).toMatchObject({ started: 0, expired: 1 });
    const closed = await matchRow(testDb.ownerPool, matchId);
    expect(closed).toMatchObject({ status: 'expired', close_reason: 'expired' });
    expect(closed?.closed_at?.getTime()).toBe(deadline);

    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    expect(app.telegram.sentTo(fox.id).map((m) => m.payload)).toEqual([
      expect.objectContaining({
        text: 'Чат не начался, и это знакомство закрылось (🦉 Сова). Скоро будут новые.',
        reply_markup: openApp,
      }),
    ]);
    expect(app.telegram.sentTo(owl.id).map((m) => m.text)).toEqual([
      'Чат не начался, и это знакомство закрылось (🦊 Лиса). Скоро будут новые.',
    ]);

    // A second run, a later run, a second tick: nothing more happens.
    expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });
    at(deadline + 3 * HOUR);
    expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });
    expect(app.telegram.of('sendMessage')).toHaveLength(2);

    // And the chat is over: a message into it is refused.
    app.telegram.clear();
    await app.handle(textUpdate(fox, 'поздно?'));
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
    expect(a).toBeTruthy();
  });

  it('does not expire when the only message never arrived', async () => {
    const { app, matchId, deadline, at, fox } = await silent({ second: { botReachable: false } });
    await app.handle(textUpdate(fox, 'ау'));
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({ verdict: 'rejected', delivered: false }),
    ]);
    at(deadline);
    expect(await app.deadlines.run()).toMatchObject({ expired: 1 });
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('expired');
  });

  it('is left alone while a message is on its way, and expires if that message never arrives', async () => {
    const { app, matchId, a, deadline, at } = await silent();
    at(deadline);
    // Accepted a moment ago, not delivered yet: the relay is between the two steps.
    await testDb.appPool.query(
      `INSERT INTO messages (id, match_id, sender_id, body, verdict, created_at, purge_after)
       VALUES (gen_random_uuid(), $1, $2, 'в пути', 'delivered', $3, $3::timestamptz + interval '30 days')`,
      [matchId, a, new Date(deadline - 5_000)],
    );
    expect(await app.deadlines.run()).toMatchObject({ expired: 0 });
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
    // A process that died there leaves the row behind. It does not keep the match open for ever.
    at(deadline + 3 * MINUTE);
    expect(await app.deadlines.run()).toMatchObject({ started: 0, expired: 1 });
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('expired');
  });

  it('expires in a u18 match like in any other, without a reminder nobody could act on', async () => {
    const { app, matchId, deadline, at, fox, owl } = await silent({ years: 16 });
    at(deadline - 12 * HOUR + 1000);
    expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });
    at(deadline);
    expect(await app.deadlines.run()).toMatchObject({ expired: 1 });
    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Чат не начался, и это знакомство закрылось (🦉 Сова). Скоро будут новые.',
    ]);
    expect(app.telegram.sentTo(owl.id)).toHaveLength(1);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('expired');
  });
});

describe('the first message', () => {
  it('stops expiry: the chat stays open long after the deadline', async () => {
    const { app, matchId, deadline, at, fox } = await silent();
    await app.handle(textUpdate(fox, 'привет'));
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');
    for (const later of [deadline, deadline + HOUR, deadline + 30 * DAY]) {
      at(later);
      expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });
    }
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');
    expect(await outboxOf(matchId)).toEqual([]);
  });

  it('starts the chat even if the process stopped right after delivering it', async () => {
    const { app, matchId, a, deadline, at } = await silent();
    const deliveredAt = deadline - 20 * HOUR;
    // Delivered, but the match is still results_ready: the step after the delivery never ran.
    const { rows } = await testDb.appPool.query<{ id: string }>(
      `INSERT INTO messages (id, match_id, sender_id, body, verdict, created_at, purge_after)
       VALUES (gen_random_uuid(), $1, $2, 'дошло', 'delivered', $3, $3::timestamptz + interval '30 days')
       RETURNING id`,
      [matchId, a, new Date(deliveredAt)],
    );
    await testDb.appPool.query('UPDATE messages SET delivered_at = $2 WHERE id = $1', [
      rows[0]!.id,
      new Date(deliveredAt),
    ]);

    // A moment after the delivery the relay may still be about to do it itself.
    at(deliveredAt + MINUTE);
    expect(await app.deadlines.run()).toMatchObject({ started: 0 });
    at(deliveredAt + 5 * MINUTE);
    expect(await app.deadlines.run()).toMatchObject({ started: 1, expired: 0 });
    const started = await testDb.ownerPool.query<{
      status: string;
      first: Date;
      deadline: Date | null;
    }>(
      'SELECT status::text AS status, first_message_at AS first, chat_deadline_at AS deadline FROM matches WHERE id = $1',
      [matchId],
    );
    expect(started.rows[0]).toMatchObject({ status: 'active', deadline: null });
    expect(started.rows[0]?.first.getTime()).toBe(deliveredAt);

    at(deadline + DAY);
    expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');
  });
});

describe('the reminder', () => {
  it('goes to both once, 12 hours before the window closes, and opens the results', async () => {
    const { app, matchId, deadline, at, fox, owl } = await silent();
    at(deadline - 12 * HOUR - MINUTE);
    expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });

    at(deadline - 12 * HOUR + 1000);
    expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 2 });
    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    const toMatch = `${TEST_MINIAPP_URL}?match=${matchId}`;
    expect(app.telegram.sentTo(fox.id).map((m) => m.payload)).toEqual([
      expect.objectContaining({
        text: 'Осталось 12 часов, чтобы написать первое сообщение (🦉 Сова). Потом это знакомство закроется.',
        reply_markup: { inline_keyboard: [[{ text: 'Написать', web_app: { url: toMatch } }]] },
      }),
    ]);
    expect(app.telegram.sentTo(owl.id).map((m) => m.text)).toEqual([
      'Осталось 12 часов, чтобы написать первое сообщение (🦊 Лиса). Потом это знакомство закроется.',
    ]);

    // Once: not a minute later, not an hour before the end.
    for (const later of [deadline - 11 * HOUR, deadline - HOUR, deadline - 1]) {
      at(later);
      expect(await app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });
    }
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });
    expect(app.telegram.of('sendMessage')).toHaveLength(2);
  });

  it('counts the hours that are really left', async () => {
    const { app, deadline, at, fox } = await silent();
    // The job was down: the reminder comes late, and says so.
    at(deadline - 90 * MINUTE);
    expect(await app.deadlines.run()).toMatchObject({ reminded: 2 });
    await app.sender.tick();
    expect(app.telegram.sentTo(fox.id)[0]?.text).toBe(
      'Осталось 2 часа, чтобы написать первое сообщение (🦉 Сова). Потом это знакомство закроется.',
    );
  });

  it('is not queued once somebody has written, and is dropped if the chat starts before it is sent', async () => {
    const written = await silent();
    await written.app.handle(textUpdate(written.fox, 'привет'));
    written.at(written.deadline - 6 * HOUR);
    expect(await written.app.deadlines.run()).toEqual({ started: 0, expired: 0, reminded: 0 });

    const racing = await silent();
    racing.at(racing.deadline - 6 * HOUR);
    expect(await racing.app.deadlines.run()).toMatchObject({ reminded: 2 });
    await racing.app.handle(textUpdate(racing.fox, 'успела раньше напоминания'));
    racing.app.telegram.clear();
    expect(await racing.app.sender.tick()).toMatchObject({ sent: 0, cancelled: 2 });
    expect(racing.app.telegram.calls).toEqual([]);
    expect(await outboxOf(racing.matchId)).toEqual([
      { kind: 'chat_reminder', status: 'cancelled', cancel_reason: 'outdated' },
      { kind: 'chat_reminder', status: 'cancelled', cancel_reason: 'outdated' },
    ]);
  });

  it('is cancelled together with everything else when the chat expires', async () => {
    const { app, matchId, deadline, at } = await silent();
    at(deadline - HOUR);
    expect(await app.deadlines.run()).toMatchObject({ reminded: 2 });
    // The sender was down until after the deadline.
    at(deadline + MINUTE);
    expect(await app.deadlines.run()).toMatchObject({ expired: 1 });
    expect(await outboxOf(matchId)).toEqual([
      { kind: 'chat_expired', status: 'pending', cancel_reason: null },
      { kind: 'chat_expired', status: 'pending', cancel_reason: null },
      { kind: 'chat_reminder', status: 'cancelled', cancel_reason: 'expired' },
      { kind: 'chat_reminder', status: 'cancelled', cancel_reason: 'expired' },
    ]);
  });
});

describe('retention', () => {
  it('removes the text of a message after 30 days and keeps the rest of it', async () => {
    const { app, matchId, clock, at, fox, owl } = await silent();
    const sentAt = clock.now().getTime();
    await app.handle(textUpdate(fox, 'это сотрётся'));
    at(sentAt + 10 * DAY);
    await app.handle(textUpdate(owl, 'а это ещё нет'));

    at(sentAt + 30 * DAY - 1000);
    expect(await app.retention.run()).toEqual({ purged: 0 });
    at(sentAt + 30 * DAY + 1000);
    expect(await app.retention.run()).toEqual({ purged: 1 });
    const rows = await messageRows(testDb.ownerPool, matchId);
    expect(rows.map((r) => r.body)).toEqual([null, 'а это ещё нет']);
    // Who sent it, that it arrived and where a reply to it goes are all still there.
    expect(rows[0]).toMatchObject({ verdict: 'delivered', delivered: true });
    expect(rows[0]?.recipient_tg_message_id).not.toBeNull();
    expect(await app.retention.run()).toEqual({ purged: 0 });

    app.telegram.clear();
    await app.handle(
      textUpdate(owl, 'ответ на стёртое', { replyTo: Number(rows[0]?.recipient_tg_message_id) }),
    );
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual(['🦉 Сова\nответ на стёртое']);
    // Nothing about the purge names a message or its text.
    expect(app.logLines().join('\n')).not.toContain('это сотрётся');
  });

  it('works through a backlog in batches', async () => {
    const { matchId, a, clock } = await silent();
    await testDb.appPool.query(
      `INSERT INTO messages (id, match_id, sender_id, body, verdict, created_at, purge_after)
       SELECT gen_random_uuid(), $1, $2, 'старое ' || n, 'delivered', now() - interval '40 days',
         now() - interval '10 days'
       FROM generate_series(1, 7) AS n`,
      [matchId, a],
    );
    const { createRetention } = await import('../../src/jobs/retention');
    const { createChatRepository } = await import('../../src/db/repositories/chat');
    const { memoryLogger } = await import('../support/fixtures');
    const retention = createRetention({
      chat: createChatRepository(testDb.db),
      clock,
      logger: memoryLogger().logger,
      batchSize: 3,
    });
    expect(await retention.run()).toEqual({ purged: 7 });
    expect((await messageRows(testDb.ownerPool, matchId)).every((r) => r.body === null)).toBe(true);
  });
});

describe('the jobs', () => {
  it('run under an advisory lock: a second instance does nothing meanwhile', async () => {
    for (const make of [
      (run: () => Promise<never>) =>
        createChatDeadlinesJob({ pool: testDb.appPool, deadlines: { run } }),
      (run: () => Promise<never>) =>
        createRetentionJob({ pool: testDb.appPool, retention: { run } }),
    ]) {
      let calls = 0;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const job = make(async () => {
        calls += 1;
        await gate;
        return undefined as never;
      });
      const signal = new AbortController().signal;
      const first = job.run(signal);
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
      await job.run(signal);
      release();
      await first;
      expect(calls).toBe(1);
      await job.run(signal);
      expect(calls).toBe(2);
    }
    expect(
      createChatDeadlinesJob({
        pool: testDb.appPool,
        deadlines: { run: () => Promise.reject(new Error('not run')) },
      }),
    ).toMatchObject({ name: 'chat-deadlines', intervalMs: 60_000, runOnStart: true });
    expect(
      createRetentionJob({
        pool: testDb.appPool,
        retention: { run: () => Promise.reject(new Error('not run')) },
      }),
    ).toMatchObject({ name: 'retention', intervalMs: 3_600_000, runOnStart: true });
  });
});
