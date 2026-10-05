/**
 * The chat relay through the real bot (PLAN.md Phase 4): a message written to the bot reaches the
 * other person of the match as a new plain-text message with the sender's alias and the text, and
 * nothing else. Every outgoing Bot API call is recorded by a fake API and checked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock';
import { activeMatchOf, insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_MINIAPP_URL } from '../support/fixtures';
import { matchRow } from '../support/matches';
import { editUpdate, lastIncomingId, mediaUpdate, textUpdate } from '../support/telegram';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

/**
 * Two people whose chat is open. `fox` is user A of the match: the other one sees them as
 * 🦊 Лиса. `owl` is user B: 🦉 Сова.
 */
async function pair(over: Parameters<typeof insertChat>[1] = {}) {
  const chat = await insertChat(testDb.appPool, over);
  return {
    ...chat,
    fox: telegramUser({ id: chat.a, telegramId: chat.telegramA }),
    owl: telegramUser({ id: chat.b, telegramId: chat.telegramB }),
  };
}

const chatFields = async (matchId: string) =>
  (
    await testDb.ownerPool.query<{ status: string; started: boolean; deadline: boolean }>(
      `SELECT status::text AS status, first_message_at IS NOT NULL AS started,
         chat_deadline_at IS NOT NULL AS deadline FROM matches WHERE id = $1`,
      [matchId],
    )
  ).rows[0];

const replyButton = (matchId: string, text = 'Ответить') => ({
  inline_keyboard: [[{ text, callback_data: `c:to:${matchId}` }]],
});

