/**
 * The notifications and the deadlines of the game (PLAN.md Phase 3, Q2): "your turn" when the
 * other player finishes first, "results are ready" to both, one reminder before the deadline, and
 * a neutral notice when an unplayed game expires. Each is sent exactly once.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock';
import { createGamesRepository } from '../../src/db/repositories/games';
import { DEFAULT_GAME_PARAMS } from '../../src/domain/game/params';
import { createGameDeadlines } from '../../src/jobs/game-deadlines';
import { createGameDeadlinesJob } from '../../src/jobs/jobs';
import { createGamePlay } from '../../src/services/game';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_MINIAPP_URL, memoryLogger } from '../support/fixtures';
import { GAME_QUESTIONS, insertGame, sides } from '../support/games';
import { insertActiveUser, insertMatch, matchRow } from '../support/matches';
import { buildSender } from '../support/notify';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

const HOUR = 3_600_000;
// Midday in every time zone the tests use, so nothing is sent silently by accident.
const NOON = () => {
  const now = new Date();
  now.setUTCHours(10, 0, 0, 0);
  return now.getTime() < Date.now() ? new Date(now.getTime() + 24 * HOUR) : now;
};

/** Two matched people with a game. `a` is user A of the match: `b` sees them as 🦊 Лиса. */
async function started() {
  const [first, second] = [
    await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) }),
    await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) }),
  ];
  const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
  await insertGame(testDb.appPool, match.id);
  const [a, b] = first.id < second.id ? [first, second] : [second, first];
  const deadline = (
    await testDb.ownerPool.query<{ at: Date }>(
      'SELECT game_deadline_at AS at FROM matches WHERE id = $1',
      [match.id],
    )
  ).rows[0]!.at;
  return { matchId: match.id, a, b, deadline };
}
const predictions = (pattern = 'AAAAA') =>
  sides(pattern).map((value, i) => ({ questionId: GAME_QUESTIONS[i]!, value: value as 'agree' }));
const play = (at = new Date()) =>
  createGamePlay({ games: createGamesRepository(testDb.db), clock: fixedClock(at) });
const deadlines = (at: Date) =>
  createGameDeadlines({
    games: createGamesRepository(testDb.db),
    clock: fixedClock(at),
    logger: memoryLogger().logger,
    params: DEFAULT_GAME_PARAMS,
  });
const outbox = async (matchId: string) =>
  (
    await testDb.ownerPool.query<{
      kind: string;
      user_id: string;
      status: string;
      cancel_reason: string | null;
    }>(
      `SELECT kind::text AS kind, user_id, status::text AS status, cancel_reason
       FROM outbox WHERE match_id = $1 ORDER BY kind, user_id`,
      [matchId],
    )
  ).rows;
const button = (text: string, url: string) => ({
  inline_keyboard: [[{ text, web_app: { url } }]],
});

