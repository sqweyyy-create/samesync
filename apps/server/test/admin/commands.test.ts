/**
 * The admin commands (PLAN.md Phase 5): only for ADMIN_TELEGRAM_IDS, re-checked on every command
 * and every button; everyone else gets the answer for a command that doesn't exist. Commands that
 * can't be undone ask for a tap on a reply to the admin's own message, and act only on that same
 * message. Every action writes an audit row. Arguments are validated, and admins never see a name.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commandHash } from '../../src/domain/safety/callbacks';
import { insertAdult, insertChat, telegramUser, type Person } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import { insertOutbox, matchRow, outboxRow } from '../support/matches';
import { callbackUpdate, textUpdate } from '../support/telegram';
import { birthDateYearsAgo, insertUser } from '../support/users';

let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

const ADMIN: TestUser = { id: 900_000_010, first_name: 'Админ', language_code: 'ru' };
const OTHER_ADMIN: TestUser = { id: 900_000_011, first_name: 'Admin Two', language_code: 'en' };
const NOBODY: TestUser = { id: 900_000_012, first_name: 'Nobody', language_code: 'ru' };
const UNKNOWN = 'Такой команды нет. Список команд: /help';

const build = () => buildChatApp(testDb, { adminTelegramIds: [ADMIN.id, OTHER_ADMIN.id] });
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const last = (app: ChatApp, chatId: number) => texts(app, chatId).at(-1);
const say = (app: ChatApp, who: TestUser, text: string) => app.handle(textUpdate(who, text));
const codeOf = async (id: string) =>
  (
    await testDb.ownerPool.query<{ public_id: string }>(
      'SELECT public_id FROM users WHERE id = $1',
      [id],
    )
  ).rows[0]!.public_id;
const audits = async (userId: string) =>
  (
    await testDb.ownerPool.query<{ action: string; admin: string; reason: string; after: unknown }>(
      'SELECT action, admin_telegram_id::text AS admin, reason, after FROM admin_actions WHERE target_user_id = $1 ORDER BY created_at',
      [userId],
    )
  ).rows;

/**
 * Taps the button under the question the bot asked about `commandText`. The question is a reply
 * to the admin's command, whose text is `originalText` by now (edited, when that differs).
 */
function confirm(
  app: ChatApp,
  who: TestUser,
  commandText: string,
  options: { action?: string; fromId?: number; originalText?: string } = {},
) {
  return app.handle(
    callbackUpdate(who, `a:${options.action ?? 'confirm'}:${commandHash(commandText)}`, {
      messageId: 8000,
      original: {
        messageId: 7999,
        text: options.originalText ?? commandText,
        ...(options.fromId === undefined ? {} : { fromId: options.fromId }),
      },
    }),
  );
}

/** A reported person: two chats, one of them with a report about them. */
async function reported(app: ChatApp, reason: 'spam' | 'harassment' = 'spam') {
  const target = await insertAdult(testDb.appPool);
  const reporter = await insertAdult(testDb.appPool);
  const { matchId } = await insertChat(testDb.appPool, { between: [reporter, target] });
  await app.handle(textUpdate(telegramUser(reporter), 'привет'));
  await app.handle(textUpdate(telegramUser(target), 'чего надо'));
  app.telegram.clear();
  const outcome = await app.safety.report({
    reporterId: reporter.id,
    matchId,
    reason,
    note: 'грубит',
  });
  expect(outcome).toMatchObject({ status: 'stored' });
  const { rows } = await testDb.ownerPool.query<{ seq: string }>(
    'SELECT seq::text AS seq FROM reports WHERE match_id = $1',
    [matchId],
  );
  return { target, reporter, matchId, seq: Number(rows[0]!.seq) };
}

describe('who may use them', () => {
  it('answers anyone else as if the command did not exist, and ignores their taps', async () => {
    const app = await build();
    for (const command of [
      '/admin',
      '/reports',
      '/user ABC',
      '/freeze ABC r',
      '/stats',
      '/reply ABC hi',
    ]) {
      await say(app, NOBODY, command);
      expect(last(app, NOBODY.id)).toBe(UNKNOWN);
    }
    await confirm(app, NOBODY, '/freeze ABC r');
    expect(
      app.telegram.calls.filter((c) => c.method !== 'sendMessage').map((c) => c.method),
    ).toEqual(['answerCallbackQuery']);
    expect(app.telegram.of('editMessageText')).toEqual([]);
  });

  it('answers an admin, in the language the bot knows for them, and is not in the menu', async () => {
    const app = await build();
    await say(app, ADMIN, '/admin');
    expect(last(app, ADMIN.id)).toContain('/freeze <код или Telegram ID> <причина>');
    await say(app, OTHER_ADMIN, '/admin');
    expect(last(app, OTHER_ADMIN.id)).toContain('/freeze <code or Telegram ID> <reason>');
    await say(app, ADMIN, '/help');
    expect(last(app, ADMIN.id)).not.toContain('/freeze');
  });
});

