/**
 * The game of a match (PLAN.md Phase 3), read and written only through its participants.
 *
 * Safety: every read uses the same participant scope as the matches repository (the caller is in
 * the match, the match was not closed for a band change, and both live bands equal its band). The
 * other person's answers and guesses leave the database only through `getResultsForParticipant`,
 * and only once both players have finished: before that the query itself returns none of them.
 * Writes pass the database triggers of migration 0007, which check the same rules again.
 */
import type { Locale, MatchStatus } from '@samesync/shared';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Stance } from '../../domain/matching/types';
import type { NotificationKind } from '../../domain/notifications';
import type { Db } from '../client';
import { pgErrorOf } from '../errors';
import { gamePredictions, games, matches, outbox } from '../schema/index';
import { READABLE_MATCH, readableBy } from './matches';

/** What a player may know about their game before the results: the questions, never an answer. */
export interface GameForPlayer {
  matchId: string;
  status: MatchStatus;
  gameDeadlineAt: Date;
  questionIds: string[];
  youDone: boolean;
  theyDone: boolean;
}

/** A finished game from one participant's side: both answers and both guesses of every question. */
export interface FinishedGameView {
  matchId: string;
  status: MatchStatus;
  /** The language of the match's pool: the opener is written in it. */
  locale: Locale;
  questionIds: string[];
  closingQuestionId: string;
  yourAnswers: Stance[];
  theirAnswers: Stance[];
  yourGuesses: Map<string, Stance>;
  theirGuesses: Map<string, Stance>;
}

export type ResultsView =
  { ready: false; status: MatchStatus } | ({ ready: true } & FinishedGameView);

export type SubmitOutcome =
  /** Not the caller's match, not readable, or a match without a game. */
  | { status: 'not_found' }
  /** The game is over: results are ready, the deadline has passed, or the match is closed. */
  | { status: 'not_playable' }
  | { status: 'already_submitted' }
  /** The guesses are not exactly one per question of the game. */
  | { status: 'invalid' }
  | { status: 'submitted'; resultsReady: boolean };

export interface GamesRepository {
  getForPlayer(userId: string, matchId: string): Promise<GameForPlayer | null>;
  /** Null if the match isn't the caller's, isn't readable or has no game. */
  getResultsForParticipant(userId: string, matchId: string): Promise<ResultsView | null>;
  /**
   * One transaction: stores the caller's guesses (write-once), marks the caller finished and
   * queues the notification of that step. When the other player has finished too, the match
   * becomes `results_ready` with its chat deadline.
   */
  submitPredictions(input: {
    userId: string;
    matchId: string;
    predictions: ReadonlyArray<{ questionId: string; value: Stance }>;
    now: Date;
    chatDeadline: Date;
  }): Promise<SubmitOutcome>;
  /**
   * Expires games whose deadline has passed (Q2): the match becomes `expired`, its other pending
   * notifications are cancelled, and both users get one neutral notice. Returns how many expired.
   */
  expireOverdue(now: Date, limit: number): Promise<number>;
  /**
   * Queues the one reminder (Q2) for every player who hasn't finished a game whose deadline is at
   * most `leadMs` away. Returns how many reminders were queued.
   */
  remindUnplayed(now: Date, leadMs: number, limit: number): Promise<number>;
}

/** Dedupe key of a game notification: one per kind, match and user, whatever is retried. */
export const gameNotificationKey = (kind: NotificationKind, matchId: string, userId: string) =>
  `${kind}:${matchId}:${userId}`;

/** Refusals of the game triggers (SS02x), the status trigger (SS012) and a duplicate guess. */
const GAME_REFUSALS = new Set(['SS020', 'SS021', 'SS012', 'SS011']);

interface PlayerRow extends Record<string, unknown> {
  id: string;
  status: MatchStatus;
  game_deadline_at_ms: number;
  question_ids: string[];
  you_done: boolean;
  they_done: boolean;
}

interface ResultsRow extends Record<string, unknown> {
  id: string;
  status: MatchStatus;
  locale: Locale;
  both_done: boolean;
  question_ids: string[] | null;
  closing_question_id: string | null;
  your_answers: Stance[] | null;
  their_answers: Stance[] | null;
  your_guesses: Record<string, Stance> | null;
  their_guesses: Record<string, Stance> | null;
}

interface LockedRow extends Record<string, unknown> {
  is_a: boolean;
  user_a_id: string;
  user_b_id: string;
  status: MatchStatus;
  game_deadline_at_ms: number;
  question_ids: string[];
  a_done: boolean;
  b_done: boolean;
}

/** Rolls a submission back with an outcome instead of an error. */
class Refused extends Error {
  constructor(readonly outcome: SubmitOutcome) {
    super(outcome.status);
  }
}

