/* eslint-disable no-console -- CLI output */
import { z } from 'zod';
import { runMigrations } from '../src/db/migrate';

const env = z
  .object({
    MIGRATION_DATABASE_URL: z
      .string()
      .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL for the owner role'),
  })
  .safeParse(process.env);

if (!env.success) {
  // Names the variable, never its value.
  console.error(
    'MIGRATION_DATABASE_URL is missing or invalid (owner role connection, see .env.example)',
  );
  process.exit(1);
}

await runMigrations(env.data.MIGRATION_DATABASE_URL);
console.log('Migrations are up to date.');
