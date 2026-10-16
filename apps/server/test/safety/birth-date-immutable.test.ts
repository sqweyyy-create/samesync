/**
 * SAFETY SUITE — birth_date is write-once (CLAUDE.md invariant 7). Only admin_set_birth_date(),
 * with a reason and an audit row, can change it. These tests attack the DB directly.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomInt } from 'node:crypto';
import { buildTestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { birthDateYearsAgo, insertUser } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const birthDateOf = async (id: string) =>
  (
    await testDb.ownerPool.query<{ b: string | null }>(
      'SELECT birth_date::text AS b FROM users WHERE id = $1',
      [id],
    )
  ).rows[0]?.b;
const WRITE_ONCE = { code: 'SS001' };

describe('as the app role', () => {
  it('can set the birth date once, from NULL', async () => {
    const { id } = await insertUser(testDb.appPool);
    const date = birthDateYearsAgo(20);
    await testDb.appPool.query('UPDATE users SET birth_date = $1 WHERE id = $2', [date, id]);
    expect(await birthDateOf(id)).toBe(date);
  });

  it('cannot change it, clear it, or bypass the trigger with the override flag', async () => {
    const original = birthDateYearsAgo(20);
    const { id } = await insertUser(testDb.appPool, { birthDate: original });
    await expect(
      testDb.appPool.query('UPDATE users SET birth_date = $1 WHERE id = $2', [
        birthDateYearsAgo(15),
        id,
      ]),
    ).rejects.toMatchObject(WRITE_ONCE);
    await expect(
      testDb.appPool.query('UPDATE users SET birth_date = NULL WHERE id = $1', [id]),
    ).rejects.toMatchObject(WRITE_ONCE);
    const client = await testDb.appPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('samesync.birth_date_override', 'on', true)");
      await expect(
        client.query('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(15), id]),
      ).rejects.toMatchObject(WRITE_ONCE);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await birthDateOf(id)).toBe(original);
  });

  it('allows rewriting the same value (not a change)', async () => {
    const date = birthDateYearsAgo(22);
    const { id } = await insertUser(testDb.appPool, { birthDate: date });
    await testDb.appPool.query('UPDATE users SET birth_date = $1 WHERE id = $2', [date, id]);
    expect(await birthDateOf(id)).toBe(date);
  });

  it('can call admin_set_birth_date() (the deliberate grant of Phase 5), which still needs an admin and a reason and audits', async () => {
    const { id } = await insertUser(testDb.appPool, { birthDate: birthDateYearsAgo(20) });
    const date = birthDateYearsAgo(25);
    // The bot checks the admin allowlist before it gets here; the function checks the rest.
    await expect(
      testDb.appPool.query('SELECT admin_set_birth_date($1, $2::date, 1, $3)', [id, date, '']),
    ).rejects.toMatchObject({ code: 'SS002' });
    await expect(
      testDb.appPool.query('SELECT admin_set_birth_date($1, $2::date, 0, $3)', [id, date, 'r']),
    ).rejects.toMatchObject({ code: 'SS002' });
    await testDb.appPool.query('SELECT admin_set_birth_date($1, $2::date, 1, $3)', [
      id,
      date,
      'checked by an admin',
    ]);
    expect(await birthDateOf(id)).toBe(date);
    const { rows } = await testDb.ownerPool.query(
      'SELECT action, admin_telegram_id::int AS admin, reason FROM admin_actions WHERE target_user_id = $1',
      [id],
    );
    expect(rows).toEqual([{ action: 'set_birth_date', admin: 1, reason: 'checked by an admin' }]);
  });

  it('cannot disable the trigger', async () => {
    await expect(
      testDb.appPool.query('ALTER TABLE users DISABLE TRIGGER users_10_birth_date_write_once'),
    ).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('as the owner', () => {
  it('cannot change it with a direct UPDATE either', async () => {
    const { id } = await insertUser(testDb.appPool, { birthDate: birthDateYearsAgo(20) });
    await expect(
      testDb.ownerPool.query('UPDATE users SET birth_date = $1 WHERE id = $2', [
        birthDateYearsAgo(25),
        id,
      ]),
    ).rejects.toMatchObject(WRITE_ONCE);
  });
});

describe('admin_set_birth_date()', () => {
  const callAdmin = (id: string, date: string, reason: string | null, admin = 777) =>
    testDb.ownerPool.query('SELECT admin_set_birth_date($1, $2::date, $3, $4)', [
      id,
      date,
      admin,
      reason,
    ]);

  it('changes the birth date and writes an audit row with before, after and the reason', async () => {
    const before = birthDateYearsAgo(20);
    const after = birthDateYearsAgo(21);
    const { id } = await insertUser(testDb.appPool, { birthDate: before });
    await callAdmin(id, after, 'typo reported via /support');
    expect(await birthDateOf(id)).toBe(after);
    const { rows } = await testDb.ownerPool.query<{
      admin_telegram_id: string;
      action: string;
      reason: string;
      before: { birth_date: string };
      after: { birth_date: string };
    }>('SELECT * FROM admin_actions WHERE target_user_id = $1', [id]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      admin_telegram_id: '777',
      action: 'set_birth_date',
      reason: 'typo reported via /support',
      before: { birth_date: before },
      after: { birth_date: after },
    });
  });

  it.each([[null], [''], ['   ']])(
    'fails without a reason (%j) and changes nothing',
    async (reason) => {
      const original = birthDateYearsAgo(20);
      const { id } = await insertUser(testDb.appPool, { birthDate: original });
      await expect(callAdmin(id, birthDateYearsAgo(25), reason)).rejects.toMatchObject({
        code: 'SS002',
      });
      expect(await birthDateOf(id)).toBe(original);
      const { rowCount } = await testDb.ownerPool.query(
        'SELECT 1 FROM admin_actions WHERE target_user_id = $1',
        [id],
      );
      expect(rowCount).toBe(0);
    },
  );

  it('rejects future and implausible dates and an unknown user', async () => {
    const { id } = await insertUser(testDb.appPool, { birthDate: birthDateYearsAgo(20) });
    await expect(callAdmin(id, birthDateYearsAgo(0, 1), 'r')).rejects.toMatchObject({
      code: 'SS002',
    });
    await expect(callAdmin(id, '1890-01-01', 'r')).rejects.toMatchObject({ code: 'SS002' });
    await expect(
      callAdmin('00000000-0000-7000-8000-000000000000', birthDateYearsAgo(20), 'r'),
    ).rejects.toMatchObject({
      code: 'SS003',
    });
  });

  it('moves a user to ineligible and removes their profile when the corrected age is under 14', async () => {
    const { id } = await insertUser(testDb.appPool, {
      birthDate: birthDateYearsAgo(15),
      mode: 'friends',
    });
    await testDb.ownerPool.query(
      "INSERT INTO answers (user_id, question_id, value, content_release, answered_at) SELECT $1, id, 'agree', (SELECT version FROM content_releases LIMIT 1), now() FROM questions LIMIT 3",
      [id],
    );
    await callAdmin(id, birthDateYearsAgo(12), 'parent reported the real age');
    const { rows } = await testDb.ownerPool.query<{
      status: string;
      mode: string | null;
      age_band: string | null;
    }>('SELECT status, mode, age_band FROM users WHERE id = $1', [id]);
    expect(rows[0]).toEqual({ status: 'ineligible', mode: null, age_band: null });
    const { rowCount } = await testDb.ownerPool.query('SELECT 1 FROM answers WHERE user_id = $1', [
      id,
    ]);
    expect(rowCount).toBe(0);
  });
});

describe('through the API', () => {
  it('a second submission gets 409 and leaves the first date in place', async () => {
    const t = await buildTestApp(testDb);
    const as = t.as({ id: randomInt(1, 2 ** 40), first_name: 'Test', language_code: 'ru' });
    expect((await as.post('/api/onboarding/locale', { locale: 'ru' })).status).toBe(200);
    const first = birthDateYearsAgo(20, 10);
    expect((await as.post('/api/onboarding/birth-date', { birthDate: first })).status).toBe(200);
    const again = await as.post('/api/onboarding/birth-date', { birthDate: birthDateYearsAgo(30) });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: 'conflict' });
    const me = (await (await as.get('/api/me')).json()) as { birthDate: string };
    expect(me.birthDate).toBe(first);
  });
});