describe('when the first player finishes', () => {
  it('tells the other player it is their turn, exactly once, and nobody else', async () => {
    const { matchId, a, b } = await started();
    expect(await play().submit(a.id, matchId, predictions())).toEqual({
      status: 'submitted',
      resultsReady: false,
    });
    expect(await outbox(matchId)).toEqual([
      { kind: 'game_turn', user_id: b.id, status: 'pending', cancel_reason: null },
    ]);

    const { sender, calls } = await buildSender(testDb, { now: NOON() });
    expect(await sender.tick()).toEqual({ sent: 1, cancelled: 0, failed: 0, retried: 0 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.payload).toMatchObject({
      chat_id: b.telegramId,
      text: 'Твой ход! 🦊 Лиса уже в игре: прогноз о тебе готов. Теперь угадываешь ты.',
      reply_markup: button('Играть', `${TEST_MINIAPP_URL}?match=${matchId}`),
    });
    // Plain text only, like every message of the bot.
    expect(calls[0]?.payload).not.toHaveProperty('parse_mode');
    expect(calls[0]?.payload).not.toHaveProperty('entities');
    expect(await sender.tick()).toEqual({ sent: 0, cancelled: 0, failed: 0, retried: 0 });
  });

  it('queues nothing more when the same submission is repeated', async () => {
    const { matchId, a } = await started();
    await play().submit(a.id, matchId, predictions());
    expect(await play().submit(a.id, matchId, predictions('DDDDD'))).toEqual({
      status: 'already_submitted',
    });
    expect(await outbox(matchId)).toHaveLength(1);
  });
});

describe('when both players have finished', () => {
  it('tells both that the results are ready, once each, in their own language', async () => {
    const { matchId, a, b } = await started();
    await play().submit(a.id, matchId, predictions());
    await testDb.ownerPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [b.id]);
    expect(await play().submit(b.id, matchId, predictions())).toEqual({
      status: 'submitted',
      resultsReady: true,
    });

    const { sender, calls } = await buildSender(testDb, { now: NOON() });
    // "Your turn" was still waiting for the second player: it is out of date now and is dropped.
    expect(await sender.tick()).toEqual({ sent: 2, cancelled: 1, failed: 0, retried: 0 });
    expect(await outbox(matchId)).toEqual(
      [
        { kind: 'game_results', user_id: a.id, status: 'sent', cancel_reason: null },
        { kind: 'game_results', user_id: b.id, status: 'sent', cancel_reason: null },
        { kind: 'game_turn', user_id: b.id, status: 'cancelled', cancel_reason: 'outdated' },
      ].sort((x, y) => (x.kind + x.user_id < y.kind + y.user_id ? -1 : 1)),
    );
    const toA = calls.find((c) => c.payload.chat_id === a.telegramId)?.payload;
    const toB = calls.find((c) => c.payload.chat_id === b.telegramId)?.payload;
    expect(toA).toMatchObject({
      text: 'Результаты готовы! 🦉 Сова и ты сыграли — посмотри, кто кого лучше угадал.',
      reply_markup: button('Смотреть', `${TEST_MINIAPP_URL}?match=${matchId}`),
    });
    expect(toB).toMatchObject({
      text: 'Results are in! You and 🦊 Fox have both played — see who read the other better.',
      reply_markup: button('See results', `${TEST_MINIAPP_URL}?match=${matchId}`),
    });
    expect(await sender.tick()).toEqual({ sent: 0, cancelled: 0, failed: 0, retried: 0 });
    expect(calls).toHaveLength(2);
  });

  it('never names the other person: only the alias, and no answer or guess', async () => {
    const { matchId, a, b } = await started();
    await testDb.ownerPool.query('UPDATE users SET username = $1 WHERE id = $2', [
      'very_secret',
      a.id,
    ]);
    await play().submit(a.id, matchId, predictions('ADADA'));
    await play().submit(b.id, matchId, predictions('DDDDD'));
    const { sender, calls, logLines } = await buildSender(testDb, { now: NOON() });
    await sender.tick();
    expect(calls).toHaveLength(2);
    // What Telegram receives: no ID of either user, no username, no answer, no guess.
    const sent = JSON.stringify(calls);
    for (const secret of ['very_secret', a.id, b.id, 'agree', 'q.pineapple_pizza']) {
      expect(sent).not.toContain(secret);
    }
    // The logs may hold internal IDs, never a username or the text of a message.
    const logs = logLines().join('\n');
    for (const secret of ['very_secret', 'Результаты готовы', 'Сова', 'Лиса']) {
      expect(logs).not.toContain(secret);
    }
  });
});

