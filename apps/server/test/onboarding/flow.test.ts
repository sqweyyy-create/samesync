import { randomInt } from 'node:crypto';
import type { DeckResponse, InterestsResponse, MeResponse } from '@samesync/shared/api';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, contentWithRetiredTakes, type TestApp } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import { insertActiveUser, insertMatch, matchRow } from '../support/matches';
import { birthDateYearsAgo, insertUser } from '../support/users';

let testDb: TestDatabase;
let t: TestApp;
beforeAll(async () => {
  testDb = await createTestDatabase();
  t = await buildTestApp(testDb);
});
afterAll(() => testDb.drop());

const newUser = (language_code = 'ru'): TestUser => ({
  id: randomInt(1, 2 ** 40),
  first_name: 'Test',
  language_code,
});
const ADULT = () => birthDateYearsAgo(25, 40);
const U18 = () => birthDateYearsAgo(16, 40);

async function json<T>(response: Promise<Response>, status = 200): Promise<T> {
  const res = await response;
  const body = (await res.json()) as T;
  expect({ status: res.status, body }).toMatchObject({ status });
  return body;
}
const expectError = async (response: Promise<Response>, status: number, error: string) => {
  const res = await response;
  expect({ status: res.status, body: await res.json() }).toMatchObject({ status, body: { error } });
};

/** Drives a user through onboarding up to (not including) `stop`, or to the end. */
async function onboard(
  app: TestApp,
  user: TestUser,
  opts: {
    birthDate: string;
    locale?: 'ru' | 'en';
    dating?: boolean;
    answers?: number;
    interests?: number;
  },
) {
  const as = app.as(user);
  await json<MeResponse>(as.post('/api/onboarding/locale', { locale: opts.locale ?? 'ru' }));
  let me = await json<MeResponse>(
    as.post('/api/onboarding/birth-date', { birthDate: opts.birthDate }),
  );
  if (me.step === 'mode') {
    me = await json<MeResponse>(
      as.post(
        '/api/onboarding/mode',
        opts.dating
          ? { mode: 'dating', gender: 'g.woman', seeking: ['g.man'] }
          : { mode: 'friends' },
      ),
    );
  }
  const deck = await json<DeckResponse>(as.get('/api/deck'));
  const answerCount = opts.answers ?? 25;
  if (answerCount > 0) {
    me = await json<MeResponse>(
      as.put('/api/profile/answers', {
        answers: deck.questions
          .slice(0, answerCount)
          .map((q, i) => ({ questionId: q.id, value: i % 2 ? 'disagree' : 'agree' })),
      }),
    );
  }
  const interestCount = opts.interests ?? 5;
  let catalog: InterestsResponse | undefined;
  if (interestCount > 0 && answerCount >= 25) {
    catalog = await json<InterestsResponse>(as.get('/api/interests'));
    me = await json<MeResponse>(
      as.put('/api/profile/interests', {
        itemIds: catalog.items.slice(0, interestCount).map((i) => i.id),
      }),
    );
  }
  return { as, me, deck, catalog };
}

