import { contentChecksum, loadValidContent } from '@samesync/content';
import type { Hono } from 'hono';
import type { BotContext } from '../../src/bot/bot';
import { fixedClock, type Clock } from '../../src/clock';
import { DEFAULT_CONTENT_DIR } from '../../src/config';
import { createContentStore, type ContentStore } from '../../src/content/store';
import { createGamesRepository } from '../../src/db/repositories/games';
import { createMatchesRepository } from '../../src/db/repositories/matches';
import { createProfileRepository } from '../../src/db/repositories/profile';
import { createUsersRepository } from '../../src/db/repositories/users';
import { createHttpApp } from '../../src/http/app';
import type { Logger } from '../../src/logger';
import type { ChatService } from '../../src/services/chat';
import type { SafetyService } from '../../src/services/safety';
import { createGameService } from '../../src/services/game';
import { createMatchesService } from '../../src/services/matches';
import { createProfileService } from '../../src/services/profile';
import { chatServices } from './chat-app';
import type { TestDatabase } from './db';
import {
  CLOCK_SKEW_SEC,
  MAX_AGE_SEC,
  TEST_BOT_TOKEN,
  initDataFor,
  memoryLogger,
  type TestUser,
} from './fixtures';
import { fakeTelegram, type FakeTelegram } from './telegram';

let cached: Promise<ContentStore> | undefined;

/** The real committed content, loaded once per test file. */
export function realContent(): Promise<ContentStore> {
  cached ??= loadValidContent(DEFAULT_CONTENT_DIR).then((b) =>
    createContentStore(b, contentChecksum(b)),
  );
  return cached;
}

/** The real content with some takes marked retired (they stay seeded in the DB, like in prod). */
export async function contentWithRetiredTakes(ids: readonly string[]): Promise<ContentStore> {
  const bundle = await loadValidContent(DEFAULT_CONTENT_DIR);
  const questions = bundle.questions.map((q) =>
    ids.includes(q.id) ? { ...q, retiredIn: bundle.release.version } : q,
  );
  return createContentStore({ ...bundle, questions }, contentChecksum(bundle));
}

export interface TestApp {
  app: Hono;
  content: ContentStore;
  clock: Clock;
  /** The fake Bot API behind the chat: what a message sent from the Mini App turns into. */
  telegram: FakeTelegram<BotContext>;
  /** Requests as `user`, with initData signed at the clock's current time. */
  as(user: TestUser): {
    get(path: string): Promise<Response>;
    post(path: string, body?: unknown): Promise<Response>;
    put(path: string, body?: unknown): Promise<Response>;
  };
}

/**
 * The real HTTP app on a test database. The clock is the real current time unless a test passes
 * its own: the DB's age triggers use the real date (vc_today()), so the app must agree with them.
 */
export async function buildTestApp(
  testDb: TestDatabase,
  options: {
    u18PoolEnabled?: boolean;
    logger?: Logger;
    content?: ContentStore;
    clock?: Clock;
    /** Services that exist already, with the fake Bot API they talk to (support/chat-app.ts). */
    chat?: { chats: ChatService; telegram: FakeTelegram<BotContext>; safety: SafetyService };
  } = {},
): Promise<TestApp> {
  const content = options.content ?? (await realContent());
  const clock = options.clock ?? fixedClock(new Date());
  const users = createUsersRepository(testDb.db);
  const matches = createMatchesRepository(testDb.db);
  const logger = options.logger ?? memoryLogger().logger;
  const telegram = options.chat?.telegram ?? fakeTelegram<BotContext>();
  const services = options.chat ?? chatServices(testDb, { content, clock, logger, telegram });
  const app = createHttpApp({
    botToken: TEST_BOT_TOKEN,
    initData: { maxAgeSec: MAX_AGE_SEC, clockSkewSec: CLOCK_SKEW_SEC },
    clock,
    logger,
    profile: createProfileService({
      users,
      profile: createProfileRepository(testDb.db),
      content,
      clock,
      u18PoolEnabled: options.u18PoolEnabled ?? false,
    }),
    matches: createMatchesService({ users, matches, content, clock }),
    game: createGameService({
      users,
      matches,
      games: createGamesRepository(testDb.db),
      content,
      clock,
    }),
    chat: services.chats,
    safety: services.safety,
  });
  return {
    app,
    content,
    clock,
    telegram,
    as(user) {
      const headers = () => ({
        Authorization: `tma ${initDataFor(user, { authDate: clock.now() })}`,
        'Content-Type': 'application/json',
      });
      const send = async (method: string, path: string, body?: unknown) =>
        app.request(path, {
          method,
          headers: headers(),
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      return {
        get: (path) => send('GET', path),
        post: (path, body) => send('POST', path, body),
        put: (path, body) => send('PUT', path, body),
      };
    },
  };
}
