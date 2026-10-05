/**
 * Consent to exchange usernames (PLAN.md Phase 4, CLAUDE.md invariant 6).
 *
 * Safety: the read is participant-scoped like every other read of a match (the caller is in it,
 * it was not closed for a band change, both live bands equal its band), and the writes pass the
 * triggers of migration 0010: consent exists only between two adults by birth date, in an open
 * chat, and `revealed_at` is set only when both have consented.
 * No username is read or written here. The usernames themselves come from Telegram at the moment
 * they are sent (services/usernames.ts).
 */
import type { Band, MatchStatus } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { Db } from '../client';
import { pgErrorOf } from '../errors';
import { outbox, revealConsents } from '../schema/index';
import { READABLE_MATCH, readableBy } from './matches';
import { notificationKey } from './outbox';

/** A match from one participant's side, with what a reveal depends on. */
export interface RevealView {
  matchId: string;
  status: MatchStatus;
  band: Band;
  bothActive: boolean;
  /** How the other person appears to the caller, as a content alias ID. */
  counterpartAlias: string;
  youConsented: boolean;
  theyConsented: boolean;
  /** The database has recorded the reveal for both. */
  revealed: boolean;
  /** The two Telegram accounts, only to ask Telegram for their current usernames. */
  you: { telegramId: number; synthetic: boolean };
  they: { id: string; telegramId: number; synthetic: boolean };
}

export interface RevealRepository {
  /** Null if the match isn't the caller's or isn't readable. */
  view(userId: string, matchId: string): Promise<RevealView | null>;
  /** Records the caller's consent. `refused`: the insert trigger said no. */
  consent(userId: string, matchId: string, now: Date): Promise<'stored' | 'exists' | 'refused'>;
  /** Asks `userId` to consent too, once per match. */
  ask(matchId: string, userId: string, now: Date): Promise<void>;
  /**
   * One transaction: marks both consents revealed and queues, for each user, the message that
   * carries the other's username. False if the update trigger refused or there was nothing to do.
   */
  reveal(matchId: string, now: Date): Promise<boolean>;
}

/** Refusals of the reveal triggers. */
const REVEAL_REFUSED = new Set(['SS040', 'SS041']);

interface Row extends Record<string, unknown> {
  id: string;
  status: MatchStatus;
  band: Band;
  counterpart_alias: string;
  your_status: UserStatus;
  their_status: UserStatus;
  you_consented: boolean;
  they_consented: boolean;
  revealed: boolean;
  your_telegram_id: string | number;
  your_synthetic: boolean;
  their_id: string;
  their_telegram_id: string | number;
  their_synthetic: boolean;
}

/** Rolls the reveal back without an error. */
class NothingToReveal extends Error {}

export function createRevealRepository(db: Db): RevealRepository {
  return {
    async view(userId, matchId) {
      const mine = sql`(m.user_a_id = ${userId}::uuid)`;
      const result = await db.execute<Row>(sql`
        SELECT m.id, m.status, m.band,
          CASE WHEN ${mine} THEN m.alias_b ELSE m.alias_a END AS counterpart_alias,
          CASE WHEN ${mine} THEN ua.status ELSE ub.status END AS your_status,
          CASE WHEN ${mine} THEN ub.status ELSE ua.status END AS their_status,
          yc.user_id IS NOT NULL AS you_consented,
          tc.user_id IS NOT NULL AS they_consented,
          (yc.revealed_at IS NOT NULL AND tc.revealed_at IS NOT NULL) AS revealed,
          CASE WHEN ${mine} THEN ua.telegram_id ELSE ub.telegram_id END AS your_telegram_id,
          CASE WHEN ${mine} THEN ua.synthetic ELSE ub.synthetic END AS your_synthetic,
          CASE WHEN ${mine} THEN ub.id ELSE ua.id END AS their_id,
          CASE WHEN ${mine} THEN ub.telegram_id ELSE ua.telegram_id END AS their_telegram_id,
          CASE WHEN ${mine} THEN ub.synthetic ELSE ua.synthetic END AS their_synthetic
        FROM ${READABLE_MATCH}
        LEFT JOIN reveal_consents yc ON yc.match_id = m.id AND yc.user_id = ${userId}::uuid
        LEFT JOIN reveal_consents tc ON tc.match_id = m.id AND tc.user_id <> ${userId}::uuid
        WHERE ${readableBy(userId)} AND m.id = ${matchId}::uuid`);
      const row = result.rows[0];
      if (!row) return null;
      return {
        matchId: row.id,
        status: row.status,
        band: row.band,
        bothActive: row.your_status === 'active' && row.their_status === 'active',
        counterpartAlias: row.counterpart_alias,
        youConsented: row.you_consented,
        theyConsented: row.they_consented,
        revealed: row.revealed,
        you: { telegramId: Number(row.your_telegram_id), synthetic: row.your_synthetic },
        they: {
          id: row.their_id,
          telegramId: Number(row.their_telegram_id),
          synthetic: row.their_synthetic,
        },
      };
    },

    async consent(userId, matchId, now) {
      try {
        const rows = await db
          .insert(revealConsents)
          .values({ matchId, userId, consentedAt: now })
          .onConflictDoNothing()
          .returning({ userId: revealConsents.userId });
        return rows.length > 0 ? 'stored' : 'exists';
      } catch (error) {
        const pgError = pgErrorOf(error);
        if (pgError && REVEAL_REFUSED.has(pgError.code)) return 'refused';
        throw error;
      }
    },

    async ask(matchId, userId, now) {
      await db
        .insert(outbox)
        .values({
          id: uuidv7(),
          userId,
          kind: 'reveal_request',
          matchId,
          dedupeKey: notificationKey('reveal_request', matchId, userId),
          nextAttemptAt: now,
          createdAt: now,
        })
        .onConflictDoNothing({ target: outbox.dedupeKey });
    },

    async reveal(matchId, now) {
      try {
        return await db.transaction(async (tx) => {
          // The update trigger checks every row: two consents, an open adult chat, both adults
          // by birth date right now, both active.
          const revealed = await tx
            .update(revealConsents)
            .set({ revealedAt: now })
            .where(and(eq(revealConsents.matchId, matchId), isNull(revealConsents.revealedAt)))
            .returning({ userId: revealConsents.userId });
          if (revealed.length !== 2) throw new NothingToReveal();
          await tx
            .insert(outbox)
            .values(
              revealed.map(({ userId }) => ({
                id: uuidv7(),
                userId,
                kind: 'reveal_done' as const,
                matchId,
                dedupeKey: notificationKey('reveal_done', matchId, userId),
                nextAttemptAt: now,
                createdAt: now,
              })),
            )
            .onConflictDoNothing({ target: outbox.dedupeKey });
          return true;
        });
      } catch (error) {
        if (error instanceof NothingToReveal) return false;
        const pgError = pgErrorOf(error);
        if (pgError && REVEAL_REFUSED.has(pgError.code)) return false;
        throw error;
      }
    },
  };
}
