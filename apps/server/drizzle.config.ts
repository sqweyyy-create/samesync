import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` only diffs the schema; it never connects to a database.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  strict: true,
  verbose: true,
});