describe('relaying a message', () => {
  it('sends the recipient a new plain-text message: the alias, the text and a reply button', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, a, fox, owl } = await pair();
    expect(await chatFields(matchId)).toEqual({
      status: 'results_ready',
      started: false,
      deadline: true,
    });

    await app.handle(textUpdate(fox, 'привет, как дела?'));
    const sentId = lastIncomingId();

    // One call, and it is sendMessage: nothing is forwarded or copied, and the sender is not
    // answered when a message simply went through.
    expect(app.telegram.calls.map((c) => c.method)).toEqual(['sendMessage']);
    // The whole payload: no parse_mode, no entities, nothing about the sender but the alias.
    expect(app.telegram.calls[0]?.payload).toEqual({
      chat_id: owl.id,
      text: '🦊 Лиса\nпривет, как дела?',
      reply_markup: replyButton(matchId),
      link_preview_options: { is_disabled: true },
    });

    // Stored, delivered, and the first message started the chat: it no longer expires.
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({
        sender_id: a,
        body: 'привет, как дела?',
        verdict: 'delivered',
        reason: null,
        delivered: true,
        sender_tg_message_id: String(sentId),
        recipient_tg_message_id: '5001',
      }),
    ]);
    expect(await chatFields(matchId)).toEqual({ status: 'active', started: true, deadline: false });
  });

  it('never carries the name, the username or the Telegram ID of the sender, and logs no text', async () => {
    const app = await buildChatApp(testDb);
    const { fox, owl } = await pair();
    await app.handle(textUpdate(fox, 'сообщение-раз'));
    await app.handle(textUpdate(owl, 'сообщение-два'));

    const sent = JSON.stringify(app.telegram.calls);
    for (const person of [fox, owl]) {
      expect(sent).not.toContain(person.first_name);
      expect(sent).not.toContain(person.last_name);
      expect(sent).not.toContain(person.username);
    }
    // Each call names exactly one Telegram account: the one it is sent to.
    expect(app.telegram.sentTo(owl.id).map((m) => m.text)).toEqual(['🦊 Лиса\nсообщение-раз']);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual(['🦉 Сова\nсообщение-два']);
    expect(JSON.stringify(app.telegram.sentTo(owl.id))).not.toContain(String(fox.id));
    expect(JSON.stringify(app.telegram.sentTo(fox.id))).not.toContain(String(owl.id));

    const logs = app.logLines().join('\n');
    expect(logs).toContain('message relayed');
    for (const secret of ['сообщение-раз', 'сообщение-два', fox.username, owl.username]) {
      expect(logs).not.toContain(secret);
    }
    for (const person of [fox, owl]) expect(logs).not.toContain(String(person.id));
  });

  it('keeps the match active for every later message, in both directions', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, a, b, fox, owl } = await pair();
    await app.handle(textUpdate(fox, 'раз'));
    await app.handle(textUpdate(owl, 'два'));
    await app.handle(textUpdate(fox, 'три'));
    expect(app.telegram.calls.map((c) => [c.payload['chat_id'], c.payload['text']])).toEqual([
      [owl.id, '🦊 Лиса\nраз'],
      [fox.id, '🦉 Сова\nдва'],
      [owl.id, '🦊 Лиса\nтри'],
    ]);
    expect((await messageRows(testDb.ownerPool, matchId)).map((r) => r.sender_id)).toEqual([
      a,
      b,
      a,
    ]);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');
  });

  it('drops the entities of a message: the recipient gets the characters only', async () => {
    const app = await buildChatApp(testDb);
    const { fox, owl } = await pair();
    await app.handle(
      textUpdate(fox, 'смотри: example.com и жирный текст', {
        entities: [
          { type: 'url', offset: 8, length: 11 },
          { type: 'bold', offset: 22, length: 6 },
        ],
      }),
    );
    const [message] = app.telegram.sentTo(owl.id);
    expect(message?.text).toBe('🦊 Лиса\nсмотри: example.com и жирный текст');
    expect(Object.keys(message?.payload ?? {}).sort()).toEqual([
      'chat_id',
      'link_preview_options',
      'reply_markup',
      'text',
    ]);
  });

  it('keeps line breaks and text that looks like markup or a placeholder as it is', async () => {
    const app = await buildChatApp(testDb);
    const { fox, owl } = await pair();
    const text = 'первая строка\n\n<b>не жирный</b> *и* _это_ {alias} [тоже](нет)';
    await app.handle(textUpdate(fox, text));
    expect(app.telegram.sentTo(owl.id)[0]?.text).toBe(`🦊 Лиса\n${text}`);
  });

  it('relays an update that Telegram delivers twice only once', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    const update = textUpdate(fox, 'один раз');
    await app.handle(update);
    await app.handle({ ...update, update_id: update.update_id + 1000 });
    expect(app.telegram.sentTo(owl.id)).toHaveLength(1);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(1);
    // The duplicate is not answered either.
    expect(app.telegram.sentTo(fox.id)).toEqual([]);
  });

  it('shows the alias and the button in the language of the recipient (Q36: a switch does not stop the chat)', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, a, fox, owl } = await pair();
    // The recipient switched to English after the match was made (Q13: future matches only).
    await testDb.appPool.query("UPDATE users SET locale = 'en' WHERE telegram_id = $1", [owl.id]);
    await app.handle(textUpdate(fox, 'привет'));
    expect(app.telegram.sentTo(owl.id)[0]?.payload).toMatchObject({
      text: '🦊 Fox\nпривет',
      reply_markup: replyButton(matchId, 'Reply'),
    });
    // And the sender, too, can switch and go on.
    await testDb.appPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [a]);
    await app.handle(textUpdate(fox, 'still here'));
    expect(app.telegram.sentTo(owl.id)[1]?.text).toBe('🦊 Fox\nstill here');
  });

  it('stops a chat after a language switch only when the same language is required (Q36)', async () => {
    const app = await buildChatApp(testDb, { params: { requireSameLocale: true } });
    const { matchId, fox, owl } = await pair();
    await app.handle(textUpdate(fox, 'до'));
    await testDb.appPool.query("UPDATE users SET locale = 'en' WHERE telegram_id = $1", [owl.id]);
    app.telegram.clear();
    await app.handle(textUpdate(fox, 'после'));
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Не получилось доставить сообщение. Попробуй ещё раз чуть позже.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(1);
  });
});

