/**
 * `pnpm dev:scenario` on a real database, with a fake Bot API: each scenario builds its state
 * through the real services, touches only the developer's matches and synthetic users, sends
 * nothing to a synthetic user, starts over cleanly when it runs again, prints a checklist in the
 * developer's language, and refuses to run in production.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ScenarioError,
  SCENARIOS,
  SCENARIO_NAMES,
  findDeveloper,
  reset,
  type Developer,
  type ScenarioDeps,
} from '../../scripts/lib/scenarios';
import { realContent } from '../support/app';
import { insertChat } from '../support/chat';
import { APP_ROLE, createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_MINIAPP_URL, memoryLogger } from '../support/fixtures';
import { insertGame } from '../support/games';
import { insertMatch, insertOutbox } from '../support/matches';
import {
  answersFor,
  insertPerson,
  itemsOf,
  realScope,
  type PersonInput,
} from '../support/population';
import { fakeTelegram, type FakeTelegram } from '../support/telegram';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
let pool: pg.Pool;
beforeEach(async () => {
  testDb = await createTestDatabase();
  // The CLI's pool: the app role, with room for the locks a scenario holds while it works.
  pool = new pg.Pool({ connectionString: testDb.ownerUrl, max: 8, options: `-c role=${APP_ROLE}` });
});
afterEach(async () => {
  await pool.end();
  await testDb.drop();
});

/** A real user with a profile in the adult ru friends pool, unless told otherwise. */
async function realPerson(over: PersonInput = {}, scopeOver: Parameters<typeof realScope>[0] = {}) {
  const scope = await realScope(scopeOver);
  const person = await insertPerson(testDb.appPool, {
    items: [...itemsOf(scope, 'niche').slice(0, 2), ...itemsOf(scope, 'mainstream').slice(0, 4)],
    answers: answersFor(scope, 'ADADADADADADADADADADADADADADAD'),
    ...(scopeOver.locale ? { locale: scopeOver.locale } : {}),
    ...over,
  });
  const { rows } = await testDb.ownerPool.query<{ public_id: string }>(
    'SELECT public_id FROM users WHERE id = $1',
    [person.id],
  );
  return { ...person, publicId: rows[0]!.public_id };
}

async function setup(options: { username?: string | null } = {}) {
  const person = await realPerson();
  const telegram = fakeTelegram();
  if (options.username !== null) {
    telegram.usernames.set(person.telegramId, options.username ?? 'dev_real_user');
  }
  const deps: ScenarioDeps = {
    db: pool,
    content: await realContent(),
    api: telegram.bot.api,
    miniAppUrl: TEST_MINIAPP_URL,
    fallbackTimeZone: { ru: 'Europe/Moscow', en: 'UTC' },
    u18PoolEnabled: false,
    syntheticUsername: 'synthetic_user',
    logger: memoryLogger().logger,
    sleep: () => Promise.resolve(),
    poolSize: 20,
    pacing: { spacingMs: 0, perChatMs: 0 },
  };
  const dev = await findDeveloper(pool, person.publicId);
  return { person, telegram, deps, dev };
}

/** Everything the bot sent, and to whom: never to anyone but the developer. */
function sent(telegram: FakeTelegram, dev: Developer): string[] {
  const calls = telegram.of('sendMessage');
  expect(calls.map((c) => c.payload['chat_id'])).toEqual(calls.map(() => dev.telegramId));
  expect(telegram.of('getChat').every((c) => c.payload['chat_id'] === dev.telegramId)).toBe(true);
  return calls.map((c) => String(c.payload['text']));
}

const count = (texts: string[], pattern: RegExp) => texts.filter((t) => pattern.test(t)).length;

async function matchesOf(userId: string) {
  const { rows } = await testDb.ownerPool.query<{
    id: string;
    status: string;
    close_reason: string | null;
  }>(
    `SELECT id, status::text AS status, close_reason::text AS close_reason FROM matches
     WHERE user_a_id = $1 OR user_b_id = $1 ORDER BY created_at, id`,
    [userId],
  );
  return rows;
}
const open = (rows: Array<{ status: string }>) =>
  rows.filter((r) => ['pending_game', 'results_ready', 'active'].includes(r.status));

