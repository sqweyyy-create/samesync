/**
 * SAFETY SUITE — the game (CLAUDE.md invariants 1, 2, 4 and 9; PLAN.md §3 layer 2).
 * A prediction goes from one user to the other, and results show each user the other's answers.
 * These tests skip the app and attack the database directly as the app role: only a participant
 * of a match that is still being played can predict, both live bands must equal the match band
 * even when the cached `age_band` is stale, a game's content never changes, and results become
 * ready only for two players who both finished and are still in the same band.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db';
import {
  GAME_QUESTIONS,
  gameRow,
  insertGame,
  insertPredictions,
  markDone,
  toResultsReady,
} from '../support/games';
import { insertActiveUser, insertMatch, matchRow, withoutTriggers } from '../support/matches';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const born = (years: number, over = {}) =>
  insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(years), ...over });
const refused = (rule: string) => ({ code: 'SS020', message: `prediction rejected: ${rule}` });
const statusRefused = (rule: string) => ({
  code: 'SS012',
  message: `match status rejected: ${rule}`,
});
const DENIED = { code: '42501' };

/** Two matched users with their game. `a` is the lower ID (user A of the match). */
async function playing(years = 25, band: 'adult' | 'u18' = 'adult') {
  const [first, second] = [await born(years), await born(years)];
  const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id, band });
  await insertGame(testDb.appPool, match.id);
  return { matchId: match.id, a: match.userA, b: match.userB };
}
const predict = (matchId: string, predictorId: string, pattern?: string) =>
  insertPredictions(testDb.appPool, { matchId, predictorId, ...(pattern ? { pattern } : {}) });
const one = (matchId: string, predictorId: string, questionId: string, predicted = 'agree') =>
  testDb.appPool.query(
    'INSERT INTO game_predictions (match_id, predictor_id, question_id, predicted) VALUES ($1, $2, $3, $4)',
    [matchId, predictorId, questionId, predicted],
  );
const predictionCount = async (matchId: string) =>
  Number(
    (
      await testDb.ownerPool.query<{ n: string }>(
        'SELECT count(*) AS n FROM game_predictions WHERE match_id = $1',
        [matchId],
      )
    ).rows[0]?.n,
  );

