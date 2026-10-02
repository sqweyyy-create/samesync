import { contentChecksum, loadValidContent } from '@samesync/content';
import type { Hono } from 'hono';
import { fixedClock, type Clock } from '../../src/clock';
import { DEFAULT_CONTENT_DIR } from '../../src/config';
import { createContentStore, type ContentStore } from '../../src/content/store';
import { createProfileRepository } from '../../src/db/repositories/profile';
import { createUsersRepository } from '../../src/db/repositories/users';
import { createHttpApp } from '../../src/http/app';
import type { Logger } from '../../src/logger';
import { createProfileService } from '../../src/services/profile';
import type { TestDatabase } from './db';
import {
  CLOCK_SKEW_SEC,
  MAX_AGE_SEC,
  TEST_BOT_TOKEN,
  initDataFor,
  memoryLogger,
  type TestUser,
} from './fixtures';

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
  /** Requests as `user`, with initData signed at the clock's current time. */
  as(user: TestUser): {
    get(path: string): Promise<Response>;
    post(path: string, body?: unknown): Promise<Response>;
    put(path: string, body?: unknown): Promise<Response>;
  };
}

/**
 * The real HTTP app on a test database. The clock is the real current time: the DB's age triggers
 * use the real date (vc_today()), so the app must agree with them.
 */
export async function buildTestApp(
  testDb: TestDatabase,
  options: { u18PoolEnabled?: boolean; logger?: Logger; content?: ContentStore } = {},
): Promise<TestApp> {
  const content = options.content ?? (await realContent());
  const clock = fixedClock(new Date());
  const app = createHttpApp({
    botToken: TEST_BOT_TOKEN,
    initData: { maxAgeSec: MAX_AGE_SEC, clockSkewSec: CLOCK_SKEW_SEC },
    clock,
    logger: options.logger ?? memoryLogger().logger,
    profile: createProfileService({
      users: createUsersRepository(testDb.db),
      profile: createProfileRepository(testDb.db),
      content,
      clock,
      u18PoolEnabled: options.u18PoolEnabled ?? false,
    }),
  });
  return {
    app,
    content,
    clock,
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
