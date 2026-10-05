import type { Band, Locale, Mode } from '@samesync/shared';
import type pg from 'pg';
import { v7 as uuidv7 } from 'uuid';
import type { NotificationKind } from '../../src/domain/notifications';
import { insertUser, type InsertUser } from './users';

/** An onboarded, active user (adult, ru, friends unless overridden). */
export function insertActiveUser(
  pool: pg.Pool,
  over: InsertUser = {},
): Promise<{ id: string; telegramId: number }> {
  return insertUser(pool, {
    status: 'active',
    mode: 'friends',
    onboardedAt: new Date(),
    ...over,
  });
}

export interface InsertMatch {
  a: string;
  b: string;
  band?: Band;
  locale?: Locale;
  mode?: Mode;
  status?: string;
  /** Keep `a` and `b` as given instead of ordering them (to attack the ordering CHECK). */
  keepOrder?: boolean;
  /**
   * Content alias IDs: how `a` appears to `b`, and how `b` appears to `a`. Without it user A of
   * the match is `a.fox` and user B is `a.owl`.
   */
  seenAs?: readonly [string, string];
}

/**
 * Inserts a match with plain SQL on `pool`, exactly like an attacker or a buggy code path would:
 * nothing is validated here, so the DB's own triggers and constraints decide.
 */
export async function insertMatch(
  pool: pg.Pool,
  input: InsertMatch,
): Promise<{ id: string; userA: string; userB: string }> {
  const asGiven = input.keepOrder || input.a < input.b;
  const [userA, userB] = asGiven ? [input.a, input.b] : [input.b, input.a];
  const [ofA, ofB] = input.seenAs ?? ['a.fox', 'a.owl'];
  const [aliasA, aliasB] = !input.seenAs || asGiven ? [ofA, ofB] : [ofB, ofA];
  const id = uuidv7();
  await pool.query(
    `INSERT INTO matches (id, band, locale, mode, user_a_id, user_b_id, tier, score, teaser,
       alias_a, alias_b, status, game_deadline_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, 1, $7, $8, $9, $10, now() + interval '48 hours')`,
    [
      id,
      input.band ?? 'adult',
      input.locale ?? 'ru',
      input.mode ?? 'friends',
      userA,
      userB,
      JSON.stringify({ interest: null, take: { id: 'q.pineapple_pizza', value: 'agree' } }),
      aliasA,
      aliasB,
      input.status ?? 'pending_game',
    ],
  );
  return { id, userA, userB };
}

/** A pending notification for `userId`: "new match" unless another kind is given. */
export async function insertOutbox(
  pool: pg.Pool,
  input: { userId: string; matchId: string; kind?: NotificationKind },
): Promise<{ id: string }> {
  const id = uuidv7();
  const kind = input.kind ?? 'match_created';
  await pool.query(
    `INSERT INTO outbox (id, user_id, kind, match_id, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, input.userId, kind, input.matchId, `${kind}:${input.matchId}:${input.userId}`],
  );
  return { id };
}

export async function matchRow(pool: pg.Pool, id: string) {
  const { rows } = await pool.query<{
    status: string;
    close_reason: string | null;
    closed_at: Date | null;
  }>('SELECT status, close_reason, closed_at FROM matches WHERE id = $1', [id]);
  return rows[0];
}

export async function outboxRow(pool: pg.Pool, id: string) {
  const { rows } = await pool.query<{
    status: string;
    cancel_reason: string | null;
    last_error: string | null;
    attempts: number;
  }>('SELECT status, cancel_reason, last_error, attempts FROM outbox WHERE id = $1', [id]);
  return rows[0];
}

/**
 * Runs `fn` on an owner connection with triggers switched off, to build states that the triggers
 * would otherwise prevent (e.g. a deliberately stale age_band cache). Setup only.
 */
export async function withoutTriggers<T>(
  ownerPool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await ownerPool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role = replica');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