describe('the reminder (one per player, 12 hours before the game deadline)', () => {
  it('goes to every player who has not played, once', async () => {
    const { matchId, a, b, deadline } = await started();
    // 13 hours before the deadline: too early.
    expect(await deadlines(new Date(deadline.getTime() - 13 * HOUR)).run()).toEqual({
      expired: 0,
      reminded: 0,
    });
    const at = new Date(deadline.getTime() - 12 * HOUR + 60_000);
    expect(await deadlines(at).run()).toEqual({ expired: 0, reminded: 2 });
    // A minute later, an hour later, or from a second instance: nothing more.
    expect(await deadlines(new Date(at.getTime() + 60_000)).run()).toEqual({
      expired: 0,
      reminded: 0,
    });
    expect(await deadlines(new Date(at.getTime() + HOUR)).run()).toEqual({
      expired: 0,
      reminded: 0,
    });
    expect(await outbox(matchId)).toEqual(
      [a.id, b.id].sort().map((user_id) => ({
        kind: 'game_reminder',
        user_id,
        status: 'pending',
        cancel_reason: null,
      })),
    );

    const { sender, calls } = await buildSender(testDb, { now: at });
    expect(await sender.tick()).toMatchObject({ sent: 2 });
    const toB = calls.find((c) => c.payload.chat_id === b.telegramId)?.payload;
    expect(toB).toMatchObject({
      text: 'Осталось 12 часов, чтобы сыграть. Тебя ждёт 🦊 Лиса.',
      reply_markup: button('Играть', `${TEST_MINIAPP_URL}?match=${matchId}`),
    });
    expect(await sender.tick()).toMatchObject({ sent: 0 });
  });

  it('skips a player who has already played', async () => {
    const { matchId, a, b, deadline } = await started();
    await play().submit(a.id, matchId, predictions());
    await deadlines(new Date(deadline.getTime() - 11 * HOUR)).run();
    expect((await outbox(matchId)).filter((o) => o.kind === 'game_reminder')).toEqual([
      { kind: 'game_reminder', user_id: b.id, status: 'pending', cancel_reason: null },
    ]);
  });

  it('is dropped if the player plays before it is sent', async () => {
    const { matchId, a, deadline } = await started();
    const at = new Date(deadline.getTime() - 11 * HOUR);
    await deadlines(at).run();
    await play().submit(a.id, matchId, predictions());
    const { sender, calls } = await buildSender(testDb, { now: at });
    await sender.tick();
    expect(calls.map((c) => c.payload.chat_id)).not.toContain(a.telegramId);
    expect(await outbox(matchId)).toContainEqual({
      kind: 'game_reminder',
      user_id: a.id,
      status: 'cancelled',
      cancel_reason: 'outdated',
    });
  });

  it('is not queued for a finished game, or for a match that is over', async () => {
    const finished = await started();
    await play().submit(finished.a.id, finished.matchId, predictions());
    await play().submit(finished.b.id, finished.matchId, predictions());
    const closed = await started();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [closed.matchId],
    );
    await deadlines(new Date(finished.deadline.getTime() - HOUR)).run();
    for (const matchId of [finished.matchId, closed.matchId]) {
      expect((await outbox(matchId)).filter((o) => o.kind === 'game_reminder')).toEqual([]);
    }
  });
});

