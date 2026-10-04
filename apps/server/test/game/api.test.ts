/**
 * The game API (PLAN.md Phase 3): GET /api/matches/:id/game, PUT …/predictions, GET …/results.
 * Participants only; no peeking at the other person's answers before both have finished;
 * guesses are write-once; the game closes at its deadline.
 */
import { randomInt } from 'node:crypto';
import type { GameResponse, MatchSummary, ResultsResponse } from '@samesync/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock';
import { buildTestApp, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import { GAME_QUESTIONS, insertGame, sides, type InsertGame } from '../support/games';
import { insertActiveUser, insertMatch, matchRow, withoutTriggers } from '../support/matches';
import { birthDateYearsAgo, type InsertUser } from '../support/users';

let testDb: TestDatabase;
let t: TestApp;
const clock = fixedClock(new Date());
beforeAll(async () => {
  testDb = await createTestDatabase();
  t = await buildTestApp(testDb, { clock });
});
afterAll(() => testDb.drop());

type Client = ReturnType<TestApp['as']>;
interface Person {
  id: string;
  telegramId: number;
  as: Client;
}

/** An active user who can call the API: a DB row plus the Telegram identity that maps to it. */
async function person(over: InsertUser = {}): Promise<Person> {
  const telegram: TestUser = { id: randomInt(1, 2 ** 40), first_name: 'Test' };
  const row = await insertActiveUser(testDb.appPool, {
    telegramId: telegram.id,
    birthDate: birthDateYearsAgo(25),
    ...over,
  });
  return { ...row, as: t.as(telegram) };
}

/**
 * Two matched people with a game of five takes. `low` is user A of the match and agrees with all
 * five; `high` is user B and disagrees with the last one, the closing question.
 */
async function started(
  over: InsertUser = {},
  band: 'adult' | 'u18' = 'adult',
  game: InsertGame = {},
) {
  const [first, second] = [await person(over), await person(over)];
  const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id, band });
  await insertGame(testDb.appPool, match.id, game);
  const [low, high] = first.id < second.id ? [first, second] : [second, first];
  return { matchId: match.id, low, high };
}

const guesses = (pattern: string, ids: readonly string[] = GAME_QUESTIONS) => ({
  predictions: sides(pattern).map((value, i) => ({ questionId: ids[i], value })),
});
const submit = (who: Person, matchId: string, pattern = 'AAAAA') =>
  who.as.put(`/api/matches/${matchId}/predictions`, guesses(pattern));
const game = (who: Person, matchId: string) => who.as.get(`/api/matches/${matchId}/game`);
const results = (who: Person, matchId: string) => who.as.get(`/api/matches/${matchId}/results`);
const stored = async (matchId: string, predictorId: string) =>
  (
    await testDb.ownerPool.query<{ question_id: string; predicted: string }>(
      `SELECT question_id, predicted::text AS predicted FROM game_predictions
       WHERE match_id = $1 AND predictor_id = $2 ORDER BY question_id`,
      [matchId, predictorId],
    )
  ).rows;
const SECRETS = /agree|disagree|answers?_|predict/i;

