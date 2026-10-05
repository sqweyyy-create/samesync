/* eslint-disable no-console -- CLI output */
/** Shared setup of the development scripts. They never run in production. */
import { contentChecksum, loadValidContent } from '@samesync/content';
import pg from 'pg';
import { z } from 'zod';
import { DEFAULT_CONTENT_DIR } from '../../src/config';
import { assertContentSeeded } from '../../src/content/seed';
import { createContentStore, type ContentStore } from '../../src/content/store';

export function refuseInProduction(script: string): void {
  if (process.env['NODE_ENV'] === 'production') {
    console.error(`${script} refuses to run with NODE_ENV=production`);
    process.exit(1);
  }
}

/** Exits with a message that names the variable, never its value. */
export function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * The app-role connection the server itself uses, and the content it serves. `max` is the size of
 * the connection pool: a script that holds advisory locks while it works needs a few more.
 */
export async function connect(
  options: { max?: number } = {},
): Promise<{ db: pg.Pool; content: ContentStore }> {
  const env = z
    .object({
      DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
      CONTENT_DIR: z.string().min(1).default(DEFAULT_CONTENT_DIR),
    })
    .safeParse(process.env);
  if (!env.success) {
    fail('DATABASE_URL is missing or invalid (app role connection, see .env.example)');
  }
  const bundle = await loadValidContent(env.data.CONTENT_DIR);
  const content = createContentStore(bundle, contentChecksum(bundle));
  const db = new pg.Pool({ connectionString: env.data.DATABASE_URL, max: options.max ?? 4 });
  try {
    await assertContentSeeded(db, content.release, content.checksum);
  } catch (error) {
    await db.end();
    fail(`${(error as Error).message}\nRun pnpm db:migrate and pnpm content:seed first.`);
  }
  return { db, content };
}
