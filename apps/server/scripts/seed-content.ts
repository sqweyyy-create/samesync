/* eslint-disable no-console -- CLI output */
/** `pnpm content:seed`: validates content/ and seeds its IDs and metadata (owner role). */
import { contentChecksum, loadValidContent } from '@samesync/content';
import pg from 'pg';
import { z } from 'zod';
import { DEFAULT_CONTENT_DIR } from '../src/config';
import { seedContent } from '../src/content/seed';

const env = z
  .object({
    MIGRATION_DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//),
    CONTENT_DIR: z.string().min(1).default(DEFAULT_CONTENT_DIR),
  })
  .safeParse(process.env);
if (!env.success) {
  // Names the variable, never its value.
  console.error(
    'MIGRATION_DATABASE_URL is missing or invalid (owner role connection, see .env.example)',
  );
  process.exit(1);
}

const bundle = await loadValidContent(env.data.CONTENT_DIR);
const pool = new pg.Pool({ connectionString: env.data.MIGRATION_DATABASE_URL, max: 1 });
try {
  const result = await seedContent(pool, bundle, contentChecksum(bundle));
  console.log(
    result.status === 'seeded'
      ? `Seeded content release ${result.version}.`
      : `Content release ${result.version} is already seeded; nothing to do.`,
  );
} finally {
  await pool.end();
}
