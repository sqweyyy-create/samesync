/**
 * SAFETY SUITE — blocking (PLAN.md Phase 5, Q9). A block ends the chat at once, inside the
 * database: the match closes, its pending notifications are cancelled, the blocked person gets
 * the same neutral notice as after any ending and nothing more, and the pair can never be
 * matched or write to each other again, in either direction. Reachable from a relayed message,
 * from /block and from the Mini App.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activeMatchOf,
  insertAdult,
  insertChat,
  insertMessage,
  messageRows,
  telegramUser,
} from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertMatch, insertOutbox, matchRow, outboxRow } from '../support/matches';
import { callbackUpdate, textUpdate } from '../support/telegram';

// The outbox is shared by everything in a database, so each test gets its own.
let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

/** Two adults who have exchanged a message each. */
async function talking() {
  const app = await buildChatApp(testDb);
  const chat = await insertChat(testDb.appPool);
  const fox = telegramUser({ id: chat.a, telegramId: chat.telegramA });
  const owl = telegramUser({ id: chat.b, telegramId: chat.telegramB });
  await app.handle(textUpdate(fox, 'привет'));
  await app.handle(textUpdate(owl, 'и тебе'));
  const rows = await messageRows(testDb.ownerPool, chat.matchId);
  app.telegram.clear();
  return { ...chat, app, fox, owl, inOwlChat: Number(rows[0]?.recipient_tg_message_id) };
}
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const edits = (app: ChatApp) => app.telegram.of('editMessageText').map((c) => c.payload['text']);
const press = (app: ChatApp, who: ReturnType<typeof telegramUser>, data: string) =>
  app.handle(callbackUpdate(who, data, { messageId: 7000 }));
const blocks = async (matchId: string) =>
  (
    await testDb.ownerPool.query<{ blocker_id: string; blocked_id: string; match_id: string }>(
      'SELECT blocker_id, blocked_id, match_id FROM blocks WHERE match_id = $1 ORDER BY created_at',
      [matchId],
    )
  ).rows;

describe('a block from the button under a relayed message', () => {
  it('asks once, then ends the chat for both, tells the other person neutrally, and is for good', async () => {
    const { app, matchId, a, b, fox, owl } = await talking();
    const pending = await insertOutbox(testDb.appPool, {
      userId: a,
      matchId,
      kind: 'chat_reminder',
    });
    await app.chat.setActiveMatch(b, matchId);

    await press(app, owl, `c:block:${matchId}`);
    expect(app.telegram.of('editMessageText').at(-1)?.payload).toMatchObject({
      text: 'Заблокировать 🦊 Лиса? Чат завершится, и вы больше не встретитесь. Отменить это будет нельзя.',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Заблокировать', callback_data: `c:block_yes:${matchId}` }],
          [{ text: 'Отмена', callback_data: `c:cancel:${matchId}` }],
        ],
      },
    });
    expect(await blocks(matchId)).toEqual([]);

    await press(app, owl, `c:block_yes:${matchId}`);
    expect(edits(app).at(-1)).toBe(
      'Готово. Этот чат завершён, и вы больше не встретитесь (🦊 Лиса).',
    );
    expect(await blocks(matchId)).toEqual([{ blocker_id: b, blocked_id: a, match_id: matchId }]);
    const closed = await matchRow(testDb.ownerPool, matchId);
    expect(closed).toMatchObject({ status: 'closed', close_reason: 'blocked' });
    expect(closed?.closed_at).not.toBeNull();
    expect(await outboxRow(testDb.ownerPool, pending.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'blocked',
    });
    expect(await activeMatchOf(testDb.ownerPool, b)).toBeNull();

    // The blocked person hears only that the chat has ended, once, through the outbox.
    expect(texts(app, fox.id)).toEqual([]);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, fox.id)).toEqual(['Этот чат завершён (🦉 Сова).']);
    expect(JSON.stringify(app.telegram.sentTo(fox.id))).not.toMatch(/блок|block/i);
    expect(texts(app, owl.id)).toEqual([]);

    // Neither can write to the other, and the database agrees.
    app.telegram.clear();
    await app.handle(textUpdate(fox, 'почему?'));
    await app.handle(textUpdate(owl, 'эй'));
    expect(texts(app, fox.id)).toEqual(['Этот чат завершён. Сообщение не доставлено.']);
    // The blocker has no chat left to write in, and hears nothing of the other person.
    expect(texts(app, owl.id)).toEqual([
      'Пока некому писать. Чат открывается, когда готовы результаты игры: загляни в приложение.',
    ]);
    await expect(insertMessage(testDb.appPool, { matchId, senderId: a })).rejects.toMatchObject({
      code: 'SS030',
    });
    await expect(insertMessage(testDb.appPool, { matchId, senderId: b })).rejects.toMatchObject({
      code: 'SS030',
    });
    // Never matched again, in either direction.
    await expect(insertMatch(testDb.appPool, { a, b })).rejects.toMatchObject({
      code: 'SS010',
      message: 'match rejected: blocked',
    });
    // A second block, or one the other way, changes nothing.
    await press(app, owl, `c:block_yes:${matchId}`);
    expect(edits(app).at(-1)).toBe('Уже в блоке (🦊 Лиса).');
    await press(app, fox, `c:block_yes:${matchId}`);
    expect(edits(app).at(-1)).toBe(
      'Готово. Этот чат завершён, и вы больше не встретитесь (🦉 Сова).',
    );
    expect(await blocks(matchId)).toHaveLength(2);
    expect(await app.sender.tick()).toMatchObject({ sent: 0 });
  });

  it("cannot block through someone else's match", async () => {
    const { app, fox } = await talking();
    const others = await talking();
    await press(app, fox, `c:block_yes:${others.matchId}`);
    expect(edits(app).at(-1)).toBe('Сейчас заблокировать не получится.');
    expect(await blocks(others.matchId)).toEqual([]);
    expect((await matchRow(testDb.ownerPool, others.matchId))?.status).toBe('active');
  });

  it('works after the chat has ended too, without telling anyone anything', async () => {
    const { app, matchId, a, b, fox } = await talking();
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [matchId],
    );
    await press(app, fox, `c:block_yes:${matchId}`);
    expect(edits(app).at(-1)).toBe(
      'Готово. Этот чат завершён, и вы больше не встретитесь (🦉 Сова).',
    );
    expect(await blocks(matchId)).toEqual([{ blocker_id: a, blocked_id: b, match_id: matchId }]);
    expect((await matchRow(testDb.ownerPool, matchId))?.close_reason).toBe('left');
    const queued = await testDb.ownerPool.query('SELECT 1 FROM outbox WHERE match_id = $1', [
      matchId,
    ]);
    expect(queued.rowCount).toBe(0);
  });
});