describe('GET /api/matches/:id/game', () => {
  it('gives each player the five takes of the game, in their language, and nothing else', async () => {
    const { matchId, low, high } = await started();
    await testDb.ownerPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [high.id]);
    const [forLow, forHigh] = [await game(low, matchId), await game(high, matchId)];
    expect([forLow.status, forHigh.status]).toEqual([200, 200]);
    const ru = (await forLow.json()) as GameResponse;
    const rawEn = await forHigh.text();
    const en = JSON.parse(rawEn) as GameResponse;

    expect(ru.questions.map((q) => q.id).sort()).toEqual([...GAME_QUESTIONS].sort());
    expect(en.questions.map((q) => q.id).sort()).toEqual([...GAME_QUESTIONS].sort());
    expect(ru.questions.find((q) => q.id === 'q.pineapple_pizza')?.text).toBe(
      'Ананасы на пицце — это нормально',
    );
    expect(en.questions.find((q) => q.id === 'q.pineapple_pizza')?.text).toBe(
      'Pineapple on pizza is fine',
    );
    // Only the takes: no answer of anyone, no hint of which take is the split.
    for (const question of [...ru.questions, ...en.questions]) {
      expect(Object.keys(question).sort()).toEqual(['id', 'text']);
    }
    expect(Object.keys(en)).toEqual(['questions']);
    expect(rawEn).not.toMatch(SECRETS);
  });

  it('shows the takes in an order of the player, which does not end on the split for everyone', async () => {
    // The stored order always ends on the closing question. Over many games the last card a
    // player sees must not always be that one.
    const closingLast: boolean[] = [];
    for (let i = 0; i < 12; i++) {
      const { matchId, low, high } = await started();
      for (const who of [low, high]) {
        const body = (await (await game(who, matchId)).json()) as GameResponse;
        closingLast.push(body.questions.at(-1)?.id === GAME_QUESTIONS.at(-1));
        // The same player always gets the same order.
        expect(await (await game(who, matchId)).json()).toEqual(body);
      }
    }
    expect(closingLast).toContain(false);
  });

  it('answers 404 to a stranger, for an unknown or malformed ID, and for a match without a game', async () => {
    const { matchId } = await started();
    const stranger = await person();
    expect((await game(stranger, matchId)).status).toBe(404);
    expect((await game(stranger, '00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await game(stranger, 'not-a-uuid')).status).toBe(404);
    // A participant of another match is a stranger to this one.
    const other = await started();
    expect((await game(other.low, matchId)).status).toBe(404);

    const [first, second] = [await person(), await person()];
    const bare = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    expect((await game(first, bare.id)).status).toBe(404);
  });

  it('answers 409 once the caller has submitted, and once the game is over', async () => {
    const { matchId, low, high } = await started();
    expect((await submit(low, matchId)).status).toBe(200);
    const again = await game(low, matchId);
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'conflict' });
    expect((await game(high, matchId)).status).toBe(200);
    expect((await submit(high, matchId)).status).toBe(200);
    expect((await game(high, matchId)).status).toBe(409);

    const closed = await started();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [closed.matchId],
    );
    expect((await game(closed.low, closed.matchId)).status).toBe(409);
  });
});

