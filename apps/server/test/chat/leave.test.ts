/**
 * Leaving a chat (PLAN.md Phase 4): /leave closes the match for both. The one who leaves confirms
 * it first, and the other person gets one neutral notice that says the chat has ended, not why.
 * Also here: the command menu of the bot.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMANDS, registerCommands } from '../../src/bot/chat';
import { activeMatchOf, insertAdult, insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertGame } from '../support/games';
import { insertMatch, insertOutbox, matchRow, outboxRow } from '../support/matches';
import { callbackUpdate, fakeTelegram, textUpdate } from '../support/telegram';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

async function pair() {
  const chat = await insertChat(testDb.appPool);
  return {
    ...chat,
    fox: telegramUser({ id: chat.a, telegramId: chat.telegramA }),
    owl: telegramUser({ id: chat.b, telegramId: chat.telegramB }),
  };
}
const press = (app: ChatApp, who: Parameters<typeof callbackUpdate>[0], data: string) =>
  app.handle(callbackUpdate(who, data, { messageId: 7000 }));
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const edits = (app: ChatApp) => app.telegram.of('editMessageText').map((c) => c.payload['text']);

describe('/leave', () => {
  it('asks first, and does nothing when the answer is no', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    await app.handle(textUpdate(fox, '/leave'));
    expect(app.telegram.sentTo(fox.id).map((m) => m.payload)).toEqual([
      {
        chat_id: fox.id,
        text: 'Завершить этот чат (🦉 Сова)? Вернуть его будет нельзя.',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Завершить', callback_data: `c:leave_yes:${matchId}` }],
            [{ text: 'Отмена', callback_data: `c:cancel:${matchId}` }],
          ],
        },
      },
    ]);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');

    await press(app, fox, `c:cancel:${matchId}`);
    expect(edits(app)).toEqual(['Хорошо, ничего не меняю.']);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
    expect(texts(app, owl.id)).toEqual([]);
  });

  it('closes the chat for both, tells the other person once and neutrally, and cancels what was queued', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, a, b, fox, owl } = await pair();
    await app.handle(textUpdate(fox, 'привет'));
    await app.handle(textUpdate(owl, 'привет!'));
    expect(await activeMatchOf(testDb.ownerPool, a)).toBe(matchId);
    // Something about this chat is still waiting to be sent to each of them.
    const queuedForOwl = await insertOutbox(testDb.appPool, {
      userId: b,
      matchId,
      kind: 'reveal_request',
    });
    const queuedForFox = await insertOutbox(testDb.appPool, {
      userId: a,
      matchId,
      kind: 'chat_reminder',
    });
    app.telegram.clear();

    await press(app, fox, `c:leave_yes:${matchId}`);
    expect(edits(app)).toEqual(['Чат завершён (🦉 Сова).']);
    const closed = await matchRow(testDb.ownerPool, matchId);
    expect(closed).toMatchObject({ status: 'closed', close_reason: 'left' });
    expect(closed?.closed_at).not.toBeNull();
    expect(await activeMatchOf(testDb.ownerPool, a)).toBeNull();
    for (const queued of [queuedForOwl, queuedForFox]) {
      expect(await outboxRow(testDb.ownerPool, queued.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'left',
      });
    }

    // The other person hears it from the outbox: once, and without a reason.
    expect(texts(app, owl.id)).toEqual([]);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });
    expect(texts(app, owl.id)).toEqual(['Этот чат завершён (🦊 Лиса).']);
    // The one who left gets no notice about their own leaving.
    expect(texts(app, fox.id)).toEqual([]);

    // Neither of them can write into it any more.
    app.telegram.clear();
    await app.handle(textUpdate(owl, 'ты где?'));
    await app.handle(textUpdate(fox, 'я тут'));
    expect(texts(app, fox.id)).toEqual([
      'Пока некому писать. Чат открывается, когда готовы результаты игры: загляни в приложение.',
    ]);
    expect(texts(app, owl.id)).toEqual(['Этот чат завершён. Сообщение не доставлено.']);
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(2);
  });

  it('says only once that the chat is over, however often the button is pressed', async () => {
    const app = await buildChatApp(testDb);
    const { matchId, fox, owl } = await pair();
    await press(app, fox, `c:leave_yes:${matchId}`);
    await press(app, fox, `c:leave_yes:${matchId}`);
    await press(app, owl, `c:leave_yes:${matchId}`);
    expect(edits(app)).toEqual([
      'Чат завершён (🦉 Сова).',
      'Этот чат завершён.',
      'Этот чат завершён.',
    ]);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, owl.id)).toEqual(['Этот чат завершён (🦊 Лиса).']);
    expect(texts(app, fox.id)).toEqual([]);
  });

  it('with several chats asks which one, then asks to confirm that one', async () => {
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
    await app.chat.setActiveMatch(meRow.id, wolfChat);

    await app.handle(textUpdate(me, '/leave'));
    const [question] = app.telegram.sentTo(me.id);
    expect(question?.text).toBe('Какой чат завершить?');
    const keyboard = (question?.payload['reply_markup'] as { inline_keyboard: unknown[] })
      .inline_keyboard;
    // Even with an active chat the user names the one to end: this can't be undone.
    expect(keyboard).toHaveLength(2);
    expect(keyboard).toEqual(
      expect.arrayContaining([
        [{ text: '🐺 Волк', callback_data: `c:leave:${wolfChat}` }],
        [{ text: '🐻 Медведь', callback_data: `c:leave:${bearChat}` }],
      ]),
    );

    await press(app, me, `c:leave:${bearChat}`);
    expect(app.telegram.of('editMessageText').at(-1)?.payload).toMatchObject({
      text: 'Завершить этот чат (🐻 Медведь)? Вернуть его будет нельзя.',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Завершить', callback_data: `c:leave_yes:${bearChat}` }],
          [{ text: 'Отмена', callback_data: `c:cancel:${bearChat}` }],
        ],
      },
    });
    expect((await matchRow(testDb.ownerPool, bearChat))?.status).toBe('results_ready');

    await press(app, me, `c:leave_yes:${bearChat}`);
    expect((await matchRow(testDb.ownerPool, bearChat))?.status).toBe('closed');
    // The other chat, and where plain messages go, are untouched.
    expect((await matchRow(testDb.ownerPool, wolfChat))?.status).toBe('results_ready');
    expect(await activeMatchOf(testDb.ownerPool, meRow.id)).toBe(wolfChat);
  });

  it('cannot end a chat of other people, or a match whose chat has not opened', async () => {
    const app = await buildChatApp(testDb);
    const { fox } = await pair();
    const others = await pair();
    await press(app, fox, `c:leave_yes:${others.matchId}`);
    await press(app, fox, `c:leave:${others.matchId}`);
    expect(edits(app)).toEqual(['Этот чат завершён.', 'Этот чат завершён.']);
    expect((await matchRow(testDb.ownerPool, others.matchId))?.status).toBe('results_ready');

    // A match that is still being played is not a chat: it is not listed and can't be left.
    const [first, second] = [await insertAdult(testDb.appPool), await insertAdult(testDb.appPool)];
    const playing = await insertMatch(testDb.appPool, { a: first.id, b: second.id });
    await insertGame(testDb.appPool, playing.id);
    const player = telegramUser(first);
    await press(app, player, `c:leave_yes:${playing.id}`);
    expect((await matchRow(testDb.ownerPool, playing.id))?.status).toBe('pending_game');
    app.telegram.clear();
    await app.handle(textUpdate(player, '/leave'));
    expect(texts(app, player.id)).toEqual([
      'Пока некому писать. Чат открывается, когда готовы результаты игры: загляни в приложение.',
    ]);
    // And nobody is told that anything ended.
    const queued = await testDb.ownerPool.query('SELECT 1 FROM outbox WHERE match_id = $1', [
      playing.id,
    ]);
    expect(queued.rowCount).toBe(0);
  });
});

describe('the command menu', () => {
  it('is registered for private chats in each language, with English as the default', async () => {
    const telegram = fakeTelegram();
    await registerCommands(telegram.bot.api);
    const calls = telegram.of('setMyCommands').map((c) => c.payload);
    expect(calls).toHaveLength(3);
    const scope = { type: 'all_private_chats' };
    const names = COMMANDS.map((command) => command);
    expect(names).toEqual([
      'start',
      'chats',
      'leave',
      'reveal',
      'report',
      'block',
      'support',
      'delete',
      'help',
    ]);
    const byLanguage = new Map(calls.map((c) => [c['language_code'], c]));
    expect(byLanguage.get('ru')).toEqual({
      scope,
      language_code: 'ru',
      commands: [
        { command: 'start', description: 'Открыть приложение' },
        { command: 'chats', description: 'Мои чаты' },
        { command: 'leave', description: 'Завершить чат' },
        { command: 'reveal', description: 'Обменяться никами' },
        { command: 'report', description: 'Пожаловаться' },
        { command: 'block', description: 'Заблокировать' },
        { command: 'support', description: 'Написать в поддержку' },
        { command: 'delete', description: 'Удалить аккаунт' },
        { command: 'help', description: 'Что умеет бот' },
      ],
    });
    const english = [
      { command: 'start', description: 'Open the app' },
      { command: 'chats', description: 'My chats' },
      { command: 'leave', description: 'End a chat' },
      { command: 'reveal', description: 'Exchange usernames' },
      { command: 'report', description: 'Report someone' },
      { command: 'block', description: 'Block someone' },
      { command: 'support', description: 'Contact support' },
      { command: 'delete', description: 'Delete account' },
      { command: 'help', description: 'What the bot can do' },
    ];
    expect(byLanguage.get('en')).toEqual({ scope, language_code: 'en', commands: english });
    // Every other client language gets the English menu (Q13).
    expect(byLanguage.get(undefined)).toEqual({ scope, commands: english });
  });

  it('is explained by /help in the language the user chose', async () => {
    const app = await buildChatApp(testDb);
    const { a, fox } = await pair();
    await app.handle(textUpdate(fox, '/help'));
    await testDb.appPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [a]);
    await app.handle(textUpdate(fox, '/help'));
    const [russian, english] = texts(app, fox.id);
    for (const command of COMMANDS) {
      expect(russian).toContain(`/${command}`);
      expect(english).toContain(`/${command}`);
    }
    expect(russian).toContain('Чтобы написать в чат');
    expect(english).toContain('To write in a chat');
  });
});
