/** Games and predictions written with plain SQL, like an attacker or a buggy code path would. */
import type pg from 'pg';

/** Five takes of the seeded content that every band, mode and locale has. */
export const GAME_QUESTIONS = [
  'q.pineapple_pizza',
  'q.long_voice_messages',
  'q.remakes_worse',
  'q.slow_replies_ok',
  'q.calls_without_warning',
] as const;

export type Side = 'agree' | 'disagree';

export interface InsertGame {
  questionIds?: readonly string[];
  closingQuestionId?: string;
  /** One character per question: `A` agree, `D` disagree, `S` skip. */
  answersA?: string;
  answersB?: string;
}

const VALUES = { A: 'agree', D: 'disagree', S: 'skip' } as const;
export const sides = (pattern: string) =>
  [...pattern].map((char) => VALUES[char as keyof typeof VALUES]);

/**
 * The game of a match: five questions, the two users agree on the first four and split on the
 * last one (user A agrees, user B disagrees) unless a test says otherwise.
 */
export async function insertGame(
  pool: pg.Pool,
  matchId: string,
  over: InsertGame = {},
): Promise<{ questionIds: string[] }> {
  const questionIds = [...(over.questionIds ?? GAME_QUESTIONS)];
  await pool.query(
    `INSERT INTO games (match_id, question_ids, closing_question_id, answers_a, answers_b)
     VALUES ($1, $2, $3, $4::answer_value[], $5::answer_value[])`,
    [
      matchId,
      questionIds,
      over.closingQuestionId ?? questionIds.at(-1),
      sides(over.answersA ?? 'AAAAA'),
      sides(over.answersB ?? 'AAAAD'),
    ],
  );
  return { questionIds };
}

/** One guess per question, in the order of `questionIds`: `A` agree, `D` disagree. */
export async function insertPredictions(
  pool: pg.Pool,
  input: {
    matchId: string;
    predictorId: string;
    pattern?: string;
    questionIds?: readonly string[];
  },
): Promise<void> {
  const questionIds = input.questionIds ?? GAME_QUESTIONS;
  await pool.query(
    `INSERT INTO game_predictions (match_id, predictor_id, question_id, predicted)
     SELECT $1, $2, q, v::answer_value FROM unnest($3::text[], $4::text[]) AS t(q, v)`,
    [input.matchId, input.predictorId, questionIds, sides(input.pattern ?? 'AAAAA')],
  );
}

/** Marks a player finished, as the app does right after writing their predictions. */
export const markDone = (pool: pg.Pool, matchId: string, side: 'a' | 'b') =>
  pool.query(`UPDATE games SET ${side}_done_at = now() WHERE match_id = $1`, [matchId]);

export const toResultsReady = (pool: pg.Pool, matchId: string) =>
  pool.query(
    `UPDATE matches SET status = 'results_ready', results_ready_at = now(),
       chat_deadline_at = now() + interval '48 hours' WHERE id = $1`,
    [matchId],
  );

export async function gameRow(pool: pg.Pool, matchId: string) {
  const { rows } = await pool.query<{
    question_ids: string[];
    closing_question_id: string;
    answers_a: Side[];
    answers_b: Side[];
    a_done: boolean;
    b_done: boolean;
  }>(
    `SELECT question_ids, closing_question_id, answers_a::text[] AS answers_a,
       answers_b::text[] AS answers_b, a_done_at IS NOT NULL AS a_done, b_done_at IS NOT NULL AS b_done
     FROM games WHERE match_id = $1`,
    [matchId],
  );
  return rows[0];
}
