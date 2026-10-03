// Bundles the server into dist/. Workspace packages (@samesync/*) are inlined because they ship
// TypeScript source; third-party dependencies stay external and are installed next to dist/.
import { build } from 'esbuild';
import { cp, readFile, rm } from 'node:fs/promises';

const pkg = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
const external = Object.keys(pkg.dependencies ?? {}).filter(
  (name) => !name.startsWith('@samesync/'),
);

await rm('dist', { recursive: true, force: true });
await build({
  entryPoints: {
    main: 'src/main.ts',
    migrate: 'scripts/migrate.ts',
    // Loaded by main.js as a worker thread (src/jobs/matching-planner.ts).
    'matching-worker': 'src/jobs/matching-worker.ts',
  },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  external,
  logLevel: 'info',
});
// migrate.js resolves migrations relative to itself (see src/db/migrate.ts).
await cp('src/db/migrations', 'dist/migrations', { recursive: true });
