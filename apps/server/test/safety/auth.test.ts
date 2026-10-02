/**
 * SAFETY SUITE — initData authentication (CLAUDE.md invariants 10 and 11, "Auth" conventions).
 * Identity must come only from initData validated with our bot token. Never skip or weaken.
 */
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateInitData, type InitDataOptions } from '../../src/http/auth/init-data';
import { signInitData } from '../../src/http/auth/init-data-signer';
import { initDataAuth, type AuthVariables } from '../../src/http/auth/middleware';
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
  OTHER_BOT_TOKEN,
  TEST_BOT_TOKEN,
  initDataFor,
  memoryLogger,
  testClock,
} from '../support/fixtures';

const options: InitDataOptions = {
  botToken: TEST_BOT_TOKEN,
  now: NOW,
  maxAgeSec: MAX_AGE_SEC,
  clockSkewSec: CLOCK_SKEW_SEC,
};
const secondsFromNow = (s: number) => new Date(NOW.getTime() + s * 1000);

describe('validateInitData', () => {
  it('accepts initData signed with our bot token and returns the user', () => {
    const result = validateInitData(initDataFor(ANYA), options);
    expect(result).toMatchObject({
      ok: true,
      data: { user: { id: ANYA.id, firstName: 'Аня', languageCode: 'ru' }, chatType: 'private' },
    });
  });

  it('accepts initData that carries the newer `signature` field (it is part of the HMAC)', () => {
    const raw = signInitData({
      botToken: TEST_BOT_TOKEN,
      authDate: NOW,
      user: { ...ANYA },
      extra: { signature: 'ed25519-signature-for-third-parties' },
    });
    expect(validateInitData(raw, options).ok).toBe(true);
  });

  it('rejects any field changed after signing', () => {
    const raw = initDataFor(ANYA);
    const tamperedUser = raw.replace(
      encodeURIComponent(`"id":${ANYA.id}`),
      encodeURIComponent('"id":1'),
    );
    expect(tamperedUser).not.toBe(raw);
    expect(validateInitData(tamperedUser, options)).toEqual({ ok: false, reason: 'bad_hash' });

    const params = new URLSearchParams(raw);
    params.set('chat_type', 'group');
    expect(validateInitData(params.toString(), options)).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rejects a field added after signing', () => {
    const raw = `${initDataFor(ANYA)}&start_param=injected`;
    expect(validateInitData(raw, options)).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rejects initData signed with another bot token', () => {
    const raw = initDataFor(ANYA, { botToken: OTHER_BOT_TOKEN });
    expect(validateInitData(raw, options)).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rejects a missing, malformed or wrong-length hash', () => {
    const params = new URLSearchParams(initDataFor(ANYA));
    const hash = params.get('hash') ?? '';
    params.delete('hash');
    expect(validateInitData(params.toString(), options)).toEqual({
      ok: false,
      reason: 'missing_hash',
    });
    params.set('hash', hash.toUpperCase());
    expect(validateInitData(params.toString(), options)).toEqual({ ok: false, reason: 'bad_hash' });
    params.set('hash', hash.slice(0, 62));
    expect(validateInitData(params.toString(), options)).toEqual({ ok: false, reason: 'bad_hash' });
  });

  it('rejects expired initData and accepts it right at the limit', () => {
    const atLimit = initDataFor(ANYA, { authDate: secondsFromNow(-MAX_AGE_SEC) });
    expect(validateInitData(atLimit, options).ok).toBe(true);
    const expired = initDataFor(ANYA, { authDate: secondsFromNow(-MAX_AGE_SEC - 1) });
    expect(validateInitData(expired, options)).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects auth_date in the future beyond the clock-skew tolerance', () => {
    const withinSkew = initDataFor(ANYA, { authDate: secondsFromNow(CLOCK_SKEW_SEC) });
    expect(validateInitData(withinSkew, options).ok).toBe(true);
    const future = initDataFor(ANYA, { authDate: secondsFromNow(CLOCK_SKEW_SEC + 1) });
    expect(validateInitData(future, options)).toEqual({ ok: false, reason: 'from_future' });
  });

  it('rejects a signed but missing or malformed user', () => {
    const noUser = signInitData({ botToken: TEST_BOT_TOKEN, authDate: NOW });
    expect(validateInitData(noUser, options)).toEqual({ ok: false, reason: 'missing_user' });
    for (const rawUser of [
      '{not json',
      '[]',
      '{"first_name":"No id"}',
      '{"id":-5,"first_name":"x"}',
      '{"id":"7","first_name":"x"}',
    ]) {
      const raw = signInitData({ botToken: TEST_BOT_TOKEN, authDate: NOW, rawUser });
      expect({ rawUser, result: validateInitData(raw, options) }).toEqual({
        rawUser,
        result: { ok: false, reason: 'bad_user' },
      });
    }
  });

  it('rejects duplicate parameters, even when one copy is validly signed', () => {
    const raw = initDataFor(ANYA);
    const forgedUser = encodeURIComponent(JSON.stringify({ id: BOB.id, first_name: 'Bob' }));
    expect(validateInitData(`${raw}&user=${forgedUser}`, options)).toEqual({
      ok: false,
      reason: 'duplicate_param',
    });
    expect(validateInitData(`user=${forgedUser}&${raw}`, options)).toEqual({
      ok: false,
      reason: 'duplicate_param',
    });
  });

  it('rejects empty and oversized input', () => {
    expect(validateInitData('', options)).toEqual({ ok: false, reason: 'malformed' });
    expect(validateInitData('a'.repeat(9000), options)).toEqual({ ok: false, reason: 'malformed' });
  });
});