describe('/user', () => {
  it('shows a user by support code or Telegram ID: status, band, counts, never a name or a username', async () => {
    const app = await build();
    const target = await insertUser(testDb.appPool, {
      birthDate: birthDateYearsAgo(25),
      status: 'active',
      mode: 'friends',
      username: 'secret_name',
      onboardedAt: new Date(),
    });
    const code = await codeOf(target.id);
    await say(app, ADMIN, `/user ${code.toLowerCase()}`);
    const view = last(app, ADMIN.id)!;
    expect(view).toContain(`Код: ${code}`);
    expect(view).toContain(`Telegram ID: ${target.telegramId}`);
    expect(view).toContain('Статус: active');
    expect(view).toContain('Возраст: 18+');
    expect(view).toContain('Жалоб на пользователя: 0 открытых, 0 всего');
    expect(view).not.toContain('secret_name');
    await say(app, ADMIN, `/user ${target.telegramId}`);
    expect(last(app, ADMIN.id)).toBe(view);
    await say(app, ADMIN, '/user 0000000000');
    expect(last(app, ADMIN.id)).toBe('Пользователь не найден: 0000000000.');
    await say(app, ADMIN, '/user');
    expect(last(app, ADMIN.id)).toBe('/user <код или Telegram ID>');
  });
});

describe('/reports, /report_view and /resolve', () => {
  it('list the reports, show one with its evidence (audited), and resolve it once', async () => {
    const app = await build();
    await say(app, ADMIN, '/reports');
    expect(last(app, ADMIN.id)).toBe('Жалоб нет (open).');
    const { target, reporter, matchId, seq } = await reported(app, 'harassment');
    const [targetCode, reporterCode] = [await codeOf(target.id), await codeOf(reporter.id)];

    await say(app, ADMIN, '/reports');
    expect(last(app, ADMIN.id)).toContain(
      `#${seq} · Оскорбления или травля · открыта · на ${targetCode} · от ${reporterCode}`,
    );

    await say(app, ADMIN, `/report_view ${seq}`);
    const view = last(app, ADMIN.id)!;
    expect(view).toContain(`Жалоба #${seq}: Оскорбления или травля (открыта)`);
    expect(view).toContain(`На: ${targetCode} (18+)`);
    expect(view).toContain(`От: ${reporterCode}`);
    expect(view).toContain(`Знакомство: ${matchId}`);
    expect(view).toContain('Примечание: грубит');
    expect(view).toContain('[заявитель] привет');
    expect(view).toContain('[ответчик] чего надо');
    expect(await audits(target.id)).toEqual([
      expect.objectContaining({ action: 'view_report', admin: String(ADMIN.id), after: { seq } }),
    ]);
    await say(app, ADMIN, '/report_view 999');
    expect(last(app, ADMIN.id)).toBe('Жалоба #999 не найдена.');
    await say(app, ADMIN, '/report_view abc');
    expect(last(app, ADMIN.id)).toBe('/report_view <номер>');

    await say(app, ADMIN, `/resolve ${seq} dismiss ошибочная`);
    expect(last(app, ADMIN.id)).toBe(`Жалоба #${seq}: отклонена.`);
    expect((await audits(target.id)).at(-1)).toMatchObject({
      action: 'resolve_report',
      reason: 'ошибочная',
    });
    await say(app, ADMIN, `/resolve ${seq} action`);
    expect(last(app, ADMIN.id)).toBe(`Жалоба #${seq} уже закрыта: отклонена.`);
    await say(app, ADMIN, `/resolve ${seq} maybe`);
    expect(last(app, ADMIN.id)).toBe('/resolve <номер> dismiss|action [примечание]');
    await say(app, ADMIN, '/reports');
    expect(last(app, ADMIN.id)).toBe('Жалоб нет (open).');
    await say(app, ADMIN, '/reports all');
    expect(last(app, ADMIN.id)).toContain(`#${seq} · Оскорбления или травля · отклонена`);
  });

  it('"action" closes the reported match, if it is still open, and tells both people neutrally', async () => {
    const app = await build();
    const { target, reporter, matchId, seq } = await reported(app);
    await say(app, ADMIN, `/resolve ${seq} action`);
    expect(last(app, ADMIN.id)).toBe(`Жалоба #${seq}: меры приняты.`);
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'reported',
    });
    expect(await app.sender.tick()).toMatchObject({ sent: 2 });
    // The target was made first, so it is user A (🦊 Лиса to the reporter) and sees the owl.
    expect(texts(app, target.telegramId)).toEqual(['Этот чат завершён (🦉 Сова).']);
    expect(texts(app, reporter.telegramId)).toEqual(['Этот чат завершён (🦊 Лиса).']);
    expect((await audits(target.id)).at(-1)).toMatchObject({
      action: 'resolve_report',
      reason: 'action',
      after: { seq, status: 'actioned', matchClosed: true },
    });
  });
});

