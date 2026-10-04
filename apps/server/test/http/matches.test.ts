/**
 * GET /api/matches and /api/matches/:id: a user sees their own open matches, with the other
 * person only as an alias, and loses sight of a match the moment it stops being readable.
 */
import { randomInt } from 'node:crypto';
import type { MatchSummary, MatchesResponse } from '@samesync/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import { insertActiveUser, insertMatch, withoutTriggers } from '../support/matches';
import { birthDateYearsAgo, type InsertUser } from '../support/users';

let testDb: TestDatabase;
let t: TestApp;
beforeAll(async () => {
  testDb = await createTestDatabase();
  t = await buildTestApp(testDb);
});
afterAll(() => testDb.drop());

/** An active user who can call the API: a DB row plus the Telegram identity that maps to it. */
async function person(over: InsertUser = {}) {
  const telegram: TestUser = { id: randomInt(1, 2 ** 40), first_name: 'Test' };
  const row = await insertActiveUser(testDb.appPool, {
    telegramId: telegram.id,
    birthDate: birthDateYearsAgo(25),
    username: over.birthDate ? null : `secret_${telegram.id}`,
    ...over,
  });
  return { ...row, as: t.as(telegram) };
}
const TEASER = {
  interest: { kind: 'item', id: 'i.music.molchat_doma' },
  take: { id: 'q.milk_before_cereal', value: 'agree' },
};
async function matched(over: InsertUser = {}, band: 'adult' | 'u18' = 'adult') {
  const [a, b] = [await person(over), await person(over)];
  const match = await insertMatch(testDb.appPool, { a: a.id, b: b.id, band });
  await withoutTriggers(testDb.ownerPool, (c) =>
    c.query('UPDATE matches SET teaser = $1 WHERE id = $2', [JSON.stringify(TEASER), match.id]),
  );
  // insertMatch stores a.fox as alias_a (the lower ID) and a.owl as alias_b.
  const [low, high] = a.id < b.id ? [a, b] : [b, a];
  return { a, b, low, high, match };
}
const list = async (who: { as: ReturnType<TestApp['as']> }) => {
  const res = await who.as.get('/api/matches');
  expect(res.status).toBe(200);
  return ((await res.json()) as MatchesResponse).matches;
};
const get = (who: { as: ReturnType<TestApp['as']> }, id: string) =>
  who.as.get(`/api/matches/${id}`);

describe('GET /api/matches', () => {
  it('is empty for someone without matches', async () => {
    expect(await list(await person())).toEqual([]);
  });

  it('lists the open matches of the caller, newest first, with the other person as an alias', async () => {
    const { low, high, match } = await matched();
    const mine = await list(low);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      id: match.id,
      // The lower ID sees the other user's alias (alias_b), and the other way round.
      alias: { emoji: '🦉', name: 'Сова' },
      teaser:
        'У кого-то здесь в плейлисте тоже Молчат Дома, и этот человек считает, что молоко наливают раньше хлопьев.',
      status: 'pending_game',
    });
    expect((await list(high))[0]).toMatchObject({ alias: { emoji: '🦊', name: 'Лиса' } });
    expect(Date.parse(mine[0]!.gameDeadlineAt) - Date.parse(mine[0]!.createdAt)).toBeGreaterThan(0);

    const second = await person();
    const newer = await insertMatch(testDb.appPool, { a: low.id, b: second.id });
    expect((await list(low)).map((m) => m.id)).toEqual([newer.id, match.id]);
  });

  it('renders the alias and the teaser in the caller language', async () => {
    const { low } = await matched();
    await testDb.ownerPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [low.id]);
    expect((await list(low))[0]).toMatchObject({
      alias: { emoji: '🦉', name: 'Owl' },
      teaser:
        'Someone here also listens to Molchat Doma and thinks milk goes in before the cereal.',
    });
  });

  it('never contains anything that identifies the other person', async () => {
    const { low, high, match } = await matched();
    const { rows } = await testDb.ownerPool.query<{ public_id: string; username: string }>(
      'SELECT public_id, username FROM users WHERE id = $1',
      [high.id],
    );
    expect(rows[0]?.username).toMatch(/^secret_/);
    for (const body of [
      await (await low.as.get('/api/matches')).text(),
      await (await get(low, match.id)).text(),
    ]) {
      expect(body).toContain(match.id);
      for (const secret of [
        high.id,
        String(high.telegramId),
        rows[0]!.public_id,
        rows[0]!.username,
      ]) {
        expect(body).not.toContain(secret);
      }
    }
  });

  it('does not list closed matches', async () => {
    const { low, match } = await matched();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [match.id],
    );
    expect(await list(low)).toEqual([]);
  });
});

describe('GET /api/matches/:id', () => {
  it('returns a match to each participant and 404 to anyone else', async () => {
    const { a, b, match } = await matched();
    for (const who of [a, b]) {
      const res = await get(who, match.id);
      expect(res.status).toBe(200);
      expect(((await res.json()) as MatchSummary).id).toBe(match.id);
    }
    const stranger = await person();
    const res = await get(stranger, match.id);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });

  it('answers 404 for unknown and malformed IDs', async () => {
    const someone = await person();
    expect((await get(someone, '00000000-0000-7000-8000-000000000000')).status).toBe(404);
    expect((await get(someone, 'not-a-uuid')).status).toBe(404);
    expect((await get(someone, "1' OR '1'='1")).status).toBe(404);
  });

  it('still shows a match that ended for an ordinary reason, as closed', async () => {
    const { a, match } = await matched();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [match.id],
    );
    const res = await get(a, match.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'closed' });
  });

  it('answers 404 to both former participants once a match is closed for a band change', async () => {
    const { a, b, match } = await matched({ birthDate: birthDateYearsAgo(17) }, 'u18');
    expect((await get(a, match.id)).status).toBe(200);
    await testDb.ownerPool.query(
      "SELECT admin_set_birth_date($1, $2::date, 777, 'age correction')",
      [a.id, birthDateYearsAgo(18)],
    );
    expect((await get(a, match.id)).status).toBe(404);
    expect((await get(b, match.id)).status).toBe(404);
    expect(await list(a)).toEqual([]);
    expect(await list(b)).toEqual([]);
  });

  it('hides a match as soon as a live band differs from its band, before any job has run', async () => {
    const { a, b, match } = await matched({ birthDate: birthDateYearsAgo(17) }, 'u18');
    // The 18th birthday is today; the cache and the match are untouched.
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET birth_date = $1 WHERE id = $2', [birthDateYearsAgo(18), a.id]),
    );
    // No API call may run as `a` before this check: any write to that row would fix the cache.
    expect((await get(b, match.id)).status).toBe(404);
    expect(await list(b)).toEqual([]);
    expect((await get(a, match.id)).status).toBe(404);
  });
});

describe('who may call the matches API', () => {
  it.each(['frozen', 'deleted'])('refuses a %s account with 403', async (status) => {
    const { a, match } = await matched();
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET status = $1 WHERE id = $2', [status, a.id]),
    );
    expect((await a.as.get('/api/matches')).status).toBe(403);
    expect((await get(a, match.id)).status).toBe(403);
  });

  it('needs valid initData', async () => {
    expect((await t.app.request('/api/matches')).status).toBe(401);
  });
});
