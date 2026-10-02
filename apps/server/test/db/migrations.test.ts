import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate';
import { APP_ROLE, appRolePool, createEmptyDatabase } from '../support/db';

async function journalEntries(): Promise<number> {
  const journal = JSON.parse(await readFile(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

describe('migrations', () => {
  let db: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let owner: pg.Pool;
  let app: pg.Pool;

  beforeAll(async () => {
    db = await createEmptyDatabase();
    owner = new pg.Pool({ connectionString: db.url, max: 1 });
  });
  afterAll(async () => {
    await Promise.all([owner.end(), app?.end()]);
    await db.drop();
  });

  const appliedCount = async () =>
    Number(
      (await owner.query<{ n: string }>('select count(*) as n from drizzle.__drizzle_migrations'))
        .rows[0]?.n,
    );

  it('apply to an empty database', async () => {
    await runMigrations(db.url);
    expect(await appliedCount()).toBe(await journalEntries());
    const tables = await owner.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['users']);
  });

  it('are a no-op when re-run', async () => {
    const before = await appliedCount();
    await runMigrations(db.url);
    expect(await appliedCount()).toBe(before);
  });

  describe(`the ${APP_ROLE} role`, () => {
    beforeAll(() => {
      app = appRolePool(db.url);
    });

    const expectDenied = (sql: string) =>
      expect(app.query(sql)).rejects.toMatchObject({ code: '42501' });

    it('is the role the app pool runs as, and is not a superuser', async () => {
      const { rows } = await app.query<{ current_user: string; rolsuper: boolean }>(
        'select current_user, (select rolsuper from pg_roles where rolname = current_user)',
      );
      expect(rows[0]).toEqual({ current_user: APP_ROLE, rolsuper: false });
    });

    it('can read and write users', async () => {
      await app.query(
        "insert into users (id, telegram_id, public_id, locale, last_active_at) values (gen_random_uuid(), 1, '0123456789', 'ru', now())",
      );
      await app.query('update users set last_active_at = now() where telegram_id = 1');
      expect((await app.query('select 1 from users')).rowCount).toBe(1);
    });

    it('cannot ALTER, DROP or DELETE (it does not own the tables)', async () => {
      await expectDenied('alter table users add column evil int');
      await expectDenied('alter table users disable trigger all');
      await expectDenied('drop table users');
      await expectDenied('delete from users');
    });

    it('cannot create objects in the public schema', async () => {
      await expectDenied('create table evil (id int)');
    });

    it('cannot bypass triggers with session_replication_role', async () => {
      await expectDenied('set session_replication_role = replica');
    });

    it('cannot read the migrations journal', async () => {
      await expectDenied('select * from drizzle.__drizzle_migrations');
    });
  });
});