describe('/freeze and /unfreeze', () => {
  it('freeze asks for a tap on the admin own command, then freezes, audits and tells the user', async () => {
    const app = await build();
    const target = await insertAdult(testDb.appPool, { telegramId: 500_000_020 });
    const other = await insertAdult(testDb.appPool);
    const { matchId } = await insertChat(testDb.appPool, { between: [target, other] });
    const pending = await insertOutbox(testDb.appPool, {
      userId: target.id,
      matchId,
      kind: 'chat_reminder',
    });
    const code = await codeOf(target.id);
    const command = `/freeze ${code} спам в трёх чатах`;

    await say(app, ADMIN, command);
    const question = app.telegram.sentTo(ADMIN.id).at(-1);
    // The question is a reply to the admin's own command message.
    const replyTo = question?.payload['reply_parameters'] as { message_id?: unknown } | undefined;
    expect(typeof replyTo?.message_id).toBe('number');
    expect(question?.payload).toMatchObject({
      text: `Заморозить ${code}? Причина: спам в трёх чатах. Все знакомства закроются, уведомления отменятся, а пользователь получит уведомление.`,
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Подтвердить', callback_data: `a:confirm:${commandHash(command)}` },
            { text: 'Отмена', callback_data: `a:cancel:${commandHash(command)}` },
          ],
        ],
      },
    });
    expect(
      (
        await testDb.ownerPool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [
          target.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'active' });

    // A tap under an edited command, or someone else's, does nothing.
    await confirm(app, ADMIN, command, { originalText: `/freeze ${code} другая причина` });
    expect(app.telegram.of('editMessageText').at(-1)?.payload['text']).toBe(
      'Команда изменилась или устарела. Отправь её ещё раз.',
    );
    await confirm(app, ADMIN, command, { fromId: OTHER_ADMIN.id });
    expect(app.telegram.of('editMessageText').at(-1)?.payload['text']).toBe(
      'Команда изменилась или устарела. Отправь её ещё раз.',
    );
    await confirm(app, ADMIN, command, { action: 'cancel' });
    expect(app.telegram.of('editMessageText').at(-1)?.payload['text']).toBe(
      'Хорошо, ничего не меняю.',
    );
    expect(
      (
        await testDb.ownerPool.query<{ status: string }>('SELECT status FROM users WHERE id = $1', [
          target.id,
        ])
      ).rows[0],
    ).toEqual({ status: 'active' });

    await confirm(app, ADMIN, command);
    expect(last(app, ADMIN.id)).toBe(`Аккаунт ${code} заморожен.`);
    expect(
      (
        await testDb.ownerPool.query(
          'SELECT status, frozen_at IS NOT NULL AS frozen FROM users WHERE id = $1',
          [target.id],
        )
      ).rows[0],
    ).toEqual({ status: 'frozen', frozen: true });
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'frozen',
    });
    expect(await outboxRow(testDb.ownerPool, pending.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'frozen',
    });
    expect(await audits(target.id)).toEqual([
      expect.objectContaining({
        action: 'freeze',
        admin: String(ADMIN.id),
        reason: 'спам в трёх чатах',
      }),
    ]);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, 500_000_020)[0]).toContain('Твой аккаунт заморожен');

    await say(app, ADMIN, command);
    expect(last(app, ADMIN.id)).toBe(
      `Аккаунт ${code} не активен (frozen): заморозить можно только активный аккаунт.`,
    );
    await say(app, ADMIN, `/freeze ${code}`);
    expect(last(app, ADMIN.id)).toBe('/freeze <код или Telegram ID> <причина>');

    await say(app, ADMIN, `/unfreeze ${code} проверено`);
    expect(last(app, ADMIN.id)).toBe(
      `Аккаунт ${code} разморожен. Старые знакомства не возвращаются.`,
    );
    expect((await audits(target.id)).at(-1)).toMatchObject({
      action: 'unfreeze',
      reason: 'проверено',
    });
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({ close_reason: 'frozen' });
    await say(app, ADMIN, `/unfreeze ${code}`);
    expect(last(app, ADMIN.id)).toBe(`Аккаунт ${code} не заморожен (active).`);
  });
});