describe('/block', () => {
  it('asks to confirm with one chat, and which one with several', async () => {
    const { app, matchId, fox } = await talking();
    await app.handle(textUpdate(fox, '/block'));
    expect(app.telegram.sentTo(fox.id).at(-1)?.payload).toMatchObject({
      text: 'Заблокировать 🦉 Сова? Чат завершится, и вы больше не встретитесь. Отменить это будет нельзя.',
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Заблокировать', callback_data: `c:block_yes:${matchId}` }],
          [{ text: 'Отмена', callback_data: `c:cancel:${matchId}` }],
        ],
      },
    });
    await press(app, fox, `c:cancel:${matchId}`);
    expect(await blocks(matchId)).toEqual([]);

    const me = await insertAdult(testDb.appPool);
    const wolf = (
      await insertChat(testDb.appPool, {
        between: [me, await insertAdult(testDb.appPool)],
        seenAs: ['a.fox', 'a.wolf'],
      })
    ).matchId;
    const bear = (
      await insertChat(testDb.appPool, {
        between: [me, await insertAdult(testDb.appPool)],
        seenAs: ['a.fox', 'a.bear'],
      })
    ).matchId;
    const user = telegramUser(me);
    await app.handle(textUpdate(user, '/block'));
    const question = app.telegram.sentTo(user.id).at(-1);
    expect(question?.text).toBe('Кого заблокировать?');
    expect(
      (question?.payload['reply_markup'] as { inline_keyboard: unknown[] }).inline_keyboard,
    ).toEqual(
      expect.arrayContaining([
        [{ text: '🐺 Волк', callback_data: `c:block:${wolf}` }],
        [{ text: '🐻 Медведь', callback_data: `c:block:${bear}` }],
      ]),
    );
    await press(app, user, `c:block:${bear}`);
    expect(edits(app).at(-1)).toBe(
      'Заблокировать 🐻 Медведь? Чат завершится, и вы больше не встретитесь. Отменить это будет нельзя.',
    );
    await press(app, user, `c:block_yes:${bear}`);
    expect((await matchRow(testDb.ownerPool, bear))?.close_reason).toBe('blocked');
    expect((await matchRow(testDb.ownerPool, wolf))?.status).toBe('results_ready');
  });

  it('has nobody to block for someone without a chat', async () => {
    const app = await buildChatApp(testDb);
    const stranger = telegramUser({ id: 'none', telegramId: 77_000_009 });
    await app.handle(textUpdate(stranger, '/block'));
    expect(texts(app, stranger.id)).toEqual(['Блокировать некого: чатов нет.']);
  });
});

describe('a block from the Mini App', () => {
  it("answers with the closed match, and 404 for a match that is not the caller's", async () => {
    const { app, matchId, a, fox, owl } = await talking();
    const response = await app
      .as({ id: fox.id, first_name: 'Dev' })
      .post(`/api/matches/${matchId}/block`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      id: matchId,
      status: 'closed',
      alias: { name: 'Сова' },
    });
    expect(await blocks(matchId)).toEqual([expect.objectContaining({ blocker_id: a })]);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, owl.id)).toEqual(['Этот чат завершён (🦊 Лиса).']);

    const others = await talking();
    const forbidden = await app
      .as({ id: fox.id, first_name: 'Dev' })
      .post(`/api/matches/${others.matchId}/block`);
    expect(forbidden.status).toBe(404);
    expect(await blocks(others.matchId)).toEqual([]);
    // Someone who was never matched with them can't be blocked either: a block needs a match.
    const unknown = await app
      .as({ id: fox.id, first_name: 'Dev' })
      .post('/api/matches/not-a-match/block');
    expect(unknown.status).toBe(404);
  });
});
