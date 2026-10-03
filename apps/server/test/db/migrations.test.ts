import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MIGRATIONS_DIR, runMigrations } from '../../src/db/migrate';
import { APP_ROLE, appRolePool, createEmptyDatabase } from '../support/db';
import { birthDateYearsAgo } from '../support/users';

async function journalEntries(): Promise<number> {
  const journal = JSON.parse(await readFile(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

/** A copy of the migrations folder that stops after `count` migrations. */
async function migrationsUpTo(count: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'samesync-migrations-'));
  await cp(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, count);
  await writeFile(journalPath, JSON.stringify(journal));
  return dir;
}

describe('upgrading a Phase 1 database (migration 0004)', () => {
  let db: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let owner: pg.Pool;
  let phase1: string;

  beforeAll(async () => {
    db = await createEmptyDatabase();
    owner = new pg.Pool({ connectionString: db.url, max: 1 });
    phase1 = await migrationsUpTo(4);
  });
  afterAll(async () => {
    await owner.end();
    await db.drop();
    await rm(phase1, { recursive: true, force: true });
  });

  it('gives existing dating users the default partner age range (Q12) and keeps everyone else', async () => {
    await runMigrations(db.url, phase1);
    await owner.query(
      "INSERT INTO dating_options (id, revision, added_in) VALUES ('g.man', 1, 'x'), ('g.woman', 1, 'x')",
    );
    const insert = (telegramId: number, years: number, mode: string | null) =>
      owner.query(
        `INSERT INTO users (id, telegram_id, public_id, locale, status, birth_date, mode, gender, seeking, last_active_at)
         VALUES (gen_random_uuid(), $1, $2, 'ru', 'active', $3, $4, $5, $6, now())`,
        [
          telegramId,
          String(telegramId).padStart(10, '0'),
          birthDateYearsAgo(years),
          mode,
          mode === 'dating' ? 'g.woman' : null,
          mode === 'dating' ? ['g.man'] : null,
        ],
      );
    await insert(1, 26, 'dating');
    await insert(2, 19, 'dating');
    await insert(3, 30, 'friends');
    await insert(4, 16, 'friends');

    await runMigrations(db.url);

    const { rows } = await owner.query(
      'SELECT telegram_id::int AS id, dating_age_min AS min, dating_age_max AS max, synthetic FROM users ORDER BY telegram_id',
    );
    expect(rows).toEqual([
      { id: 1, min: 21, max: 31, synthetic: false },
      { id: 2, min: 18, max: 24, synthetic: false },
      { id: 3, min: null, max: null, synthetic: false },
      { id: 4, min: null, max: null, synthetic: false },
    ]);
  });
});

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
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'admin_actions',
      'answers',
      'blocks',
      'content_releases',
      'dating_options',
      'feature_stats',
      'games',
      'interest_categories',
      'interest_items',
      'match_runs',
      'matches',
      'outbox',
      'questions',
      'user_interests',
      'users',
    ]);
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

    it('can only read the content tables (seeding runs as the owner)', async () => {
      const keyColumn: Record<string, string> = {
        content_releases: 'version',
        questions: 'id',
        interest_categories: 'id',
        interest_items: 'id',
        dating_options: 'id',
      };
      for (const [table, key] of Object.entries(keyColumn)) {
        await app.query(`SELECT 1 FROM ${table} LIMIT 1`);
        await expectDenied(`DELETE FROM ${table}`);
        await expectDenied(`UPDATE ${table} SET ${key} = ${key}`);
      }
      await expectDenied(
        "INSERT INTO content_releases (version, checksum) VALUES ('2099.01.1', 'x')",
      );
    });

    it('can write answers but not delete them; can add and remove interests', async () => {
      await app.query('SELECT 1 FROM answers');
      await expectDenied('DELETE FROM answers');
      await app.query('DELETE FROM user_interests WHERE false');
      await expectDenied('UPDATE user_interests SET item_id = item_id');
    });

    it('can only append to admin_actions', async () => {
      await app.query(
        "INSERT INTO admin_actions (admin_telegram_id, action, reason) VALUES (1, 'test', 'test')",
      );
      await expectDenied('SELECT * FROM admin_actions');
      await expectDenied("UPDATE admin_actions SET reason = 'x'");
      await expectDenied('DELETE FROM admin_actions');
    });

    it('can create matches and change their lifecycle columns only, and never delete them', async () => {
      await app.query('SELECT 1 FROM matches');
      await app.query("UPDATE matches SET status = 'active' WHERE false");
      await expectDenied('UPDATE matches SET user_b_id = user_b_id');
      await expectDenied("UPDATE matches SET band = 'adult'");
      await expectDenied("UPDATE matches SET teaser = '{}'");
      await expectDenied('DELETE FROM matches');
      await expectDenied('TRUNCATE matches CASCADE');
      await expectDenied('ALTER TABLE matches DISABLE TRIGGER matches_10_guard_insert');
      await expectDenied('ALTER TABLE users DISABLE TRIGGER users_90_close_matches');
    });

    it('can write runs, the outbox and game shells, but not delete them', async () => {
      for (const table of ['match_runs', 'outbox', 'games']) {
        await app.query(`SELECT 1 FROM ${table}`);
        await expectDenied(`DELETE FROM ${table}`);
      }
      await app.query("UPDATE outbox SET status = 'pending' WHERE false");
      await app.query('UPDATE match_runs SET pairs_created = 0 WHERE false');
      await expectDenied('UPDATE games SET created_at = now()');
    });

    it('can only read blocks (they are written from Phase 5)', async () => {
      await app.query('SELECT 1 FROM blocks');
      await expectDenied(
        'INSERT INTO blocks (blocker_id, blocked_id) VALUES (gen_random_uuid(), gen_random_uuid())',
      );
      await expectDenied('DELETE FROM blocks');
    });

    it('can replace the derived feature statistics', async () => {
      await app.query(
        "INSERT INTO feature_stats (band, locale, feature_key, n_users, pool_size, weight, computed_at) VALUES ('adult', 'ru', 'i:test', 1, 2, 0.5, now())",
      );
      await app.query("DELETE FROM feature_stats WHERE band = 'adult' AND locale = 'ru'");
      await expectDenied('UPDATE feature_stats SET weight = 0');
    });

    it('cannot call the trigger functions or the admin function directly', async () => {
      await expectDenied('SELECT matches_guard_insert()');
      await expectDenied('SELECT users_close_matches_on_state_change()');
    });

    it('cannot read the migrations journal', async () => {
      await expectDenied('select * from drizzle.__drizzle_migrations');
    });
  });
});
