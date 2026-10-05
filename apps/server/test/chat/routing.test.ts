/**
 * Routing between several chats in one bot chat (PLAN.md Phase 4, Q24): a reply goes to the chat
 * of the message it answers, everything else to the active chat, and a message that could mean
 * several chats is never guessed: the sender is asked. A chat that has ended is refused politely,
 * and its message is not moved somewhere else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { activeMatchOf, insertAdult, insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_MINIAPP_URL } from '../support/fixtures';
import { callbackUpdate, lastIncomingId, textUpdate } from '../support/telegram';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

/**
 * One person with two open chats. To them the others are 🐺 Волк and 🐻 Медведь; both of the
 * others see them as 🦊 Лиса.
 */
async function world() {
  const [meRow, wolfRow, bearRow] = [
    await insertAdult(testDb.appPool),
    await insertAdult(testDb.appPool),
    await insertAdult(testDb.appPool),
  ];
  const withWolf = await insertChat(testDb.appPool, {
    between: [meRow, wolfRow],
    seenAs: ['a.fox', 'a.wolf'],
  });
  const withBear = await insertChat(testDb.appPool, {
    between: [meRow, bearRow],
    seenAs: ['a.fox', 'a.bear'],
  });
  return {
    meId: meRow.id,
    wolfId: wolfRow.id,
    bearId: bearRow.id,
    me: telegramUser(meRow),
    wolf: telegramUser(wolfRow),
    bear: telegramUser(bearRow),
    wolfChat: withWolf.matchId,
    bearChat: withBear.matchId,
  };
}

const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const button = (text: string, data: string) => [{ text, callback_data: data }];
/** The ID of the bot's message that carried the latest message of a chat to its recipient. */
const lastRelayed = async (matchId: string) =>
  Number((await messageRows(testDb.ownerPool, matchId)).at(-1)?.recipient_tg_message_id);
const press = (
  app: ChatApp,
  who: Parameters<typeof callbackUpdate>[0],
  data: string,
  question = {},
) => app.handle(callbackUpdate(who, data, { messageId: 7000, ...question }));

describe('a message that could mean several chats', () => {
  it('is not guessed: the sender is asked, and the chosen chat becomes the active one', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.handle(textUpdate(w.me, 'кому это?'));
    const asked = lastIncomingId();

    // Nothing went anywhere yet.
    expect(texts(app, w.wolf.id)).toEqual([]);
    expect(texts(app, w.bear.id)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, w.wolfChat)).toEqual([]);
    const [question] = app.telegram.sentTo(w.me.id);
    expect(question?.payload).toMatchObject({
      text: 'Кому отправить это сообщение?',
      reply_parameters: { message_id: asked },
    });
    const keyboard = (question?.payload['reply_markup'] as { inline_keyboard: unknown[] })
      .inline_keyboard;
    expect(keyboard).toHaveLength(2);
    expect(keyboard).toEqual(
      expect.arrayContaining([
        button('🐺 Волк', `c:send:${w.wolfChat}`),
        button('🐻 Медведь', `c:send:${w.bearChat}`),
      ]),
    );

    app.telegram.clear();
    await press(app, w.me, `c:send:${w.wolfChat}`, {
      original: { messageId: asked, text: 'кому это?' },
    });
    expect(texts(app, w.wolf.id)).toEqual(['🦊 Лиса\nкому это?']);
    expect(texts(app, w.bear.id)).toEqual([]);
    expect(app.telegram.of('editMessageText').map((c) => c.payload['text'])).toEqual([
      'Отправлено: 🐺 Волк. Сообщения без ответа теперь идут в этот чат.',
    ]);
    expect(app.telegram.of('answerCallbackQuery')).toHaveLength(1);
    expect(await activeMatchOf(testDb.ownerPool, w.meId)).toBe(w.wolfChat);

    // From now on plain messages go there, without a question and without a note.
    app.telegram.clear();
    await app.handle(textUpdate(w.me, 'дальше без вопросов'));
    expect(app.telegram.calls.map((c) => [c.method, c.payload['chat_id']])).toEqual([
      ['sendMessage', w.wolf.id],
    ]);
  });

  it('is sent once, whichever buttons of the question are pressed afterwards', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.handle(textUpdate(w.me, 'один раз'));
    const asked = lastIncomingId();
    const original = { messageId: asked, text: 'один раз' };
    await press(app, w.me, `c:send:${w.bearChat}`, { original });
    app.telegram.clear();
    await press(app, w.me, `c:send:${w.wolfChat}`, { original });
    await press(app, w.me, `c:send:${w.bearChat}`, { original });
    expect(app.telegram.of('sendMessage')).toEqual([]);
    expect(app.telegram.of('editMessageText').map((c) => c.payload['text'])).toEqual([
      'Это сообщение уже отправлено.',
      'Это сообщение уже отправлено.',
    ]);
    expect(await messageRows(testDb.ownerPool, w.bearChat)).toHaveLength(1);
    expect(await messageRows(testDb.ownerPool, w.wolfChat)).toEqual([]);
  });

  it('needs the message it was asked about, written by the one who presses', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await press(app, w.me, `c:send:${w.wolfChat}`);
    await press(app, w.me, `c:send:${w.wolfChat}`, {
      original: { messageId: 4242, text: 'чужое', fromId: w.bear.id },
    });
    expect(app.telegram.of('sendMessage')).toEqual([]);
    expect(app.telegram.of('editMessageText').map((c) => c.payload['text'])).toEqual([
      'Не вижу исходное сообщение. Отправь его ещё раз.',
      'Не вижу исходное сообщение. Отправь его ещё раз.',
    ]);
  });

  it('is not ambiguous with one open chat: it goes there, and that chat is remembered', async () => {
    const app = await buildChatApp(testDb);
    const chat = await insertChat(testDb.appPool);
    const fox = telegramUser(chat.first);
    await app.handle(textUpdate(fox, 'привет'));
    expect(texts(app, chat.second.telegramId)).toHaveLength(1);
    expect(texts(app, fox.id)).toEqual([]);
    expect(await activeMatchOf(testDb.ownerPool, chat.first.id)).toBe(chat.matchId);
  });
});

