/* eslint-disable no-console -- CLI output */
/**
 * Builds a synthetic population in one pool × mode, for trying out matching locally.
 * Synthetic users are matched like anyone else outside production, but never messaged.
 * Refuses to run in production.
 *
 *   pnpm dev:population --pool adult:ru --mode friends --n 500 [--seed 1]
 */
import { parseArgs } from 'node:util';
import { BANDS, LOCALES, MODES, type Band, type Locale, type Mode } from '@samesync/shared';
import { connect, fail, refuseInProduction } from './lib/dev-runtime';
import { generateProfiles, insertSyntheticUsers } from './lib/synthetic';

refuseInProduction('dev:population');

const { values } = parseArgs({
  options: {
    pool: { type: 'string', default: 'adult:ru' },
    mode: { type: 'string', default: 'friends' },
    n: { type: 'string', default: '500' },
    seed: { type: 'string' },
  },
});
const [band, locale] = values.pool.split(':') as [Band, Locale];
const mode = values.mode as Mode;
const n = Number(values.n);
if (!BANDS.includes(band) || !LOCALES.includes(locale)) {
  fail('--pool must be <band>:<locale>, e.g. adult:ru or u18:en');
}
if (!MODES.includes(mode)) fail('--mode must be friends or dating');
if (band === 'u18' && mode !== 'friends') fail('u18 users are friends-only');
if (!Number.isInteger(n) || n < 1 || n > 20_000) fail('--n must be a whole number from 1 to 20000');
const seed = values.seed === undefined ? Math.floor(Math.random() * 2 ** 31) : Number(values.seed);
if (!Number.isInteger(seed)) fail('--seed must be a whole number');

const { db, content } = await connect();
try {
  const now = new Date();
  const pool = { band, locale };
  const profiles = generateProfiles(content.matchScope({ ...pool, mode }), {
    pool,
    mode,
    n,
    seed,
    now,
  });
  await insertSyntheticUsers(db, pool, mode, profiles, now);
  console.log(`Created ${n} synthetic users in ${band}:${locale}, ${mode} mode (seed ${seed}).`);
  console.log('They are matched at the next drop, or right away with pnpm dev:match-me.');
} finally {
  await db.end();
}
