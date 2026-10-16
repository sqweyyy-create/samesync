/**
 * SAFETY SUITE — reports and the automatic freeze (CLAUDE.md invariants 4 and 9; PLAN.md Phase
 * 5, Q18). Enough different people reporting someone within the window freeze that account at
 * once: its open matches close and its pending notifications are cancelled in the same
 * transaction, it is told once, the admins are told, and the freeze is audited. The same
 * reporter counts once, a dismissed report does not count, reports older than the window do not
 * count, and the u18 band freezes sooner. A report of age misrepresentation reaches the admins at
 * once. Enough hits of the contact filter in a day make a system report.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { insertAdult, insertChat, telegramUser, type Person } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_BOT_INFO } from '../support/fixtures';
import {
  insertActiveUser,
  insertOutbox,
  matchRow,
  outboxRow,
  withoutTriggers,
} from '../support/matches';
import { textUpdate } from '../support/telegram';
import { birthDateYearsAgo } from '../support/users';

// Reports, freezes and the admins' messages are per database: each test gets its own.
let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

const ADMIN = 900_000_001;
const build = (over: Parameters<typeof buildChatApp>[1] = {}) =>
  buildChatApp(testDb, { adminTelegramIds: [ADMIN], ...over });

const userRow = async (id: string) =>
  (
    await testDb.ownerPool.query<{ status: string; frozen: boolean; public_id: string }>(
      'SELECT status::text AS status, frozen_at IS NOT NULL AS frozen, public_id FROM users WHERE id = $1',
      [id],
    )
  ).rows[0]!;
const audits = async (userId: string) =>
  (
    await testDb.ownerPool.query<{ action: string; admin: string; reason: string }>(
      'SELECT action, admin_telegram_id::text AS admin, reason FROM admin_actions WHERE target_user_id = $1 ORDER BY created_at',
      [userId],
    )
  ).rows;
const reportsAbout = async (userId: string) =>
  (
    await testDb.ownerPool.query<{
      reporter: string | null;
      reason: string;
      status: string;
      seq: string;
    }>(
      'SELECT reporter_id AS reporter, reason::text AS reason, status::text AS status, seq::text AS seq FROM reports WHERE reported_id = $1 ORDER BY created_at',
      [userId],
    )
  ).rows;
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);

/** `n` people, each in a finished-game chat with `target`, who then report them. */
async function reportedBy(
  app: ChatApp,
  target: Person,
  n: number,
  over: { years?: number; reason?: 'spam' | 'age_misrepresentation' } = {},
) {
  const years = over.years ?? 25;
  const reporters: Person[] = [];
  const outcomes = [];
  for (let i = 0; i < n; i++) {
    const reporter = await insertActiveUser(testDb.appPool, {
      birthDate: birthDateYearsAgo(years),
    });
    const { matchId } = await insertChat(testDb.appPool, { years, between: [reporter, target] });
    reporters.push(reporter);
    outcomes.push(
      await app.safety.report({ reporterId: reporter.id, matchId, reason: over.reason ?? 'spam' }),
    );
  }
  return { reporters, outcomes };
}

