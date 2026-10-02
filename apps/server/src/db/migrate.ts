import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

/** In source this is src/db/migrations; in the bundle, dist/migrations (copied by build.mjs). */
export const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations', import.meta.url));

/**
 * Applies pending migrations. Must connect as the owner role, never as `samesync_app`.
 * Already-applied migrations are skipped, so re-running is a no-op.
 */
export async function runMigrations(
  connectionString: string,
  migrationsFolder: string = MIGRATIONS_DIR,
): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    await migrate(drizzle({ client: pool }), { migrationsFolder });
  } finally {
    await pool.end();
  }
}
