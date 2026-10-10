/**
 * Mutual username reveal in the adult band (PLAN.md Phase 4, Q25): nothing is revealed until both
 * have agreed, the usernames are the ones Telegram reports at that moment, a missing username
 * keeps the consent pending, and a chat that has ended reveals nothing.
 * What can never happen in the u18 band is in test/safety/u18-no-username.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { consentRows, insertAdult, insertChat, insertConsent, telegramUser } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import { matchRow } from '../support/matches';
import { callbackUpdate, textUpdate } from '../support/telegram';

// The outbox is shared by everything in a database, so each test gets its own.
let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

const FOX_NAME = 'fox_on_telegram';
const OWL_NAME = 'owl_on_telegram';

/**
 * Two adults in an open chat. `fox` is user A (🦊 Лиса to the other one), `owl` is user B
 * (🦉 Сова). Telegram knows a username for each unless a test removes it.
 */
async function pair(options: Parameters<typeof buildChatApp>[1] = {}, chatOver = {}) {
  const app = await buildChatApp(testDb, options);
  const chat = await insertChat(testDb.appPool, chatOver);
  const fox = telegramUser({ id: chat.a, telegramId: chat.telegramA });
  const owl = telegramUser({ id: chat.b, telegramId: chat.telegramB });
  app.telegram.usernames.set(fox.id, FOX_NAME);
  app.telegram.usernames.set(owl.id, OWL_NAME);
  return { ...chat, app, fox, owl };
}

const press = (app: ChatApp, who: TestUser, data: string) =>
  app.handle(callbackUpdate(who, data, { messageId: 7000 }));
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const lastEdit = (app: ChatApp) => app.telegram.of('editMessageText').at(-1)?.payload['text'];
const everythingSent = (app: ChatApp) =>
  JSON.stringify(app.telegram.calls.filter((c) => c.method !== 'getChat'));
const agreeOrNot = (matchId: string) => ({
  inline_keyboard: [
    [
      { text: 'Согласиться', callback_data: `c:reveal_yes:${matchId}` },
      { text: 'Не сейчас', callback_data: `c:reveal_no:${matchId}` },
    ],
  ],
});
const outboxOf = async (matchId: string) =>
  (
    await testDb.ownerPool.query<{
      kind: string;
      status: string;
      cancel_reason: string | null;
      payload: unknown;
    }>(
      `SELECT kind::text AS kind, status::text AS status, cancel_reason, payload FROM outbox
       WHERE match_id = $1 ORDER BY created_at, kind, user_id`,
      [matchId],
    )
  ).rows;