describe('writing a prediction', () => {
  it('is possible for each participant, once per question of the game', async () => {
    const { matchId, a, b } = await playing();
    await predict(matchId, a);
    await predict(matchId, b, 'DDDDD');
    expect(await predictionCount(matchId)).toBe(10);
    // Write-once: the same question again is a duplicate key.
    await expect(one(matchId, a, GAME_QUESTIONS[0])).rejects.toMatchObject({ code: '23505' });
  });

  it('is refused for anyone who is not in the match', async () => {
    const { matchId } = await playing();
    const stranger = await born(25);
    await expect(predict(matchId, stranger.id)).rejects.toMatchObject(refused('not_participant'));
    // A participant of another match is still a stranger here.
    const other = await playing();
    await expect(predict(matchId, other.a)).rejects.toMatchObject(refused('not_participant'));
    expect(await predictionCount(matchId)).toBe(0);
  });

  it('is refused for an unknown match, a question outside the game, and a skip', async () => {
    const { matchId, a } = await playing();
    await expect(predict('00000000-0000-7000-8000-000000000000', a)).rejects.toMatchObject(
      refused('unknown_match'),
    );
    await expect(one(matchId, a, 'q.cats_over_dogs')).rejects.toMatchObject(refused('not_in_game'));
    await expect(one(matchId, a, GAME_QUESTIONS[0], 'skip')).rejects.toMatchObject({
      code: '23514',
      constraint: 'game_predictions_no_skip',
    });
  });

  it('is refused for a match without a game', async () => {
    const [first, second] = [await born(25), await born(25)];
    const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    await expect(one(match.id, first.id, GAME_QUESTIONS[0])).rejects.toMatchObject(
      refused('not_in_game'),
    );
  });

  it.each([
    ["status = 'closed', close_reason = 'left', closed_at = now()"],
    ["status = 'expired', close_reason = 'expired', closed_at = now()"],
    ["status = 'closed', close_reason = 'band_change', closed_at = now()"],
  ])('is refused once the match is over (%s)', async (change) => {
    const { matchId, a, b } = await playing();
    await testDb.appPool.query(`UPDATE matches SET ${change} WHERE id = $1`, [matchId]);
    await expect(predict(matchId, a)).rejects.toMatchObject(refused('game_over'));
    await expect(predict(matchId, b)).rejects.toMatchObject(refused('game_over'));
  });

  it('is refused for a player who has finished, and for both once results are ready', async () => {
    const { matchId, a, b } = await playing();
    await predict(matchId, a);
    await markDone(testDb.appPool, matchId, 'a');
    // Finished means finished, even if one of the questions were free again.
    await testDb.ownerPool.query(
      'DELETE FROM game_predictions WHERE match_id = $1 AND predictor_id = $2 AND question_id = $3',
      [matchId, a, GAME_QUESTIONS[0]],
    );
    await expect(one(matchId, a, GAME_QUESTIONS[0])).rejects.toMatchObject(
      refused('already_finished'),
    );

    await predict(matchId, b);
    await markDone(testDb.appPool, matchId, 'b');
    await toResultsReady(testDb.appPool, matchId);
    await testDb.ownerPool.query(
      'DELETE FROM game_predictions WHERE match_id = $1 AND predictor_id = $2 AND question_id = $3',
      [matchId, b, GAME_QUESTIONS[0]],
    );
    await expect(one(matchId, b, GAME_QUESTIONS[0])).rejects.toMatchObject(refused('game_over'));
  });

  it('can never be changed or deleted by the app', async () => {
    const { matchId, a } = await playing();
    await predict(matchId, a);
    await expect(
      testDb.appPool.query(
        "UPDATE game_predictions SET predicted = 'disagree' WHERE match_id = $1",
        [matchId],
      ),
    ).rejects.toMatchObject(DENIED);
    await expect(
      testDb.appPool.query('DELETE FROM game_predictions WHERE match_id = $1', [matchId]),
    ).rejects.toMatchObject(DENIED);
    await expect(
      testDb.appPool.query(
        'ALTER TABLE game_predictions DISABLE TRIGGER game_predictions_10_guard_insert',
      ),
    ).rejects.toMatchObject(DENIED);
  });
});

describe('bands and account status are checked live, from the birth date', () => {
  it('refuses a prediction as soon as one user is 18 by birth date, with the cached band still u18', async () => {
    const { matchId, a, b } = await playing(17, 'u18');
    // The 18th birthday is today. Nothing has rewritten the cache or closed the match yet.
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(18), a]),
    );
    const { rows } = await testDb.ownerPool.query<{ age_band: string }>(
      'SELECT age_band FROM users WHERE id = $1',
      [a],
    );
    expect(rows[0]?.age_band).toBe('u18');
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('pending_game');
    // Neither the new adult nor the minor can send game data to the other.
    await expect(predict(matchId, a)).rejects.toMatchObject(refused('band'));
    await expect(predict(matchId, b)).rejects.toMatchObject(refused('band'));
    expect(await predictionCount(matchId)).toBe(0);
  });

  it('refuses a prediction in an adult match once a user is a minor by birth date', async () => {
    const { matchId, a, b } = await playing();
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(16), b]),
    );
    await expect(predict(matchId, a)).rejects.toMatchObject(refused('band'));
    await expect(predict(matchId, b)).rejects.toMatchObject(refused('band'));
  });

  it.each(['frozen', 'deleted', 'waitlisted'])(
    'refuses a prediction while either user is %s, even if the match is still open',
    async (status) => {
      const { matchId, a, b } = await playing();
      await withoutTriggers(testDb.ownerPool, (c) =>
        c.query('UPDATE users SET status = $1 WHERE id = $2', [status, a]),
      );
      await expect(predict(matchId, a)).rejects.toMatchObject(refused('not_active'));
      await expect(predict(matchId, b)).rejects.toMatchObject(refused('not_active'));
    },
  );

  it('closes the game with the match on a birth-date correction: nothing can be predicted after it', async () => {
    const { matchId, a, b } = await playing(17, 'u18');
    await predict(matchId, a);
    await testDb.ownerPool.query(
      "SELECT admin_set_birth_date($1, $2::date, 777, 'age correction')",
      [a, birthDateYearsAgo(18)],
    );
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    await expect(predict(matchId, b)).rejects.toMatchObject(refused('game_over'));
    // A closed match stays closed: its results can never become ready.
    await expect(toResultsReady(testDb.appPool, matchId)).rejects.toMatchObject({ code: 'SS011' });
  });
});

