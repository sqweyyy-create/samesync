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
}

export interface MatchesRepository {
  /** The caller's open matches, newest first. */
  listOpenForParticipant(userId: string): Promise<MatchView[]>;
  /** One match of the caller, open or ended; null if it isn't theirs or isn't readable. */
  getForParticipant(userId: string, matchId: string): Promise<MatchView | null>;
}

interface Row extends Record<string, unknown> {
  id: string;
  status: MatchStatus;
  locale: Locale;
  tier: number;
  teaser: unknown;
  counterpart_alias: string;
  created_at: Date;
  game_deadline_at: Date;
}

const OPEN = sql.join(
  OPEN_MATCH_STATUSES.map((s) => sql`${s}`),
  sql`, `,
);

export function createMatchesRepository(db: Db): MatchesRepository {
  const select = async (userId: string, extra: SQL): Promise<MatchView[]> => {
    const result = await db.execute<Row>(sql`
      SELECT m.id, m.status, m.locale, m.tier, m.teaser,
        CASE WHEN m.user_a_id = ${userId}::uuid THEN m.alias_b ELSE m.alias_a END AS counterpart_alias,
        m.created_at, m.game_deadline_at
      FROM matches m
      JOIN users ua ON ua.id = m.user_a_id
      JOIN users ub ON ub.id = m.user_b_id
      WHERE (m.user_a_id = ${userId}::uuid OR m.user_b_id = ${userId}::uuid)
        AND m.close_reason IS DISTINCT FROM 'band_change'
        AND coalesce(vc_band(ua.birth_date, vc_today()) = m.band, false)
        AND coalesce(vc_band(ub.birth_date, vc_today()) = m.band, false)
        AND ${extra}
      ORDER BY m.created_at DESC, m.id DESC`);
    return result.rows.map((r) => ({
      id: r.id,
      status: r.status,
      locale: r.locale,
      tier: r.tier,
      teaser: r.teaser,
      counterpartAlias: r.counterpart_alias,
      createdAt: r.created_at,
      gameDeadlineAt: r.game_deadline_at,
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