describe('a reply and the active chat', () => {
  it('sends a reply to the chat of the message it answers, whatever the active chat is', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.chat.setActiveMatch(w.meId, w.wolfChat);
    // 🐻 writes; the bot's message that carries it is what gets replied to.
    await app.handle(textUpdate(w.bear, 'привет от медведя'));
    const fromBear = await lastRelayed(w.bearChat);
    app.telegram.clear();

    await app.handle(textUpdate(w.me, 'ответ медведю', { replyTo: fromBear }));
    expect(texts(app, w.bear.id)).toEqual(['🦊 Лиса\nответ медведю']);
    expect(texts(app, w.wolf.id)).toEqual([]);
    // The conversation in the bot chat stayed with 🐻: nothing needs saying, and a reply does
    // not change where plain messages go.
    expect(texts(app, w.me.id)).toEqual([]);
    expect(await activeMatchOf(testDb.ownerPool, w.meId)).toBe(w.wolfChat);
  });

  it('sends everything else to the active chat, and says so when the bot chat was elsewhere', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.chat.setActiveMatch(w.meId, w.wolfChat);
    await app.handle(textUpdate(w.bear, 'привет от медведя'));
    app.telegram.clear();

    // The latest message in the bot chat is 🐻's, but the active chat is 🐺.
    await app.handle(textUpdate(w.me, 'это волку'));
    const sent = lastIncomingId();
    expect(texts(app, w.wolf.id)).toEqual(['🦊 Лиса\nэто волку']);
    expect(texts(app, w.bear.id)).toEqual([]);
    expect(app.telegram.sentTo(w.me.id).map((m) => m.payload)).toEqual([
      {
        chat_id: w.me.id,
        text: '→ 🐺 Волк',
        reply_parameters: { message_id: sent },
        disable_notification: true,
      },
    ]);

    // A second message in a row needs no note.
    app.telegram.clear();
    await app.handle(textUpdate(w.me, 'и это волку'));
    expect(texts(app, w.wolf.id)).toEqual(['🦊 Лиса\nи это волку']);
    expect(texts(app, w.me.id)).toEqual([]);
  });

  it('routes a reply to one of the sender own messages to the chat that message went to', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.chat.setActiveMatch(w.meId, w.bearChat);
    await app.handle(textUpdate(w.me, 'первое, медведю'));
    const mine = lastIncomingId();
    await app.chat.setActiveMatch(w.meId, w.wolfChat);
    await app.handle(textUpdate(w.me, 'второе, волку'));
    app.telegram.clear();

    await app.handle(textUpdate(w.me, 'уточнение к первому', { replyTo: mine }));
    expect(texts(app, w.bear.id)).toEqual(['🦊 Лиса\nуточнение к первому']);
    expect(texts(app, w.wolf.id)).toEqual([]);
    // The bot chat was with 🐺 a moment ago: the sender sees where this one went.
    expect(texts(app, w.me.id)).toEqual(['→ 🐻 Медведь']);
  });

  it('treats a reply to anything else like a message that is not a reply', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.chat.setActiveMatch(w.meId, w.bearChat);
    // A reply to a notification of the bot, or to a message of somebody else's chat.
    await app.handle(textUpdate(w.me, 'ответ на уведомление', { replyTo: 123_456 }));
    expect(texts(app, w.bear.id)).toEqual(['🦊 Лиса\nответ на уведомление']);

    const strangers = await insertChat(testDb.appPool);
    await app.handle(textUpdate(telegramUser(strangers.first), 'чужой чат'));
    const foreign = await lastRelayed(strangers.matchId);
    app.telegram.clear();
    await app.handle(textUpdate(w.me, 'не туда', { replyTo: foreign }));
    expect(texts(app, w.bear.id)).toEqual(['🦊 Лиса\nне туда']);
    expect(texts(app, strangers.first.telegramId)).toEqual([]);
    expect(texts(app, strangers.second.telegramId)).toEqual([]);
  });

  it('makes a chat the active one with the button under a message, and with /chats', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await press(app, w.me, `c:to:${w.bearChat}`);
    expect(app.telegram.of('answerCallbackQuery').map((c) => c.payload['text'])).toEqual([
      'Теперь сообщения идут сюда: 🐻 Медведь',
    ]);
    expect(await activeMatchOf(testDb.ownerPool, w.meId)).toBe(w.bearChat);
    await app.handle(textUpdate(w.me, 'медведю'));
    expect(texts(app, w.bear.id)).toEqual(['🦊 Лиса\nмедведю']);

    app.telegram.clear();
    await app.handle(textUpdate(w.me, '/chats'));
    const [list] = app.telegram.sentTo(w.me.id);
    expect(list?.text).toBe('Твои чаты. Нажми на чат, и сообщения без ответа пойдут в него:');
    const keyboard = (list?.payload['reply_markup'] as { inline_keyboard: unknown[] })
      .inline_keyboard;
    expect(keyboard).toHaveLength(2);
    expect(keyboard).toEqual(
      expect.arrayContaining([
        button('✓ 🐻 Медведь', `c:to:${w.bearChat}`),
        button('🐺 Волк', `c:to:${w.wolfChat}`),
      ]),
    );
    // The list itself sends nothing to anyone else.
    expect(texts(app, w.bear.id)).toEqual([]);
    expect(texts(app, w.wolf.id)).toEqual([]);
  });

  it('answers /chats without chats with a way into the app', async () => {
    const app = await buildChatApp(testDb);
    const loner = telegramUser(await insertAdult(testDb.appPool));
    await app.handle(textUpdate(loner, '/chats'));
    expect(app.telegram.sentTo(loner.id)[0]?.payload).toMatchObject({
      text: 'Пока некому писать. Чат открывается, когда готовы результаты игры: загляни в приложение.',
      reply_markup: {
        inline_keyboard: [[{ text: 'Открыть SameSync', web_app: { url: TEST_MINIAPP_URL } }]],
      },
    });
  });
});

