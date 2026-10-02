import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProfileRepository } from '../../src/db/repositories/profile';
import { createUsersRepository } from '../../src/db/repositories/users';
import { createHttpApp } from '../../src/http/app';
import { createProfileService } from '../../src/services/profile';
import { realContent } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import {
  ANYA,
  BOB,
  CLOCK_SKEW_SEC,
  MAX_AGE_SEC,
  NOW,
  TEST_BOT_TOKEN,
  initDataFor,
  memoryLogger,
  testClock,
} from '../support/fixtures';

describe('GET /api/me', () => {
  let testDb: TestDatabase;
  let app: Hono;
  const clock = testClock();

  beforeAll(async () => {
    testDb = await createTestDatabase();
    app = createHttpApp({
      botToken: TEST_BOT_TOKEN,
      initData: { maxAgeSec: MAX_AGE_SEC, clockSkewSec: CLOCK_SKEW_SEC },
      clock,
      logger: memoryLogger().logger,
      profile: createProfileService({
        users: createUsersRepository(testDb.db),
        profile: createProfileRepository(testDb.db),
        content: await realContent(),
        clock,
        u18PoolEnabled: false,
      }),
    });
  });
  afterAll(() => testDb.drop());

  const me = (initData: string) =>
    app.request('/api/me', { headers: { Authorization: `tma ${initData}` } });
  const rowsFor = (telegramId: number) =>
    testDb.ownerPool.query<{ public_id: string; locale: string; last_active_at: Date }>(
      'select public_id, locale, last_active_at from users where telegram_id = $1',
      [telegramId],
    );

  it('responds 401 without an Authorization header', async () => {
    expect((await app.request('/api/me')).status).toBe(401);
  });

  it('returns the validated user and creates them once', async () => {
    const response = await me(initDataFor(ANYA));
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      firstName: 'Аня',
      locale: 'ru',
      status: 'onboarding',
      step: 'locale',
      birthDate: null,
      band: null,
    });
    expect(body['publicId']).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    // Never echoes the username or the Telegram ID.
    expect(JSON.stringify(body)).not.toContain('anya_secret');
    expect(JSON.stringify(body)).not.toContain(String(ANYA.id));

    const { rows } = await rowsFor(ANYA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.public_id).toBe(body['publicId']);
  });

  it('is idempotent: a second call keeps the same user and public ID, and refreshes last_active_at', async () => {
    const first = (await (await me(initDataFor(ANYA))).json()) as { publicId: string };
    clock.set(new Date(NOW.getTime() + 60_000));
    const second = (await (await me(initDataFor(ANYA))).json()) as { publicId: string };
    expect(second.publicId).toBe(first.publicId);
    const { rows } = await rowsFor(ANYA.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_active_at.toISOString()).toBe('2026-10-02T12:01:00.000Z');
    clock.set(NOW);
  });

  it('picks the locale from language_code on first contact', async () => {
    const response = await me(initDataFor(BOB));
    expect(await response.json()).toMatchObject({ firstName: 'Bob', locale: 'en' });
    const german = { id: 777001, first_name: 'Greta', language_code: 'de' };
    expect(await (await me(initDataFor(german))).json()).toMatchObject({ locale: 'en' });
  });

  it('does not store the username', async () => {
    const { rows } = await testDb.ownerPool.query('select * from users where telegram_id = $1', [
      ANYA.id,
    ]);
    expect(JSON.stringify(rows)).not.toContain('anya_secret');
  });

  it('serves /healthz without authentication', async () => {
    const response = await app.request('/healthz');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('answers unknown non-API routes with a JSON 404', async () => {
    const response = await app.request('/nope');
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'not_found' });
  });
});
