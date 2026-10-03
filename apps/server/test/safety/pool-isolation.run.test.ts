/**
 * SAFETY SUITE — the real matching run on a mixed database population (CLAUDE.md invariants 1, 5,
 * 8 and 9). Every pool × mode is run over a database that holds users of both bands, both locales
 * and both modes, plus frozen and unreachable users, blocks and earlier matches. Then every match
 * in the database is checked with plain SQL against the rules, using the bands derived from the
 * birth dates. The planner and the database trigger must agree: no planned pair may be refused.
 */
import type { Band, Locale, Mode } from '@samesync/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateProfiles, insertSyntheticUsers } from '../../scripts/lib/synthetic';
import { realContent } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertMatch } from '../support/matches';
import { buildMatching } from '../support/population';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const RUNS: ReadonlyArray<{ band: Band; locale: Locale; mode: Mode }> = [
  { band: 'u18', locale: 'ru', mode: 'friends' },
  { band: 'u18', locale: 'en', mode: 'friends' },
  { band: 'adult', locale: 'ru', mode: 'friends' },
  { band: 'adult', locale: 'en', mode: 'friends' },
  { band: 'adult', locale: 'ru', mode: 'dating' },
  { band: 'adult', locale: 'en', mode: 'dating' },
];
const count = async (sql: string) =>
  Number(
    (await testDb.ownerPool.query<{ n: string }>(`SELECT count(*) AS n FROM ${sql}`)).rows[0]?.n,
  );

describe('matching runs over a mixed population', () => {
  it('create matches only inside one pool and mode, and only ones that obey every hard filter', async () => {
    const content = await realContent();
    const now = new Date();
    for (const [index, { band, locale, mode }] of RUNS.entries()) {
      const pool = { band, locale };
      const profiles = generateProfiles(content.matchScope({ ...pool, mode }), {
        pool,
        mode,
        n: 60,
        seed: 100 + index,
        now,
      });
      await insertSyntheticUsers(testDb.appPool, pool, mode, profiles, now);
    }
    // Noise that must never be matched: frozen and unreachable users, and people who went quiet.
    await testDb.ownerPool.query(
      "UPDATE users SET status = 'frozen' WHERE id IN (SELECT id FROM users ORDER BY id LIMIT 20)",
    );
    await testDb.ownerPool.query(
      `UPDATE users SET bot_reachable = false WHERE id IN (
         SELECT id FROM users WHERE status = 'active' ORDER BY id DESC LIMIT 20)`,
    );
    // Blocks and earlier matches between people who would otherwise be good pairs.
    const { rows: adults } = await testDb.ownerPool.query<{ id: string }>(
      `SELECT id FROM users WHERE status = 'active' AND bot_reachable AND age_band = 'adult'
         AND locale = 'ru' AND mode = 'friends' ORDER BY id LIMIT 12`,
    );
    for (let i = 0; i + 1 < 6; i += 2) {
      await testDb.ownerPool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
        adults[i]!.id,
        adults[i + 1]!.id,
      ]);
    }
    const earlier: Array<[string, string]> = [];
    for (let i = 6; i + 1 < 12; i += 2) {
      const match = await insertMatch(testDb.appPool, { a: adults[i]!.id, b: adults[i + 1]!.id });
      earlier.push([match.userA, match.userB]);
    }
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now()",
    );

    // Everyone has waited long enough for every tier.
    const { service } = await buildMatching(testDb, {
      params: { tier2AfterHours: 0, tier3AfterHours: 0, dailyLimit: 100 },
    });
    let created = 0;
    for (const { band, locale, mode } of RUNS) {
      const outcome = await service.run({ pool: { band, locale }, mode, slot: now });
      expect(outcome).toMatchObject({ status: 'done', pairsRejected: 0 });
      if (outcome.status === 'done') created += outcome.pairsCreated;
    }
    // Enough matches, at more than one tier, for the checks below to mean something.
    expect(created).toBeGreaterThan(100);
    const tiers = await testDb.ownerPool.query<{ tier: number }>(
      'SELECT DISTINCT tier FROM matches WHERE run_id IS NOT NULL ORDER BY tier',
    );
    expect(tiers.rows.length).toBeGreaterThanOrEqual(2);

    const NEW = `matches m JOIN users a ON a.id = m.user_a_id JOIN users b ON b.id = m.user_b_id
                 WHERE m.run_id IS NOT NULL`;
    // Same live band (from the birth dates), locale and mode as the match.
    expect(
      await count(
        `${NEW} AND NOT (vc_band(a.birth_date, vc_today()) = m.band AND vc_band(b.birth_date, vc_today()) = m.band)`,
      ),
    ).toBe(0);
    expect(await count(`${NEW} AND NOT (a.locale = m.locale AND b.locale = m.locale)`)).toBe(0);
    expect(await count(`${NEW} AND NOT (a.mode = m.mode AND b.mode = m.mode)`)).toBe(0);
    // u18: friends only, birth dates at most 2 calendar years apart.
    expect(await count(`${NEW} AND m.band = 'u18'`)).toBeGreaterThan(10);
    expect(
      await count(
        `${NEW} AND m.band = 'u18' AND NOT (m.mode = 'friends' AND vc_within_years(a.birth_date, b.birth_date, 2))`,
      ),
    ).toBe(0);
    // Dating: preferences and age ranges fit both ways.
    expect(await count(`${NEW} AND m.mode = 'dating'`)).toBeGreaterThan(10);
    expect(
      await count(
        `${NEW} AND m.mode = 'dating' AND NOT (
           a.gender = ANY (b.seeking) AND b.gender = ANY (a.seeking)
           AND vc_age_years(b.birth_date, vc_today()) BETWEEN a.dating_age_min AND a.dating_age_max
           AND vc_age_years(a.birth_date, vc_today()) BETWEEN b.dating_age_min AND b.dating_age_max)`,
      ),
    ).toBe(0);
    // Never a frozen or unreachable user, a blocked pair or a rematch.
    expect(
      await count(
        `${NEW} AND NOT (a.status = 'active' AND b.status = 'active' AND a.bot_reachable AND b.bot_reachable)`,
      ),
    ).toBe(0);
    expect(
      await count(
        `${NEW} AND EXISTS (SELECT 1 FROM blocks k WHERE (k.blocker_id, k.blocked_id) IN ((a.id, b.id), (b.id, a.id)))`,
      ),
    ).toBe(0);
    for (const [first, second] of earlier) {
      expect(await count(`matches WHERE user_a_id = '${first}' AND user_b_id = '${second}'`)).toBe(
        1,
      );
    }
    // At most one new match per user per run, and two notifications per match.
    expect(
      await count(
        `(SELECT u FROM matches m, LATERAL (VALUES (m.user_a_id), (m.user_b_id)) AS v(u)
          WHERE m.run_id IS NOT NULL GROUP BY m.run_id, u HAVING count(*) > 1) dup`,
      ),
    ).toBe(0);
    expect(await count('outbox')).toBe(created * 2);
  });
});
