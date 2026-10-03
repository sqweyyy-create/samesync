/**
 * SAFETY SUITE — pool isolation enforced by the database itself (CLAUDE.md invariants 1, 2, 5, 8
 * and 9; PLAN.md §3 layers 1 and 2). Every test skips the app and attacks the `matches` table
 * with plain SQL as the app role: the insert trigger re-derives both users' bands from
 * `birth_date`, never from the cached `age_band`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertActiveUser, insertMatch, matchRow, withoutTriggers } from '../support/matches';
import { birthDateYearsAgo, type InsertUser } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const ADULT = () => birthDateYearsAgo(25);
/** Born exactly `years` years ago: `years` old today. */
const born = (years: number, over: InsertUser = {}) =>
  insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(years), ...over });
const adult = (over: InsertUser = {}) =>
  insertActiveUser(testDb.appPool, { birthDate: ADULT(), ...over });
const kid = (over: InsertUser = {}) =>
  insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(16, 100), ...over });
const dater = (gender: string, seeking: string[], over: InsertUser = {}) =>
  adult({ mode: 'dating', gender, seeking, ...over });

/** The insert trigger refused the match, naming this rule. */
const expectRejected = (insert: Promise<unknown>, rule: string) =>
  expect(insert).rejects.toMatchObject({ code: 'SS010', message: `match rejected: ${rule}` });
const CHECK = (constraint: string) => ({ code: '23514', constraint });

