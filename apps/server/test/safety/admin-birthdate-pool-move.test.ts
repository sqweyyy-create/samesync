/**
 * SAFETY SUITE — a birth-date correction by an admin (CLAUDE.md invariants 4, 6 and 7; PLAN.md
 * Phase 5). /setbirthdate asks for a tap, then calls admin_set_birth_date(): the function audits,
 * and the band change closes every cross-band match in the same transaction, nulls the username
 * when the user becomes u18, and makes the old counterparts' data unreadable. birth_date stays
 * write-once for everything else, the app role included.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMatchesRepository } from '../../src/db/repositories/matches';
import { commandHash } from '../../src/domain/safety/callbacks';
import { insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import {
  insertActiveUser,
  insertMatch,
  insertOutbox,
  matchRow,
  outboxRow,
} from '../support/matches';
import { callbackUpdate, textUpdate } from '../support/telegram';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

const ADMIN: TestUser = { id: 900_000_040, first_name: 'Админ', language_code: 'ru' };
const build = () => buildChatApp(testDb, { adminTelegramIds: [ADMIN.id] });
const last = (app: ChatApp) => app.telegram.sentTo(ADMIN.id).at(-1)?.text;
const codeOf = async (id: string) =>
  (
    await testDb.ownerPool.query<{ public_id: string }>(
      'SELECT public_id FROM users WHERE id = $1',
      [id],
    )
  ).rows[0]!.public_id;
const userRow = async (id: string) =>
  (
    await testDb.ownerPool.query<{
      birth_date: string;
      age_band: string;
      username: string | null;
      mode: string | null;
      gender: string | null;
    }>(
      'SELECT birth_date::text, age_band::text, username, mode::text, gender FROM users WHERE id = $1',
      [id],
    )
  ).rows[0]!;

/** Sends the command and taps its confirmation. */
async function correct(app: ChatApp, command: string) {
  await app.handle(textUpdate(ADMIN, command));
  await app.handle(
    callbackUpdate(ADMIN, `a:confirm:${commandHash(command)}`, {
      messageId: 8000,
      original: { messageId: 7999, text: command },
    }),
  );
}

describe('correcting an adult to u18', () => {
  it('closes their adult matches at once, nulls the username and dating fields, and hides the counterparts', async () => {
    const app = await build();
    const user = await insertActiveUser(testDb.appPool, {
      birthDate: birthDateYearsAgo(25),
      username: 'was_adult',
    });
    // Someone in dating mode, without a match: the dating fields go too.
    const dater = await insertActiveUser(testDb.appPool, {
      birthDate: birthDateYearsAgo(25),
      mode: 'dating',
      gender: 'g.man',
      seeking: ['g.woman'],
    });
    const partner = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const { matchId } = await insertChat(testDb.appPool, { between: [user, partner] });
    const fox = telegramUser({ id: user.id, telegramId: user.telegramId });
    await app.handle(textUpdate(fox, 'привет'));
    const pending = await insertOutbox(testDb.appPool, {
      userId: partner.id,
      matchId,
      kind: 'chat_reminder',
    });
    const code = await codeOf(user.id);
    const to = birthDateYearsAgo(16);
    const command = `/setbirthdate ${code} ${to} паспорт показан в поддержке`;

    await app.handle(textUpdate(ADMIN, command));
    expect(last(app)).toBe(
      `Изменить дату рождения ${code}: ${birthDateYearsAgo(25)} → ${to} (возраст: 18+ → до 18)? Причина: паспорт показан в поддержке. Знакомства с другой возрастной группой закроются сразу.`,
    );
    expect((await userRow(user.id)).birth_date).toBe(birthDateYearsAgo(25));
    await app.handle(
      callbackUpdate(ADMIN, `a:confirm:${commandHash(command)}`, {
        messageId: 8000,
        original: { messageId: 7999, text: command },
      }),
    );
    expect(last(app)).toBe(
      `Дата рождения ${code} изменена: ${birthDateYearsAgo(25)} → ${to}. Возраст: до 18.`,
    );

    expect(await userRow(user.id)).toEqual({
      birth_date: to,
      age_band: 'u18',
      username: null,
      mode: 'friends',
      gender: null,
    });
    await correct(app, `/setbirthdate ${await codeOf(dater.id)} ${to} same here`);
    expect(await userRow(dater.id)).toMatchObject({
      age_band: 'u18',
      mode: 'friends',
      gender: null,
    });
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    expect(await outboxRow(testDb.ownerPool, pending.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'band_change',
    });
    const matches = createMatchesRepository(testDb.db);
    expect(await matches.getForParticipant(user.id, matchId)).toBeNull();
    expect(await matches.getForParticipant(partner.id, matchId)).toBeNull();
    // The function itself wrote the audit row, with this admin's ID and reason.
    const { rows } = await testDb.ownerPool.query(
      'SELECT action, admin_telegram_id::text AS admin, reason FROM admin_actions WHERE target_user_id = $1',
      [user.id],
    );
    expect(rows).toEqual([
      { action: 'set_birth_date', admin: String(ADMIN.id), reason: 'паспорт показан в поддержке' },
    ]);
    // Nothing of the old chat reaches either side any more.
    app.telegram.clear();
    await app.handle(textUpdate(fox, 'ты тут?'));
    await app.handle(
      textUpdate(telegramUser({ id: partner.id, telegramId: partner.telegramId }), 'ау'),
    );
    expect(app.telegram.sentTo(partner.telegramId).every((m) => !m.text.startsWith('🦊'))).toBe(
      true,
    );
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(1);
  });
});