async function profileOf(userId: string) {
  const { rows } = await testDb.ownerPool.query<Record<string, unknown>>(
    `SELECT birth_date::text, locale::text, status::text, mode::text, synthetic, public_id,
       (SELECT count(*)::int FROM answers WHERE user_id = u.id) AS answers,
       (SELECT count(*)::int FROM user_interests WHERE user_id = u.id) AS interests
     FROM users u WHERE id = $1`,
    [userId],
  );
  return rows[0];
}

describe('the developer', () => {
  it('defaults to the only real user, and a support code picks one', async () => {
    await expect(findDeveloper(pool)).rejects.toThrow(/no real user yet/);
    const first = await realPerson();
    expect(await findDeveloper(pool)).toMatchObject({ id: first.id, publicId: first.publicId });
    // Synthetic users don't count.
    await insertPerson(testDb.appPool, { synthetic: true });
    expect((await findDeveloper(pool)).id).toBe(first.id);

    const second = await realPerson({}, { locale: 'en' });
    await expect(findDeveloper(pool)).rejects.toThrow(
      new RegExp(`several real users.*${first.publicId}.*${second.publicId}`),
    );
    expect((await findDeveloper(pool, second.publicId.toLowerCase())).id).toBe(second.id);
  });

  it('refuses a synthetic user, an unknown code and something that is not a code', async () => {
    const synthetic = await insertPerson(testDb.appPool, { synthetic: true });
    const { rows } = await testDb.ownerPool.query<{ public_id: string }>(
      'SELECT public_id FROM users WHERE id = $1',
      [synthetic.id],
    );
    await expect(findDeveloper(pool, rows[0]!.public_id)).rejects.toThrow(/is a synthetic user/);
    await expect(findDeveloper(pool, '0000000000')).rejects.toThrow(
      /no user with the support code/,
    );
    await expect(findDeveloper(pool, 'nope')).rejects.toBeInstanceOf(ScenarioError);
  });
});

describe('reset', () => {
  it('closes only my open matches, retires synthetic users, and never touches my profile', async () => {
    const me = await realPerson();
    const synthetic = await insertPerson(testDb.appPool, { synthetic: true });
    const otherSynthetic = await insertPerson(testDb.appPool, { synthetic: true });
    // My open match with a synthetic user, a notification still waiting, my active chat.
    const mine = await insertMatch(testDb.appPool, { a: me.id, b: synthetic.id });
    await insertGame(testDb.appPool, mine.id);
    const waiting = await insertOutbox(testDb.appPool, { userId: me.id, matchId: mine.id });
    const chat = await insertChat(testDb.appPool, {
      between: [me, otherSynthetic],
      seenAs: ['a.owl', 'a.wolf'],
    });
    await testDb.appPool.query('UPDATE users SET active_match_id = $2 WHERE id = $1', [
      me.id,
      chat.matchId,
    ]);
    // Two other real people and their match: not mine, so never touched.
    const others = await insertChat(testDb.appPool);
    const before = await profileOf(me.id);

    expect(await reset(pool, { id: me.id })).toEqual({ closed: 2, retired: 2 });

    expect(open(await matchesOf(me.id))).toEqual([]);
    expect((await matchesOf(me.id)).map((m) => m.close_reason)).toEqual(['admin', 'admin']);
    const { rows: outbox } = await testDb.ownerPool.query(
      'SELECT status::text AS status, cancel_reason FROM outbox WHERE id = $1',
      [waiting.id],
    );
    expect(outbox[0]).toEqual({ status: 'cancelled', cancel_reason: 'dev_reset' });
    const { rows: synthetics } = await testDb.ownerPool.query<{ status: string }>(
      'SELECT status::text AS status FROM users WHERE synthetic',
    );
    expect(synthetics.map((r) => r.status)).toEqual(['deleted', 'deleted']);
    expect(await profileOf(me.id)).toEqual(before);
    const { rows: pointer } = await testDb.ownerPool.query(
      'SELECT active_match_id FROM users WHERE id = $1',
      [me.id],
    );
    expect(pointer[0]).toEqual({ active_match_id: null });
    const { rows: theirs } = await testDb.ownerPool.query(
      'SELECT status::text AS status FROM matches WHERE id = $1',
      [others.matchId],
    );
    expect(theirs[0]).toEqual({ status: 'results_ready' });

    // Twice is the same as once.
    expect(await reset(pool, { id: me.id })).toEqual({ closed: 0, retired: 0 });
  });
});

