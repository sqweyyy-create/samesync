/**
 * `pnpm dev:match-me` and `pnpm dev:population` on a real database: the real user gets a match
 * with a synthetic user and a notification, synthetic users never get a message, and the scripts
 * refuse to run in production.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { matchMe, type MatchMeOptions } from '../../scripts/lib/match-me';
import { createMatchingRepository } from '../../src/db/repositories/matching';
import { DEFAULT_MATCHING_PARAMS } from '../../src/domain/matching/params';
import { realContent } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertMatch, withoutTriggers } from '../support/matches';
import { buildSender } from '../support/notify';
import {
  answersFor,
  buildMatching,
  hoursAgo,
  insertPerson,
  itemsOf,
  realScope,
  type PersonInput,
} from '../support/population';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

const OPTIONS: Omit<MatchMeOptions, 'publicId'> = {
  poolSize: 60,
  lookalikes: 3,
  ignoreLimits: false,
  strict: false,
  seed: 11,
};

/** A real (not synthetic) user with a normal profile, and their support code. */
async function realUser(over: PersonInput = {}, scopeOver: Parameters<typeof realScope>[0] = {}) {
  const scope = await realScope(scopeOver);
  const user = await insertPerson(testDb.appPool, {
    items: [...itemsOf(scope, 'niche').slice(0, 2), ...itemsOf(scope, 'mainstream').slice(0, 4)],
    answers: answersFor(scope, 'ADADADADADADADADADADADADADADAD'),
    ...over,
  });
  const { rows } = await testDb.ownerPool.query<{ public_id: string }>(
    'SELECT public_id FROM users WHERE id = $1',
    [user.id],
  );
  return { ...user, publicId: rows[0]!.public_id };
}
async function run(publicId: string, over: Partial<MatchMeOptions> = {}, u18PoolEnabled = false) {
  const { service } = await buildMatching(testDb, { u18PoolEnabled });
  return matchMe(
    {
      db: testDb.appPool,
      content: await realContent(),
      repo: createMatchingRepository(testDb.db),
      matching: service,
      params: DEFAULT_MATCHING_PARAMS,
      now: new Date(),
    },
    { ...OPTIONS, publicId, ...over },
  );
}
const partnerOf = async (matchId: string, userId: string) =>
  (
    await testDb.ownerPool.query<Record<string, unknown>>(
      `SELECT u.* FROM matches m JOIN users u
         ON u.id = CASE WHEN m.user_a_id = $2 THEN m.user_b_id ELSE m.user_a_id END
       WHERE m.id = $1`,
      [matchId, userId],
    )
  ).rows[0];

