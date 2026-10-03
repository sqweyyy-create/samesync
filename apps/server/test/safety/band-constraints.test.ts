/**
 * SAFETY SUITE — band rules enforced by the DB itself (CLAUDE.md invariants 5, 6 and 10):
 * u18 users are friends-only and never have a stored username, and age_band always follows
 * birth_date no matter what the app writes. Attacks the DB directly as the app role.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { birthDateYearsAgo, insertUser } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const CHECK = (constraint: string) => ({ code: '23514', constraint });
const U18 = () => birthDateYearsAgo(16, 100);
const ADULT = () => birthDateYearsAgo(25);
const row = async (id: string) =>
  (
    await testDb.ownerPool.query<{
      age_band: string | null;
      mode: string | null;
      username: string | null;
      gender: string | null;
    }>('SELECT age_band, mode, username, gender FROM users WHERE id = $1', [id])
  ).rows[0];
const datingAgeOf = async (id: string) =>
  (
    await testDb.ownerPool.query<{ min: number | null; max: number | null }>(
      'SELECT dating_age_min AS min, dating_age_max AS max FROM users WHERE id = $1',
      [id],
    )
  ).rows[0];

describe('u18 users', () => {
  it('cannot be in dating mode (insert or update)', async () => {
    await expect(
      insertUser(testDb.appPool, {
        birthDate: U18(),
        mode: 'dating',
        gender: 'g.man',
        seeking: ['g.woman'],
      }),
    ).rejects.toMatchObject(CHECK('users_mode_band'));
    const { id } = await insertUser(testDb.appPool, { birthDate: U18(), mode: 'friends' });
    await expect(
      testDb.appPool.query(
        "UPDATE users SET mode = 'dating', gender = 'g.man', seeking = ARRAY['g.woman'], dating_age_min = 18, dating_age_max = 25 WHERE id = $1",
        [id],
      ),
    ).rejects.toMatchObject(CHECK('users_mode_band'));
  });

  it('cannot have a username stored', async () => {
    await expect(
      insertUser(testDb.appPool, { birthDate: U18(), username: 'kid_handle' }),
    ).rejects.toMatchObject(CHECK('users_username_adult'));
    const { id } = await insertUser(testDb.appPool, { birthDate: U18() });
    await expect(
      testDb.appPool.query("UPDATE users SET username = 'kid_handle' WHERE id = $1", [id]),
    ).rejects.toMatchObject(CHECK('users_username_adult'));
  });

  it('cannot be relabelled adult by writing age_band directly', async () => {
    const { id } = await insertUser(testDb.appPool, { birthDate: U18() });
    await testDb.appPool.query("UPDATE users SET age_band = 'adult' WHERE id = $1", [id]);
    expect((await row(id))?.age_band).toBe('u18');
    await expect(
      testDb.appPool.query(
        "UPDATE users SET age_band = 'adult', username = 'kid_handle' WHERE id = $1",
        [id],
      ),
    ).rejects.toMatchObject(CHECK('users_username_adult'));
  });

  it('get age_band derived on insert, and none before a birth date exists', async () => {
    const { id: kid } = await insertUser(testDb.appPool, { birthDate: U18() });
    const { id: fresh } = await insertUser(testDb.appPool);
    const { id: young } = await insertUser(testDb.appPool, {
      birthDate: birthDateYearsAgo(13),
      status: 'ineligible',
    });
    expect((await row(kid))?.age_band).toBe('u18');
    expect((await row(fresh))?.age_band).toBeNull();
    expect((await row(young))?.age_band).toBeNull();
  });

  it('cannot get a username before they have a birth date', async () => {
    await expect(insertUser(testDb.appPool, { username: 'someone' })).rejects.toMatchObject(
      CHECK('users_username_adult'),
    );
  });
});

describe('adults', () => {
  it('can be in dating mode with gender and seeking, and store a username', async () => {
    const { id } = await insertUser(testDb.appPool, {
      birthDate: ADULT(),
      mode: 'dating',
      gender: 'g.woman',
      seeking: ['g.man', 'g.woman'],
      username: 'adult_handle',
    });
    expect(await row(id)).toEqual({
      age_band: 'adult',
      mode: 'dating',
      username: 'adult_handle',
      gender: 'g.woman',
    });
  });

  it('need gender and seeking exactly when in dating mode', async () => {
    await expect(
      insertUser(testDb.appPool, { birthDate: ADULT(), mode: 'dating' }),
    ).rejects.toMatchObject(CHECK('users_dating_fields'));
    await expect(
      insertUser(testDb.appPool, {
        birthDate: ADULT(),
        mode: 'friends',
        gender: 'g.man',
        seeking: ['g.woman'],
      }),
    ).rejects.toMatchObject(CHECK('users_dating_fields'));
    await expect(
      insertUser(testDb.appPool, {
        birthDate: ADULT(),
        mode: 'dating',
        gender: 'g.man',
        seeking: [],
      }),
    ).rejects.toMatchObject(CHECK('users_seeking_not_empty'));
  });

  it('have a partner age range exactly when in dating mode, never reaching below 18 (Q12)', async () => {
    const dating = { birthDate: ADULT(), mode: 'dating', gender: 'g.man', seeking: ['g.woman'] };
    const RANGE = CHECK('users_dating_age_range');
    for (const datingAge of [
      { min: null, max: null },
      { min: 20, max: null },
      { min: 17, max: 30 },
      { min: 30, max: 25 },
      { min: 18, max: 121 },
    ]) {
      await expect(
        insertUser(testDb.appPool, { ...dating, datingAge } as never),
      ).rejects.toMatchObject(RANGE);
    }
    await expect(
      insertUser(testDb.appPool, {
        birthDate: ADULT(),
        mode: 'friends',
        datingAge: { min: 18, max: 30 },
      }),
    ).rejects.toMatchObject(RANGE);
    const { id } = await insertUser(testDb.appPool, {
      ...dating,
      datingAge: { min: 18, max: 18 },
    } as never);
    expect(await datingAgeOf(id)).toEqual({ min: 18, max: 18 });
  });

  it('can only reference existing dating options', async () => {
    await expect(
      insertUser(testDb.appPool, {
        birthDate: ADULT(),
        mode: 'dating',
        gender: 'g.unknown',
        seeking: ['g.man'],
      }),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('admin correction to u18', () => {
  it('nulls the username and drops dating mode and fields', async () => {
    const { id } = await insertUser(testDb.appPool, {
      birthDate: ADULT(),
      mode: 'dating',
      gender: 'g.man',
      seeking: ['g.woman'],
      username: 'was_adult',
    });
    await testDb.ownerPool.query(
      "SELECT admin_set_birth_date($1, $2::date, 42, 'age correction')",
      [id, U18()],
    );
    expect(await row(id)).toEqual({
      age_band: 'u18',
      mode: 'friends',
      username: null,
      gender: null,
    });
    expect(await datingAgeOf(id)).toEqual({ min: null, max: null });
  });
});

describe('ineligible users (under 14)', () => {
  it('cannot hold profile data', async () => {
    await expect(
      insertUser(testDb.appPool, {
        birthDate: birthDateYearsAgo(12),
        status: 'ineligible',
        mode: 'friends',
      }),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