describe('phase2', () => {
  it('makes one new match and delivers its notification once, and starts over when run again', async () => {
    const { telegram, deps, dev } = await setup();
    const run = await SCENARIOS.phase2(deps, dev);
    expect(open(await matchesOf(dev.id))).toHaveLength(1);
    const texts = sent(telegram, dev);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toMatch(/^Новое знакомство! /);
    expect(run.summary.join('\n')).toContain('Notifications delivered to you: 1.');
    expect(run.checklist).toHaveLength(3);
    expect(run.checklist[0]).toContain(`«${texts[0]}»`);
    expect(run.checklist[0]).toContain('«Открыть»');
    expect(run.later).toBeUndefined();

    telegram.clear();
    await SCENARIOS.phase2(deps, dev);
    const all = await matchesOf(dev.id);
    expect(open(all)).toHaveLength(1);
    expect(all.filter((m) => m.close_reason === 'admin')).toHaveLength(1);
    expect(sent(telegram, dev)).toHaveLength(1);
  });

  it('refuses when another real user is active in the same pool, and allows one elsewhere', async () => {
    const { telegram, deps, dev } = await setup();
    const elsewhere = await realPerson({}, { locale: 'en' });
    await SCENARIOS.phase2(deps, dev);
    expect(open(await matchesOf(elsewhere.id))).toEqual([]);

    const neighbour = await realPerson();
    telegram.clear();
    await expect(SCENARIOS.phase2(deps, dev)).rejects.toThrow(
      new RegExp(`another real user is active in your pool \\(${neighbour.publicId}\\)`),
    );
    expect(open(await matchesOf(neighbour.id))).toEqual([]);
    expect(telegram.calls).toEqual([]);
  });
});

describe('phase3', () => {
  it('prepares a game to play, one to wait in, a reminder and an expiry, moving only those deadlines', async () => {
    const { telegram, deps, dev } = await setup();
    // A real pair elsewhere with a game in progress: the deadlines job must leave it alone.
    const a = await realPerson({}, { locale: 'en' });
    const b = await realPerson({}, { locale: 'en' });
    const theirs = await insertMatch(testDb.appPool, { a: a.id, b: b.id, locale: 'en' });
    await insertGame(testDb.appPool, theirs.id);
    const deadline = async (id: string) =>
      (
        await testDb.ownerPool.query<{ at: Date }>(
          'SELECT game_deadline_at AS at FROM matches WHERE id = $1',
          [id],
        )
      ).rows[0]!.at.getTime();
    const theirDeadline = await deadline(theirs.id);

    const run = await SCENARIOS.phase3(deps, dev);
    const mine = await matchesOf(dev.id);
    expect(mine.map((m) => m.status)).toEqual([
      'pending_game',
      'pending_game',
      'pending_game',
      'expired',
    ]);
    const [played, waiting, reminded] = mine;
    const { rows: games } = await testDb.ownerPool.query<{ match_id: string; done: number }>(
      `SELECT match_id, (a_done_at IS NOT NULL)::int + (b_done_at IS NOT NULL)::int AS done
       FROM games WHERE match_id = ANY($1::uuid[])`,
      [[played!.id, waiting!.id]],
    );
    expect(Object.fromEntries(games.map((g) => [g.match_id, g.done]))).toEqual({
      [played!.id]: 1,
      [waiting!.id]: 0,
    });
    const hoursLeft = ((await deadline(reminded!.id)) - Date.now()) / 3_600_000;
    expect(hoursLeft).toBeGreaterThan(11.9);
    expect(hoursLeft).toBeLessThan(12);
    expect(await deadline(theirs.id)).toBe(theirDeadline);
    const { rows: still } = await testDb.ownerPool.query(
      'SELECT status::text AS status FROM matches WHERE id = $1',
      [theirs.id],
    );
    expect(still[0]).toEqual({ status: 'pending_game' });

    const texts = sent(telegram, dev);
    expect(count(texts, /^Новое знакомство! /)).toBe(3);
    expect(count(texts, /^Твой ход! /)).toBe(1);
    expect(count(texts, /^Осталось 12 часов, чтобы сыграть\. Тебя ждёт /)).toBe(1);
    expect(count(texts, /^Время на игру вышло, и это знакомство закрылось /)).toBe(1);
    expect(texts).toHaveLength(6);
    expect(run.checklist).toHaveLength(4);
    expect(run.checklist[2]).toContain('«Осталось 12 часов, чтобы сыграть. Тебя ждёт ');

    telegram.clear();
    await SCENARIOS.phase3(deps, dev);
    expect(open(await matchesOf(dev.id))).toHaveLength(3);
    expect(sent(telegram, dev)).toHaveLength(6);
  });
});