describe('revealing usernames', () => {
  it('needs both to agree: one consent reveals nothing and asks the other person', async () => {
    const { app, matchId, a, b, fox, owl } = await pair();

    await app.handle(textUpdate(fox, '/reveal'));
    expect(app.telegram.sentTo(fox.id).map((m) => m.payload)).toEqual([
      {
        chat_id: fox.id,
        text: 'Обменяться никами в Telegram (🦉 Сова)? Ники откроются, только если согласятся обе стороны.',
        reply_markup: agreeOrNot(matchId),
      },
    ]);
    // Asking is not agreeing.
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([]);

    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(lastEdit(app)).toBe(
      'Твоё согласие записано. Ники откроются, когда придёт второе согласие (🦉 Сова).',
    );
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: a, revealed: false }]);

    // The other person is asked, by alias. No username has gone anywhere.
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(app.telegram.sentTo(owl.id).map((m) => m.payload)).toEqual([
      expect.objectContaining({
        text: '🦊 Лиса предлагает обменяться никами в Telegram. Ники откроются, только если согласятся обе стороны.',
        reply_markup: agreeOrNot(matchId),
      }),
    ]);
    expect(everythingSent(app)).not.toContain(FOX_NAME);
    expect(everythingSent(app)).not.toContain(OWL_NAME);

    app.telegram.clear();
    await press(app, owl, `c:reveal_yes:${matchId}`);
    expect(lastEdit(app)).toBe('Согласие есть с обеих сторон. Сейчас пришлю ник (🦊 Лиса).');
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual(
      [a, b].sort().map((user_id) => ({ user_id, revealed: true })),
    );
    // Still nothing with a username in it: that is the outbox sender's one message.
    expect(everythingSent(app)).not.toContain(FOX_NAME);
    expect(everythingSent(app)).not.toContain(OWL_NAME);

    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    expect(app.telegram.sentTo(fox.id).map((m) => m.payload)).toEqual([
      expect.objectContaining({ text: `🦉 Сова в Telegram: @${OWL_NAME}` }),
    ]);
    expect(app.telegram.sentTo(owl.id).map((m) => m.payload)).toEqual([
      expect.objectContaining({ text: `🦊 Лиса в Telegram: @${FOX_NAME}` }),
    ]);
    // Each got the other's username, not their own, and no buttons.
    expect(texts(app, fox.id).join()).not.toContain(FOX_NAME);
    expect(texts(app, owl.id).join()).not.toContain(OWL_NAME);
    expect(app.telegram.sentTo(fox.id)[0]?.payload).not.toHaveProperty('reply_markup');

    // Once: nothing more is ever sent about it.
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });
    app.telegram.clear();
    await app.handle(textUpdate(fox, '/reveal'));
    await press(app, owl, `c:reveal_yes:${matchId}`);
    expect(texts(app, fox.id)).toEqual(['Вы уже обменялись никами (🦉 Сова).']);
    expect(lastEdit(app)).toBe('Вы уже обменялись никами (🦊 Лиса).');
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });

    // Q25: the chat stays open after a reveal, and still shows aliases only.
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
    app.telegram.clear();
    await app.handle(textUpdate(fox, 'теперь можно и тут'));
    expect(texts(app, owl.id)).toEqual(['🦊 Лиса\nтеперь можно и тут']);
  });

  it('stores nothing but the two consents: no username in the database or the logs', async () => {
    const { app, matchId, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    await app.sender.tick();
    const queued = await outboxOf(matchId);
    expect(queued.map((r) => [r.kind, r.status]).sort()).toEqual([
      ['reveal_done', 'sent'],
      ['reveal_done', 'sent'],
      // The request to the second person was overtaken by their own consent.
      ['reveal_request', 'cancelled'],
    ]);
    expect(queued.every((r) => JSON.stringify(r.payload) === '{}')).toBe(true);
    const logs = app.logLines().join('\n');
    expect(logs).toContain('usernames revealed');
    for (const secret of [FOX_NAME, OWL_NAME]) expect(logs).not.toContain(secret);
  });

  it('uses the username Telegram reports when the message is sent, not one seen earlier', async () => {
    const { app, matchId, a, fox, owl } = await pair();
    // What the bot saw on an earlier update, and stored for the adult user.
    await app.handle(textUpdate({ ...fox, username: 'old_fox_name' }, '/help'));
    const stored = await testDb.ownerPool.query<{ username: string }>(
      'SELECT username FROM users WHERE id = $1',
      [a],
    );
    expect(stored.rows[0]?.username).toBe('old_fox_name');

    await press(app, fox, `c:reveal_yes:${matchId}`);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    // …and the username changes once more before the message goes out.
    app.telegram.usernames.set(fox.id, 'newest_fox_name');
    await app.sender.tick();
    expect(texts(app, owl.id).at(-1)).toBe('🦊 Лиса в Telegram: @newest_fox_name');
    expect(everythingSent(app)).not.toContain('old_fox_name');
    expect(everythingSent(app)).not.toContain(FOX_NAME);
  });

  it('keeps a consent pending while its owner has no username, and asks nobody yet', async () => {
    const { app, matchId, a, b, fox, owl } = await pair();
    app.telegram.usernames.delete(fox.id);

    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(lastEdit(app)).toBe(
      'У тебя в Telegram не задано имя пользователя, поэтому обменяться пока нечем. Задай его в настройках Telegram и отправь /reveal ещё раз: твоё согласие сохранено.',
    );
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: a, revealed: false }]);
    expect(await outboxOf(matchId)).toEqual([]);

    // With a username, /reveal picks the consent up where it stopped.
    app.telegram.usernames.set(fox.id, FOX_NAME);
    app.telegram.clear();
    await app.handle(textUpdate(fox, '/reveal'));
    expect(texts(app, fox.id)).toEqual([
      'Твоё согласие записано. Ники откроются, когда придёт второе согласие (🦉 Сова).',
    ]);
    expect((await outboxOf(matchId)).map((r) => r.kind)).toEqual(['reveal_request']);

    // The second person has none either: their consent waits, and nothing is revealed.
    app.telegram.usernames.delete(owl.id);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    expect(lastEdit(app)).toContain('У тебя в Telegram не задано имя пользователя');
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual(
      [a, b].sort().map((user_id) => ({ user_id, revealed: false })),
    );
    await app.sender.tick();
    expect(everythingSent(app)).not.toContain(FOX_NAME);

    app.telegram.usernames.set(owl.id, OWL_NAME);
    app.telegram.clear();
    await app.handle(textUpdate(owl, '/reveal'));
    expect(texts(app, owl.id)).toEqual([
      'Согласие есть с обеих сторон. Сейчас пришлю ник (🦊 Лиса).',
    ]);
    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    expect(texts(app, fox.id).at(-1)).toBe(`🦉 Сова в Telegram: @${OWL_NAME}`);
    expect(texts(app, owl.id).at(-1)).toBe(`🦊 Лиса в Telegram: @${FOX_NAME}`);
  });

  it('does not reveal one side only when the other person has lost their username meanwhile', async () => {
    const { app, matchId, a, b, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    app.telegram.usernames.delete(fox.id);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    expect(lastEdit(app)).toBe(
      'Пока не получилось: у второй стороны сейчас нет имени пользователя в Telegram (🦊 Лиса). Попробуй позже: /reveal.',
    );
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual(
      [a, b].sort().map((user_id) => ({ user_id, revealed: false })),
    );
    await app.sender.tick();
    expect(everythingSent(app)).not.toContain(OWL_NAME);
    expect(texts(app, fox.id).join()).not.toContain('в Telegram: @');
  });

  it('drops the one message whose username is gone when it is about to be sent', async () => {
    const { app, matchId, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    app.telegram.usernames.delete(fox.id);
    app.telegram.clear();
    expect(await app.sender.tick()).toMatchObject({ sent: 1, cancelled: 2 });
    expect(texts(app, fox.id)).toEqual([`🦉 Сова в Telegram: @${OWL_NAME}`]);
    expect(texts(app, owl.id)).toEqual([]);
    expect((await outboxOf(matchId)).map((r) => [r.kind, r.status, r.cancel_reason])).toEqual(
      expect.arrayContaining([['reveal_done', 'cancelled', 'username_missing']]),
    );
  });

  it('treats a failing getChat like a missing username', async () => {
    const { app, matchId, fox } = await pair();
    app.telegram.answer = (call) =>
      call.method === 'getChat'
        ? { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
        : { ok: true };
    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(lastEdit(app)).toContain('У тебя в Telegram не задано имя пользователя');
    expect(await outboxOf(matchId)).toEqual([]);
  });
});

describe('"Not now"', () => {
  it('changes nothing and tells nobody, and can be taken back with /reveal', async () => {
    const { app, matchId, a, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await app.sender.tick();
    app.telegram.clear();

    await press(app, owl, `c:reveal_no:${matchId}`);
    expect(lastEdit(app)).toBe(
      'Хорошо, ники остаются скрытыми. Если передумаешь, отправь /reveal.',
    );
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: a, revealed: false }]);
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });
    expect(texts(app, fox.id)).toEqual([]);

    // Later the second person asks themselves: they see the standing request, and can agree.
    app.telegram.clear();
    await app.handle(textUpdate(owl, '/reveal'));
    expect(app.telegram.sentTo(owl.id).map((m) => m.payload)).toEqual([
      {
        chat_id: owl.id,
        text: '🦊 Лиса предлагает обменяться никами в Telegram. Ники откроются, только если согласятся обе стороны.',
        reply_markup: agreeOrNot(matchId),
      },
    ]);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    expect(texts(app, fox.id)).toEqual([`🦉 Сова в Telegram: @${OWL_NAME}`]);
  });

  it('is asked of the other person only once, however often the first one repeats the request', async () => {
    const { app, matchId, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await app.handle(textUpdate(fox, '/reveal'));
    await app.sender.tick();
    await app.handle(textUpdate(fox, '/reveal'));
    await app.sender.tick();
    expect(texts(app, owl.id)).toHaveLength(1);
    expect((await outboxOf(matchId)).map((r) => r.kind)).toEqual(['reveal_request']);
  });
});