describe('HTTP authentication', () => {
  let testDb: TestDatabase;
  let app: Hono;
  let log: ReturnType<typeof memoryLogger>;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    log = memoryLogger();
    const clock = testClock();
    app = createHttpApp({
      botToken: TEST_BOT_TOKEN,
      initData: { maxAgeSec: MAX_AGE_SEC, clockSkewSec: CLOCK_SKEW_SEC },
      clock,
      logger: log.logger,
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

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers });
  const userCount = async () =>
    Number(
      (await testDb.ownerPool.query<{ n: string }>('select count(*) as n from users')).rows[0]?.n,
    );

  it.each([
    ['no Authorization header', {}],
    ['an empty tma value', { Authorization: 'tma ' }],
    ['another scheme', { Authorization: `Bearer ${initDataFor(ANYA)}` }],
    [
      'forged initData',
      {
        Authorization: `tma ${initDataFor(ANYA).replace(/hash=[0-9a-f]+/, `hash=${'0'.repeat(64)}`)}`,
      },
    ],
    [
      'initData for another bot',
      { Authorization: `tma ${initDataFor(ANYA, { botToken: OTHER_BOT_TOKEN })}` },
    ],
    [
      'expired initData',
      { Authorization: `tma ${initDataFor(ANYA, { authDate: secondsFromNow(-MAX_AGE_SEC - 1) })}` },
    ],
  ])('responds 401 to %s and creates no user', async (_label, headers) => {
    const response = await get('/api/me', headers);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'unauthorized' });
    expect(await userCount()).toBe(0);
  });

  it('protects unknown /api routes too (401 before 404)', async () => {
    expect((await get('/api/does-not-exist')).status).toBe(401);
  });

  it('ignores identity passed in the query string or other headers', async () => {
    const response = await get(`/api/me?user_id=${BOB.id}&telegram_id=${BOB.id}&id=${BOB.id}`, {
      Authorization: `tma ${initDataFor(ANYA)}`,
      'X-Telegram-User-Id': String(BOB.id),
      'X-User-Id': String(BOB.id),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ firstName: 'Аня' });
    const ids = await testDb.ownerPool.query<{ telegram_id: string }>(
      'select telegram_id from users',
    );
    expect(ids.rows.map((r) => Number(r.telegram_id))).toEqual([ANYA.id]);
  });

  it('ignores identity passed in a request body', async () => {
    const echo = new Hono<{ Variables: AuthVariables }>();
    echo.use(
      initDataAuth({
        botToken: TEST_BOT_TOKEN,
        maxAgeSec: MAX_AGE_SEC,
        clockSkewSec: CLOCK_SKEW_SEC,
        clock: testClock(),
        logger: log.logger,
      }),
    );
    echo.post('/whoami', (c) => c.json({ id: c.get('auth').user.id }));
    const response = await echo.request('/whoami', {
      method: 'POST',
      headers: { Authorization: `tma ${initDataFor(ANYA)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: BOB.id, telegram_id: BOB.id, user: { id: BOB.id } }),
    });
    expect(await response.json()).toEqual({ id: ANYA.id });
  });

  it('never logs initData, the hash or the username', () => {
    const raw = initDataFor(ANYA);
    const hash = new URLSearchParams(raw).get('hash') ?? '';
    const output = log.lines().join('\n');
    expect(output).toContain('request rejected');
    expect(output).not.toContain(hash);
    expect(output).not.toContain('anya_secret');
    expect(output).not.toContain('auth_date');
    expect(output).not.toContain(TEST_BOT_TOKEN);
  });
});
