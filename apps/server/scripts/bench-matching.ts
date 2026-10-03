/* eslint-disable no-console -- CLI output */
/**
 * Benchmark for PLAN.md Phase 2: one matching run over N synthetic users in a single pool must
 * finish in under 60 seconds without the main event loop lagging more than 100 ms.
 * Runs on a throwaway database (created and dropped here), with the worker-thread planner exactly
 * as the server uses it. Manual, not a CI gate. Refuses to run in production.
 *
 *   pnpm bench:matching [--n 5000] [--mode friends]
 */
import { randomBytes } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import { contentChecksum, loadValidContent } from '@samesync/content';
import type { Mode } from '@samesync/shared';
import pg from 'pg';
import { systemClock } from '../src/clock';
import { DEFAULT_CONTENT_DIR } from '../src/config';
import { seedContent } from '../src/content/seed';
import { createContentStore } from '../src/content/store';
import { createDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { createMatchingRepository } from '../src/db/repositories/matching';
import { DEFAULT_MATCHING_PARAMS } from '../src/domain/matching/params';
import { workerPlanner } from '../src/jobs/matching-planner';
import { createLogger } from '../src/logger';
import { createMatchingService } from '../src/services/matching';
import { fail, refuseInProduction } from './lib/dev-runtime';
import { generateProfiles, insertSyntheticUsers } from './lib/synthetic';

refuseInProduction('bench:matching');

const { values } = parseArgs({
  options: { n: { type: 'string', default: '5000' }, mode: { type: 'string', default: 'friends' } },
});
const n = Number(values.n);
const mode = values.mode as Mode;
if (!Number.isInteger(n) || n < 2 || n > 20_000) fail('--n must be a whole number from 2 to 20000');
if (mode !== 'friends' && mode !== 'dating') fail('--mode must be friends or dating');
const adminUrl = process.env['TEST_DATABASE_URL'];
if (!adminUrl) fail('TEST_DATABASE_URL is not set (owner connection to the maintenance database)');

const database = `samesync_bench_${randomBytes(6).toString('hex')}`;
const url = new URL(adminUrl);
url.pathname = `/${database}`;
const admin = async (sql: string) => {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};

/** The largest gap between two 10 ms timer ticks, beyond those 10 ms: the event loop lag. */
function lagProbe() {
  const INTERVAL = 10;
  let last = performance.now();
  let max = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    max = Math.max(max, now - last - INTERVAL);
    last = now;
  }, INTERVAL);
  return () => {
    clearInterval(timer);
    return max;
  };
}

await admin(`CREATE DATABASE "${database}"`);
let app: pg.Pool | undefined;
try {
  await runMigrations(url.toString());
  const bundle = await loadValidContent(DEFAULT_CONTENT_DIR);
  const owner = new pg.Pool({ connectionString: url.toString(), max: 1 });
  await seedContent(owner, bundle, contentChecksum(bundle));
  await owner.end();

  // Everything below runs as the restricted app role, like the server.
  app = new pg.Pool({ connectionString: url.toString(), max: 10, options: '-c role=samesync_app' });
  const content = createContentStore(bundle, contentChecksum(bundle));
  const pool = { band: 'adult', locale: 'ru' } as const;
  const now = new Date();
  const generated = performance.now();
  const profiles = generateProfiles(content.matchScope({ ...pool, mode }), {
    pool,
    mode,
    n,
    seed: 20261003,
    now,
  });
  await insertSyntheticUsers(app, pool, mode, profiles, now);
  console.log(
    `Prepared ${n} synthetic users in adult:ru, ${mode} mode ` +
      `(${((performance.now() - generated) / 1000).toFixed(1)} s).`,
  );

  const matching = createMatchingService({
    pool: app,
    repo: createMatchingRepository(createDb(app)),
    content,
    planner: workerPlanner,
    clock: systemClock,
    logger: createLogger('warn'),
    params: DEFAULT_MATCHING_PARAMS,
    u18PoolEnabled: false,
    allowSynthetic: true,
  });
  const histogram = monitorEventLoopDelay({ resolution: 10 });
  histogram.enable();
  const stopProbe = lagProbe();
  const started = performance.now();
  const outcome = await matching.run({ pool, mode, slot: now });
  const seconds = (performance.now() - started) / 1000;
  const maxLag = stopProbe();
  histogram.disable();

  if (outcome.status !== 'done') fail(`the run did not complete: ${outcome.status}`);
  const { tierCounts: tiers } = outcome;
  console.log(
    `Run: ${outcome.pairsCreated} pairs (tier 1: ${tiers[1]}, tier 2: ${tiers[2]}, tier 3: ${tiers[3]}), ` +
      `${outcome.eligibleUsers} of ${outcome.poolSize} users eligible, ${outcome.pairsRejected} refused.`,
  );
  console.log(`Time for the run: ${seconds.toFixed(1)} s (limit 60 s).`);
  console.log(
    `Main event loop: longest lag ${maxLag.toFixed(0)} ms (limit 100 ms), ` +
      `p99 ${(histogram.percentile(99) / 1e6).toFixed(0)} ms between 10 ms ticks.`,
  );
  const ok = seconds < 60 && maxLag <= 100;
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await app?.end();
  await admin(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
}