describe('a direct INSERT INTO matches as the app role', () => {
  it('works for two active users of one band, locale and mode (the control case)', async () => {
    const [a, b] = [await adult(), await adult()];
    const match = await insertMatch(testDb.appPool, { a: a.id, b: b.id });
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({ status: 'pending_game' });
    const [k1, k2] = [await kid(), await kid()];
    await insertMatch(testDb.appPool, { a: k1.id, b: k2.id, band: 'u18' });
  });

  it('fails across bands, whichever band the match claims', async () => {
    const [a, k] = [await adult(), await kid()];
    await expectRejected(insertMatch(testDb.appPool, { a: a.id, b: k.id, band: 'adult' }), 'band');
    await expectRejected(insertMatch(testDb.appPool, { a: a.id, b: k.id, band: 'u18' }), 'band');
  });

  it('fails when the match claims a band neither user is in', async () => {
    const [a, b] = [await adult(), await adult()];
    await expectRejected(insertMatch(testDb.appPool, { a: a.id, b: b.id, band: 'u18' }), 'band');
    const [k1, k2] = [await kid(), await kid()];
    await expectRejected(
      insertMatch(testDb.appPool, { a: k1.id, b: k2.id, band: 'adult' }),
      'band',
    );
  });

  it('uses the live band from birth_date even when the cached age_band is stale', async () => {
    // A 16-year-old whose cache wrongly says "adult": the cache must not let them into an adult match.
    const stale = await kid();
    const realAdult = await adult();
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query("UPDATE users SET age_band = 'adult' WHERE id = $1", [stale.id]),
    );
    const cached = await testDb.ownerPool.query<{ age_band: string }>(
      'SELECT age_band FROM users WHERE id = $1',
      [stale.id],
    );
    expect(cached.rows[0]?.age_band).toBe('adult');
    await expectRejected(
      insertMatch(testDb.appPool, { a: stale.id, b: realAdult.id, band: 'adult' }),
      'band',
    );

    // Someone who turned 18 today but is still cached as u18 (the hourly job has not run yet):
    // they can no longer be put into a u18 match.
    const turned18 = await born(18);
    const realKid = await born(17);
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query("UPDATE users SET age_band = 'u18' WHERE id = $1", [turned18.id]),
    );
    await expectRejected(
      insertMatch(testDb.appPool, { a: turned18.id, b: realKid.id, band: 'u18' }),
      'band',
    );
  });

  it('fails across locales', async () => {
    const [ru, en, en2] = [
      await adult(),
      await adult({ locale: 'en' }),
      await adult({ locale: 'en' }),
    ];
    await expectRejected(insertMatch(testDb.appPool, { a: ru.id, b: en.id }), 'locale');
    await expectRejected(
      insertMatch(testDb.appPool, { a: ru.id, b: en.id, locale: 'en' }),
      'locale',
    );
    await expectRejected(
      insertMatch(testDb.appPool, { a: en.id, b: en2.id, locale: 'ru' }),
      'locale',
    );
  });

  it('fails across modes', async () => {
    const [friend, date] = [await adult(), await dater('g.man', ['g.woman'])];
    await expectRejected(insertMatch(testDb.appPool, { a: friend.id, b: date.id }), 'mode');
    await expectRejected(
      insertMatch(testDb.appPool, { a: friend.id, b: date.id, mode: 'dating' }),
      'mode',
    );
  });

  it('fails for u18 users born more than 2 calendar years apart, and allows exactly 2', async () => {
    const [sixteen, fourteen] = [await born(16), await born(14)];
    await insertMatch(testDb.appPool, { a: sixteen.id, b: fourteen.id, band: 'u18' });

    // One day more than two years.
    const dayOlder = await insertActiveUser(testDb.appPool, {
      birthDate: birthDateYearsAgo(16, -1),
    });
    await expectRejected(
      insertMatch(testDb.appPool, { a: dayOlder.id, b: fourteen.id, band: 'u18' }),
      'u18_age_gap',
    );
    // 17 and 14: both u18, three years apart.
    const seventeen = await born(17);
    await expectRejected(
      insertMatch(testDb.appPool, { a: seventeen.id, b: fourteen.id, band: 'u18' }),
      'u18_age_gap',
    );
    // 17 and 15 are fine again.
    await insertMatch(testDb.appPool, { a: seventeen.id, b: (await born(15)).id, band: 'u18' });
  });

  it('never lets u18 users into a dating match', async () => {
    const [k1, k2] = [await kid(), await kid()];
    await expectRejected(
      insertMatch(testDb.appPool, { a: k1.id, b: k2.id, band: 'u18', mode: 'dating' }),
      'mode',
    );
    // The CHECK is a second layer: it holds even with the trigger out of the way.
    await expect(
      withoutTriggers(testDb.ownerPool, (c) =>
        c.query(
          `INSERT INTO matches (id, band, locale, mode, user_a_id, user_b_id, tier, score, teaser, alias_a, alias_b, game_deadline_at)
           VALUES (gen_random_uuid(), 'u18', 'ru', 'dating', $1, $2, 1, 1, '{}', 'a.fox', 'a.owl', now())`,
          [k1.id < k2.id ? k1.id : k2.id, k1.id < k2.id ? k2.id : k1.id],
        ),
      ),
    ).rejects.toMatchObject(CHECK('matches_mode_band'));
  });

  it('fails for a blocked pair, in either direction', async () => {
    const [a, b, c] = [await adult(), await adult(), await adult()];
    await testDb.ownerPool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      a.id,
      b.id,
    ]);
    await testDb.ownerPool.query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2)', [
      c.id,
      a.id,
    ]);
    await expectRejected(insertMatch(testDb.appPool, { a: a.id, b: b.id }), 'blocked');
    await expectRejected(insertMatch(testDb.appPool, { a: a.id, b: c.id }), 'blocked');
    await insertMatch(testDb.appPool, { a: b.id, b: c.id });
  });

  it.each(['frozen', 'deleted', 'waitlisted', 'onboarding'])(
    'fails when a user is %s',
    async (status) => {
      const [ok, other] = [await adult(), await adult({ status })];
      await expectRejected(insertMatch(testDb.appPool, { a: ok.id, b: other.id }), 'not_active');
    },
  );

  it('fails for a user without a birth date (no band: fail closed)', async () => {
    const [ok, unknown] = [await adult(), await insertActiveUser(testDb.appPool, { mode: null })];
    await expectRejected(insertMatch(testDb.appPool, { a: ok.id, b: unknown.id }), 'band');
  });

  it('fails when user_a is not below user_b, and for a user matched with themselves', async () => {
    const [a, b] = [await adult(), await adult()];
    const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await expect(
      insertMatch(testDb.appPool, { a: high, b: low, keepOrder: true }),
    ).rejects.toMatchObject(CHECK('matches_user_order'));
    await expect(
      insertMatch(testDb.appPool, { a: low, b: low, keepOrder: true }),
    ).rejects.toMatchObject(CHECK('matches_user_order'));
  });

  it('fails for a pair that was matched before, even after that match closed (Q9)', async () => {
    const [a, b] = [await adult(), await adult()];
    const first = await insertMatch(testDb.appPool, { a: a.id, b: b.id });
    const DUPLICATE = { code: '23505', constraint: 'matches_pair_unique' };
    await expect(insertMatch(testDb.appPool, { a: a.id, b: b.id })).rejects.toMatchObject(
      DUPLICATE,
    );
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [first.id],
    );
    await expect(insertMatch(testDb.appPool, { a: b.id, b: a.id })).rejects.toMatchObject(
      DUPLICATE,
    );
  });

  it('fails for dating users who are not looking for each other', async () => {
    const man = await dater('g.man', ['g.woman']);
    const woman = await dater('g.woman', ['g.woman']);
    const match = (a: string, b: string) => insertMatch(testDb.appPool, { a, b, mode: 'dating' });
    await expectRejected(match(man.id, woman.id), 'dating_preference');
    const mutual = await dater('g.woman', ['g.man', 'g.woman']);
    await match(man.id, mutual.id);
    await match(woman.id, mutual.id);
  });

  it("fails for dating users outside each other's age range (Q12)", async () => {
    const match = (a: string, b: string) => insertMatch(testDb.appPool, { a, b, mode: 'dating' });
    // 25 years old, looking for 30–40: a 25-year-old who accepts 18–99 is still out of range.
    const picky = await dater('g.man', ['g.woman'], { datingAge: { min: 30, max: 40 } });
    const open = await dater('g.woman', ['g.man']);
    await expectRejected(match(picky.id, open.id), 'dating_age_range');
    // The other direction: she accepts only 18–20, he is 25.
    const narrow = await dater('g.woman', ['g.man'], { datingAge: { min: 18, max: 20 } });
    const man = await dater('g.man', ['g.woman']);
    await expectRejected(match(man.id, narrow.id), 'dating_age_range');
    // Both ends are inclusive.
    const exact = await dater('g.woman', ['g.man'], { datingAge: { min: 25, max: 25 } });
    await match(man.id, exact.id);
  });

  it('fails for a match that does not start as pending_game', async () => {
    const [a, b] = [await adult(), await adult()];
    await expectRejected(
      insertMatch(testDb.appPool, { a: a.id, b: b.id, status: 'active' }),
      'bad_initial_status',
    );
  });

  it('fails for an unknown user', async () => {
    const a = await adult();
    await expectRejected(
      insertMatch(testDb.appPool, { a: a.id, b: '00000000-0000-7000-8000-000000000000' }),
      'unknown_user',
    );
  });
});

