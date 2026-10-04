/**
 * A matching run gives every match its game in the same transaction (PLAN.md Phase 3): the
 * configured number of takes both users answered, ending on one they split on, with each user's
 * own answers kept as they were at that moment.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateProfiles, insertSyntheticUsers } from '../../scripts/lib/synthetic';
import { planPool } from '../../src/domain/matching/plan';
import type { PoolScope } from '../../src/domain/matching/types';
import type { MatchPlanner } from '../../src/jobs/matching-planner';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { answersFor, buildMatching, insertPerson, itemsOf, realScope } from '../support/population';

let testDb: TestDatabase;
let scope: PoolScope;
let niche: string[];
beforeEach(async () => {
  testDb = await createTestDatabase();
  scope = await realScope();
  niche = itemsOf(scope, 'niche');
});
afterEach(() => testDb.drop());

const ADULT_RU = { band: 'adult', locale: 'ru' } as const;
const SLOT = new Date('2026-10-04T10:00:00Z');

interface GameRow {
  match_id: string;
  user_a_id: string;
  user_b_id: string;
  question_ids: string[];
  closing_question_id: string;
  answers_a: string[];
  answers_b: string[];
  a_done_at: Date | null;
  b_done_at: Date | null;
}
const games = async () =>
  (
    await testDb.ownerPool.query<GameRow>(
      `SELECT g.match_id, m.user_a_id, m.user_b_id, g.question_ids, g.closing_question_id,
         g.answers_a::text[] AS answers_a, g.answers_b::text[] AS answers_b, g.a_done_at, g.b_done_at
       FROM games g JOIN matches m ON m.id = g.match_id ORDER BY g.match_id`,
    )
  ).rows;
const answersOf = async (userId: string) =>
  new Map(
    (
      await testDb.ownerPool.query<{ question_id: string; value: string }>(
        'SELECT question_id, value::text AS value FROM answers WHERE user_id = $1',
        [userId],
      )
    ).rows.map((r) => [r.question_id, r.value]),
  );

describe('the game of a new match', () => {
  it('has five takes both answered, ends on the one they split on, and keeps both answers', async () => {
    // Eight takes in common; they split on the 3rd only, and one of them skipped the 9th.
    const a = await insertPerson(testDb.appPool, {
      items: [niche[0]!],
      answers: answersFor(scope, 'AADADDAAS'),
    });
    const b = await insertPerson(testDb.appPool, {
      items: [niche[0]!],
      answers: answersFor(scope, 'AAAADDAAA'),
    });
    const { service } = await buildMatching(testDb);
    expect(await service.run({ pool: ADULT_RU, mode: 'friends', slot: SLOT })).toMatchObject({
      status: 'done',
      pairsCreated: 1,
    });

    const [game] = await games();
    const split = scope.takes[2]!.id;
    expect(game?.question_ids).toHaveLength(5);
    expect(new Set(game?.question_ids).size).toBe(5);
    expect(game?.closing_question_id).toBe(split);
    expect(game?.question_ids.at(-1)).toBe(split);
    // The skipped take is not part of the game.
    expect(game?.question_ids).not.toContain(scope.takes[8]!.id);
    expect([game?.a_done_at, game?.b_done_at]).toEqual([null, null]);

    // The snapshot is each user's own answer to each question.
    const [low, high] = a.id < b.id ? [a, b] : [b, a];
    const [lowAnswers, highAnswers] = [await answersOf(low.id), await answersOf(high.id)];
    game?.question_ids.forEach((id, i) => {
      expect(game.answers_a[i]).toBe(lowAnswers.get(id));
      expect(game.answers_b[i]).toBe(highAnswers.get(id));
    });
    expect(game?.answers_a.at(-1)).not.toBe(game?.answers_b.at(-1));
  });

  it('does not change when a user edits their answers afterwards (Q5)', async () => {
    const a = await insertPerson(testDb.appPool, {
      items: [niche[0]!],
      answers: answersFor(scope, 'AAAAAD'),
    });
    await insertPerson(testDb.appPool, {
      items: [niche[0]!],
      answers: answersFor(scope, 'AAAAAA'),
    });
    const { service } = await buildMatching(testDb);
    await service.run({ pool: ADULT_RU, mode: 'friends', slot: SLOT });
    const [before] = await games();

    await testDb.appPool.query(
      "UPDATE answers SET value = CASE WHEN value = 'agree' THEN 'disagree' ELSE 'skip' END::answer_value WHERE user_id = $1",
      [a.id],
    );
    expect(await games()).toEqual([before]);
  });

  it('is picked from the answers at the moment of the insert: a pair that lost its game is skipped and counted', async () => {
    const a = await insertPerson(testDb.appPool, {
      items: [niche[0]!],
      answers: answersFor(scope, 'AAAAAD'),
    });
    await insertPerson(testDb.appPool, {
      items: [niche[0]!],
      answers: answersFor(scope, 'AAAAAA'),
    });
    // Between planning and the insert, the only disagreement disappears.
    const planner: MatchPlanner = {
      async plan(input) {
        const plan = planPool(input);
        await testDb.appPool.query(
          "UPDATE answers SET value = 'agree' WHERE user_id = $1 AND value = 'disagree'",
          [a.id],
        );
        return plan;
      },
    };
    const { service, logLines } = await buildMatching(testDb, { planner });
    expect(await service.run({ pool: ADULT_RU, mode: 'friends', slot: SLOT })).toMatchObject({
      status: 'done',
      pairsCreated: 0,
      pairsRejected: 1,
    });
    // Nothing of the pair is left behind: no match, no game, no notification.
    for (const table of ['matches', 'games', 'outbox']) {
      const { rows } = await testDb.ownerPool.query<{ n: string }>(
        `SELECT count(*) AS n FROM ${table}`,
      );
      expect({ table, n: rows[0]?.n }).toEqual({ table, n: '0' });
    }
    expect(logLines().join('\n')).toContain('"reason":"no_game"');
  });

  it('holds for every match of a whole run: five distinct deck takes, both answered, a split last', async () => {
    const now = new Date();
    const profiles = generateProfiles(scope, {
      pool: ADULT_RU,
      mode: 'friends',
      n: 80,
      seed: 20261004,
      now,
    });
    const ids = await insertSyntheticUsers(testDb.appPool, ADULT_RU, 'friends', profiles, now);
    // Answers outside the friends deck (kept from an earlier dating profile) must not be used.
    const friendsDeck = new Set(scope.takes.map((t) => t.id));
    const datingOnly = (await realScope({ mode: 'dating' })).takes
      .map((t) => t.id)
      .filter((id) => !friendsDeck.has(id));
    expect(datingOnly.length).toBeGreaterThan(0);
    await testDb.appPool.query(
      `INSERT INTO answers (user_id, question_id, value, content_release, answered_at)
       SELECT u, q, CASE WHEN random() < 0.5 THEN 'agree' ELSE 'disagree' END::answer_value,
         (SELECT version FROM content_releases ORDER BY applied_at DESC LIMIT 1), now()
       FROM unnest($1::uuid[]) AS u CROSS JOIN unnest($2::text[]) AS q`,
      [ids, datingOnly],
    );

    const { service } = await buildMatching(testDb, {
      params: { tier2AfterHours: 0, tier3AfterHours: 0 },
    });
    const outcome = await service.run({ pool: ADULT_RU, mode: 'friends', slot: SLOT });
    if (outcome.status !== 'done') throw new Error('the run did not finish');
    expect(outcome.pairsCreated).toBeGreaterThanOrEqual(20);
    expect(outcome.pairsRejected).toBe(0);

    const all = await games();
    expect(all).toHaveLength(outcome.pairsCreated);
    for (const game of all) {
      expect(game.question_ids).toHaveLength(5);
      expect(new Set(game.question_ids).size).toBe(5);
      const [a, b] = [await answersOf(game.user_a_id), await answersOf(game.user_b_id)];
      game.question_ids.forEach((id, i) => {
        expect(friendsDeck.has(id)).toBe(true);
        expect(['agree', 'disagree']).toContain(game.answers_a[i]);
        expect({ id, a: game.answers_a[i], b: game.answers_b[i] }).toEqual({
          id,
          a: a.get(id),
          b: b.get(id),
        });
      });
      expect(game.question_ids.at(-1)).toBe(game.closing_question_id);
      expect(game.answers_a.at(-1)).not.toBe(game.answers_b.at(-1));
    }
  });
});