describe('a chat that has ended', () => {
  it('is refused politely: a reply into it goes nowhere', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.handle(textUpdate(w.bear, 'привет и пока'));
    const fromBear = await lastRelayed(w.bearChat);
    await app.chat.leave(w.bearId, w.bearChat, new Date());
    app.telegram.clear();

    await app.handle(textUpdate(w.me, 'ты ещё тут?', { replyTo: fromBear }));
    const sent = lastIncomingId();
    expect(texts(app, w.bear.id)).toEqual([]);
    expect(texts(app, w.wolf.id)).toEqual([]);
    expect(app.telegram.sentTo(w.me.id).map((m) => m.payload)).toEqual([
      {
        chat_id: w.me.id,
        text: 'Этот чат завершён. Сообщение не доставлено.',
        reply_parameters: { message_id: sent },
      },
    ]);
    expect(await messageRows(testDb.ownerPool, w.bearChat)).toHaveLength(1);
  });

  it('does not hand its message to another chat: the sender is told, and asked', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.chat.setActiveMatch(w.meId, w.wolfChat);
    await app.handle(textUpdate(w.me, 'привет, волк'));
    await app.chat.leave(w.wolfId, w.wolfChat, new Date());
    app.telegram.clear();

    await app.handle(textUpdate(w.me, 'ты куда?'));
    const asked = lastIncomingId();
    // Not delivered to the one chat that is left, although it is the only one.
    expect(texts(app, w.bear.id)).toEqual([]);
    expect(texts(app, w.wolf.id)).toEqual([]);
    expect(app.telegram.sentTo(w.me.id).map((m) => m.payload)).toEqual([
      {
        chat_id: w.me.id,
        text: 'Этот чат завершён. Отправить сообщение в другой чат?',
        reply_parameters: { message_id: asked },
        reply_markup: { inline_keyboard: [button('🐻 Медведь', `c:send:${w.bearChat}`)] },
      },
    ]);
    expect(await activeMatchOf(testDb.ownerPool, w.meId)).toBeNull();

    // They can still decide to send it there.
    await press(app, w.me, `c:send:${w.bearChat}`, {
      original: { messageId: asked, text: 'ты куда?' },
    });
    expect(texts(app, w.bear.id)).toEqual(['🦊 Лиса\nты куда?']);
    expect(await activeMatchOf(testDb.ownerPool, w.meId)).toBe(w.bearChat);
  });

  it('says that it has ended when no other chat is open', async () => {
    const app = await buildChatApp(testDb);
    const chat = await insertChat(testDb.appPool);
    const [fox, owl] = [telegramUser(chat.first), telegramUser(chat.second)];
    await app.handle(textUpdate(fox, 'привет'));
    await app.chat.leave(chat.second.id, chat.matchId, new Date());
    app.telegram.clear();
    await app.handle(textUpdate(fox, 'эй'));
    expect(texts(app, owl.id)).toEqual([]);
    expect(texts(app, fox.id)).toEqual(['Этот чат завершён. Сообщение не доставлено.']);
    // After that there is simply nobody to write to.
    app.telegram.clear();
    await app.handle(textUpdate(fox, 'эй?'));
    expect(texts(app, fox.id)).toEqual([
      'Пока некому писать. Чат открывается, когда готовы результаты игры: загляни в приложение.',
    ]);
  });

  it('cannot be made the active chat, and cannot be written to through a button', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    await app.chat.leave(w.bearId, w.bearChat, new Date());
    await press(app, w.me, `c:to:${w.bearChat}`);
    expect(app.telegram.of('answerCallbackQuery').map((c) => c.payload['text'])).toEqual([
      'Этот чат завершён.',
    ]);
    expect(await activeMatchOf(testDb.ownerPool, w.meId)).toBeNull();

    await app.handle(textUpdate(w.me, 'в закрытый чат'));
    const asked = lastIncomingId();
    app.telegram.clear();
    await press(app, w.me, `c:send:${w.bearChat}`, {
      original: { messageId: asked, text: 'в закрытый чат' },
    });
    expect(app.telegram.of('sendMessage')).toEqual([]);
    expect(app.telegram.of('editMessageText').map((c) => c.payload['text'])).toEqual([
      'Этот чат завершён. Сообщение не доставлено.',
    ]);
  });
});