describe('/stats', () => {
  it('shows every pool × mode with its active users, open matches and last run', async () => {
    const app = await build();
    const first = await insertAdult(testDb.appPool);
    await insertChat(testDb.appPool, { between: [first, await insertAdult(testDb.appPool)] });
    await say(app, ADMIN, '/stats');
    const lines = last(app, ADMIN.id)!.split('\n');
    expect(lines[0]).toBe('Пулы (активные пользователи · открытые знакомства · последний запуск):');
    expect(lines.slice(1)).toHaveLength(6);
    expect(lines).toContain('adult:ru · friends: 2 · 1 · запусков не было');
    expect(lines).toContain('u18:ru · friends: 0 · 0 · запусков не было');
  });
});

describe('/support and /reply', () => {
  it('relay a user text to every admin with the support code, and an admin answer back through the outbox', async () => {
    const app = await build();
    const person: Person = await insertAdult(testDb.appPool, { telegramId: 500_000_030 });
    const code = await codeOf(person.id);
    const user = telegramUser(person);
    await say(app, user, '/support');
    expect(last(app, user.id)).toBe(
      'Напиши /support и текст сообщения. Например: /support не открывается приложение',
    );
    await say(app, user, '/support не приходят знакомства');
    expect(last(app, user.id)).toBe(
      'Сообщение передано в поддержку. Ответ придёт сюда, в этот чат.',
    );
    expect(texts(app, ADMIN.id)).toEqual([
      `Поддержка · ${code} (ru):\nне приходят знакомства\n\nОтветить: /reply ${code} <текст>`,
    ]);
    // An admin the bot has no stored language for is written to in Russian, the main locale.
    expect(texts(app, OTHER_ADMIN.id)).toEqual([
      `Поддержка · ${code} (ru):\nне приходят знакомства\n\nОтветить: /reply ${code} <текст>`,
    ]);
    expect(JSON.stringify(app.telegram.calls)).not.toContain(user.first_name);

    await say(app, ADMIN, `/reply ${code} смотрим, подожди`);
    expect(last(app, ADMIN.id)).toBe(`Ответ для ${code} поставлен в очередь.`);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(last(app, user.id)).toBe('Ответ поддержки:\nсмотрим, подожди');
    expect((await audits(person.id)).at(-1)).toMatchObject({
      action: 'support_reply',
      after: { length: [...'смотрим, подожди'].length },
    });
    await say(app, ADMIN, '/reply 0000000000 hi');
    expect(last(app, ADMIN.id)).toBe('Пользователь не найден: 0000000000.');
    await say(app, ADMIN, `/reply ${code}`);
    expect(last(app, ADMIN.id)).toBe('/reply <код> <текст>');
  });

  it('limits support requests per hour, and says so when no admin is configured', async () => {
    const app = await build();
    const user = telegramUser(await insertAdult(testDb.appPool));
    for (let i = 0; i < 5; i++) await say(app, user, `/support сообщение ${i}`);
    await say(app, user, '/support шестое');
    expect(last(app, user.id)).toBe(
      'Слишком много сообщений в поддержку подряд. Попробуй через час.',
    );
    expect(texts(app, ADMIN.id)).toHaveLength(5);

    const alone = await buildChatApp(testDb);
    const other = telegramUser(await insertAdult(testDb.appPool));
    await alone.handle(textUpdate(other, '/support ау'));
    expect(last(alone, other.id)).toBe('Поддержка сейчас недоступна. Попробуй позже.');
    const stranger = { id: 777_000_777, first_name: 'Stranger', language_code: 'ru' };
    await alone.handle(textUpdate(stranger, '/support ау'));
    expect(last(alone, stranger.id)).toBe('Сначала открой приложение: /start');
  });
});