describe('happy paths', () => {
  it('an adult in ru completes onboarding in friends mode and becomes active', async () => {
    const user = newUser('ru');
    const { as, me } = await onboard(t, user, { birthDate: ADULT() });
    expect(me.step).toBe('finish');
    const done = await json<MeResponse>(
      as.post('/api/onboarding/complete', { timezone: 'Europe/Moscow' }),
    );
    expect(done).toMatchObject({
      step: 'done',
      status: 'active',
      band: 'adult',
      mode: 'friends',
      locale: 'ru',
    });
    const { rows } = await testDb.ownerPool.query<{
      timezone: string | null;
      onboarded_at: Date | null;
    }>('SELECT timezone, onboarded_at FROM users WHERE telegram_id = $1', [user.id]);
    expect(rows[0]).toMatchObject({ timezone: 'Europe/Moscow' });
    expect(rows[0]?.onboarded_at).not.toBeNull();
  });

  it('an adult in en completes onboarding in dating mode with gender and seeking', async () => {
    const user = newUser('en');
    const { as, me } = await onboard(t, user, { birthDate: ADULT(), locale: 'en', dating: true });
    expect(me).toMatchObject({
      locale: 'en',
      mode: 'dating',
      gender: 'g.woman',
      seeking: ['g.man'],
    });
    expect((await json<MeResponse>(as.post('/api/onboarding/complete', {}))).status).toBe('active');
  });

  it('u18 users skip the mode step (friends only) and are waitlisted while the u18 pool is off', async () => {
    const user = newUser();
    const as = t.as(user);
    await json(as.post('/api/onboarding/locale', { locale: 'ru' }));
    const me = await json<MeResponse>(as.post('/api/onboarding/birth-date', { birthDate: U18() }));
    expect(me).toMatchObject({ band: 'u18', mode: 'friends', step: 'answers' });
    await onboardRest(as);
    expect((await json<MeResponse>(as.post('/api/onboarding/complete', {}))).status).toBe(
      'waitlisted',
    );
  });

  it('u18 users become active instead when the u18 pool is enabled', async () => {
    const enabled = await buildTestApp(testDb, { u18PoolEnabled: true });
    const { as } = await onboard(enabled, newUser(), { birthDate: U18() });
    expect((await json<MeResponse>(as.post('/api/onboarding/complete', {}))).status).toBe('active');
  });

  async function onboardRest(as: ReturnType<TestApp['as']>) {
    const deck = await json<DeckResponse>(as.get('/api/deck'));
    await json(
      as.put('/api/profile/answers', {
        answers: deck.questions.slice(0, 25).map((q) => ({ questionId: q.id, value: 'agree' })),
      }),
    );
    const catalog = await json<InterestsResponse>(as.get('/api/interests'));
    await json(
      as.put('/api/profile/interests', { itemIds: catalog.items.slice(0, 5).map((i) => i.id) }),
    );
  }
});

describe('steps cannot run out of order', () => {
  it('needs the language first, then the birth date, then the mode', async () => {
    const as = t.as(newUser());
    await expectError(
      as.post('/api/onboarding/birth-date', { birthDate: ADULT() }),
      409,
      'out_of_order',
    );
    await json(as.post('/api/onboarding/locale', { locale: 'ru' }));
    await expectError(as.post('/api/onboarding/mode', { mode: 'friends' }), 409, 'out_of_order');
    await expectError(as.get('/api/deck'), 409, 'out_of_order');
    await json(as.post('/api/onboarding/birth-date', { birthDate: ADULT() }));
    await expectError(as.get('/api/deck'), 409, 'out_of_order');
    await expectError(
      as.put('/api/profile/answers', { answers: [{ questionId: 'q.x', value: 'agree' }] }),
      409,
      'out_of_order',
    );
  });

  it('needs the deck minimum before interests, and every minimum before completing', async () => {
    const { as, me } = await onboard(t, newUser(), {
      birthDate: ADULT(),
      answers: 24,
      interests: 0,
    });
    expect(me.step).toBe('answers');
    const catalog = await json<InterestsResponse>(as.get('/api/interests'));
    await expectError(
      as.put('/api/profile/interests', { itemIds: catalog.items.slice(0, 5).map((i) => i.id) }),
      409,
      'out_of_order',
    );
    await expectError(as.post('/api/onboarding/complete', {}), 409, 'out_of_order');
  });

  it('enforces 5–30 interests', async () => {
    const { as, catalog } = await onboard(t, newUser(), { birthDate: ADULT(), interests: 4 });
    expect((await json<MeResponse>(as.get('/api/me'))).step).toBe('interests');
    await expectError(as.post('/api/onboarding/complete', {}), 409, 'out_of_order');
    const tooMany = (catalog?.items ?? []).slice(0, 31).map((i) => i.id);
    await expectError(as.put('/api/profile/interests', { itemIds: tooMany }), 400, 'invalid');
  });
});