describe('phase4', () => {
  it('prepares the chats, both reveals, an ended chat and a fresh finished game', async () => {
    const { telegram, deps, dev } = await setup();
    const run = await SCENARIOS.phase4(deps, dev);

    const mine = await matchesOf(dev.id);
    expect(mine.map((m) => [m.status, m.close_reason])).toEqual([
      ['active', null],
      ['active', null],
      ['closed', 'left'],
      ['results_ready', null],
    ]);
    const [a, b, c] = mine.map((m) => m.id) as [string, string, string];
    const { rows: messages } = await testDb.ownerPool.query<{ match_id: string; mine: boolean }>(
      `SELECT match_id, sender_id = $1 AS mine FROM messages ORDER BY created_at`,
      [dev.id],
    );
    expect(messages).toEqual([
      { match_id: a, mine: false },
      { match_id: b, mine: false },
      { match_id: c, mine: false },
    ]);
    const consents = async () =>
      (
        await testDb.ownerPool.query<{ match_id: string; mine: boolean; revealed: boolean }>(
          `SELECT match_id, user_id = $1 AS mine, revealed_at IS NOT NULL AS revealed
           FROM reveal_consents ORDER BY match_id, mine`,
          [dev.id],
        )
      ).rows;
    expect(await consents()).toEqual(
      [
        { match_id: a, mine: false, revealed: false },
        { match_id: b, mine: true, revealed: false },
      ].sort((x, y) => (x.match_id < y.match_id ? -1 : 1)),
    );
    const { rows: pointer } = await testDb.ownerPool.query(
      'SELECT active_match_id FROM users WHERE id = $1',
      [dev.id],
    );
    expect(pointer[0]).toEqual({ active_match_id: null });

    const texts = sent(telegram, dev);
    // Three relayed messages: an alias, a line break, the counterpart's opener.
    expect(count(texts, /^\S+ \S+\n.+/s)).toBe(3);
    expect(count(texts, /^Результаты готовы! /)).toBe(1);
    expect(count(texts, / предлагает обменяться никами в Telegram\./)).toBe(1);
    expect(count(texts, /^Этот чат завершён \(/)).toBe(1);
    // The game messages of the setup were left out.
    expect(count(texts, /^Новое знакомство!|^Твой ход!/)).toBe(0);
    expect(texts).toHaveLength(6);
    expect(texts.join('\n')).not.toContain('dev_real_user');

    expect(run.checklist).toHaveLength(10);
    expect(run.checklist[1]).toContain('«Кому отправить это сообщение?»');
    expect(run.checklist[2]).toContain('the ✓ in the list moves to');
    // With a username, agreeing to the counterpart's request reveals at once.
    expect(run.checklist[4]).toContain('«Согласие есть с обеих сторон. Сейчас пришлю ник (');
    expect(run.checklist[4]).not.toContain('no username');
    expect(run.checklist[5]).toContain('your consent in');
    expect(run.checklist[5]).toContain('в Telegram: @synthetic_user');
    expect(run.checklist[9]).toContain('«Твоё согласие записано.');
    expect(run.checklist[9]).toContain('«Передумать»');
    expect(run.checklist[9]).toContain('согласие отозвано');
    expect(run.later?.inMs).toBe(15_000);

    // A few seconds later the counterpart of B agrees, and the username arrives.
    telegram.clear();
    expect(await run.later!.run()).toMatch(
      /agreed: «.+ в Telegram: @synthetic_user» is in the bot/,
    );
    expect(sent(telegram, dev)).toEqual([expect.stringMatching(/ в Telegram: @synthetic_user$/)]);
    expect((await consents()).filter((r) => r.match_id === b).map((r) => r.revealed)).toEqual([
      true,
      true,
    ]);

    // Running it again leaves one set of matches, not two.
    telegram.clear();
    await SCENARIOS.phase4(deps, dev);
    const again = await matchesOf(dev.id);
    expect(open(again)).toHaveLength(3);
    expect(again.filter((m) => m.close_reason === 'admin')).toHaveLength(3);
    expect(sent(telegram, dev)).toHaveLength(6);
  });

  it('keeps my consent waiting when my account has no username, and says what to do', async () => {
    const { telegram, deps, dev } = await setup({ username: null });
    const run = await SCENARIOS.phase4(deps, dev);
    // Both reveal items, and the withdrawal, say that a consent waits for the username first.
    expect(run.checklist[4]).toContain('your Telegram account has no username');
    expect(run.checklist[4]).toContain('«У тебя в Telegram не задано имя пользователя');
    expect(run.checklist[4]).not.toContain('tap «Согласиться»: «Согласие есть');
    expect(run.checklist[5]).toContain('your Telegram account has no username');
    expect(run.checklist[5]).not.toContain('tap «Согласиться»');
    expect(run.checklist[9]).toContain('«У тебя в Telegram не задано имя пользователя');
    expect(run.checklist[9]).toContain('«Передумать»');
    expect(await run.later!.run()).toContain('your account has no Telegram username');
    expect(count(sent(telegram, dev), / в Telegram: @/)).toBe(0);
  });

  it('refuses a u18 account: the chat is closed in that band until Phase 5', async () => {
    const { deps } = await setup();
    const minor = await realPerson({ birthDate: birthDateYearsAgo(16) }, { band: 'u18' });
    const dev = await findDeveloper(pool, minor.publicId);
    await expect(SCENARIOS.phase4({ ...deps, u18PoolEnabled: true }, dev)).rejects.toThrow(
      /phase4 needs an adult account/,
    );
  });
});

describe('the script', () => {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const script = fileURLToPath(new URL('../../scripts/dev-scenario.ts', import.meta.url));

  it.each(SCENARIO_NAMES)('refuses to run %s with NODE_ENV=production', async (name) => {
    const me = await realPerson();
    const before = await testDb.ownerPool.query('SELECT id, status FROM matches ORDER BY id');
    const url = new URL(testDb.ownerUrl);
    url.searchParams.set('options', `-c role=${APP_ROLE}`);
    const result = await promisify(execFile)(
      process.execPath,
      [tsxCli, script, name, me.publicId],
      {
        // Would work if the script went on: it must stop before using any of it.
        env: {
          PATH: process.env['PATH'] ?? '',
          NODE_ENV: 'production',
          DATABASE_URL: url.toString(),
        },
        timeout: 30_000,
      },
    ).then(
      () => ({ code: 0, stderr: '' }),
      (error: { code?: number; stderr?: string }) => ({
        code: error.code ?? -1,
        stderr: error.stderr ?? '',
      }),
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('dev:scenario refuses to run with NODE_ENV=production');
    expect(
      (await testDb.ownerPool.query('SELECT id, status FROM matches ORDER BY id')).rows,
    ).toEqual(before.rows);
    expect(await profileOf(me.id)).toMatchObject({ status: 'active' });
  });
});
