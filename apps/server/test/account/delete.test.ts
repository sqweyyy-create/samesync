/**
 * Account deletion (PLAN.md Phase 5, Q23 provisional): /delete asks once, then the profile is
 * anonymized, the answers and interests are removed, every open match closes and every pending
 * notification is cancelled, the API and the relay refuse the account, and the reports and audit
 * rows about it stay. The birth date and the Telegram ID stay, so nobody starts over.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertAdult, insertChat, telegramUser } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertOutbox, matchRow, outboxRow } from '../support/matches';
import { insertPerson, realScope, answersFor, itemsOf } from '../support/population';
import { callbackUpdate, textUpdate } from '../support/telegram';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const edits = (app: ChatApp) => app.telegram.of('editMessageText').map((c) => c.payload['text']);
const CONFIRM =
  'Удалить аккаунт? Профиль, ответы и интересы будут удалены, все чаты завершатся. Вернуть аккаунт будет нельзя.';

describe('/delete', () => {
  it('asks first, and nothing happens on a cancel', async () => {
    const app = await buildChatApp(testDb);
    const me = telegramUser(await insertAdult(testDb.appPool));
    await app.handle(textUpdate(me, '/delete'));
    expect(app.telegram.sentTo(me.id).at(-1)?.payload).toMatchObject({
      text: CONFIRM,
      reply_markup: {
        inline_keyboard: [
          [{ text: 'Удалить аккаунт', callback_data: 'u:delete_yes' }],
          [{ text: 'Отмена', callback_data: 'u:delete_no' }],
        ],
      },
    });
    await app.handle(callbackUpdate(me, 'u:delete_no', { messageId: 7000 }));
    expect(edits(app)).toEqual(['Хорошо, ничего не меняю.']);
    const { rows } = await testDb.ownerPool.query(
      'SELECT status FROM users WHERE telegram_id = $1',
      [me.id],
    );
    expect(rows[0]).toEqual({ status: 'active' });
  });

  it('removes the profile, keeps what safety needs, closes everything, and refuses the account afterwards', async () => {
    const app = await buildChatApp(testDb, { adminTelegramIds: [900_000_050] });
    const scope = await realScope();
    const person = await insertPerson(testDb.appPool, {
      items: itemsOf(scope, 'niche').slice(0, 3),
      answers: answersFor(scope, 'ADADADADAD'),
      username: 'leaving_user',
      timezone: 'Europe/Moscow',
    });
    const other = await insertAdult(testDb.appPool);
    const { matchId } = await insertChat(testDb.appPool, { between: [person, other] });
    const me = telegramUser(person);
    await app.handle(textUpdate(me, 'привет'));
    await app.handle(textUpdate(telegramUser(other), 'привет!'));
    const pending = await insertOutbox(testDb.appPool, {
      userId: person.id,
      matchId,
      kind: 'chat_reminder',
    });
    // A report about them, and an admin's action, exist before they leave.
    expect(
      await app.safety.report({ reporterId: other.id, matchId, reason: 'spam' }),
    ).toMatchObject({ status: 'stored' });
    await app.adminRepo.audit({
      adminTelegramId: 900_000_050,
      action: 'note',
      targetUserId: person.id,
      reason: 'test',
    });
    app.telegram.clear();

    await app.handle(callbackUpdate(me, 'u:delete_yes', { messageId: 7000 }));
    expect(edits(app)).toEqual(['Аккаунт удалён.']);

    const { rows } = await testDb.ownerPool.query<Record<string, unknown>>(
      `SELECT status::text AS status, telegram_id::text AS telegram_id, birth_date::text AS birth_date, username, timezone,
         mode, gender, seeking, dating_age_min, active_match_id,
         (SELECT count(*)::int FROM answers WHERE user_id = u.id) AS answers,
         (SELECT count(*)::int FROM user_interests WHERE user_id = u.id) AS interests,
         (SELECT count(*)::int FROM reports WHERE reported_id = u.id) AS reports,
         (SELECT count(*)::int FROM admin_actions WHERE target_user_id = u.id) AS audits
       FROM users u WHERE id = $1`,
      [person.id],
    );
    expect(rows[0]).toEqual({
      status: 'deleted',
      telegram_id: String(person.telegramId),
      birth_date: birthDateYearsAgo(25),
      username: null,
      timezone: null,
      mode: null,
      gender: null,
      seeking: null,
      dating_age_min: null,
      active_match_id: null,
      answers: 0,
      interests: 0,
      reports: 1,
      audits: 1,
    });
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'deleted',
    });
    expect(await outboxRow(testDb.ownerPool, pending.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'deleted',
    });

    // The API: their own state still reads as deleted; everything else is forbidden.
    const meResponse = await app.as(me).get('/api/me');
    expect(await meResponse.json()).toMatchObject({ status: 'deleted' });
    expect((await app.as(me).get('/api/matches')).status).toBe(403);
    expect((await app.as(me).put('/api/profile/locale', { locale: 'en' })).status).toBe(403);
    // The relay, in both directions.
    app.telegram.clear();
    await app.handle(textUpdate(me, 'я вернусь'));
    await app.handle(textUpdate(telegramUser(other), 'ты где?'));
    expect(texts(app, me.id)).toEqual(['Сейчас отправлять сообщения нельзя.']);
    expect(texts(app, other.telegramId)).toEqual(['Этот чат завершён. Сообщение не доставлено.']);
    // Again: nothing to delete.
    await app.handle(textUpdate(me, '/delete'));
    expect(texts(app, me.id).at(-1)).toBe('Аккаунт уже удалён.');
    await app.handle(callbackUpdate(me, 'u:delete_yes', { messageId: 7001 }));
    expect(edits(app).at(-1)).toBe('Аккаунт уже удалён.');
    expect(await app.account.deleteAccount(person.id)).toBe('already');

    // Someone in dating mode loses the dating fields too.
    const dater = await insertPerson(testDb.appPool, {
      mode: 'dating',
      gender: 'g.man',
      seeking: ['g.woman'],
    });
    expect(await app.account.deleteAccount(dater.id)).toBe('deleted');
    const { rows: gone } = await testDb.ownerPool.query(
      'SELECT status::text AS status, mode, gender, seeking, dating_age_min FROM users WHERE id = $1',
      [dater.id],
    );
    expect(gone[0]).toEqual({
      status: 'deleted',
      mode: null,
      gender: null,
      seeking: null,
      dating_age_min: null,
    });
  });

  it('has nothing to delete for someone the bot does not know', async () => {
    const app = await buildChatApp(testDb);
    const stranger = { id: 777_000_778, first_name: 'Stranger', language_code: 'ru' };
    await app.handle(textUpdate(stranger, '/delete'));
    expect(texts(app, stranger.id)).toEqual(['Аккаунта пока нет: нечего удалять.']);
    await app.handle(callbackUpdate(stranger, 'u:delete_yes', { messageId: 7000 }));
    expect(edits(app)).toEqual(['Аккаунта пока нет: нечего удалять.']);
  });
});