describe('a message that is not relayed', () => {
  it('is a message longer than the limit: the sender is told, nothing is stored', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    await app.handle(textUpdate(fox, 'я'.repeat(2001)));
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Слишком длинное сообщение: можно до 2000 символов. Оно не доставлено.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');

    // Exactly at the limit it goes through, emoji counted as one character each.
    await app.handle(textUpdate(fox, '🦊'.repeat(2000)));
    expect(app.telegram.sentTo(owl.id)).toHaveLength(1);
  });

  it.each([
    ['a photo', { photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 1, height: 1 }] }],
    ['a photo with a caption', { photo: [{ file_id: 'p1' }], caption: 'подпись с текстом' }],
    ['a sticker', { sticker: { file_id: 's1', type: 'regular' } }],
    ['a voice message', { voice: { file_id: 'v1', duration: 3 } }],
  ])('is %s: text only, in the adult pool as well (Q19)', async (_name, content) => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    await app.handle(mediaUpdate(fox, content));
    expect(app.telegram.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Пока можно отправлять только текст. Это сообщение не доставлено.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('is an edit: the first version stays, and the sender is told that edits are not passed on', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    await app.handle(textUpdate(fox, 'первая версия'));
    const sentId = lastIncomingId();
    app.telegram.clear();

    await app.handle(editUpdate(fox, sentId, 'вторая версия'));
    expect(app.telegram.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(app.telegram.sentTo(fox.id)[0]?.payload).toMatchObject({
      text: 'Правки не передаются: собеседник видит сообщение таким, каким оно было отправлено. Если нужно, отправь новое.',
      reply_parameters: { message_id: sentId },
    });
    expect((await messageRows(testDb.ownerPool, matchId)).map((r) => r.body)).toEqual([
      'первая версия',
    ]);

    // An edit of something that was never relayed (a command, say) is nobody's business.
    app.telegram.clear();
    await app.handle(editUpdate(fox, 999_999, 'что-то другое'));
    expect(app.telegram.calls).toEqual([]);
  });

  it('is a command the bot does not have: it is answered, never relayed', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    await app.handle(textUpdate(fox, '/leav'));
    await app.handle(textUpdate(fox, '/unknown with words'));
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Такой команды нет. Список команд: /help',
      'Такой команды нет. Список команд: /help',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('is a message from someone the bot does not know, or who has no chat', async () => {
    const app = await buildChatApp(testDb);
    const stranger = telegramUser({ id: 'none', telegramId: 77_000_001 });
    await app.handle(textUpdate(stranger, 'есть кто?'));
    expect(app.telegram.calls.map((c) => c.method)).toEqual(['sendMessage']);
    expect(app.telegram.sentTo(stranger.id)[0]?.payload).toMatchObject({
      text: 'Пока некому писать. Чат открывается, когда готовы результаты игры: загляни в приложение.',
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть SameSync', web_app: { url: TEST_MINIAPP_URL } }]],
      },
    });
  });

  it('is a message beyond the rate limit, until a minute has passed', async () => {
    const clock = fixedClock(new Date());
    const app = await buildChatApp(testDb, { clock, params: { ratePerMinute: 3 } });
    const { matchId, fox, owl } = await pair();
    for (const text of ['1', '2', '3', '4']) await app.handle(textUpdate(fox, text));
    expect(app.telegram.sentTo(owl.id).map((m) => m.text)).toEqual([
      '🦊 Лиса\n1',
      '🦊 Лиса\n2',
      '🦊 Лиса\n3',
    ]);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Слишком много сообщений подряд. Это не доставлено: подожди минуту и отправь ещё раз.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(3);
    // The limit is per sender: the other person is not affected by it.
    await app.handle(textUpdate(owl, 'ответ'));
    expect(app.telegram.sentTo(fox.id)).toHaveLength(2);

    clock.set(new Date(clock.now().getTime() + 61_000));
    await app.handle(textUpdate(fox, '5'));
    expect(app.telegram.sentTo(owl.id)).toHaveLength(4);
  });
});

describe('a message the database cannot store', () => {
  it('is refused as not being text when it carries a NUL character, through the API as well', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    const response = await app
      .as({ id: fox.id, first_name: 'Dev' })
      .post(`/api/matches/${matchId}/messages`, { text: 'секретный текст\u0000' });
    expect(response.status).toBe(400);
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('never puts the text into an error, whatever the database says', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, a } = await pair();
    // Past the relay's own check, straight into the repository: the insert fails in the driver.
    const failure = await app.chat
      .store({
        id: '01999999-9999-7999-8999-999999999999',
        matchId,
        senderId: a,
        body: 'секретный текст\u0000',
        senderTgMessageId: null,
        now: new Date(),
        purgeAfter: new Date(Date.now() + 86_400_000),
      })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.message).toMatch(/^storing a message failed \(/);
    expect(JSON.stringify([failure?.message, failure?.stack, failure?.cause])).not.toContain(
      'секретный',
    );
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
  });
});