describe('validation', () => {
  it('rejects unknown and retired takes, and takes outside the user deck scope', async () => {
    const retiredId = t.content.deckCandidates({ band: 'adult', mode: 'friends', locale: 'ru' })[0]!
      .id;
    const retiring = await buildTestApp(testDb, {
      content: await contentWithRetiredTakes([retiredId]),
    });
    const { as } = await onboard(retiring, newUser(), {
      birthDate: ADULT(),
      answers: 0,
      interests: 0,
    });
    await expectError(
      as.put('/api/profile/answers', {
        answers: [{ questionId: 'q.does_not_exist', value: 'agree' }],
      }),
      400,
      'invalid',
    );
    await expectError(
      as.put('/api/profile/answers', { answers: [{ questionId: retiredId, value: 'agree' }] }),
      400,
      'invalid',
    );
    const datingOnly = t.content
      .deckCandidates({ band: 'adult', mode: 'dating', locale: 'ru' })
      .find((q) => !q.modes.includes('friends'))!;
    await expectError(
      as.put('/api/profile/answers', { answers: [{ questionId: datingOnly.id, value: 'agree' }] }),
      400,
      'invalid',
    );
    const deck = await json<DeckResponse>(as.get('/api/deck'));
    expect(deck.questions.map((q) => q.id)).not.toContain(retiredId);
  });

  it('rejects items for another locale or audience', async () => {
    const ruOnly = t.content
      .catalog({ band: 'adult', locale: 'ru' })
      .find(({ item }) => !item.locales.includes('en'))!;
    const adultOnly = t.content
      .catalog({ band: 'adult', locale: 'ru' })
      .find(({ item }) => !item.audiences.includes('u18'))!;
    const en = await onboard(t, newUser('en'), { birthDate: ADULT(), locale: 'en', interests: 0 });
    await expectError(
      en.as.put('/api/profile/interests', { itemIds: [ruOnly.item.id] }),
      400,
      'invalid',
    );
    const kid = await onboard(t, newUser(), { birthDate: U18(), interests: 0 });
    await expectError(
      kid.as.put('/api/profile/interests', { itemIds: [adultOnly.item.id] }),
      400,
      'invalid',
    );
    const kidCatalog = await json<InterestsResponse>(kid.as.get('/api/interests'));
    expect(kidCatalog.items.map((i) => i.id)).not.toContain(adultOnly.item.id);
    const enCatalog = await json<InterestsResponse>(en.as.get('/api/interests'));
    expect(enCatalog.items.map((i) => i.id)).not.toContain(ruOnly.item.id);
  });

  it('rejects malformed bodies, bad dates, unknown domains and invalid time zones', async () => {
    const as = t.as(newUser());
    await json(as.post('/api/onboarding/locale', { locale: 'ru' }));
    await expectError(as.post('/api/onboarding/locale', { locale: 'de' }), 400, 'invalid');
    await expectError(
      as.post('/api/onboarding/birth-date', { birthDate: '15.06.2008' }),
      400,
      'invalid',
    );
    await expectError(
      as.post('/api/onboarding/birth-date', { birthDate: birthDateYearsAgo(0, 1) }),
      400,
      'invalid',
    );
    await expectError(
      as.post('/api/onboarding/birth-date', { birthDate: '1890-01-01' }),
      400,
      'invalid',
    );
    const { as: done } = await onboard(t, newUser(), { birthDate: ADULT() });
    await expectError(done.get('/api/interests?domain=podcasts'), 400, 'invalid');
    await expectError(
      done.post('/api/onboarding/complete', { timezone: 'Mars/Olympus' }),
      400,
      'invalid',
    );
  });

  it('rejects dating with unknown options or without seeking', async () => {
    const as = t.as(newUser());
    await json(as.post('/api/onboarding/locale', { locale: 'ru' }));
    await json(as.post('/api/onboarding/birth-date', { birthDate: ADULT() }));
    await expectError(
      as.post('/api/onboarding/mode', { mode: 'dating', gender: 'g.unknown', seeking: ['g.man'] }),
      400,
      'invalid',
    );
    await expectError(
      as.post('/api/onboarding/mode', { mode: 'dating', gender: 'g.man', seeking: [] }),
      400,
      'invalid',
    );
    await expectError(
      as.post('/api/onboarding/mode', { mode: 'dating', gender: 'g.man' }),
      400,
      'invalid',
    );
    await expectError(
      as.post('/api/onboarding/mode', { mode: 'friends', gender: 'g.man' }),
      400,
      'invalid',
    );
  });
});

