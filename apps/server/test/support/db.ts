import { randomBytes } from 'node:crypto';
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

/**
 * A pool whose every session runs as `samesync_app`. The role is set as a startup parameter, so
 * not a single query on these connections runs with owner privileges.
 */
export function appRolePool(connectionString: string): pg.Pool {
  return new pg.Pool({ connectionString, max: 4, options: `-c role=${APP_ROLE}` });
}

async function onAdmin(sql: string): Promise<void> {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

/** A fresh database cloned from the migrated template. Call `drop()` in afterAll. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `samesync_t_${randomBytes(8).toString('hex')}`;
  await onAdmin(
    `CREATE DATABASE ${quoteIdent(name)} TEMPLATE ${quoteIdent(inject('templateDatabase'))}`,
  );
  const ownerUrl = withDatabase(testDatabaseUrl(), name);
  const appPool = appRolePool(ownerUrl);
  const ownerPool = new pg.Pool({ connectionString: ownerUrl, max: 2 });
  return {
    name,
    ownerUrl,
    appPool,
    db: createDb(appPool),
    ownerPool,
    async drop() {
      await Promise.all([appPool.end(), ownerPool.end()]);
      await onAdmin(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    },
  };
}

/** An empty database (no migrations), for migration tests. */
export async function createEmptyDatabase(): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `samesync_e_${randomBytes(8).toString('hex')}`;
  await onAdmin(`CREATE DATABASE ${quoteIdent(name)}`);
  return {
    url: withDatabase(testDatabaseUrl(), name),
    drop: () => onAdmin(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`),
  };
}
