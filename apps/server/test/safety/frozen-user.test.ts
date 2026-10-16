/**
 * SAFETY SUITE — a frozen user (CLAUDE.md invariant 9; PLAN.md Phase 5). A frozen account gets
 * 403 from every product API (it can still read its own state), can't send or receive relayed
 * messages, is excluded from matching, has its pending notifications cancelled, and can still
 * write to support. After an admin unfreezes it, matching resumes but no old match comes back.
 */
import { randomInt } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertAdult, insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertOutbox, matchRow, outboxRow } from '../support/matches';
import { answersFor, buildMatching, insertPerson, itemsOf, realScope } from '../support/population';
import { textUpdate } from '../support/telegram';

// The outbox is shared by everything in a database, so each test gets its own.
let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

const ADMIN = 900_000_002;
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);

describe('a frozen user', () => {
  it('gets 403 from every product API and can only read its own state', async () => {
    const app = await buildChatApp(testDb, { adminTelegramIds: [ADMIN] });
    const { matchId, a, telegramA } = await insertChat(testDb.appPool);
    const me = telegramUser({ id: a, telegramId: telegramA });
    expect(await app.safety.freeze(a, { admin: ADMIN }, 'test')).toBe('frozen');
    const as = app.as(me);
    const meResponse = await as.get('/api/me');
    expect(meResponse.status).toBe(200);
    expect(await meResponse.json()).toMatchObject({ status: 'frozen' });
    const calls: Array<[string, 'get' | 'post' | 'put', unknown?]> = [
      ['/api/matches', 'get'],
      [`/api/matches/${matchId}`, 'get'],
      [`/api/matches/${matchId}/game`, 'get'],
      [`/api/matches/${matchId}/results`, 'get'],
      [`/api/matches/${matchId}/messages`, 'post', { text: 'привет' }],
      [`/api/matches/${matchId}/report`, 'post', { reason: 'spam' }],
      [`/api/matches/${matchId}/block`, 'post'],
      ['/api/deck', 'get'],
      [
        '/api/profile/answers',
        'put',
        { answers: [{ questionId: 'q.pineapple_pizza', value: 'agree' }] },
      ],
      ['/api/profile/interests', 'put', { itemIds: [] }],
      ['/api/profile/locale', 'put', { locale: 'en' }],
      ['/api/profile/mode', 'put', { mode: 'friends' }],
    ];
    for (const [path, method, body] of calls) {
      const response = await as[method](path, body);
      expect({ path, status: response.status }).toEqual({ path, status: 403 });
      expect(await response.json()).toEqual({ error: 'forbidden' });
    }
    expect(
      app.telegram.of('sendMessage').filter((c) => c.payload['chat_id'] !== telegramA),
    ).toEqual([]);
  });

  it('neither sends nor receives relayed messages, and its pending notifications are cancelled', async () => {
    const app = await buildChatApp(testDb, { adminTelegramIds: [ADMIN] });
    const { matchId, a, b, telegramA, telegramB } = await insertChat(testDb.appPool);
    const fox = telegramUser({ id: a, telegramId: telegramA });
    const owl = telegramUser({ id: b, telegramId: telegramB });
    await app.handle(textUpdate(fox, 'привет'));
    await app.handle(textUpdate(owl, 'привет!'));
    const pending = await insertOutbox(testDb.appPool, {
      userId: a,
      matchId,
      kind: 'chat_reminder',
    });
    app.telegram.clear();

    expect(await app.safety.freeze(a, { admin: ADMIN }, 'test')).toBe('frozen');
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'frozen',
    });
    expect(await outboxRow(testDb.ownerPool, pending.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'frozen',
    });
    await app.handle(textUpdate(fox, 'я заморожен'));
    await app.handle(textUpdate(owl, 'ты где?'));
    expect(texts(app, owl.id)).toEqual(['Этот чат завершён. Сообщение не доставлено.']);
    expect(texts(app, fox.id)).toEqual(['Сейчас отправлять сообщения нельзя.']);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);
    // The one message they still get is the one that says so.
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, fox.id).at(-1)).toContain('Твой аккаунт заморожен');
    // And they can still write to support.
    app.telegram.clear();
    await app.handle(textUpdate(fox, '/support это ошибка'));
    expect(texts(app, fox.id)).toEqual([
      'Сообщение передано в поддержку. Ответ придёт сюда, в этот чат.',
    ]);
    expect(texts(app, ADMIN)[0]).toMatch(/^Поддержка · [0-9A-HJKMNP-TV-Z]{10} \(ru\):\nэто ошибка/);
    // The admin's answer reaches them although they are frozen.
    expect(
      await app.admin.reply(texts(app, ADMIN)[0]!.split(' ')[2]!, 'проверяем', ADMIN),
    ).toMatchObject({ status: 'queued' });
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, fox.id).at(-1)).toBe('Ответ поддержки:\nпроверяем');
  });

  it('is excluded from matching, and matched again after an unfreeze without the old matches coming back', async () => {
    const app = await buildChatApp(testDb, { adminTelegramIds: [ADMIN] });
    const scope = await realScope();
    const profile = {
      items: itemsOf(scope, 'niche').slice(0, 2),
      answers: answersFor(scope, 'ADADADADADADADADADADADADADADAD'),
    };
    const telegramId = randomInt(1, 2 ** 40);
    const me = await insertPerson(testDb.appPool, { ...profile, telegramId });
    // The same tastes, two different views: a match needs something to disagree on.
    const partner = await insertPerson(testDb.appPool, {
      ...profile,
      answers: answersFor(scope, 'ADADADADADADADADADADADADADADDA'),
    });
    const old = await insertAdult(testDb.appPool);
    const oldMatch = await insertChat(testDb.appPool, { between: [me, old] });
    expect(await app.safety.freeze(me.id, { admin: ADMIN }, 'test')).toBe('frozen');

    const { service } = await buildMatching(testDb);
    const pool = { band: 'adult' as const, locale: 'ru' as const };
    const first = await service.run({ pool, mode: 'friends', slot: new Date(Date.now() - 60_000) });
    expect(first).toMatchObject({ status: 'done', pairsCreated: 0 });
    const matchesOf = async (userId: string) =>
      (
        await testDb.ownerPool.query<{ status: string; close_reason: string | null }>(
          'SELECT status::text AS status, close_reason::text AS close_reason FROM matches WHERE user_a_id = $1 OR user_b_id = $1 ORDER BY created_at',
          [userId],
        )
      ).rows;
    expect(await matchesOf(me.id)).toEqual([{ status: 'closed', close_reason: 'frozen' }]);

    expect(await app.safety.unfreeze(me.id, ADMIN, 'checked')).toBe('unfrozen');
    const second = await service.run({ pool, mode: 'friends', slot: new Date() });
    expect(second).toMatchObject({ status: 'done', pairsCreated: 1 });
    expect(await matchesOf(me.id)).toEqual([
      { status: 'closed', close_reason: 'frozen' },
      { status: 'pending_game', close_reason: null },
    ]);
    expect((await matchRow(testDb.ownerPool, oldMatch.matchId))?.close_reason).toBe('frozen');
    expect(partner.id).toBeDefined();
  });
});