describe('delivery', () => {
  it('skips a synthetic recipient: stored and counted as delivered, never sent', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, a, fox } = await pair({ second: { synthetic: true } });
    // The real user is `fox` only if they are user A; make sure who is who.
    const { rows } = await testDb.ownerPool.query<{ id: string; synthetic: boolean }>(
      'SELECT id, synthetic FROM users WHERE id = $1',
      [a],
    );
    expect(rows[0]?.synthetic).toBe(false);

    await app.handle(textUpdate(fox, 'привет, бот'));
    expect(app.telegram.calls).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({
        body: 'привет, бот',
        verdict: 'delivered',
        delivered: true,
        recipient_tg_message_id: null,
      }),
    ]);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');
  });

  it('does not call Telegram for a recipient the bot cannot reach, and tells the sender', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair({ second: { botReachable: false } });
    await app.handle(textUpdate(fox, 'ау'));
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Не получилось доставить сообщение. Попробуй ещё раз чуть позже.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({ verdict: 'rejected', reason: 'unreachable', delivered: false }),
    ]);
    // Nothing arrived, so the chat has not started and can still expire.
    expect(await chatFields(matchId)).toEqual({
      status: 'results_ready',
      started: false,
      deadline: true,
    });
  });

  it('marks a recipient who blocked the bot unreachable, and the message as not delivered', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, b, fox, owl } = await pair();
    app.telegram.answer = (call) =>
      call.payload['chat_id'] === owl.id
        ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }
        : { ok: true };
    await app.handle(textUpdate(fox, 'ау'));
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Не получилось доставить сообщение. Попробуй ещё раз чуть позже.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({ verdict: 'rejected', reason: 'unreachable', delivered: false }),
    ]);
    const { rows } = await testDb.ownerPool.query<{ bot_reachable: boolean }>(
      'SELECT bot_reachable FROM users WHERE id = $1',
      [b],
    );
    expect(rows[0]?.bot_reachable).toBe(false);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
  });

  it('tries once more after a short rate-limit answer, and gives up on a long one', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    let attempts = 0;
    app.telegram.answer = (call) => {
      if (call.payload['chat_id'] !== owl.id) return { ok: true };
      attempts++;
      return attempts === 1
        ? { ok: false, error_code: 429, description: 'Too Many Requests', retry_after: 1 }
        : { ok: true };
    };
    await app.handle(textUpdate(fox, 'со второй попытки'));
    expect(attempts).toBe(2);
    expect(app.telegram.sentTo(fox.id)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({ verdict: 'delivered', delivered: true }),
    ]);

    attempts = 0;
    app.telegram.answer = (call) =>
      call.payload['chat_id'] === owl.id
        ? { ok: false, error_code: 429, description: 'Too Many Requests', retry_after: 30 }
        : { ok: true };
    await app.handle(textUpdate(fox, 'не дойдёт'));
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Не получилось доставить сообщение. Попробуй ещё раз чуть позже.',
    ]);
    expect((await messageRows(testDb.ownerPool, matchId)).at(-1)).toMatchObject({
      verdict: 'rejected',
      reason: 'send_failed',
      delivered: false,
    });
  });

  it('checks the match again before a retry: a chat that ended in between gets nothing', async () => {
    const { matchId, fox, owl } = await pair();
    // The other person leaves while the relay waits to try again.
    const app = await buildChatApp(testDb, {
      onRetryWait: async () => {
        await app.chat.leave((await app.chat.user(owl.id))!.id, matchId, new Date());
      },
    });
    let attempts = 0;
    app.telegram.answer = (call) => {
      if (call.payload['chat_id'] !== owl.id) return { ok: true };
      attempts++;
      return { ok: false, error_code: 429, description: 'Too Many Requests', retry_after: 1 };
    };
    await app.handle(textUpdate(fox, 'успею?'));
    // The first try was answered with "slow down"; the second was never made.
    expect(attempts).toBe(1);
    expect(app.telegram.sentTo(fox.id).map((m) => m.text)).toEqual([
      'Этот чат завершён. Сообщение не доставлено.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({ verdict: 'rejected', reason: 'chat_ended', delivered: false }),
    ]);
  });
});