describe('the automatic freeze', () => {
  it('freezes an adult after three reports from different people, closes their matches, cancels and tells', async () => {
    const app = await build();
    const target = await insertAdult(testDb.appPool, { telegramId: 500_000_001 });
    // Another open chat of the target, with something queued for both of them.
    const other = await insertAdult(testDb.appPool, { telegramId: 500_000_002 });
    const open = await insertChat(testDb.appPool, { between: [target, other] });
    const queued = await insertOutbox(testDb.appPool, {
      userId: target.id,
      matchId: open.matchId,
      kind: 'chat_reminder',
    });
    const queuedForOther = await insertOutbox(testDb.appPool, {
      userId: other.id,
      matchId: open.matchId,
      kind: 'chat_reminder',
    });

    const { outcomes } = await reportedBy(app, target, 3);
    expect(outcomes.map((o) => o.status === 'stored' && o.frozen)).toEqual([false, false, true]);
    expect(await userRow(target.id)).toMatchObject({ status: 'frozen', frozen: true });
    expect(await matchRow(testDb.ownerPool, open.matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'frozen',
    });
    for (const row of [queued, queuedForOther]) {
      expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
        status: 'cancelled',
        cancel_reason: 'frozen',
      });
    }
    // Audited as the bot's own doing, with the count that did it.
    expect(await audits(target.id)).toEqual([
      {
        action: 'auto_freeze',
        admin: String(TEST_BOT_INFO.id),
        reason: '3 reports from distinct users in 30 days',
      },
    ]);
    // The admins hear about it with the support code; the frozen person is told once, with
    // /support, and nothing else that was pending reaches them.
    const { public_id } = await userRow(target.id);
    expect(texts(app, ADMIN)).toEqual([
      `Аккаунт ${public_id} заморожен автоматически: 3 жалобы от разных пользователей за 30 дн. Открыть: /user ${public_id}`,
    ]);
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, 500_000_001)).toEqual([
      'Твой аккаунт заморожен: на него поступило несколько жалоб. Знакомства и чаты приостановлены. Если это ошибка, напиши нам: /support и текст сообщения.',
    ]);
    expect(texts(app, 500_000_002)).toEqual([]);
    // The relay refuses them from now on, and the API too.
    await app.handle(textUpdate(telegramUser(target), 'я ещё тут'));
    expect(texts(app, 500_000_002)).toEqual([]);
    expect(texts(app, 500_000_001).at(-1)).toBe('Сейчас отправлять сообщения нельзя.');
    const response = await app.as(telegramUser(target)).get('/api/matches');
    expect(response.status).toBe(403);
  });

  it('counts the same reporter once: a second report of the same chat is a duplicate', async () => {
    const app = await build();
    const target = await insertAdult(testDb.appPool);
    const reporter = await insertAdult(testDb.appPool);
    const { matchId } = await insertChat(testDb.appPool, { between: [reporter, target] });
    const report = (reason: 'spam' | 'other') =>
      app.safety.report({ reporterId: reporter.id, matchId, reason });
    expect(await report('spam')).toMatchObject({ status: 'stored', frozen: false });
    expect(await report('other')).toMatchObject({ status: 'duplicate' });
    expect(await report('spam')).toMatchObject({ status: 'duplicate' });
    expect(await reportsAbout(target.id)).toHaveLength(1);
    // Two more people are still two, not four.
    const { outcomes } = await reportedBy(app, target, 1);
    expect(outcomes[0]).toMatchObject({ status: 'stored', frozen: false });
    expect(await userRow(target.id)).toMatchObject({ status: 'active' });
  });

  it('counts only reports within the window and not the dismissed ones', async () => {
    const app = await build();
    const target = await insertAdult(testDb.appPool);
    await reportedBy(app, target, 2);
    const [first, second] = await reportsAbout(target.id);
    // One is older than the window (written past the trigger that keeps a report's time).
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query("UPDATE reports SET created_at = now() - interval '31 days' WHERE seq = $1", [
        first!.seq,
      ]),
    );
    expect((await reportedBy(app, target, 1)).outcomes[0]).toMatchObject({ frozen: false });
    expect(await userRow(target.id)).toMatchObject({ status: 'active' });
    // The other one is dismissed by an admin.
    expect(
      await app.admin.resolve(Number(second!.seq), 'dismiss', 'a mistake', ADMIN),
    ).toMatchObject({
      status: 'resolved',
      result: 'dismissed',
    });
    expect((await reportedBy(app, target, 1)).outcomes[0]).toMatchObject({ frozen: false });
    expect(await userRow(target.id)).toMatchObject({ status: 'active' });
    // The next distinct one makes three that count.
    expect((await reportedBy(app, target, 1)).outcomes[0]).toMatchObject({ frozen: true });
    expect(await userRow(target.id)).toMatchObject({ status: 'frozen' });
  });

  it('freezes a u18 user after two reports from different people', async () => {
    const app = await build();
    const target = await insertActiveUser(testDb.appPool, { birthDate: birthDateYearsAgo(16) });
    const { outcomes } = await reportedBy(app, target, 2, { years: 16 });
    expect(outcomes.map((o) => o.status === 'stored' && o.frozen)).toEqual([false, true]);
    expect(await userRow(target.id)).toMatchObject({ status: 'frozen' });
    expect(await audits(target.id)).toEqual([
      expect.objectContaining({
        action: 'auto_freeze',
        reason: '2 reports from distinct users in 30 days',
      }),
    ]);
  });

  it('is undone only by an admin: an unfreeze is audited and old matches stay closed', async () => {
    const app = await build();
    const target = await insertAdult(testDb.appPool);
    const other = await insertAdult(testDb.appPool);
    const open = await insertChat(testDb.appPool, { between: [target, other] });
    await reportedBy(app, target, 3);
    expect(await app.safety.unfreeze(target.id, ADMIN, 'checked, a brigade')).toBe('unfrozen');
    expect(await userRow(target.id)).toMatchObject({ status: 'active', frozen: false });
    expect(await app.safety.unfreeze(target.id, ADMIN, 'again')).toBe('not_frozen');
    expect(await matchRow(testDb.ownerPool, open.matchId)).toMatchObject({
      close_reason: 'frozen',
    });
    expect((await audits(target.id)).map((a) => [a.action, a.admin])).toEqual([
      ['auto_freeze', String(TEST_BOT_INFO.id)],
      ['unfreeze', String(ADMIN)],
    ]);
  });
});