describe('correcting a u18 user to adult', () => {
  it('closes their u18 matches at once and lets them be matched as an adult', async () => {
    const app = await build();
    const user = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(17) });
    const friend = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(16) });
    const match = await insertMatch(testDb.appPool, { a: user.id, b: friend.id, band: 'u18' });
    const code = await codeOf(user.id);
    await correct(app, `/setbirthdate ${code} ${birthDateYearsAgo(19)} указан не тот год`);
    expect(last(app)).toContain('Возраст: 18+.');
    expect(await matchRow(testDb.ownerPool, match.id)).toMatchObject({
      status: 'closed',
      close_reason: 'band_change',
    });
    expect(
      await createMatchesRepository(testDb.db).getForParticipant(friend.id, match.id),
    ).toBeNull();
    const adult = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(21) });
    await insertMatch(testDb.appPool, { a: user.id, b: adult.id, band: 'adult' });
    await expect(
      insertMatch(testDb.appPool, {
        a: user.id,
        b: (await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(16) })).id,
        band: 'u18',
      }),
    ).rejects.toMatchObject({ code: 'SS010' });
  });
});

describe('what the command refuses', () => {
  it('rejects a bad date, the same date, an unknown user, and a missing reason, and changes nothing', async () => {
    const app = await build();
    const user = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(25) });
    const code = await codeOf(user.id);
    await app.handle(textUpdate(ADMIN, `/setbirthdate ${code} 2010-13-40 причина`));
    expect(last(app)).toBe('Дата должна быть в формате ГГГГ-ММ-ДД, в прошлом и правдоподобной.');
    await app.handle(textUpdate(ADMIN, `/setbirthdate ${code} ${birthDateYearsAgo(0, 1)} причина`));
    expect(last(app)).toBe('Дата должна быть в формате ГГГГ-ММ-ДД, в прошлом и правдоподобной.');
    await app.handle(textUpdate(ADMIN, `/setbirthdate ${code} ${birthDateYearsAgo(25)} причина`));
    expect(last(app)).toBe(`У ${code} уже стоит эта дата рождения.`);
    await app.handle(
      textUpdate(ADMIN, `/setbirthdate 0000000000 ${birthDateYearsAgo(20)} причина`),
    );
    expect(last(app)).toBe('Пользователь не найден: 0000000000.');
    await app.handle(textUpdate(ADMIN, `/setbirthdate ${code} ${birthDateYearsAgo(20)}`));
    expect(last(app)).toBe('/setbirthdate <код или Telegram ID> <ГГГГ-ММ-ДД> <причина>');
    expect((await userRow(user.id)).birth_date).toBe(birthDateYearsAgo(25));
    // And the app role still can't write a birth date on its own.
    await expect(
      testDb.appPool.query('UPDATE users SET birth_date = $2 WHERE id = $1', [
        user.id,
        birthDateYearsAgo(20),
      ]),
    ).rejects.toMatchObject({ code: 'SS001' });
  });
});
