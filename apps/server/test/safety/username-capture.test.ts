/**
 * SAFETY SUITE — usernames (CLAUDE.md invariant 6) and band rules through the real entry points:
 * initData on API requests and bot updates. A u18 user's username is never stored, even though
 * Telegram sends it with every request; dating is refused for u18 at the API.
 */
import { randomInt } from 'node:crypto';
import type { Update } from 'grammy/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBot } from '../../src/bot/bot';
import { createUsersRepository } from '../../src/db/repositories/users';
import { buildTestApp, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import {
  TEST_BOT_INFO,
  TEST_BOT_TOKEN,
  TEST_MINIAPP_URL,
  memoryLogger,
  type TestUser,
} from '../support/fixtures';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
let t: TestApp;
beforeAll(async () => {
  testDb = await createTestDatabase();
  t = await buildTestApp(testDb);
});
afterAll(() => testDb.drop());

const person = (username: string): TestUser => ({
  id: randomInt(1, 2 ** 40),
  first_name: 'Test',
  username,
  language_code: 'ru',
});
const storedUsername = async (telegramId: number) =>
  (
    await testDb.ownerPool.query<{ username: string | null }>(
      'SELECT username FROM users WHERE telegram_id = $1',
      [telegramId],
    )
  ).rows[0]?.username;

async function withBirthDate(user: TestUser, birthDate: string) {
  const as = t.as(user);
  expect((await as.post('/api/onboarding/locale', { locale: 'ru' })).status).toBe(200);
  const res = await as.post('/api/onboarding/birth-date', { birthDate });
  expect(res.status).toBe(200);
  return as;
}

function botUpdate(user: TestUser): Update {
  return {
    update_id: randomInt(1, 2 ** 31),
    message: {
      message_id: 1,
      date: 1_790_000_000,
      chat: { id: user.id, type: 'private', first_name: user.first_name },
      from: {
        id: user.id,
        is_bot: false,
        first_name: user.first_name,
        username: user.username!,
        language_code: 'ru',
      },
      text: '/help',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
    },
  };
}

function botOnTestDb() {
  const bot = createBot({
    token: TEST_BOT_TOKEN,
    miniAppUrl: TEST_MINIAPP_URL,
    logger: memoryLogger().logger,
    botInfo: TEST_BOT_INFO,
    users: createUsersRepository(testDb.db),
  });
  bot.api.config.use(() =>
    Promise.resolve({
      ok: true,
      result: { message_id: 1, date: 0, chat: { id: 1, type: 'private' } },
    } as never),
  );
  return bot;
}

describe('usernames from initData (API requests)', () => {
  it('are never stored before a birth date exists', async () => {
    const user = person('no_age_yet');
    expect((await t.as(user).get('/api/me')).status).toBe(200);
    expect(await storedUsername(user.id)).toBeNull();
  });

  it('are never stored for a u18 user, on any later request', async () => {
    const user = person('kid_handle');
    const as = await withBirthDate(user, birthDateYearsAgo(16, 40));
    expect((await as.get('/api/me')).status).toBe(200);
    expect((await as.get('/api/deck')).status).toBe(200);
    expect(await storedUsername(user.id)).toBeNull();
    const me = (await (await as.get('/api/me')).json()) as Record<string, unknown>;
    expect(JSON.stringify(me)).not.toContain('kid_handle');
  });

  it('are stored for an adult and follow later changes', async () => {
    const user = person('adult_one');
    const as = await withBirthDate(user, birthDateYearsAgo(30));
    expect((await as.get('/api/me')).status).toBe(200);
    expect(await storedUsername(user.id)).toBe('adult_one');
    expect((await t.as({ ...user, username: 'adult_two' }).get('/api/me')).status).toBe(200);
    expect(await storedUsername(user.id)).toBe('adult_two');
  });
});

describe('usernames from bot updates', () => {
  it('are stored for adults only', async () => {
    const kid = person('kid_in_bot');
    const adult = person('adult_in_bot');
    await withBirthDate(kid, birthDateYearsAgo(15, 40));
    await withBirthDate(adult, birthDateYearsAgo(28));
    await testDb.ownerPool.query('UPDATE users SET username = NULL WHERE telegram_id = $1', [
      adult.id,
    ]);
    const bot = botOnTestDb();
    await bot.handleUpdate(botUpdate(kid));
    await bot.handleUpdate(botUpdate(adult));
    expect(await storedUsername(kid.id)).toBeNull();
    expect(await storedUsername(adult.id)).toBe('adult_in_bot');
  });

  it('create no user row for people who never opened the Mini App', async () => {
    const stranger = person('stranger');
    await botOnTestDb().handleUpdate(botUpdate(stranger));
    const { rowCount } = await testDb.ownerPool.query(
      'SELECT 1 FROM users WHERE telegram_id = $1',
      [stranger.id],
    );
    expect(rowCount).toBe(0);
  });
});

describe('the API never puts a u18 user in dating mode', () => {
  it('refuses at onboarding and in settings', async () => {
    const user = person('kid_dating');
    const as = await withBirthDate(user, birthDateYearsAgo(17, 40));
    const dating = { mode: 'dating', gender: 'g.man', seeking: ['g.woman'] };
    expect((await as.post('/api/onboarding/mode', dating)).status).toBe(403);
    expect((await as.put('/api/profile/mode', dating)).status).toBe(403);
    const { rows } = await testDb.ownerPool.query(
      'SELECT mode, gender FROM users WHERE telegram_id = $1',
      [user.id],
    );
    expect(rows[0]).toEqual({ mode: 'friends', gender: null });
  });
});