describe('"Передумать" (Q38): a consent can be taken back until the reveal', () => {
  const withdrawRow = (matchId: string) => ({
    inline_keyboard: [[{ text: 'Передумать', callback_data: `c:reveal_withdraw:${matchId}` }]],
  });
  const WITHDRAWN =
    'Хорошо, согласие отозвано: ники остаются скрытыми (🦉 Сова). Если передумаешь снова, отправь /reveal.';
  const REQUEST_FROM_OWL =
    '🦉 Сова предлагает обменяться никами в Telegram. Ники откроются, только если согласятся обе стороны.';
  /** Moves the clock on: a consent is told from an earlier one of the same person by its time. */
  const later = (app: ChatApp, ms: number) =>
    (app.clock as { set(next: Date): void }).set(new Date(app.clock.now().getTime() + ms));

  it('is offered under every answer that leaves a consent standing, and never after the reveal', async () => {
    const { app, matchId, a, b, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(app.telegram.of('editMessageText').at(-1)?.payload).toMatchObject({
      text: 'Твоё согласие записано. Ники откроются, когда придёт второе согласие (🦉 Сова).',
      reply_markup: withdrawRow(matchId),
    });
    // /reveal shows the standing consent with the same button.
    app.telegram.clear();
    await app.handle(textUpdate(fox, '/reveal'));
    expect(app.telegram.sentTo(fox.id).map((m) => m.payload)).toEqual([
      expect.objectContaining({ reply_markup: withdrawRow(matchId) }),
    ]);
    // A consent that waits for its owner's username stands too.
    app.telegram.usernames.delete(owl.id);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    const needed = app.telegram.of('editMessageText').at(-1)?.payload;
    expect(needed?.['text']).toContain('У тебя в Telegram не задано имя пользователя');
    expect(needed?.['reply_markup']).toEqual(withdrawRow(matchId));
    // So does one that waits for the other person's username.
    app.telegram.usernames.set(owl.id, OWL_NAME);
    app.telegram.usernames.delete(fox.id);
    app.telegram.clear();
    await app.handle(textUpdate(owl, '/reveal'));
    const [missing] = app.telegram.sentTo(owl.id);
    expect(missing?.text).toContain('Пока не получилось');
    expect(missing?.payload['reply_markup']).toEqual(withdrawRow(matchId));
    // Once the reveal has happened there is nothing to take back, and no button.
    app.telegram.usernames.set(fox.id, FOX_NAME);
    app.telegram.clear();
    await app.handle(textUpdate(owl, '/reveal'));
    const [onTheWay] = app.telegram.sentTo(owl.id);
    expect(onTheWay?.text).toBe('Согласие есть с обеих сторон. Сейчас пришлю ник (🦊 Лиса).');
    expect(onTheWay?.payload).not.toHaveProperty('reply_markup');
    await app.handle(textUpdate(fox, '/reveal'));
    const already = app.telegram.sentTo(fox.id).at(-1);
    expect(already?.text).toBe('Вы уже обменялись никами (🦉 Сова).');
    expect(already?.payload).not.toHaveProperty('reply_markup');
    // A forged button changes nothing either.
    await press(app, fox, `c:reveal_withdraw:${matchId}`);
    expect(lastEdit(app)).toBe('Вы уже обменялись никами (🦉 Сова).');
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual(
      [a, b].sort().map((user_id) => ({ user_id, revealed: true })),
    );
    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
  });

  it('removes the consent and tells the other person nothing; their question stays answerable', async () => {
    const { app, matchId, a, b, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    app.telegram.clear();

    await press(app, fox, `c:reveal_withdraw:${matchId}`);
    expect(lastEdit(app)).toBe(WITHDRAWN);
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([]);
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });
    expect(texts(app, owl.id)).toEqual([]);
    // Again: there is nothing to take back.
    await press(app, fox, `c:reveal_withdraw:${matchId}`);
    expect(lastEdit(app)).toBe(
      'Хорошо, ники остаются скрытыми. Если передумаешь, отправь /reveal.',
    );
    // /reveal is an offer again.
    app.telegram.clear();
    await app.handle(textUpdate(fox, '/reveal'));
    expect(app.telegram.sentTo(fox.id)[0]?.payload).toMatchObject({
      text: 'Обменяться никами в Telegram (🦉 Сова)? Ники откроются, только если согласятся обе стороны.',
      reply_markup: agreeOrNot(matchId),
    });

    // The owl still has the question in their chat. Agreeing now is a consent of their own, and
    // the fox, who has none any more, is the one who is asked.
    app.telegram.clear();
    await press(app, owl, `c:reveal_yes:${matchId}`);
    expect(lastEdit(app)).toBe(
      'Твоё согласие записано. Ники откроются, когда придёт второе согласие (🦊 Лиса).',
    );
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: b, revealed: false }]);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, fox.id)).toEqual([REQUEST_FROM_OWL]);
    expect(everythingSent(app)).not.toContain(FOX_NAME);
    expect(everythingSent(app)).not.toContain(OWL_NAME);

    // And agreeing again reveals, as it would have the first time.
    app.telegram.clear();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    expect(texts(app, fox.id)).toEqual([`🦉 Сова в Telegram: @${OWL_NAME}`]);
    expect(texts(app, owl.id)).toEqual([`🦊 Лиса в Telegram: @${FOX_NAME}`]);
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual(
      [a, b].sort().map((user_id) => ({ user_id, revealed: true })),
    );
  });

  it('asks the other person once when a consent is taken back and given again before the question went out', async () => {
    const { app, matchId, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await press(app, fox, `c:reveal_withdraw:${matchId}`);
    later(app, 1000);
    await press(app, fox, `c:reveal_yes:${matchId}`);
    // Two questions were queued; the first goes out, the second is dropped for it.
    expect(await app.sender.tick()).toMatchObject({ sent: 1, cancelled: 1 });
    expect(texts(app, owl.id)).toHaveLength(1);
    expect((await outboxOf(matchId)).map((r) => [r.kind, r.status, r.cancel_reason])).toEqual([
      ['reveal_request', 'sent', null],
      ['reveal_request', 'cancelled', 'already_asked'],
    ]);
  });

  it('asks the other person when the question of the first consent was dropped before it went out', async () => {
    const { app, matchId, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await press(app, fox, `c:reveal_withdraw:${matchId}`);
    expect(await app.sender.tick()).toMatchObject({ sent: 0, cancelled: 1 });
    expect(texts(app, owl.id)).toEqual([]);
    later(app, 1000);
    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, owl.id)).toHaveLength(1);
    expect((await outboxOf(matchId)).map((r) => [r.kind, r.status, r.cancel_reason])).toEqual([
      ['reveal_request', 'cancelled', 'outdated'],
      ['reveal_request', 'sent', null],
    ]);
  });

  it('never asks the other person twice in one match', async () => {
    const { app, matchId, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    for (const step of [1, 2]) {
      await press(app, fox, `c:reveal_withdraw:${matchId}`);
      later(app, 1000 * step);
      await press(app, fox, `c:reveal_yes:${matchId}`);
      await app.handle(textUpdate(fox, '/reveal'));
    }
    expect(await app.sender.tick()).toMatchObject({ sent: 0, cancelled: 2 });
    expect(texts(app, owl.id)).toHaveLength(1);
    expect((await outboxOf(matchId)).map((r) => r.status)).toEqual([
      'sent',
      'cancelled',
      'cancelled',
    ]);
  });

  it('is not available for a chat of other people or a chat that has ended', async () => {
    const { app, matchId, fox, owl } = await pair();
    const others = await insertChat(testDb.appPool);
    await insertConsent(testDb.appPool, others.matchId, others.a);
    await press(app, fox, `c:reveal_withdraw:${others.matchId}`);
    expect(lastEdit(app)).toBe('Обмен никами недоступен.');
    expect(await consentRows(testDb.ownerPool, others.matchId)).toHaveLength(1);

    await press(app, fox, `c:reveal_yes:${matchId}`);
    await app.chat.leave((await app.chat.user(owl.id))!.id, matchId, app.clock.now());
    await press(app, fox, `c:reveal_withdraw:${matchId}`);
    expect(lastEdit(app)).toBe('Обмен никами недоступен.');
  });
});

