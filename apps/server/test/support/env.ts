import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const rootEnv = fileURLToPath(new URL('../../../../.env', import.meta.url));

/**
 * Owner connection to the maintenance database (usually /postgres). Tests create and drop their own
 * databases through it. CI sets TEST_DATABASE_URL directly; locally it comes from the root .env.
 */
export function testDatabaseUrl(): string {
  if (!process.env['TEST_DATABASE_URL'] && existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const url = process.env['TEST_DATABASE_URL'];
  if (!url) {
    throw new Error(
      'TEST_DATABASE_URL is not set. Start Postgres (`docker compose up -d db`) and set it in .env ' +
        '(see .env.example).',
    );
  }
  return url;
}

export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

export function quoteIdent(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new Error(`unsafe database name: ${name}`);
  return `"${name}"`;
}