describe('expiry (Q2: an unplayed game expires 48 hours after the match)', () => {
  it('expires the match at its deadline, once, and tells both players in neutral words', async () => {
    const { matchId, a, b, deadline } = await started();
    // One second before the deadline nothing happens.
    expect((await deadlines(new Date(deadline.getTime() - 1_000)).run()).expired).toBe(0);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('pending_game');

    // The deadline is stored with microseconds; the first whole millisecond after it.
    const at = new Date(deadline.getTime() + 1);
    expect((await deadlines(at).run()).expired).toBe(1);
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'expired',
      close_reason: 'expired',
      closed_at: at,
    });
    // A rerun, and a run much later, change nothing.
    expect((await deadlines(at).run()).expired).toBe(0);
    expect((await deadlines(new Date(at.getTime() + 24 * HOUR)).run()).expired).toBe(0);

    const rows = await outbox(matchId);
    expect(rows.filter((o) => o.kind === 'game_expired')).toEqual(
      [a.id, b.id].sort().map((user_id) => ({
        kind: 'game_expired',
        user_id,
        status: 'pending',
        cancel_reason: null,
      })),
    );
    // The reminders that were still waiting are cancelled with the match.
    expect(rows.filter((o) => o.kind === 'game_reminder').map((o) => o.cancel_reason)).toEqual([
      'expired',
      'expired',
    ]);

    const { sender, calls } = await buildSender(testDb, { now: at });
    expect(await sender.tick()).toEqual({ sent: 2, cancelled: 0, failed: 0, retried: 0 });
    const toA = calls.find((c) => c.payload.chat_id === a.telegramId)?.payload;
    expect(toA).toMatchObject({
      text: 'Время на игру вышло, и это знакомство закрылось (🦉 Сова). Скоро будут новые.',
      // The match is over: the button opens the app, not the match.
      reply_markup: button('Открыть SameSync', TEST_MINIAPP_URL),
    });
    expect(await sender.tick()).toMatchObject({ sent: 0 });
    expect(calls).toHaveLength(2);
  });

  it('expires a half-played game too, and nothing can be submitted afterwards', async () => {
    const { matchId, a, b, deadline } = await started();
    await play().submit(a.id, matchId, predictions());
    const at = new Date(deadline.getTime() + 60_000);
    expect((await deadlines(at).run()).expired).toBe(1);
    expect(await play(at).submit(b.id, matchId, predictions())).toEqual({ status: 'not_playable' });
    // "Your turn" was never sent to the second player: it went with the match.
    expect((await outbox(matchId)).find((o) => o.kind === 'game_turn')).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'expired',
    });
  });

  it('leaves alone a finished game and a game whose deadline has not come', async () => {
    const finished = await started();
    await play().submit(finished.a.id, finished.matchId, predictions());
    await play().submit(finished.b.id, finished.matchId, predictions());
    const fresh = await started();
    const at = new Date(Math.min(finished.deadline.getTime(), fresh.deadline.getTime()) - HOUR);
    expect((await deadlines(at).run()).expired).toBe(0);
    // Long after the game deadline, a match whose results are ready is still open.
    await testDb.ownerPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [fresh.matchId],
    );
    expect((await deadlines(new Date(finished.deadline.getTime() + 72 * HOUR)).run()).expired).toBe(
      0,
    );
    expect((await matchRow(testDb.ownerPool, finished.matchId))?.status).toBe('results_ready');
    expect(await matchRow(testDb.ownerPool, fresh.matchId)).toMatchObject({ close_reason: 'left' });
  });

  it('handles many overdue games in batches', async () => {
    const games = [];
    for (let i = 0; i < 7; i++) games.push(await started());
    const latest = Math.max(...games.map((g) => g.deadline.getTime()));
    const job = createGameDeadlines({
      games: createGamesRepository(testDb.db),
      clock: fixedClock(new Date(latest + 1)),
      logger: memoryLogger().logger,
      params: DEFAULT_GAME_PARAMS,
      batchSize: 3,
    });
    expect(await job.run()).toEqual({ expired: 7, reminded: 0 });
    const { rows } = await testDb.ownerPool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM outbox WHERE kind = 'game_expired'",
    );
    expect(rows[0]?.n).toBe(14);
  });
});

describe('the scheduled job', () => {
  it('holds an advisory lock: two instances never apply the deadlines at the same time', async () => {
    let running = 0;
    let peak = 0;
    let calls = 0;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const job = createGameDeadlinesJob({
      pool: testDb.appPool,
      deadlines: {
        async run() {
          calls += 1;
          running += 1;
          peak = Math.max(peak, running);
          await gate;
          running -= 1;
          return { expired: 0, reminded: 0 };
        },
      },
    });
    expect(job).toMatchObject({ name: 'game-deadlines', intervalMs: 60_000, runOnStart: true });
    const signal = new AbortController().signal;
    const first = job.run(signal);
    // Give the first run time to take the lock, then start a second one.
    while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    await job.run(signal);
    release();
    await first;
    expect({ calls, peak }).toEqual({ calls: 1, peak: 1 });
    // Once the lock is free, the job runs again.
    await job.run(signal);
    expect(calls).toBe(2);
  });
});
