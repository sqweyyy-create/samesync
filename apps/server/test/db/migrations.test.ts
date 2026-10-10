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

describe('upgrading a Phase 2 database (migration 0006)', () => {
  let db: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let owner: pg.Pool;
  let phase2: string;

  beforeAll(async () => {
    db = await createEmptyDatabase();
    owner = new pg.Pool({ connectionString: db.url, max: 1 });
    phase2 = await migrationsUpTo(6);
  });
  afterAll(async () => {
    await owner.end();
    await db.drop();
    await rm(phase2, { recursive: true, force: true });
  });

  it('closes the open matches that only have a game shell, drops their unsent notifications, and keeps the rest', async () => {
    await runMigrations(db.url, phase2);
    const user = async (telegramId: number) =>
      (
        await owner.query<{ id: string }>(
          `INSERT INTO users (id, telegram_id, public_id, locale, status, birth_date, mode, last_active_at)
           VALUES (gen_random_uuid(), $1, $2, 'ru', 'active', $3, 'friends', now()) RETURNING id`,
          [telegramId, String(telegramId).padStart(10, '0'), birthDateYearsAgo(25)],
        )
      ).rows[0]!.id;
    const match = async (first: string, second: string) => {
      const [a, b] = first < second ? [first, second] : [second, first];
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO matches (id, band, locale, mode, user_a_id, user_b_id, tier, score, teaser,
           alias_a, alias_b, game_deadline_at)
         VALUES (gen_random_uuid(), 'adult', 'ru', 'friends', $1, $2, 1, 1, '{}', 'a.fox', 'a.owl',
           now() + interval '48 hours') RETURNING id`,
        [a, b],
      );
      const id = rows[0]!.id;
      await owner.query('INSERT INTO games (match_id) VALUES ($1)', [id]);
      for (const userId of [a, b]) {
        await owner.query(
          `INSERT INTO outbox (id, user_id, kind, match_id, dedupe_key)
           VALUES (gen_random_uuid(), $1, 'match_created', $2, $3)`,
          [userId, id, `match_created:${id}:${userId}`],
        );
      }
      return id;
    };
    const [u1, u2, u3] = [await user(1), await user(2), await user(3)];
    const open = await match(u1, u2);
    const left = await match(u1, u3);
    await owner.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [left],
    );
    await owner.query(
      "UPDATE outbox SET status = 'sent', sent_at = now() WHERE match_id = $1 AND user_id = $2",
      [open, u1],
    );

    await runMigrations(db.url);

    const matches = await owner.query(
      'SELECT id, status, close_reason, closed_at IS NOT NULL AS closed FROM matches ORDER BY id',
    );
    expect(matches.rows).toEqual(
      [
        { id: open, status: 'closed', close_reason: 'admin', closed: true },
        { id: left, status: 'closed', close_reason: 'left', closed: true },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    // The shells are gone; a row of "games" now always has its questions.
    expect((await owner.query('SELECT 1 FROM games')).rowCount).toBe(0);
    const outbox = await owner.query(
      'SELECT match_id, user_id, status::text AS status, cancel_reason FROM outbox ORDER BY match_id, user_id',
    );
    const expected = [
      // Already sent: untouched. Still pending for the open match: cancelled.
      { match_id: open, user_id: u1, status: 'sent', cancel_reason: null },
      { match_id: open, user_id: u2, status: 'cancelled', cancel_reason: 'admin' },
      // A match that was closed before keeps what it had.
      { match_id: left, user_id: u1, status: 'pending', cancel_reason: null },
      { match_id: left, user_id: u3, status: 'pending', cancel_reason: null },
    ];
    const byKey = (x: { match_id: string; user_id: string }) => `${x.match_id}:${x.user_id}`;
    expect(outbox.rows).toEqual(expected.sort((x, y) => (byKey(x) < byKey(y) ? -1 : 1)));
    // A bare shell can no longer be inserted: a game needs its questions.
    await expect(
      owner.query('INSERT INTO games (match_id) VALUES ($1)', [open]),
    ).rejects.toMatchObject({ code: '23502' });
  });
});

describe('upgrading a Phase 3 database (migration 0009)', () => {
  let db: Awaited<ReturnType<typeof createEmptyDatabase>>;
  let owner: pg.Pool;
  let phase3: string;

  beforeAll(async () => {
    db = await createEmptyDatabase();
    owner = new pg.Pool({ connectionString: db.url, max: 1 });
    phase3 = await migrationsUpTo(9);
  });
  afterAll(async () => {
    await owner.end();
    await db.drop();
    await rm(phase3, { recursive: true, force: true });
  });

  it('closes a match that claims to be active without a chat, and keeps every other match', async () => {
    await runMigrations(db.url, phase3);
    const user = async (telegramId: number) =>
      (
        await owner.query<{ id: string }>(
          `INSERT INTO users (id, telegram_id, public_id, locale, status, birth_date, mode, last_active_at)
           VALUES (gen_random_uuid(), $1, $2, 'ru', 'active', $3, 'friends', now()) RETURNING id`,
          [telegramId, String(telegramId).padStart(10, '0'), birthDateYearsAgo(25)],
        )
      ).rows[0]!.id;
    // Before the chat existed nothing guarded the status, so a plain UPDATE could set anything.
    const match = async (first: string, second: string, status: string) => {
      const [a, b] = first < second ? [first, second] : [second, first];
      const { rows } = await owner.query<{ id: string }>(
        `INSERT INTO matches (id, band, locale, mode, user_a_id, user_b_id, tier, score, teaser,
           alias_a, alias_b, game_deadline_at)
         VALUES (gen_random_uuid(), 'adult', 'ru', 'friends', $1, $2, 1, 1, '{}', 'a.fox', 'a.owl',
           now() + interval '48 hours') RETURNING id`,
        [a, b],
      );
      const id = rows[0]!.id;
      await owner.query('ALTER TABLE matches DISABLE TRIGGER matches_20_guard_game_status');
      await owner.query(
        `UPDATE matches SET status = $2, results_ready_at = now(),
           chat_deadline_at = now() + interval '48 hours' WHERE id = $1`,
        [id, status],
      );
      await owner.query('ALTER TABLE matches ENABLE TRIGGER matches_20_guard_game_status');
      await owner.query(
        `INSERT INTO outbox (id, user_id, kind, match_id, dedupe_key)
         VALUES (gen_random_uuid(), $1, 'game_results', $2, $3)`,
        [a, id, `game_results:${id}:${a}`],
      );
      return id;
    };
    const [u1, u2, u3] = [await user(1), await user(2), await user(3)];
    const active = await match(u1, u2, 'active');
    const ready = await match(u1, u3, 'results_ready');

    await runMigrations(db.url);

    const matches = await owner.query(
      'SELECT id, status::text AS status, close_reason::text AS close_reason FROM matches ORDER BY id',
    );
    expect(matches.rows).toEqual(
      [
        { id: active, status: 'closed', close_reason: 'admin' },
        { id: ready, status: 'results_ready', close_reason: null },
      ].sort((x, y) => (x.id < y.id ? -1 : 1)),
    );
    const outbox = await owner.query(
      'SELECT match_id, status::text AS status, cancel_reason FROM outbox ORDER BY match_id',
    );
    expect(outbox.rows).toEqual(
      [
        { match_id: active, status: 'cancelled', cancel_reason: 'admin' },
        { match_id: ready, status: 'pending', cancel_reason: null },
      ].sort((x, y) => (x.match_id < y.match_id ? -1 : 1)),
    );
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
      'game_predictions',
      'games',
      'interest_categories',
      'interest_items',
      'match_runs',
      'matches',
      'messages',
      'outbox',
      'questions',
      'reveal_consents',
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

    it('can write runs, the outbox and games, but not delete them', async () => {
      for (const table of ['match_runs', 'outbox', 'games']) {
        await app.query(`SELECT 1 FROM ${table}`);
        await expectDenied(`DELETE FROM ${table}`);
      }
      await app.query("UPDATE outbox SET status = 'pending' WHERE false");
      await app.query('UPDATE match_runs SET pairs_created = 0 WHERE false');
      await expectDenied('UPDATE games SET created_at = now()');
    });

    it('can mark a player of a game finished, and change nothing else of the game', async () => {
      await app.query('UPDATE games SET a_done_at = now(), b_done_at = now() WHERE false');
      // Locking a game row (the app does it while predictions are submitted) needs that grant.
      await app.query('SELECT match_id FROM games FOR UPDATE');
      await expectDenied("UPDATE games SET question_ids = '{}'");
      await expectDenied("UPDATE games SET closing_question_id = 'q.x'");
      await expectDenied("UPDATE games SET answers_a = '{}', answers_b = '{}'");
      await expectDenied('ALTER TABLE games DISABLE TRIGGER games_10_guard_update');
    });

    it('can add predictions and read them, and never change or delete one', async () => {
      await app.query('SELECT 1 FROM game_predictions');
      await app.query(
        "INSERT INTO game_predictions (match_id, predictor_id, question_id, predicted) SELECT gen_random_uuid(), gen_random_uuid(), 'q.x', 'agree' WHERE false",
      );
      await expectDenied("UPDATE game_predictions SET predicted = 'agree'");
      await expectDenied('DELETE FROM game_predictions');
      await expectDenied('TRUNCATE game_predictions');
      await expectDenied(
        'ALTER TABLE game_predictions DISABLE TRIGGER game_predictions_10_guard_insert',
      );
      await expectDenied('ALTER TABLE matches DISABLE TRIGGER matches_20_guard_game_status');
    });

    it('can store a message and record its delivery, and never rewrite or delete one', async () => {
      await app.query('SELECT 1 FROM messages');
      await app.query(
        "INSERT INTO messages (id, match_id, sender_id, body, verdict, purge_after) SELECT gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'x', 'delivered', now() WHERE false",
      );
      await app.query(
        "UPDATE messages SET body = NULL, verdict = 'rejected', reason = 'x', sender_tg_message_id = 1, recipient_tg_message_id = 1, delivered_at = now() WHERE false",
      );
      await expectDenied('UPDATE messages SET match_id = match_id');
      await expectDenied('UPDATE messages SET sender_id = sender_id');
      await expectDenied('UPDATE messages SET created_at = now()');
      await expectDenied('UPDATE messages SET purge_after = now()');
      await expectDenied('DELETE FROM messages');
      await expectDenied('TRUNCATE messages');
      await expectDenied('ALTER TABLE messages DISABLE TRIGGER messages_10_guard_insert');
      await expectDenied('ALTER TABLE messages DISABLE TRIGGER messages_10_guard_update');
      await expectDenied('ALTER TABLE matches DISABLE TRIGGER matches_30_guard_chat_status');
    });

    it('can record a consent to reveal, mark it revealed or withdraw it, and nothing else', async () => {
      await app.query('SELECT 1 FROM reveal_consents');
      await app.query(
        'INSERT INTO reveal_consents (match_id, user_id, consented_at) SELECT gen_random_uuid(), gen_random_uuid(), now() WHERE false',
      );
      await app.query('UPDATE reveal_consents SET revealed_at = now() WHERE false');
      // A withdrawal is a delete; the trigger limits it to a consent that was not revealed.
      await app.query('DELETE FROM reveal_consents WHERE false');
      await expectDenied('UPDATE reveal_consents SET consented_at = now()');
      await expectDenied('UPDATE reveal_consents SET user_id = user_id');
      await expectDenied('TRUNCATE reveal_consents');
      await expectDenied(
        'ALTER TABLE reveal_consents DISABLE TRIGGER reveal_consents_10_guard_insert',
      );
      await expectDenied(
        'ALTER TABLE reveal_consents DISABLE TRIGGER reveal_consents_10_guard_update',
      );
      await expectDenied(
        'ALTER TABLE reveal_consents DISABLE TRIGGER reveal_consents_10_guard_delete',
      );
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
      await expectDenied('SELECT game_predictions_guard_insert()');
      await expectDenied('SELECT games_guard_update()');
      await expectDenied('SELECT matches_guard_game_status()');
      await expectDenied('SELECT messages_guard_insert()');
      await expectDenied('SELECT messages_guard_update()');
      await expectDenied('SELECT reveal_consents_guard_insert()');
      await expectDenied('SELECT reveal_consents_guard_update()');
      await expectDenied('SELECT reveal_consents_guard_delete()');
      await expectDenied('SELECT matches_guard_chat_status()');
    });

    it('cannot read the migrations journal', async () => {
      await expectDenied('select * from drizzle.__drizzle_migrations');
    });
  });
});