describe('matchMe', () => {
  it('matches a real user with a synthetic one and names something they really share', async () => {
    const user = await realUser();
    const result = await run(user.publicId);
    expect(result).toMatchObject({
      status: 'matched',
      pool: { band: 'adult', locale: 'ru' },
      mode: 'friends',
      added: { fillers: 60, lookalikes: 3 },
    });
    if (result.status !== 'matched' || !result.match) throw new Error('expected a match');
    expect(result.match.alias).toMatch(/^\S+ \S+/);
    expect(result.match.teaser.length).toBeGreaterThan(10);
    expect(result.match.teaser).not.toMatch(/[{}]|teaser\./);
    const partner = await partnerOf(result.match.id, user.id);
    expect(partner).toMatchObject({ synthetic: true, locale: 'ru', mode: 'friends' });

    // Only the real user is messaged; the synthetic partner's row is dropped.
    await testDb.ownerPool.query("UPDATE outbox SET next_attempt_at = '2020-01-01T00:00:00Z'");
    const { sender, calls } = await buildSender(testDb);
    for (let i = 0; i < 20; i++) await sender.tick();
    expect(calls.map((c) => c.payload.chat_id)).toEqual([user.telegramId]);
    expect(calls[0]?.payload.text).toContain(result.match.teaser);
    const states = await testDb.ownerPool.query<{ status: string; cancel_reason: string | null }>(
      `SELECT DISTINCT o.status, o.cancel_reason FROM outbox o JOIN users u ON u.id = o.user_id
       WHERE u.synthetic`,
    );
    expect(states.rows).toEqual([{ status: 'cancelled', cancel_reason: 'synthetic_user' }]);
  });

  it('tops the pool up only once: a second run adds just the lookalikes', async () => {
    const user = await realUser();
    expect(await run(user.publicId)).toMatchObject({ added: { fillers: 60, lookalikes: 3 } });
    expect(await run(user.publicId, { seed: 12 })).toMatchObject({
      status: 'matched',
      added: { fillers: 0, lookalikes: 3 },
    });
  });

  it('respects dating preferences and age ranges of the real user', async () => {
    const user = await realUser(
      {
        mode: 'dating',
        gender: 'g.woman',
        seeking: ['g.man'],
        datingAge: { min: 24, max: 28 },
        birthDate: birthDateYearsAgo(26),
      },
      { mode: 'dating' },
    );
    const result = await run(user.publicId);
    if (result.status !== 'matched' || !result.match) throw new Error('expected a match');
    const partner = await partnerOf(result.match.id, user.id);
    expect(partner).toMatchObject({ gender: 'g.man', mode: 'dating', synthetic: true });
    expect(partner?.['seeking']).toContain('g.woman');
    const { rows } = await testDb.ownerPool.query<{ age: number }>(
      'SELECT vc_age_years(birth_date, vc_today()) AS age FROM users WHERE id = $1',
      [partner?.['id']],
    );
    expect(rows[0]!.age).toBeGreaterThanOrEqual(24);
    expect(rows[0]!.age).toBeLessThanOrEqual(28);
    expect(result.run).toMatchObject({ pairsRejected: 0 });
  });

  it('explains why a user at the open-match limit is skipped, and matches them with --ignore-limits', async () => {
    const user = await realUser();
    for (let i = 0; i < 5; i++) {
      const other = await insertPerson(testDb.appPool, {});
      await insertMatch(testDb.appPool, { a: user.id, b: other.id });
    }
    // Three days old, so only the open-match limit applies (created_at is immutable otherwise).
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query("UPDATE matches SET created_at = now() - interval '3 days'"),
    );
    expect(await run(user.publicId)).toMatchObject({
      status: 'not_matched',
      ineligible: 'open_limit',
      match: null,
    });
    expect(await run(user.publicId, { ignoreLimits: true, seed: 12 })).toMatchObject({
      status: 'matched',
    });
  });

  it('says so when the bot cannot reach the user', async () => {
    const user = await realUser({ botReachable: false });
    expect(await run(user.publicId)).toMatchObject({
      status: 'not_matched',
      ineligible: 'unreachable',
    });
  });

  it('with --strict keeps the waiting thresholds of the fallback tiers', async () => {
    // No niche item, onboarded just now: under the real rules nobody is a tier 1 partner.
    const scope = await realScope();
    const user = await realUser({ items: itemsOf(scope, 'mainstream').slice(0, 5) });
    expect(await run(user.publicId, { strict: true })).toMatchObject({
      status: 'not_matched',
      ineligible: null,
    });
    const relaxed = await run(user.publicId, { seed: 12 });
    expect(relaxed).toMatchObject({ status: 'matched' });
    if (relaxed.status === 'matched') expect(relaxed.match?.tier).toBe(2);
  });

  it('refuses unknown codes, synthetic users and accounts that are not active', async () => {
    expect(await run('ZZZZZZZZZZ')).toEqual({ status: 'user_not_found' });
    const onboarding = await realUser({ status: 'onboarding', onboardedAt: null });
    expect(await run(onboarding.publicId)).toMatchObject({ status: 'user_not_ready' });
    const synthetic = await realUser({ synthetic: true });
    expect(await run(synthetic.publicId)).toMatchObject({ status: 'user_not_ready' });
    const { rows } = await testDb.ownerPool.query('SELECT 1 FROM users WHERE synthetic');
    expect(rows).toHaveLength(1);
  });

  it('reports a disabled u18 pool instead of matching', async () => {
    const user = await realUser(
      { birthDate: birthDateYearsAgo(16), onboardedAt: hoursAgo(1) },
      { band: 'u18' },
    );
    expect(await run(user.publicId)).toMatchObject({
      status: 'not_matched',
      run: { status: 'disabled' },
    });
    const enabled = await run(user.publicId, { seed: 12 }, true);
    expect(enabled).toMatchObject({ status: 'matched', pool: { band: 'u18' } });
    if (enabled.status !== 'matched' || !enabled.match) throw new Error('expected a match');
    const partner = await partnerOf(enabled.match.id, user.id);
    expect(partner).toMatchObject({ age_band: 'u18', mode: 'friends' });
  });
});

describe('the dev scripts', () => {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const script = (name: string) =>
    fileURLToPath(new URL(`../../scripts/${name}.ts`, import.meta.url));
  const runScript = (name: string, args: string[], env: Record<string, string>) =>
    promisify(execFile)(process.execPath, [tsxCli, script(name), ...args], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      timeout: 30_000,
    }).then(
      (ok) => ({ code: 0, ...ok }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? -1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );

  it.each([
    ['dev-population', ['--n', '5']],
    ['dev-match-me', ['ABCDEFGH12']],
    ['bench-matching', ['--n', '10']],
  ])('%s refuses to run with NODE_ENV=production', async (name, args) => {
    const result = await runScript(name, args, {
      NODE_ENV: 'production',
      // Would work if the script went on: it must stop before using it.
      DATABASE_URL: testDb.ownerUrl,
      TEST_DATABASE_URL: testDb.ownerUrl,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refuses to run with NODE_ENV=production');
    const { rows } = await testDb.ownerPool.query('SELECT 1 FROM users');
    expect(rows).toHaveLength(0);
  });

  it('dev-population creates synthetic users in the chosen pool, as the app role', async () => {
    const url = new URL(testDb.ownerUrl);
    url.searchParams.set('options', '-c role=samesync_app');
    const result = await runScript(
      'dev-population',
      ['--pool', 'adult:en', '--mode', 'dating', '--n', '12', '--seed', '3'],
      { DATABASE_URL: url.toString() },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain(
      'Created 12 synthetic users in adult:en, dating mode (seed 3).',
    );
    const { rows } = await testDb.ownerPool.query<Record<string, unknown>>(
      `SELECT count(*)::int AS n, bool_and(synthetic) AS synthetic, bool_and(status = 'active') AS active,
         bool_and(locale = 'en' AND mode = 'dating' AND age_band = 'adult') AS in_pool,
         bool_and(gender IS NOT NULL AND dating_age_min >= 18) AS dating
       FROM users`,
    );
    expect(rows[0]).toEqual({ n: 12, synthetic: true, active: true, in_pool: true, dating: true });
  });

  it('dev-match-me validates the support code before doing anything', async () => {
    const result = await runScript('dev-match-me', ['not a code'], {
      DATABASE_URL: testDb.ownerUrl,
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Usage: pnpm dev:match-me <public_id>');
  });
});