describe('the first message from the Mini App', () => {
  const send = (
    app: Awaited<ReturnType<typeof buildChatApp>>,
    who: { id: number },
    id: string,
    text: unknown,
  ) => app.as({ id: who.id, first_name: 'Dev' }).post(`/api/matches/${id}/messages`, { text });

  it('goes through the relay, starts the chat and leaves a copy in the sender bot chat', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, a, fox, owl } = await pair();
    const response = await send(app, fox, matchId, 'Я за. А ты почему против?');
    expect(response.status).toBe(200);
    // The answer is the match as it is now. It never carries the message or the other person.
    expect(await response.json()).toMatchObject({
      id: matchId,
      status: 'active',
      chat: true,
      alias: { emoji: '🦉', name: 'Сова' },
      chatDeadlineAt: null,
    });

    expect(app.telegram.calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
    expect(app.telegram.sentTo(owl.id)[0]?.payload).toEqual({
      chat_id: owl.id,
      text: '🦊 Лиса\nЯ за. А ты почему против?',
      reply_markup: replyButton(matchId),
      link_preview_options: { is_disabled: true },
    });
    expect(app.telegram.sentTo(fox.id)[0]?.payload).toEqual({
      chat_id: fox.id,
      text: 'Ты → 🦉 Сова\nЯ за. А ты почему против?',
      link_preview_options: { is_disabled: true },
    });
    // The copy stands for the message in the sender's chat, and the chat is now their active one.
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({
        sender_id: a,
        delivered: true,
        recipient_tg_message_id: '5001',
        sender_tg_message_id: '5002',
      }),
    ]);
    expect(await activeMatchOf(testDb.ownerPool, a)).toBe(matchId);

    // A reply to the copy, and any plain message, continue this chat from the bot.
    await app.handle(textUpdate(fox, 'и ещё вопрос', { replyTo: 5002 }));
    await app.handle(textUpdate(fox, 'и ещё один'));
    expect(app.telegram.sentTo(owl.id).map((m) => m.text)).toEqual([
      '🦊 Лиса\nЯ за. А ты почему против?',
      '🦊 Лиса\nи ещё вопрос',
      '🦊 Лиса\nи ещё один',
    ]);
  });

  it('is delivered even when the copy cannot be sent', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    app.telegram.answer = (call) =>
      call.payload['chat_id'] === fox.id
        ? { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }
        : { ok: true };
    expect((await send(app, fox, matchId, 'привет')).status).toBe(200);
    expect(app.telegram.sentTo(owl.id)).toHaveLength(1);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({ delivered: true, sender_tg_message_id: null }),
    ]);
  });

  it('is refused for anyone who is not in the match, and for a match that does not exist', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, owl } = await pair();
    const other = await pair();
    for (const response of [
      await send(app, other.fox, matchId, 'привет'),
      await send(app, other.fox, '00000000-0000-7000-8000-000000000000', 'привет'),
      await send(app, other.fox, 'not-a-match', 'привет'),
    ]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'not_found' });
    }
    expect(app.telegram.sentTo(owl.id)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('validates the text and the state of the match', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    for (const text of ['', 42, null, 'я'.repeat(2001)]) {
      const response = await send(app, fox, matchId, text);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid' });
    }
    expect(app.telegram.calls).toEqual([]);

    // A chat that has ended answers 409, whoever asks.
    await app.chat.leave((await app.chat.user(owl.id))!.id, matchId, new Date());
    const response = await send(app, fox, matchId, 'привет');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'conflict' });
    expect(app.telegram.calls).toEqual([]);
  });

  it('answers 429 beyond the rate limit and 503 when Telegram does not take the message', async () => {
    const app = await buildChatApp(testDb, { params: { ratePerMinute: 1 } });
    const { matchId, fox, owl } = await pair();
    expect((await send(app, fox, matchId, 'раз')).status).toBe(200);
    const limited = await send(app, fox, matchId, 'два');
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: 'rate_limited' });

    const failing = await buildChatApp(testDb);
    const second = await pair();
    failing.telegram.answer = () => ({ ok: false, error_code: 500, description: 'Internal' });
    const down = await send(failing, second.fox, second.matchId, 'привет');
    expect(down.status).toBe(503);
    expect(await down.json()).toEqual({ error: 'unavailable' });
    expect((await matchRow(testDb.ownerPool, second.matchId))?.status).toBe('results_ready');
    expect(owl.id).not.toBe(second.owl.id);
  });

  it('is refused before the game is finished', async () => {
    const app = await buildChatApp(testDb);
    const { insertGame } = await import('../support/games');
    const { insertActiveUser, insertMatch } = await import('../support/matches');
    const { birthDateYearsAgo } = await import('../support/users');
    const first = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const second = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const match = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    await insertGame(testDb.appPool, match.id);
    const response = await send(app, { id: first.telegramId }, match.id, 'рано');
    expect(response.status).toBe(409);
    expect(app.telegram.calls).toEqual([]);
  });
});