describe('idempotency', () => {
  it('re-submitting the same answers and interests changes nothing', async () => {
    const { as, deck, catalog, me } = await onboard(t, newUser(), { birthDate: ADULT() });
    const answers = deck.questions
      .slice(0, 25)
      .map((q, i) => ({ questionId: q.id, value: i % 2 ? 'disagree' : 'agree' }));
    const again = await json<MeResponse>(as.put('/api/profile/answers', { answers }));
    const interests = await json<MeResponse>(
      as.put('/api/profile/interests', {
        itemIds: (catalog?.items ?? []).slice(0, 5).map((i) => i.id),
      }),
    );
    expect(again.progress).toEqual(me.progress);
    expect(interests.progress).toEqual(me.progress);
    expect((await json<DeckResponse>(as.get('/api/deck'))).questions).toEqual(deck.questions);
    await json(as.post('/api/onboarding/complete', {}));
    expect((await json<MeResponse>(as.post('/api/onboarding/complete', {}))).step).toBe('done');
  });
});

describe('decks', () => {
  it('a u18 deck never contains adult-only takes', async () => {
    for (let i = 0; i < 5; i++) {
      const { deck } = await onboard(t, newUser(i % 2 ? 'en' : 'ru'), {
        birthDate: U18(),
        locale: i % 2 ? 'en' : 'ru',
        answers: 0,
        interests: 0,
      });
      expect(deck.questions).toHaveLength(35);
      const unsuitable = deck.questions.filter(
        (q) =>
          !t.content.isQuestionAvailable(q.id, {
            band: 'u18',
            mode: 'friends',
            locale: i % 2 ? 'en' : 'ru',
          }),
      );
      expect(unsuitable).toEqual([]);
    }
  });

  it('adults in dating mode can get dating-only takes; the deck is stable per user', async () => {
    const { as, deck } = await onboard(t, newUser(), {
      birthDate: ADULT(),
      dating: true,
      answers: 0,
      interests: 0,
    });
    expect(deck.questions).toHaveLength(35);
    expect((await json<DeckResponse>(as.get('/api/deck'))).questions).toEqual(deck.questions);
  });
});