describe('the content of a game', () => {
  it('cannot be changed by the app: only the two "done" marks are writable', async () => {
    const { matchId } = await playing();
    for (const change of [
      "question_ids = ARRAY['q.cats_over_dogs']",
      "closing_question_id = 'q.cats_over_dogs'",
      "answers_a = ARRAY['agree']::answer_value[]",
      "answers_b = ARRAY['agree']::answer_value[]",
      'created_at = now()',
      'match_id = match_id',
    ]) {
      await expect(
        testDb.appPool.query(`UPDATE games SET ${change} WHERE match_id = $1`, [matchId]),
      ).rejects.toMatchObject(DENIED);
    }
    await expect(
      testDb.appPool.query('DELETE FROM games WHERE match_id = $1', [matchId]),
    ).rejects.toMatchObject(DENIED);
    await expect(
      testDb.appPool.query('ALTER TABLE games DISABLE TRIGGER games_10_guard_update'),
    ).rejects.toMatchObject(DENIED);
  });

  it('cannot be changed by the owner either: the trigger keeps questions and answers as they were', async () => {
    const { matchId } = await playing();
    const before = await gameRow(testDb.ownerPool, matchId);
    for (const change of [
      "question_ids = ARRAY['q.calls_without_warning', 'q.slow_replies_ok', 'q.remakes_worse', 'q.long_voice_messages', 'q.pineapple_pizza']",
      "answers_a = ARRAY['disagree', 'agree', 'agree', 'agree', 'agree']::answer_value[]",
      "answers_b = ARRAY['agree', 'agree', 'agree', 'disagree', 'disagree']::answer_value[]",
    ]) {
      await expect(
        testDb.ownerPool.query(`UPDATE games SET ${change} WHERE match_id = $1`, [matchId]),
      ).rejects.toMatchObject({ code: 'SS021' });
    }
    expect(await gameRow(testDb.ownerPool, matchId)).toEqual(before);
  });

  it('must end on a split, hold no skips, and keep the answers aligned with the questions', async () => {
    const pair = async () => {
      const [first, second] = [await born(25), await born(25)];
      return (await insertMatch(testDb.appPool, { a: first.id, b: second.id })).id;
    };
    const cases: Array<[Parameters<typeof insertGame>[2], string]> = [
      [{ answersB: 'AAAAA' }, 'games_closing_split'],
      [{ closingQuestionId: GAME_QUESTIONS[0] }, 'games_closing_split'],
      [{ answersA: 'ASAAA' }, 'games_answers_complete'],
      [{ answersB: 'AAAD' }, 'games_answers_aligned'],
      [
        { questionIds: [], answersA: '', answersB: '', closingQuestionId: 'q.pineapple_pizza' },
        'games_answers_aligned',
      ],
    ];
    for (const [over, constraint] of cases) {
      await expect(insertGame(testDb.appPool, await pair(), over)).rejects.toMatchObject({
        code: '23514',
        constraint,
      });
    }
  });
});

