/**
 * Postgres advisory locks for jobs (PLAN.md §2): a second server instance, or a dev script running
 * next to the server, never does the same job at the same time. The lock belongs to one database
 * session, which is held for as long as `fn` runs.
 */
import type { Band, Locale, Mode } from '@samesync/shared';
import type pg from 'pg';

/** First key of every SameSync lock; the second key names the job. */
const NAMESPACE = 5_347_283;

export const LOCK = {
  outbox: 1,
  ageTransition: 2,
  /** One lock per pool × mode, so different pools can run side by side. */
  matching: (pool: { band: Band; locale: Locale }, mode: Mode) =>
    100 +
    (pool.band === 'adult' ? 4 : 0) +
    (pool.locale === 'en' ? 2 : 0) +
    (mode === 'dating' ? 1 : 0),
} as const;

export type Locked<T> = { acquired: true; value: T } | { acquired: false };

/** Runs `fn` while holding the lock, or returns `{ acquired: false }` if someone else holds it. */
export async function withAdvisoryLock<T>(
  pool: pg.Pool,
  key: number,
  fn: () => Promise<T>,
): Promise<Locked<T>> {
  const client = await pool.connect();
  // A connection that could not unlock is destroyed, which releases its session locks.
  let destroy = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [NAMESPACE, key],
    );
    if (!rows[0]?.locked) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [NAMESPACE, key]).catch(() => {
        destroy = true;
      });
    }
  } catch (error) {
    destroy = true;
    throw error;
  } finally {
    client.release(destroy);
  }
}