describe('birth date (Q16) and mode switching (Q10)', () => {
  it('stores nothing but the birth date and status for an under-14 user, and blocks the next steps', async () => {
    const user = newUser();
    const as = t.as(user);
    await json(as.post('/api/onboarding/locale', { locale: 'ru' }));
    const me = await json<MeResponse>(
      as.post('/api/onboarding/birth-date', { birthDate: birthDateYearsAgo(12) }),
    );
    expect(me).toMatchObject({ step: 'ineligible', status: 'ineligible', band: null, mode: null });
    await expectError(as.get('/api/deck'), 403, 'forbidden');
    await expectError(as.get('/api/interests'), 403, 'forbidden');
    await expectError(as.post('/api/onboarding/mode', { mode: 'friends' }), 403, 'forbidden');
    await expectError(
      as.post('/api/onboarding/birth-date', { birthDate: ADULT() }),
      409,
      'conflict',
    );
    const { rows } = await testDb.ownerPool.query<{ id: string } & Record<string, unknown>>(
      'SELECT id, mode, gender, seeking, username, timezone, onboarded_at FROM users WHERE telegram_id = $1',
      [user.id],
    );
    expect(rows[0]).toMatchObject({
      mode: null,
      gender: null,
      seeking: null,
      username: null,
      timezone: null,
      onboarded_at: null,
    });
    const id = rows[0]!.id;
    for (const table of ['answers', 'user_interests']) {
      expect(
        (await testDb.ownerPool.query(`SELECT 1 FROM ${table} WHERE user_id = $1`, [id])).rowCount,
      ).toBe(0);
    }
  });

  it('lets an ineligible user continue from their 14th birthday, still without changing the birth date', async () => {
    const user = newUser();
    // Registered at 13; today is their 14th birthday.
    await insertUser(testDb.appPool, {
      telegramId: user.id,
      birthDate: birthDateYearsAgo(14),
      status: 'ineligible',
    });
    await testDb.ownerPool.query(
      'UPDATE users SET locale_confirmed_at = now() WHERE telegram_id = $1',
      [user.id],
    );
    const as = t.as(user);
    const me = await json<MeResponse>(as.get('/api/me'));
    expect(me).toMatchObject({ status: 'onboarding', band: 'u18', step: 'mode', age: 14 });
    await expectError(
      as.post('/api/onboarding/birth-date', { birthDate: ADULT() }),
      409,
      'conflict',
    );
    expect(
      (await json<MeResponse>(as.post('/api/onboarding/mode', { mode: 'friends' }))).step,
    ).toBe('answers');
  });

  it('lets an adult switch modes; friends clears gender and seeking and keeps answers and interests', async () => {
    const { as, me } = await onboard(t, newUser(), { birthDate: ADULT(), dating: true });
    await json(as.post('/api/onboarding/complete', {}));
    const friends = await json<MeResponse>(as.put('/api/profile/mode', { mode: 'friends' }));
    expect(friends).toMatchObject({ mode: 'friends', gender: null, seeking: null, step: 'done' });
    expect(friends.progress.interests).toBe(me.progress.interests);
    const dating = await json<MeResponse>(
      as.put('/api/profile/mode', {
        mode: 'dating',
        gender: 'g.man',
        seeking: ['g.man', 'g.woman'],
      }),
    );
    expect(dating).toMatchObject({
      mode: 'dating',
      gender: 'g.man',
      seeking: ['g.man', 'g.woman'],
    });
  });

  it('gives dating users a partner age range: own age ±5 by default, never below 18 (Q12)', async () => {
    const { me } = await onboard(t, newUser(), { birthDate: ADULT(), dating: true });
    expect(me.age).toBe(24);
    expect(me).toMatchObject({ datingAgeMin: 19, datingAgeMax: 29 });
    const young = await onboard(t, newUser(), { birthDate: birthDateYearsAgo(18), dating: true });
    expect(young.me).toMatchObject({ age: 18, datingAgeMin: 18, datingAgeMax: 23 });
    const friends = await onboard(t, newUser(), { birthDate: ADULT() });
    expect(friends.me).toMatchObject({ datingAgeMin: null, datingAgeMax: null });
  });

  it('lets a dating user change the range in settings, and validates it', async () => {
    const { as } = await onboard(t, newUser(), { birthDate: ADULT(), dating: true });
    await json(as.post('/api/onboarding/complete', {}));
    const dating = { mode: 'dating', gender: 'g.woman', seeking: ['g.man'] };
    expect(
      await json<MeResponse>(as.put('/api/profile/mode', { ...dating, ageMin: 30, ageMax: 45 })),
    ).toMatchObject({ datingAgeMin: 30, datingAgeMax: 45 });
    // Saving the mode again without a range keeps the stored one.
    expect(
      await json<MeResponse>(as.put('/api/profile/mode', { ...dating, seeking: ['g.woman'] })),
    ).toMatchObject({ seeking: ['g.woman'], datingAgeMin: 30, datingAgeMax: 45 });
    for (const range of [
      { ageMin: 31, ageMax: 30 },
      { ageMin: 17, ageMax: 30 },
      { ageMin: 25 },
      { ageMax: 40 },
      { ageMin: 20, ageMax: 121 },
      { ageMin: 20.5, ageMax: 30 },
    ]) {
      await expectError(as.put('/api/profile/mode', { ...dating, ...range }), 400, 'invalid');
    }
    await expectError(
      as.put('/api/profile/mode', { mode: 'friends', ageMin: 20, ageMax: 30 }),
      400,
      'invalid',
    );
    // Friends clears the range; coming back to dating starts from the default again.
    expect(await json<MeResponse>(as.put('/api/profile/mode', { mode: 'friends' }))).toMatchObject({
      datingAgeMin: null,
      datingAgeMax: null,
    });
    expect(await json<MeResponse>(as.put('/api/profile/mode', dating))).toMatchObject({
      datingAgeMin: 19,
      datingAgeMax: 29,
    });
  });

  it('leaves open matches open when the mode changes, in both directions (Q10)', async () => {
    const user = newUser();
    const { as } = await onboard(t, user, { birthDate: ADULT() });
    await json(as.post('/api/onboarding/complete', {}));
    const { rows } = await testDb.ownerPool.query<{ id: string }>(
      'SELECT id FROM users WHERE telegram_id = $1',
      [user.id],
    );
    const me = rows[0]!.id;
    const statusOf = async (matchId: string) => (await matchRow(testDb.ownerPool, matchId))?.status;

    // An open friends match, then a switch to dating.
    const friend = await insertActiveUser(testDb.appPool, { birthDate: ADULT() });
    const friendsMatch = await insertMatch(testDb.appPool, { a: me, b: friend.id });
    const dating = { mode: 'dating', gender: 'g.woman', seeking: ['g.man'] };
    await json(as.put('/api/profile/mode', dating));
    expect(await statusOf(friendsMatch.id)).toBe('pending_game');

    // An open dating match, then a switch back to friends.
    const date = await insertActiveUser(testDb.appPool, {
      birthDate: ADULT(),
      mode: 'dating',
      gender: 'g.man',
      seeking: ['g.woman'],
    });
    const datingMatch = await insertMatch(testDb.appPool, { a: me, b: date.id, mode: 'dating' });
    await json(as.put('/api/profile/mode', { mode: 'friends' }));
    expect(await statusOf(friendsMatch.id)).toBe('pending_game');
    expect(await statusOf(datingMatch.id)).toBe('pending_game');

    // Both are still listed for the user, and no notification was cancelled along the way.
    const { matches } = await json<{ matches: Array<{ id: string }> }>(as.get('/api/matches'));
    expect(matches.map((m) => m.id).sort()).toEqual([friendsMatch.id, datingMatch.id].sort());
  });

  it('never lets a u18 user switch to dating or see dating options', async () => {
    const { as } = await onboard(t, newUser(), { birthDate: U18() });
    await expectError(
      as.put('/api/profile/mode', { mode: 'dating', gender: 'g.man', seeking: ['g.woman'] }),
      403,
      'forbidden',
    );
    await expectError(as.get('/api/dating-options'), 403, 'forbidden');
  });
});

describe('locale (Q13)', () => {
  it('stores the chosen language and keeps it whatever the Telegram client sends later', async () => {
    const user = newUser('ru');
    await json(t.as(user).post('/api/onboarding/locale', { locale: 'en' }));
    const me = await json<MeResponse>(t.as({ ...user, language_code: 'ru' }).get('/api/me'));
    expect(me.locale).toBe('en');
    expect(
      (await json<MeResponse>(t.as(user).put('/api/profile/locale', { locale: 'ru' }))).locale,
    ).toBe('ru');
  });

  it('renders dating options in the user locale', async () => {
    const { as } = await onboard(t, newUser('en'), {
      birthDate: ADULT(),
      locale: 'en',
      answers: 0,
      interests: 0,
    });
    const body = await json<{ options: Array<{ id: string; self: string; seeking: string }> }>(
      as.get('/api/dating-options'),
    );
    expect(body.options).toEqual([
      { id: 'g.man', self: 'Man', seeking: 'Men' },
      { id: 'g.woman', self: 'Woman', seeking: 'Women' },
    ]);
  });
});
