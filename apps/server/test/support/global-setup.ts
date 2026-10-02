import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '../../src/db/migrate';
import { quoteIdent, testDatabaseUrl, withDatabase } from './env';

declare module 'vitest' {
  export interface ProvidedContext {
    templateDatabase: string;
  }
}

async function admin<T>(url: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Postgres is not reachable through TEST_DATABASE_URL (${(error as Error).message}). ` +
        'Run `docker compose up -d db` first.',
      { cause: error },
    );
  }
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Migrates a template database once per run; each test file then clones it (see db.ts). */
export default async function setup(project: TestProject) {
  const adminUrl = testDatabaseUrl();
  const template = `samesync_tpl_${randomBytes(6).toString('hex')}`;
  await admin(adminUrl, (c) => c.query(`CREATE DATABASE ${quoteIdent(template)}`));
  await runMigrations(withDatabase(adminUrl, template));
  project.provide('templateDatabase', template);

  return async () => {
    await admin(adminUrl, (c) =>
      c.query(`DROP DATABASE IF EXISTS ${quoteIdent(template)} WITH (FORCE)`),
    );
  };
}