describe('finishing a game', () => {
  it('needs a prediction for every question', async () => {
    const { matchId, a, b } = await playing();
    await expect(markDone(testDb.appPool, matchId, 'a')).rejects.toMatchObject({
      code: 'SS021',
      message: 'games: predictions are incomplete',
    });
    await insertPredictions(testDb.appPool, {
      matchId,
      predictorId: a,
      pattern: 'AAAA',
      questionIds: GAME_QUESTIONS.slice(0, 4),
    });
    await expect(markDone(testDb.appPool, matchId, 'a')).rejects.toMatchObject({ code: 'SS021' });
    // The other player's predictions don't count for this one.
    await predict(matchId, b);
    await expect(markDone(testDb.appPool, matchId, 'a')).rejects.toMatchObject({ code: 'SS021' });
    await one(matchId, a, GAME_QUESTIONS[4]);
    await markDone(testDb.appPool, matchId, 'a');
    expect(await gameRow(testDb.ownerPool, matchId)).toMatchObject({ a_done: true, b_done: false });
  });

  it('cannot be undone or re-dated', async () => {
    const { matchId, a } = await playing();
    await predict(matchId, a);
    await markDone(testDb.appPool, matchId, 'a');
    for (const value of ['NULL', "now() + interval '1 hour'"]) {
      await expect(
        testDb.appPool.query(`UPDATE games SET a_done_at = ${value} WHERE match_id = $1`, [
          matchId,
        ]),
      ).rejects.toMatchObject({
        code: 'SS021',
        message: 'games: a player who has finished stays finished',
      });
    }
  });
});

describe('results become ready', () => {
  /** Both players have predicted and are marked finished. */
  async function finished(years = 25, band: 'adult' | 'u18' = 'adult') {
    const game = await playing(years, band);
    await predict(game.matchId, game.a);
    await predict(game.matchId, game.b);
    await markDone(testDb.appPool, game.matchId, 'a');
    await markDone(testDb.appPool, game.matchId, 'b');
    return game;
  }

  it('only when both players have finished', async () => {
    const { matchId, a, b } = await playing();
    await expect(toResultsReady(testDb.appPool, matchId)).rejects.toMatchObject(
      statusRefused('game_not_finished'),
    );
    await predict(matchId, a);
    await markDone(testDb.appPool, matchId, 'a');
    await expect(toResultsReady(testDb.appPool, matchId)).rejects.toMatchObject(
      statusRefused('game_not_finished'),
    );
    await predict(matchId, b);
    await markDone(testDb.appPool, matchId, 'b');
    await toResultsReady(testDb.appPool, matchId);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
  });

  it('never for a match without a game', async () => {
    const [first, second] = [await born(25), await born(25)];
    const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    await expect(toResultsReady(testDb.appPool, match.id)).rejects.toMatchObject(
      statusRefused('game_not_finished'),
    );
  });

  it('only with the moment and the chat deadline recorded', async () => {
    const { matchId } = await finished();
    await expect(
      testDb.appPool.query("UPDATE matches SET status = 'results_ready' WHERE id = $1", [matchId]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'matches_results_ready_fields' });
  });

  it('never when a live band differs from the match band, even with a stale cached band', async () => {
    const { matchId, a } = await finished(17, 'u18');
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(18), a]),
    );
    await expect(toResultsReady(testDb.appPool, matchId)).rejects.toMatchObject(
      statusRefused('band'),
    );
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('pending_game');
  });

  it.each(['frozen', 'deleted'])('never while a user is %s', async (status) => {
    const { matchId, b } = await finished();
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET status = $1 WHERE id = $2', [status, b]),
    );
    await expect(toResultsReady(testDb.appPool, matchId)).rejects.toMatchObject(
      statusRefused('not_active'),
    );
  });

  it('once: the game cannot start over, and results cannot be "ready" again from another state', async () => {
    const { matchId } = await finished();
    await toResultsReady(testDb.appPool, matchId);
    await expect(
      testDb.appPool.query("UPDATE matches SET status = 'pending_game' WHERE id = $1", [matchId]),
    ).rejects.toMatchObject(statusRefused('game_cannot_restart'));
    await testDb.appPool.query("UPDATE matches SET status = 'active' WHERE id = $1", [matchId]);
    await expect(toResultsReady(testDb.appPool, matchId)).rejects.toMatchObject(
      statusRefused('not_pending_game'),
    );
  });
});