describe('a report of age misrepresentation', () => {
  it('reaches the admins at once, whatever the count, and still counts like any other', async () => {
    const app = await build();
    const target = await insertAdult(testDb.appPool);
    const { reporters } = await reportedBy(app, target, 1, { reason: 'age_misrepresentation' });
    const [report] = await reportsAbout(target.id);
    const { public_id } = await userRow(target.id);
    const reporter = await userRow(reporters[0]!.id);
    expect(texts(app, ADMIN)).toEqual([
      `Жалоба #${report!.seq}: Похоже, не тот возраст (младше или старше, чем можно). На: ${public_id} (18+). От: ${reporter.public_id}. Открыть: /report_view ${report!.seq}`,
    ]);
    expect(await userRow(target.id)).toMatchObject({ status: 'active' });
    // Two more reports of any kind freeze them.
    expect(
      (await reportedBy(app, target, 2)).outcomes.map((o) => o.status === 'stored' && o.frozen),
    ).toEqual([false, true]);
  });

  it('is the only kind the admins hear about before the freeze', async () => {
    const app = await build();
    const target = await insertAdult(testDb.appPool);
    await reportedBy(app, target, 2, { reason: 'spam' });
    expect(texts(app, ADMIN)).toEqual([]);
  });
});

describe('the evidence a report keeps', () => {
  it('is the last messages of the chat in both directions, who wrote each, and what the filter stopped', async () => {
    const app = await build();
    const { matchId, a, b, telegramA, telegramB } = await insertChat(testDb.appPool, { years: 16 });
    const fox = telegramUser({ id: a, telegramId: telegramA });
    const owl = telegramUser({ id: b, telegramId: telegramB });
    await app.handle(textUpdate(fox, 'привет'));
    await app.handle(textUpdate(owl, 'привет!'));
    await app.handle(textUpdate(owl, 'мой тг @owl_08'));
    expect(
      await app.safety.report({
        reporterId: a,
        matchId,
        reason: 'contact_sharing',
        note: 'просит ник',
      }),
    ).toMatchObject({ status: 'stored' });
    const { rows } = await testDb.ownerPool.query<{ note: string; evidence: unknown }>(
      'SELECT note, evidence FROM reports WHERE match_id = $1',
      [matchId],
    );
    expect(rows[0]?.note).toBe('просит ник');
    expect(rows[0]?.evidence).toEqual([
      expect.objectContaining({ from: 'reporter', text: 'привет', verdict: 'delivered' }),
      expect.objectContaining({ from: 'reported', text: 'привет!', verdict: 'delivered' }),
      expect.objectContaining({
        from: 'reported',
        text: 'мой тг @owl_08',
        verdict: 'blocked_by_filter',
        reason: 'handle',
      }),
    ]);
  });
});

describe('the contact filter escalation', () => {
  it('files one system report after three hits in a day, with the stopped messages as evidence', async () => {
    const app = await build();
    const { matchId, a, telegramA } = await insertChat(testDb.appPool, { years: 16 });
    const fox = telegramUser({ id: a, telegramId: telegramA });
    for (const text of ['@fox_08', 'мой номер 8926 123 45 67', 'fox точка ру', '@fox_again']) {
      await app.handle(textUpdate(fox, text));
    }
    const reports = await reportsAbout(a);
    expect(reports.map(({ seq, ...rest }) => ({ ...rest, numbered: /^\d+$/.test(seq) }))).toEqual([
      { reporter: null, reason: 'contact_sharing', status: 'open', numbered: true },
    ]);
    const { rows } = await testDb.ownerPool.query<{ evidence: Array<{ verdict: string }> }>(
      'SELECT evidence FROM reports WHERE match_id = $1',
      [matchId],
    );
    expect(rows[0]?.evidence.map((e) => e.verdict)).toEqual([
      'blocked_by_filter',
      'blocked_by_filter',
      'blocked_by_filter',
    ]);
    // It is listed for the admins as the system's, and it does not count toward the freeze.
    const listed = await app.admin.reports('open');
    expect(listed).toEqual([
      expect.objectContaining({ reporterCode: null, reason: 'contact_sharing' }),
    ]);
    expect(await userRow(a)).toMatchObject({ status: 'active' });
  });
});