describe('PUT /api/matches/:id/predictions', () => {
  it('stores the guesses of the first player and leaves the match waiting for the other', async () => {
    const { matchId, low, high } = await started();
    const res = await submit(low, matchId, 'ADADA');
    expect(res.status).toBe(200);
    const raw = await res.text();
    const summary = JSON.parse(raw) as MatchSummary;
    expect(summary).toMatchObject({
      id: matchId,
      status: 'pending_game',
      resultsReadyAt: null,
      chatDeadlineAt: null,
      game: { questions: 5, youDone: true, theyDone: false },
    });
    // The answer to a submission never carries an answer or a guess.
    expect(raw).not.toMatch(SECRETS);
    expect((await stored(matchId, low.id)).map((p) => p.predicted)).toHaveLength(5);
    expect(await stored(matchId, high.id)).toEqual([]);

    const seenByOther = (await (
      await high.as.get(`/api/matches/${matchId}`)
    ).json()) as MatchSummary;
    expect(seenByOther.game).toEqual({ questions: 5, youDone: false, theyDone: true });
  });

  it('makes the results ready when the second player submits, with the 48-hour chat deadline', async () => {
    const { matchId, low, high } = await started();
    await submit(low, matchId);
    const res = await submit(high, matchId);
    expect(res.status).toBe(200);
    const summary = (await res.json()) as MatchSummary;
    expect(summary).toMatchObject({
      status: 'results_ready',
      game: { questions: 5, youDone: true, theyDone: true },
    });
    expect(summary.resultsReadyAt).toBe(clock.now().toISOString());
    expect(Date.parse(summary.chatDeadlineAt!) - Date.parse(summary.resultsReadyAt!)).toBe(
      48 * 3_600_000,
    );
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
  });

  it('is write-once: a second submission is refused and changes nothing', async () => {
    const { matchId, low } = await started();
    await submit(low, matchId, 'AAAAA');
    const before = await stored(matchId, low.id);
    const again = await submit(low, matchId, 'DDDDD');
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'conflict' });
    expect(await stored(matchId, low.id)).toEqual(before);
    expect(before.every((p) => p.predicted === 'agree')).toBe(true);
  });

  it('takes one submission when the same player sends two at once', async () => {
    const { matchId, low } = await started();
    const responses = await Promise.all([
      submit(low, matchId, 'AAAAA'),
      submit(low, matchId, 'DDDDD'),
    ]);
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await stored(matchId, low.id);
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((p) => p.predicted)).size).toBe(1);
  });

  it('gets to the results once when both players submit at the same moment', async () => {
    const { matchId, low, high } = await started();
    const responses = await Promise.all([submit(low, matchId), submit(high, matchId)]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
    const { rows } = await testDb.ownerPool.query<{ kind: string; n: number }>(
      'SELECT kind::text AS kind, count(*)::int AS n FROM outbox WHERE match_id = $1 GROUP BY kind ORDER BY kind',
      [matchId],
    );
    expect(rows).toEqual([
      { kind: 'game_results', n: 2 },
      { kind: 'game_turn', n: 1 },
    ]);
  });

  it.each([
    ['one guess missing', guesses('AAAA', GAME_QUESTIONS.slice(0, 4))],
    [
      'a take that is not in the game',
      guesses('AAAAA', [...GAME_QUESTIONS.slice(0, 4), 'q.cats_over_dogs']),
    ],
    ['the same take twice', guesses('AAAAA', [...GAME_QUESTIONS.slice(0, 4), GAME_QUESTIONS[0]])],
    ['one guess too many', guesses('AAAAAA', [...GAME_QUESTIONS, 'q.cats_over_dogs'])],
    [
      'a skip',
      { predictions: GAME_QUESTIONS.map((questionId) => ({ questionId, value: 'skip' })) },
    ],
    ['no guesses', { predictions: [] }],
    ['a body that is not the contract', { guesses: [] }],
  ])('refuses %s with 400 and stores nothing', async (_label, body) => {
    const { matchId, low } = await started();
    const res = await low.as.put(`/api/matches/${matchId}/predictions`, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid' });
    expect(await stored(matchId, low.id)).toEqual([]);
    // The game is still open for a correct submission.
    expect((await submit(low, matchId)).status).toBe(200);
  });

  it('answers 404 to anyone who is not in the match, and stores nothing for them', async () => {
    const { matchId } = await started();
    const stranger = await person();
    const other = await started();
    for (const who of [stranger, other.low]) {
      expect((await submit(who, matchId)).status).toBe(404);
      expect(await stored(matchId, who.id)).toEqual([]);
    }
    expect((await submit(stranger, 'not-a-uuid')).status).toBe(404);
  });

  it('is refused for a match that has ended', async () => {
    const { matchId, low } = await started();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [matchId],
    );
    expect((await submit(low, matchId)).status).toBe(409);
    expect(await stored(matchId, low.id)).toEqual([]);
  });
});

