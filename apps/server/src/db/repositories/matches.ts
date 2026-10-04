/**
 * A user's own view of their matches (PLAN.md §3 layer 4). Every read is scoped to a participant
 * and re-derives both users' bands from `birth_date`: a match is unreadable once it was closed for
 * a band change, or as soon as either user's live band differs from the match band, even before
 * the age-transition job has closed it. Nothing here returns the other user's ID.
 */
import { OPEN_MATCH_STATUSES, type Locale, type MatchStatus } from '@samesync/shared';
import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';

export interface MatchView {
  id: string;
  status: MatchStatus;
  locale: Locale;
  tier: number;
  /** Content IDs only (see domain/matching/teaser.ts). */
  teaser: unknown;
  /** The anonymous name of the other participant, as a content alias ID. */
  counterpartAlias: string;
  createdAt: Date;
  gameDeadlineAt: Date;
  resultsReadyAt: Date | null;
  chatDeadlineAt: Date | null;
  /**
   * How far the game is, from the caller's side. Never an answer or a guess of anyone.
   * Null for a match that has no game (made before games existed).
   */
  game: { questions: number; youDone: boolean; theyDone: boolean } | null;
}

export interface MatchesRepository {
  /** The caller's open matches, newest first. */
  listOpenForParticipant(userId: string): Promise<MatchView[]>;
  /** One match of the caller, open or ended; null if it isn't theirs or isn't readable. */
  getForParticipant(userId: string, matchId: string): Promise<MatchView | null>;
}

/**
 * The tables every participant-scoped read starts from: the match as `m`, and both of its users as
 * `ua` and `ub`, whose birth dates decide whether the match is still readable.
 */
export const READABLE_MATCH = sql`matches m
  JOIN users ua ON ua.id = m.user_a_id
  JOIN users ub ON ub.id = m.user_b_id`;

/**
 * The condition of every participant-scoped read (CLAUDE.md invariants 1 and 4): `userId` is in
 * the match, the match was not closed for a band change, and both users' live bands, derived from
 * their birth dates right now, equal the match band. Anything unknown is "no" (fail closed).
 */
export const readableBy = (userId: string): SQL => sql`(
    (m.user_a_id = ${userId}::uuid OR m.user_b_id = ${userId}::uuid)
    AND m.close_reason IS DISTINCT FROM 'band_change'
    AND coalesce(vc_band(ua.birth_date, vc_today()) = m.band, false)
    AND coalesce(vc_band(ub.birth_date, vc_today()) = m.band, false)
  )`;

interface Row extends Record<string, unknown> {
  id: string;
  status: MatchStatus;
  locale: Locale;
  tier: number;
  teaser: unknown;
  counterpart_alias: string;
  /** Epoch milliseconds: Drizzle hands raw timestamps back as text, so they are read as numbers. */
  created_at_ms: number;
  game_deadline_at_ms: number;
  results_ready_at_ms: number | null;
  chat_deadline_at_ms: number | null;
  game_questions: number | null;
  you_done: boolean | null;
  they_done: boolean | null;
}

const OPEN = sql.join(
  OPEN_MATCH_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

const dateOrNull = (ms: number | null) => (ms === null ? null : new Date(ms));

export function createMatchesRepository(db: Db): MatchesRepository {
  const select = async (userId: string, extra: SQL): Promise<MatchView[]> => {
    const result = await db.execute<Row>(sql`
      SELECT m.id, m.status, m.locale, m.tier, m.teaser,
        CASE WHEN m.user_a_id = ${userId}::uuid THEN m.alias_b ELSE m.alias_a END AS counterpart_alias,
        (extract(epoch FROM m.created_at) * 1000)::float8 AS created_at_ms,
        (extract(epoch FROM m.game_deadline_at) * 1000)::float8 AS game_deadline_at_ms,
        (extract(epoch FROM m.results_ready_at) * 1000)::float8 AS results_ready_at_ms,
        (extract(epoch FROM m.chat_deadline_at) * 1000)::float8 AS chat_deadline_at_ms,
        cardinality(g.question_ids) AS game_questions,
        CASE WHEN m.user_a_id = ${userId}::uuid THEN g.a_done_at ELSE g.b_done_at END IS NOT NULL
          AS you_done,
        CASE WHEN m.user_a_id = ${userId}::uuid THEN g.b_done_at ELSE g.a_done_at END IS NOT NULL
          AS they_done
      FROM ${READABLE_MATCH}
      LEFT JOIN games g ON g.match_id = m.id
      WHERE ${readableBy(userId)} AND ${extra}
      ORDER BY m.created_at DESC, m.id DESC`);
    return result.rows.map((r) => ({
      id: r.id,
      status: r.status,
      locale: r.locale,
      tier: r.tier,
      teaser: r.teaser,
      counterpartAlias: r.counterpart_alias,
      createdAt: new Date(r.created_at_ms),
      gameDeadlineAt: new Date(r.game_deadline_at_ms),
      resultsReadyAt: dateOrNull(r.results_ready_at_ms),
      chatDeadlineAt: dateOrNull(r.chat_deadline_at_ms),
      game:
        r.game_questions === null
          ? null
          : {
              questions: r.game_questions,
              youDone: r.you_done === true,
              theyDone: r.they_done === true,
            },
    }));
  };

  return {
    listOpenForParticipant: (userId) => select(userId, sql`m.status IN (${OPEN})`),
    async getForParticipant(userId, matchId) {
      const [match] = await select(userId, sql`m.id = ${matchId}::uuid`);
      return match ?? null;
    },
  };
}