describe('an existing match', () => {
  it('cannot be moved to another user, band, locale or mode', async () => {
    const [a, b, k] = [await adult(), await adult(), await kid()];
    const match = await insertMatch(testDb.appPool, { a: a.id, b: b.id });
    // Layer 1: the app role has no privilege on these columns at all.
    const denied = { code: '42501' };
    await expect(
      testDb.appPool.query('UPDATE matches SET user_b_id = $1 WHERE id = $2', [k.id, match.id]),
    ).rejects.toMatchObject(denied);
    await expect(
      testDb.appPool.query("UPDATE matches SET band = 'u18' WHERE id = $1", [match.id]),
    ).rejects.toMatchObject(denied);
    // Layer 2: the trigger refuses it even for the table owner.
    const IMMUTABLE = { code: 'SS011' };
    for (const [column, value] of [
      ['user_a_id', k.id],
      ['user_b_id', k.id],
      ['band', 'u18'],
      ['locale', 'en'],
      ['mode', 'dating'],
      ['alias_a', 'a.otter'],
      ['teaser', '{}'],
    ] as const) {
      await expect(
        testDb.ownerPool.query(`UPDATE matches SET ${column} = $1 WHERE id = $2`, [
          value,
          match.id,
        ]),
      ).rejects.toMatchObject(IMMUTABLE);
    }
  });

  it('can be closed by the app, and then never reopened or re-labelled', async () => {
    const [a, b] = [await adult(), await adult()];
    const match = await insertMatch(testDb.appPool, { a: a.id, b: b.id });
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'band_change', closed_at = now() WHERE id = $1",
      [match.id],
    );
    const CLOSED = { code: 'SS011' };
    await expect(
      testDb.appPool.query(
        "UPDATE matches SET status = 'active', close_reason = NULL, closed_at = NULL WHERE id = $1",
        [match.id],
      ),
    ).rejects.toMatchObject(CLOSED);
    await expect(
      testDb.appPool.query("UPDATE matches SET close_reason = 'left' WHERE id = $1", [match.id]),
    ).rejects.toMatchObject(CLOSED);
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
  });

  it('must have a close reason and time exactly when it is closed or expired', async () => {
    const [a, b] = [await adult(), await adult()];
    const match = await insertMatch(testDb.appPool, { a: a.id, b: b.id });
    await expect(
      testDb.appPool.query("UPDATE matches SET status = 'closed' WHERE id = $1", [match.id]),
    ).rejects.toMatchObject(CHECK('matches_closed_fields'));
    await expect(
      testDb.appPool.query(
        "UPDATE matches SET status = 'expired', close_reason = 'left', closed_at = now() WHERE id = $1",
        [match.id],
      ),
    ).rejects.toMatchObject(CHECK('matches_expired_reason'));
  });
});
