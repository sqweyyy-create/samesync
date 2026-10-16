import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import pg from 'pg';
import { inject } from 'vitest';
import { createDb, type Db } from '../../src/db/client';
import { quoteIdent, testDatabaseUrl, withDatabase } from './env';

export const APP_ROLE = 'samesync_app';

export interface TestDatabase {
  name: string;
  /** Owner connection URL (migrations, setup, assertions). */
  ownerUrl: string;
  /** Pool whose sessions run as the restricted app role, exactly like the server at runtime. */
  appPool: pg.Pool;
  db: Db;
  /** Pool with owner privileges, for setup and assertions only. */
  ownerPool: pg.Pool;
  drop(): Promise<void>;
}

/** Every pool made here, by the database it connects to, so that `drop()` can end them all. */
const poolsOf = new Map<string, Set<pg.Pool>>();

function track(pool: pg.Pool, database: string): pg.Pool {
  let pools = poolsOf.get(database);
  if (!pools) {
    pools = new Set();
    poolsOf.set(database, pools);
  }
  pools.add(pool);
  return pool;
}

const databaseOf = (connectionString: string) =>
  decodeURIComponent(new URL(connectionString).pathname.slice(1));

/**
 * A pool whose every session runs as `samesync_app`. The role is set as a startup parameter, so
 * not a single query on these connections runs with owner privileges.
 */
export function appRolePool(connectionString: string): pg.Pool {
  return track(
    new pg.Pool({ connectionString, max: 4, options: `-c role=${APP_ROLE}` }),
    databaseOf(connectionString),
  );
}

async function onAdmin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** How long a session of a dropped database may take to go away after its pool has ended. */
const SESSIONS_GONE_TIMEOUT_MS = 10_000;

/**
 * Ends every pool of `name` made through this module, then waits until the server shows no
 * session of that database any more, and only then drops it.
 *
 * `pool.end()` resolves as soon as the pool has told each idle client to end: it does not wait for
 * the server to see the Terminate. A `DROP DATABASE … WITH (FORCE)` that runs right then kills
 * sessions that are still closing, and the server's "terminating connection due to administrator
 * command" lands on a client the pool has already let go of, as an unhandled pool error that
 * fails whatever test runs next. So the sessions are waited for, pool or no pool: a test may have
 * made its own.
 */
async function dropDatabase(name: string): Promise<void> {
  const pools = poolsOf.get(name) ?? new Set<pg.Pool>();
  poolsOf.delete(name);
  // A test may have ended a pool itself; pg-pool refuses a second end() and flags the first.
  const stillOpen = [...pools].filter((pool) => !(pool as { ending?: boolean }).ending);
  await Promise.all(stillOpen.map((pool) => pool.end()));
  await onAdmin(async (client) => {
    const started = Date.now();
    for (;;) {
      const { rows } = await client.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1',
        [name],
      );
      const left = rows[0]?.n ?? 0;
      if (left === 0) break;
      if (Date.now() - started > SESSIONS_GONE_TIMEOUT_MS) {
        // Dropped anyway, so no database is left behind; the leak itself is reported.
        await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
        throw new Error(
          `${left} session(s) of ${name} were still open when it was dropped: a pool or client ` +
            'of the test was not ended',
        );
      }
      await sleep(20);
    }
    await client.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  });
}

/** A fresh database cloned from the migrated template. Call `drop()` in afterAll. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `samesync_t_${randomBytes(8).toString('hex')}`;
  await onAdmin((client) =>
    client.query(
      `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(inject('templateDatabase'))}`,
    ),
  );
  const ownerUrl = withDatabase(testDatabaseUrl(), name);
  const appPool = appRolePool(ownerUrl);
  const ownerPool = track(new pg.Pool({ connectionString: ownerUrl, max: 2 }), name);
  return {
    name,
    ownerUrl,
    appPool,
    db: createDb(appPool),
    ownerPool,
    drop: () => dropDatabase(name),
  };
}

/** An empty database (no migrations), for migration tests. */
export async function createEmptyDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `samesync_e_${randomBytes(8).toString('hex')}`;
  await onAdmin((client) => client.query(`CREATE DATABASE ${quoteIdent(name)}`));
  return {
    url: withDatabase(testDatabaseUrl(), name),
    drop: () => dropDatabase(name),
  };
}