describe('GET /api/matches/:id/results', () => {
  it('answers 409 until both players have submitted, to the one who played and to the one who did not', async () => {
    const { matchId, low, high } = await started();
    for (const who of [low, high]) {
      const res = await results(who, matchId);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'out_of_order' });
    }
    await submit(low, matchId);
    for (const who of [low, high]) {
      const res = await results(who, matchId);
      expect(res.status).toBe(409);
      // No peeking: not a single answer or guess in the refusal.
      expect(await res.text()).not.toMatch(SECRETS);
    }
  });

  it('shows each player how well both guessed, every question side by side, and ends on the split', async () => {
    const { matchId, low, high } = await started();
    // low answered AAAAA, high AAAAD. low guesses high right on all five; high gets three of low's.
    await submit(low, matchId, 'AAAAD');
    await submit(high, matchId, 'DDAAA');

    const forLow = (await (await results(low, matchId)).json()) as ResultsResponse;
    const forHigh = (await (await results(high, matchId)).json()) as ResultsResponse;
    expect(forLow).toMatchObject({ total: 5, youGuessed: 5, theyGuessed: 3 });
    expect(forHigh).toMatchObject({ total: 5, youGuessed: 3, theyGuessed: 5 });

    expect(forLow.rounds.map((r) => r.questionId)).toEqual([...GAME_QUESTIONS]);
    expect(forLow.rounds[0]).toEqual({
      questionId: 'q.pineapple_pizza',
      text: 'Ананасы на пицце — это нормально',
      yours: 'agree',
      theirs: 'agree',
      yourGuess: 'agree',
      theirGuess: 'disagree',
    });
    // The same round from the other side.
    expect(forHigh.rounds[0]).toMatchObject({
      yours: 'agree',
      theirs: 'agree',
      yourGuess: 'disagree',
      theirGuess: 'agree',
    });
    // The closing question is last, and it is the one they split on.
    expect(forLow.rounds.at(-1)).toMatchObject({
      questionId: 'q.calls_without_warning',
      yours: 'agree',
      theirs: 'disagree',
    });
    expect(forHigh.rounds.at(-1)).toMatchObject({ yours: 'disagree', theirs: 'agree' });
  });

  it('suggests the opener of the caller side of the closing question, and of nothing else', async () => {
    const { matchId, low, high } = await started();
    await submit(low, matchId);
    await submit(high, matchId);
    const agree = t.content.game.opener('q.calls_without_warning', 'agree')!;
    const disagree = t.content.game.opener('q.calls_without_warning', 'disagree')!;
    const forLow = (await (await results(low, matchId)).json()) as ResultsResponse;
    const forHigh = (await (await results(high, matchId)).json()) as ResultsResponse;
    expect(forLow.opener).toBe(agree.ru);
    expect(forHigh.opener).toBe(disagree.ru);
    expect(forLow.opener).not.toBe(forHigh.opener);
  });

  it('keeps the opener in the language of the match when the reader has switched theirs', async () => {
    const { matchId, low, high } = await started();
    await submit(low, matchId);
    await submit(high, matchId);
    await testDb.ownerPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [low.id]);
    const body = (await (await results(low, matchId)).json()) as ResultsResponse;
    // The cards follow the reader; the message is for the other person, who matched in Russian.
    expect(body.rounds[0]?.text).toBe('Pineapple on pizza is fine');
    expect(body.opener).toBe(t.content.game.opener('q.calls_without_warning', 'agree')!.ru);
  });

  it('uses the answers of the moment the match was made, whatever the profiles say now (Q5)', async () => {
    const { matchId, low, high } = await started();
    await submit(low, matchId, 'AAAAD');
    await submit(high, matchId, 'AAAAA');
    const before = await (await results(low, matchId)).json();
    for (const who of [low, high]) {
      await testDb.appPool.query(
        `INSERT INTO answers (user_id, question_id, value, content_release, answered_at)
         SELECT $1, q, 'disagree',
           (SELECT version FROM content_releases ORDER BY applied_at DESC LIMIT 1), now()
         FROM unnest($2::text[]) AS q
         ON CONFLICT (user_id, question_id) DO UPDATE SET value = 'disagree'`,
        [who.id, [...GAME_QUESTIONS]],
      );
    }
    expect(await (await results(low, matchId)).json()).toEqual(before);
  });

  it('answers 404 to a stranger and 409 once the match has ended', async () => {
    const { matchId, low, high } = await started();
    await submit(low, matchId);
    await submit(high, matchId);
    expect((await results(await person(), matchId)).status).toBe(404);
    expect((await results(low, 'not-a-uuid')).status).toBe(404);
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [matchId],
    );
    const res = await results(low, matchId);
    expect(res.status).toBe(409);
    expect(await res.text()).not.toMatch(SECRETS);
  });
});