export function createGamesRepository(db: Db): GamesRepository {
  return {
    async getForPlayer(userId, matchId) {
      const result = await db.execute<PlayerRow>(sql`
        SELECT m.id, m.status,
          (extract(epoch FROM m.game_deadline_at) * 1000)::float8 AS game_deadline_at_ms,
          g.question_ids,
          CASE WHEN m.user_a_id = ${userId}::uuid THEN g.a_done_at ELSE g.b_done_at END IS NOT NULL
            AS you_done,
          CASE WHEN m.user_a_id = ${userId}::uuid THEN g.b_done_at ELSE g.a_done_at END IS NOT NULL
            AS they_done
        FROM ${READABLE_MATCH}
        JOIN games g ON g.match_id = m.id
        WHERE ${readableBy(userId)} AND m.id = ${matchId}::uuid`);
      const row = result.rows[0];
      if (!row) return null;
      return {
        matchId: row.id,
        status: row.status,
        gameDeadlineAt: new Date(row.game_deadline_at_ms),
        questionIds: row.question_ids,
        youDone: row.you_done,
        theyDone: row.they_done,
      };
    },

    async getResultsForParticipant(userId, matchId) {
      // Answers and guesses are selected only when both players have finished: until then the
      // query returns NULL for all of them, so no caller can leak what it never received.
      const mine = sql`(m.user_a_id = ${userId}::uuid)`;
      const done = sql`(g.a_done_at IS NOT NULL AND g.b_done_at IS NOT NULL)`;
      const guessesOf = (predictor: SQL) => sql`(
        SELECT coalesce(jsonb_object_agg(p.question_id, p.predicted), '{}'::jsonb)
        FROM game_predictions p WHERE p.match_id = m.id AND p.predictor_id = ${predictor})`;
      const result = await db.execute<ResultsRow>(sql`
        SELECT m.id, m.status, m.locale, ${done} AS both_done,
          CASE WHEN ${done} THEN g.question_ids END AS question_ids,
          CASE WHEN ${done} THEN g.closing_question_id END AS closing_question_id,
          CASE WHEN ${done} THEN (CASE WHEN ${mine} THEN g.answers_a ELSE g.answers_b END)::text[] END
            AS your_answers,
          CASE WHEN ${done} THEN (CASE WHEN ${mine} THEN g.answers_b ELSE g.answers_a END)::text[] END
            AS their_answers,
          CASE WHEN ${done} THEN ${guessesOf(sql`CASE WHEN ${mine} THEN m.user_a_id ELSE m.user_b_id END`)} END
            AS your_guesses,
          CASE WHEN ${done} THEN ${guessesOf(sql`CASE WHEN ${mine} THEN m.user_b_id ELSE m.user_a_id END`)} END
            AS their_guesses
        FROM ${READABLE_MATCH}
        JOIN games g ON g.match_id = m.id
        WHERE ${readableBy(userId)} AND m.id = ${matchId}::uuid`);
      const row = result.rows[0];
      if (!row) return null;
      if (
        !row.both_done ||
        !row.question_ids ||
        !row.closing_question_id ||
        !row.your_answers ||
        !row.their_answers
      ) {
        return { ready: false, status: row.status };
      }
      return {
        ready: true,
        matchId: row.id,
        status: row.status,
        locale: row.locale,
        questionIds: row.question_ids,
        closingQuestionId: row.closing_question_id,
        yourAnswers: row.your_answers,
        theirAnswers: row.their_answers,
        yourGuesses: new Map(Object.entries(row.your_guesses ?? {})),
        theirGuesses: new Map(Object.entries(row.their_guesses ?? {})),
      };
    },

    async submitPredictions({ userId, matchId, predictions, now, chatDeadline }) {
      try {
        return await db.transaction(async (tx) => {
          // Lock the game first: two submissions for one match run one after the other.
          const locked = await tx.execute<LockedRow>(sql`
            SELECT (m.user_a_id = ${userId}::uuid) AS is_a, m.user_a_id, m.user_b_id, m.status,
              (extract(epoch FROM m.game_deadline_at) * 1000)::float8 AS game_deadline_at_ms,
              g.question_ids, g.a_done_at IS NOT NULL AS a_done, g.b_done_at IS NOT NULL AS b_done
            FROM ${READABLE_MATCH}
            JOIN games g ON g.match_id = m.id
            WHERE ${readableBy(userId)} AND m.id = ${matchId}::uuid
            FOR UPDATE OF g`);
          const game = locked.rows[0];
          if (!game) return { status: 'not_found' } as const;
          if (game.status !== 'pending_game' || game.game_deadline_at_ms <= now.getTime()) {
            return { status: 'not_playable' } as const;
          }
          if (game.is_a ? game.a_done : game.b_done)
            return { status: 'already_submitted' } as const;
          const wanted = new Set(game.question_ids);
          const given = new Set(predictions.map((p) => p.questionId));
          if (
            predictions.length !== wanted.size ||
            given.size !== wanted.size ||
            [...given].some((id) => !wanted.has(id))
          ) {
            return { status: 'invalid' } as const;
          }

          // The insert trigger re-checks the participant, the match state and both live bands.
          await tx.insert(gamePredictions).values(
            predictions.map((p) => ({
              matchId,
              predictorId: userId,
              questionId: p.questionId,
              predicted: p.value,
              createdAt: now,
            })),
          );
          await tx
            .update(games)
            .set(game.is_a ? { aDoneAt: now } : { bDoneAt: now })
            .where(eq(games.matchId, matchId));

          const other = game.is_a ? game.user_b_id : game.user_a_id;
          const resultsReady = game.is_a ? game.b_done : game.a_done;
          const notify = (kind: NotificationKind, recipients: readonly string[]) =>
            tx
              .insert(outbox)
              .values(
                recipients.map((recipient) => ({
                  id: uuidv7(),
                  userId: recipient,
                  kind,
                  matchId,
                  dedupeKey: gameNotificationKey(kind, matchId, recipient),
                  nextAttemptAt: now,
                  createdAt: now,
                })),
              )
              .onConflictDoNothing({ target: outbox.dedupeKey });
          if (resultsReady) {
            // The status trigger checks again that both finished and both live bands match.
            const moved = await tx
              .update(matches)
              .set({ status: 'results_ready', resultsReadyAt: now, chatDeadlineAt: chatDeadline })
              .where(and(eq(matches.id, matchId), eq(matches.status, 'pending_game')))
              .returning({ id: matches.id });
            if (moved.length === 0) throw new Refused({ status: 'not_playable' });
            await notify('game_results', [userId, other]);
          } else {
            await notify('game_turn', [other]);
          }
          return { status: 'submitted', resultsReady } as const;
        });
      } catch (error) {
        if (error instanceof Refused) return error.outcome;
        const pgError = pgErrorOf(error);
        // A concurrent duplicate of the same submission lost the race for the primary key.
        if (pgError?.code === '23505') return { status: 'already_submitted' };
        // A trigger refused: the match closed, expired or stopped being readable in between.
        if (pgError && GAME_REFUSALS.has(pgError.code)) return { status: 'not_playable' };
        throw error;
      }
    },

    async expireOverdue(now, limit) {
      return db.transaction(async (tx) => {
        const overdue = await tx.execute<{ id: string; user_a_id: string; user_b_id: string }>(sql`
          SELECT id, user_a_id, user_b_id FROM matches
          WHERE status = 'pending_game' AND game_deadline_at <= ${now.toISOString()}::timestamptz
          ORDER BY game_deadline_at, id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED`);
        if (overdue.rows.length === 0) return 0;
        const ids = sql`${`{${overdue.rows.map((m) => m.id).join(',')}}`}::uuid[]`;
        await tx.execute(sql`
          UPDATE matches SET status = 'expired', close_reason = 'expired',
            closed_at = ${now.toISOString()}::timestamptz
          WHERE id = ANY(${ids}) AND status = 'pending_game'`);
        // "Your turn" and the reminder make no sense any more; the new match notice may still be
        // on its way, and is dropped too: the match it announces is over.
        await tx.execute(sql`
          UPDATE outbox SET status = 'cancelled', cancel_reason = 'expired'
          WHERE status = 'pending' AND match_id = ANY(${ids})`);
        await tx
          .insert(outbox)
          .values(
            overdue.rows.flatMap((match) =>
              [match.user_a_id, match.user_b_id].map((userId) => ({
                id: uuidv7(),
                userId,
                kind: 'game_expired' as const,
                matchId: match.id,
                dedupeKey: gameNotificationKey('game_expired', match.id, userId),
                nextAttemptAt: now,
                createdAt: now,
              })),
            ),
          )
          .onConflictDoNothing({ target: outbox.dedupeKey });
        return overdue.rows.length;
      });
    },

    async remindUnplayed(now, leadMs, limit) {
      const from = now.toISOString();
      const until = new Date(now.getTime() + leadMs).toISOString();
      // Players who haven't finished and were never reminded about this game.
      const due = await db.execute<{ match_id: string; user_id: string }>(sql`
        SELECT m.id AS match_id, p.user_id
        FROM matches m
        JOIN games g ON g.match_id = m.id
        CROSS JOIN LATERAL (
          VALUES (m.user_a_id, g.a_done_at), (m.user_b_id, g.b_done_at)
        ) AS p(user_id, done_at)
        WHERE m.status = 'pending_game'
          AND m.game_deadline_at > ${from}::timestamptz
          AND m.game_deadline_at <= ${until}::timestamptz
          AND p.done_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM outbox o
            WHERE o.dedupe_key = 'game_reminder:' || m.id::text || ':' || p.user_id::text
          )
        ORDER BY m.game_deadline_at, m.id, p.user_id
        LIMIT ${limit}`);
      if (due.rows.length === 0) return 0;
      const queued = await db
        .insert(outbox)
        .values(
          due.rows.map((row) => ({
            id: uuidv7(),
            userId: row.user_id,
            kind: 'game_reminder' as const,
            matchId: row.match_id,
            dedupeKey: gameNotificationKey('game_reminder', row.match_id, row.user_id),
            nextAttemptAt: now,
            createdAt: now,
          })),
        )
        .onConflictDoNothing({ target: outbox.dedupeKey })
        .returning({ id: outbox.id });
      return queued.length;
    },
  };
}