describe('a chat that is not open', () => {
  it('reveals nothing once it has ended, whatever was agreed before', async () => {
    const { app, matchId, a, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await app.chat.leave((await app.chat.user(owl.id))!.id, matchId, app.clock.now());
    app.telegram.clear();

    await press(app, owl, `c:reveal_yes:${matchId}`);
    await press(app, fox, `c:reveal_yes:${matchId}`);
    expect(app.telegram.of('editMessageText').map((c) => c.payload['text'])).toEqual([
      'Обмен никами недоступен.',
      'Обмен никами недоступен.',
    ]);
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([{ user_id: a, revealed: false }]);
    await app.sender.tick();
    expect(everythingSent(app)).not.toContain(FOX_NAME);
    expect(everythingSent(app)).not.toContain(OWL_NAME);
    // With no open chat left, /reveal has nothing to offer.
    app.telegram.clear();
    await app.handle(textUpdate(fox, '/reveal'));
    expect(texts(app, fox.id)).toEqual([
      'Обменяться никами можно в открытом чате, а его пока нет.',
    ]);
  });

  it('does not send a username for a chat that ended after both had agreed', async () => {
    const { app, matchId, fox, owl } = await pair();
    await press(app, fox, `c:reveal_yes:${matchId}`);
    await press(app, owl, `c:reveal_yes:${matchId}`);
    // The outbox has not run yet when one of them leaves.
    await app.chat.leave((await app.chat.user(fox.id))!.id, matchId, app.clock.now());
    app.telegram.clear();
    await app.sender.tick();
    expect(everythingSent(app)).not.toContain(FOX_NAME);
    expect(everythingSent(app)).not.toContain(OWL_NAME);
    expect(texts(app, owl.id)).toEqual(['Этот чат завершён (🦊 Лиса).']);
    expect(
      (await outboxOf(matchId)).filter((r) => r.kind === 'reveal_done').map((r) => r.status),
    ).toEqual(['cancelled', 'cancelled']);
  });

  it('is not offered for a chat of other people', async () => {
    const { app, fox } = await pair();
    const others = await insertChat(testDb.appPool);
    await press(app, fox, `c:reveal_yes:${others.matchId}`);
    await press(app, fox, `c:reveal:${others.matchId}`);
    expect(app.telegram.of('editMessageText').map((c) => c.payload['text'])).toEqual([
      'Обмен никами недоступен.',
      'Обмен никами недоступен.',
    ]);
    expect(await consentRows(testDb.ownerPool, others.matchId)).toEqual([]);
    expect(await outboxOf(others.matchId)).toEqual([]);
  });
});

describe('/reveal with several chats', () => {
  it('asks with whom, and then asks to agree for that chat only', async () => {
    const app = await buildChatApp(testDb);
    const [meRow, wolfRow, bearRow] = [
      await insertAdult(testDb.appPool),
      await insertAdult(testDb.appPool),
      await insertAdult(testDb.appPool),
    ];
    const wolfChat = (
      await insertChat(testDb.appPool, { between: [meRow, wolfRow], seenAs: ['a.fox', 'a.wolf'] })
    ).matchId;
    const bearChat = (
      await insertChat(testDb.appPool, { between: [meRow, bearRow], seenAs: ['a.fox', 'a.bear'] })
    ).matchId;
    const me = telegramUser(meRow);
    app.telegram.usernames.set(me.id, 'me_on_telegram');
    await app.chat.setActiveMatch(meRow.id, wolfChat);

    await app.handle(textUpdate(me, '/reveal'));
    const [question] = app.telegram.sentTo(me.id);
    expect(question?.text).toBe('С кем обменяться никами?');
    expect(
      (question?.payload['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard,
    ).toEqual(
      expect.arrayContaining([
        [{ text: '🐺 Волк', callback_data: `c:reveal:${wolfChat}` }],
        [{ text: '🐻 Медведь', callback_data: `c:reveal:${bearChat}` }],
      ]),
    );
    expect(await consentRows(testDb.ownerPool, wolfChat)).toEqual([]);

    await press(app, me, `c:reveal:${bearChat}`);
    expect(app.telegram.of('editMessageText').at(-1)?.payload).toMatchObject({
      text: 'Обменяться никами в Telegram (🐻 Медведь)? Ники откроются, только если согласятся обе стороны.',
      reply_markup: agreeOrNot(bearChat),
    });
    await press(app, me, `c:reveal_yes:${bearChat}`);
    expect(await consentRows(testDb.ownerPool, bearChat)).toEqual([
      { user_id: meRow.id, revealed: false },
    ]);
    // The other chat knows nothing about it.
    expect(await consentRows(testDb.ownerPool, wolfChat)).toEqual([]);
    await app.sender.tick();
    expect(texts(app, wolfRow.telegramId)).toEqual([]);
    expect(texts(app, bearRow.telegramId)).toHaveLength(1);
  });
});

describe('a synthetic counterpart (development tooling)', () => {
  it('has the development username, so one account can try the whole flow', async () => {
    const { app, matchId, a, fox } = await pair(
      { syntheticUsername: 'synthetic_user' },
      { second: { synthetic: true } },
    );
    await press(app, fox, `c:reveal_yes:${matchId}`);
    // The synthetic side agrees through the same service the bot uses.
    const synthetic = (await consentRows(testDb.ownerPool, matchId)).length;
    expect(synthetic).toBe(1);
    const { rows } = await testDb.ownerPool.query<{ id: string }>(
      'SELECT id FROM users WHERE id <> $1 AND synthetic',
      [a],
    );
    expect(await app.reveal.consent(rows[0]!.id, matchId)).toMatchObject({ status: 'revealed' });
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, fox.id)).toEqual(['🦉 Сова в Telegram: @synthetic_user']);
    // Nothing is ever sent to the synthetic user, and Telegram is never asked about them:
    // every call that names a chat names the real user's.
    const chats = app.telegram.calls.map((c) => c.payload['chat_id']).filter((id) => id);
    expect(new Set(chats)).toEqual(new Set([fox.id]));
  });

  it('has no username where development tooling is off, so nothing is revealed', async () => {
    const { app, matchId, a, fox } = await pair({}, { second: { synthetic: true } });
    await press(app, fox, `c:reveal_yes:${matchId}`);
    const { rows } = await testDb.ownerPool.query<{ id: string }>(
      'SELECT id FROM users WHERE id <> $1 AND synthetic',
      [a],
    );
    expect(await app.reveal.consent(rows[0]!.id, matchId)).toEqual({ status: 'username_needed' });
    await app.sender.tick();
    expect(everythingSent(app)).not.toContain('в Telegram: @');
  });
});