describe('a band change', () => {
  it('turns the game, the predictions and the results into 404 for both former participants', async () => {
    const { matchId, low, high } = await started({ birthDate: birthDateYearsAgo(17) }, 'u18');
    await submit(low, matchId);
    expect((await game(high, matchId)).status).toBe(200);
    await testDb.ownerPool.query(
      "SELECT admin_set_birth_date($1, $2::date, 777, 'age correction')",
      [low.id, birthDateYearsAgo(18)],
    );
    for (const who of [low, high]) {
      expect((await game(who, matchId)).status).toBe(404);
      expect((await submit(who, matchId)).status).toBe(404);
      expect((await results(who, matchId)).status).toBe(404);
    }
    expect(await stored(matchId, high.id)).toEqual([]);
  });

  it('hides finished results too, as soon as a live band differs, before any job has run', async () => {
    const { matchId, low, high } = await started({ birthDate: birthDateYearsAgo(17) }, 'u18');
    await submit(low, matchId);
    await submit(high, matchId);
    expect((await results(high, matchId)).status).toBe(200);
    // The 18th birthday is today; the cached band and the match are untouched.
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(18), low.id]),
    );
    // No API call may run as `low` before this check: any write to that row would fix the cache.
    const res = await results(high, matchId);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toMatch(SECRETS);
    expect((await results(low, matchId)).status).toBe(404);
  });
});

describe('who may call the game API', () => {
  it.each(['frozen', 'deleted'])('refuses a %s account with 403', async (status) => {
    const { matchId, low } = await started();
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET status = $1 WHERE id = $2', [status, low.id]),
    );
    expect((await game(low, matchId)).status).toBe(403);
    expect((await submit(low, matchId)).status).toBe(403);
    expect((await results(low, matchId)).status).toBe(403);
    expect(await stored(matchId, low.id)).toEqual([]);
  });

  it('needs valid initData', async () => {
    const { matchId } = await started();
    for (const path of ['game', 'results']) {
      expect((await t.app.request(`/api/matches/${matchId}/${path}`)).status).toBe(401);
    }
    const res = await t.app.request(`/api/matches/${matchId}/predictions`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(guesses('AAAAA')),
    });
    expect(res.status).toBe(401);
  });

  it('ignores a user ID in the body: the guesses are always the caller own', async () => {
    const { matchId, low, high } = await started();
    const res = await low.as.put(`/api/matches/${matchId}/predictions`, {
      ...guesses('AAAAA'),
      userId: high.id,
      predictorId: high.id,
    });
    expect(res.status).toBe(200);
    expect(await stored(matchId, low.id)).toHaveLength(5);
    expect(await stored(matchId, high.id)).toEqual([]);
  });
});

describe('the game deadline (Q2: 48 hours from the match)', () => {
  it('closes the game for both players the moment it passes, before the expiry job has run', async () => {
    const { matchId, low, high } = await started();
    await submit(low, matchId);
    const now = clock.now();
    try {
      clock.set(new Date(now.getTime() + 47 * 3_600_000));
      expect((await game(high, matchId)).status).toBe(200);
      clock.set(new Date(now.getTime() + 48 * 3_600_000 + 60_000));
      expect((await game(high, matchId)).status).toBe(409);
      expect((await submit(high, matchId)).status).toBe(409);
      expect(await stored(matchId, high.id)).toEqual([]);
      // The first player still has no results: the other one never played.
      expect((await results(low, matchId)).status).toBe(409);
    } finally {
      clock.set(now);
    }
  });
});
