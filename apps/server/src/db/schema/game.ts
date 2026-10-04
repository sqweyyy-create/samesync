/**
 * The game of a match (PLAN.md §4). `games` holds the questions and a snapshot of each user's own
 * answers to them, taken when the match was made: editing a profile later doesn't change a game
 * (Q5). `game_predictions` holds what each user guessed about the other.
 * Migration 0007 adds the triggers: who may predict (both users' bands are re-derived from
 * `birth_date`), that a game's questions and answers never change, and that a user is done only
 * with a guess for every question.
 */
import { sql } from 'drizzle-orm';
import { check, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { questions } from './content';
import { answerValueEnum } from './enums';
import { matches } from './matching';
import { users } from './users';

export const games = pgTable(
  'games',
  {
    matchId: uuid('match_id')
      .primaryKey()
      .references(() => matches.id),
    /** Ordered. The last one is the closing question: a take the two split on. */
    questionIds: text('question_ids').array().notNull(),
    closingQuestionId: text('closing_question_id')
      .notNull()
      .references(() => questions.id),
    /** User A's (B's) own answers to `question_ids`, in the same order. Never a skip. */
    answersA: answerValueEnum('answers_a').array().notNull(),
    answersB: answerValueEnum('answers_b').array().notNull(),
    /** When user A (B) submitted their guesses. Results exist once both are set. */
    aDoneAt: timestamp('a_done_at', { withTimezone: true }),
    bDoneAt: timestamp('b_done_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      'games_answers_aligned',
      sql`cardinality(${t.questionIds}) BETWEEN 1 AND 50 AND cardinality(${t.answersA}) = cardinality(${t.questionIds}) AND cardinality(${t.answersB}) = cardinality(${t.questionIds})`,
    ),
    check(
      'games_answers_complete',
      sql`array_position(${t.questionIds}, NULL) IS NULL AND array_position(${t.answersA}, NULL) IS NULL AND array_position(${t.answersB}, NULL) IS NULL AND array_position(${t.answersA}, 'skip') IS NULL AND array_position(${t.answersB}, 'skip') IS NULL`,
    ),
    // The game ends on a disagreement.
    check(
      'games_closing_split',
      sql`${t.closingQuestionId} = ${t.questionIds}[cardinality(${t.questionIds})] AND ${t.answersA}[cardinality(${t.answersA})] <> ${t.answersB}[cardinality(${t.answersB})]`,
    ),
  ],
);

/** One guess: what `predictor_id` thinks the other user answered. Write-once (no UPDATE grant). */
export const gamePredictions = pgTable(
  'game_predictions',
  {
    matchId: uuid('match_id')
      .notNull()
      .references(() => games.matchId),
    predictorId: uuid('predictor_id')
      .notNull()
      .references(() => users.id),
    questionId: text('question_id')
      .notNull()
      .references(() => questions.id),
    predicted: answerValueEnum('predicted').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.matchId, t.predictorId, t.questionId] }),
    check('game_predictions_no_skip', sql`${t.predicted} <> 'skip'`),
  ],
);