describe('buttons', () => {
  it('do nothing for data that is not ours, and nothing for a chat of other people', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    const others = await insertChat(testDb.appPool);
    for (const data of [
      '',
      'garbage',
      'c:to:not-a-uuid',
      'c:delete:' + w.wolfChat,
      'x'.repeat(80),
    ]) {
      await press(app, w.me, data);
    }
    expect(app.telegram.calls.map((c) => c.method)).toEqual(Array(5).fill('answerCallbackQuery'));

    app.telegram.clear();
    await press(app, w.me, `c:to:${others.matchId}`);
    await app.handle(textUpdate(w.me, 'в чужой чат'));
    const asked = lastIncomingId();
    await press(app, w.me, `c:send:${others.matchId}`, {
      original: { messageId: asked, text: 'в чужой чат' },
    });
    // Nothing reaches the two people of that chat, and nothing is stored in it.
    expect(texts(app, others.first.telegramId)).toEqual([]);
    expect(texts(app, others.second.telegramId)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, others.matchId)).toEqual([]);
    expect(await activeMatchOf(testDb.ownerPool, w.meId)).toBeNull();
    expect(app.telegram.of('answerCallbackQuery')[0]?.payload['text']).toBe('Этот чат завершён.');
    expect(app.telegram.of('editMessageText').map((c) => c.payload['text'])).toEqual([
      'Этот чат завершён. Сообщение не доставлено.',
    ]);
  });

  it('are ignored when pressed by someone the bot does not know', async () => {
    const app = await buildChatApp(testDb);
    const w = await world();
    const stranger = telegramUser({ id: 'none', telegramId: 77_000_002 });
    await press(app, stranger, `c:to:${w.wolfChat}`);
    await press(app, stranger, `c:leave_yes:${w.wolfChat}`);
    expect(app.telegram.calls.map((c) => c.method)).toEqual([
      'answerCallbackQuery',
      'answerCallbackQuery',
    ]);
  });
});
