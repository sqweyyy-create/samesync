/**
 * Match notifications end to end: a matching run queues them, the outbox sender delivers them
 * through the Bot API (faked here), in the recipient's language, with a button into the Mini App.
 */
import { translatorFor } from '@samesync/shared/i18n/static';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PoolScope } from '../../src/domain/matching/types';
import { realContent } from '../support/app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_MINIAPP_URL } from '../support/fixtures';
import { outboxRow } from '../support/matches';
import { buildSender, type ApiAnswer } from '../support/notify';
import {
  answersFor,
  buildMatching,
  insertPerson,
  itemsOf,
  realScope,
  type PersonInput,
} from '../support/population';

let testDb: TestDatabase;
let scope: PoolScope;
let item: string;
beforeEach(async () => {
  testDb = await createTestDatabase();
  scope = await realScope();
  item = itemsOf(scope, 'niche')[0]!;
});
afterEach(() => testDb.drop());

const SLOT = new Date('2026-10-03T10:00:00Z');
const BLOCKED: ApiAnswer = {
  ok: false,
  error_code: 403,
  description: 'Forbidden: bot was blocked by the user',
};

/** Two matched people with their pending notifications. */
async function matchedPair(overA: PersonInput = {}, overB: PersonInput = {}) {
  const a = await insertPerson(testDb.appPool, {
    items: [item],
    answers: answersFor(scope, 'AAAAAD'),
    ...overA,
  });
  const b = await insertPerson(testDb.appPool, {
    items: [item],
    answers: answersFor(scope, 'AAAAAA'),
    ...overB,
  });
  const { service } = await buildMatching(testDb);
  const outcome = await service.run({
    pool: { band: 'adult', locale: 'ru' },
    mode: 'friends',
    slot: SLOT,
  });
  expect(outcome).toMatchObject({ status: 'done', pairsCreated: 1 });
  // The run used the real clock; the sender below has a fixed one. Make the rows due for any "now".
  await testDb.ownerPool.query("UPDATE outbox SET next_attempt_at = '2020-01-01T00:00:00Z'");
  const { rows } = await testDb.ownerPool.query<{ id: string }>('SELECT id FROM matches');
  return { a, b, matchId: rows[0]!.id, service };
}
const outboxOf = async (userId: string) => {
  const { rows } = await testDb.ownerPool.query<{ id: string }>(
    'SELECT id FROM outbox WHERE user_id = $1',
    [userId],
  );
  return outboxRow(testDb.ownerPool, rows[0]!.id);
};
const names = async () => {
  const content = await realContent();
  const take = [...scope.takes.slice(0, 5)].sort(
    (x, y) => x.priorAgree - y.priorAgree || (x.id < y.id ? -1 : 1),
  )[0]!;
  // Both agreed with it, so the teaser uses the "agree" side of its stance.
  return { item: content.teaser.item(item)!.name, take: content.teaser.stance(take.id)!.agree };
};

describe('a new match', () => {
  it('sends each user exactly one message naming the shared item and take, with a Mini App button', async () => {
    const { a, b, matchId } = await matchedPair();
    const { sender, calls } = await buildSender(testDb);
    expect(await sender.tick()).toEqual({ sent: 2, cancelled: 0, failed: 0, retried: 0 });

    expect(calls.map((c) => c.method)).toEqual(['sendMessage', 'sendMessage']);
    expect(calls.map((c) => c.payload.chat_id).sort()).toEqual([a.telegramId, b.telegramId].sort());
    const { item: itemName, take } = await names();
    const ru = translatorFor('ru');
    for (const { payload } of calls) {
      expect(payload.text).toMatch(/^Новое знакомство! /);
      expect(payload.text).toContain(itemName.ru);
      expect(payload.text).toContain(take.ru);
      expect(payload.reply_markup).toEqual({
        inline_keyboard: [
          [
            {
              text: ru.t('bot.match.open'),
              web_app: { url: `${TEST_MINIAPP_URL}?match=${matchId}` },
            },
          ],
        ],
      });
      // Plain text only, and sent normally in the daytime.
      expect(payload).not.toHaveProperty('parse_mode');
      expect(payload).not.toHaveProperty('entities');
      expect(payload).not.toHaveProperty('disable_notification');
    }
    expect(await outboxOf(a.id)).toMatchObject({ status: 'sent', attempts: 1 });
    expect(await outboxOf(b.id)).toMatchObject({ status: 'sent', attempts: 1 });
  });

  it('is never sent twice: not by a second tick, and not by rerunning the drop', async () => {
    const { service } = await matchedPair();
    const { sender, calls } = await buildSender(testDb);
    await sender.tick();
    expect(await sender.tick()).toEqual({ sent: 0, cancelled: 0, failed: 0, retried: 0 });
    await service.run({ pool: { band: 'adult', locale: 'ru' }, mode: 'friends', slot: SLOT });
    await sender.tick();
    expect(calls).toHaveLength(2);
  });

  it('is rendered in the language each recipient uses now', async () => {
    const { a, b } = await matchedPair();
    // After the match was made, one of them switched SameSync to English (Q13).
    await testDb.ownerPool.query("UPDATE users SET locale = 'en' WHERE id = $1", [b.id]);
    const { sender, calls } = await buildSender(testDb);
    await sender.tick();
    const { item: itemName, take } = await names();
    const toA = calls.find((c) => c.payload.chat_id === a.telegramId)!.payload;
    const toB = calls.find((c) => c.payload.chat_id === b.telegramId)!.payload;
    expect(toA.text).toContain(itemName.ru);
    expect(toB.text).toMatch(/^New match! /);
    expect(toB.text).toContain(itemName.en ?? itemName.ru);
    expect(toB.text).toContain(take.en);
    expect(toB.reply_markup.inline_keyboard[0]![0]!.text).toBe('Open');
  });

  it('keeps the message text out of the logs', async () => {
    await matchedPair();
    const { sender, logLines } = await buildSender(testDb);
    await sender.tick();
    const { item: itemName, take } = await names();
    const logs = logLines().join('\n');
    expect(logs).not.toContain(itemName.ru);
    expect(logs).not.toContain(take.ru);
  });
});

describe('quiet hours (Q22)', () => {
  it('sends silently between 23:00 and 08:00 in the recipient time zone, and never holds a message', async () => {
    // 15:30 UTC: 00:30 in Tokyo (quiet), 18:30 in Moscow (not quiet).
    const { a, b } = await matchedPair({ timezone: 'Asia/Tokyo' }, { timezone: 'Europe/Moscow' });
    const { sender, calls } = await buildSender(testDb, { now: new Date('2026-10-03T15:30:00Z') });
    expect(await sender.tick()).toMatchObject({ sent: 2 });
    const toA = calls.find((c) => c.payload.chat_id === a.telegramId)!.payload;
    const toB = calls.find((c) => c.payload.chat_id === b.telegramId)!.payload;
    expect(toA.disable_notification).toBe(true);
    expect(toB).not.toHaveProperty('disable_notification');
  });

  it('assumes the pool time zone for a user who never reported one', async () => {
    // 21:00 UTC is midnight in Moscow, the ru pool's zone.
    await matchedPair({ timezone: null }, { timezone: 'America/New_York' });
    const { sender, calls } = await buildSender(testDb, { now: new Date('2026-10-03T21:00:00Z') });
    await sender.tick();
    expect(calls.map((c) => c.payload.disable_notification ?? false).sort()).toEqual([false, true]);
  });
});

describe('delivery failures', () => {
  it('a 403 marks the user unreachable, is not retried, and keeps them out of later runs', async () => {
    const { a, b, service } = await matchedPair();
    const { sender, calls, clock } = await buildSender(testDb, {
      answer: (call) => (call.chat_id === a.telegramId ? BLOCKED : { ok: true }),
    });
    expect(await sender.tick()).toEqual({ sent: 1, cancelled: 0, failed: 1, retried: 0 });
    expect(await outboxOf(a.id)).toMatchObject({
      status: 'failed',
      last_error: '403: Forbidden: bot was blocked by the user',
    });
    expect(await outboxOf(b.id)).toMatchObject({ status: 'sent' });
    const reachable = async (id: string) =>
      (
        await testDb.ownerPool.query<{ bot_reachable: boolean }>(
          'SELECT bot_reachable FROM users WHERE id = $1',
          [id],
        )
      ).rows[0]?.bot_reachable;
    expect(await reachable(a.id)).toBe(false);
    expect(await reachable(b.id)).toBe(true);

    clock.set(new Date(clock.now().getTime() + 24 * 3_600_000));
    expect(await sender.tick()).toEqual({ sent: 0, cancelled: 0, failed: 0, retried: 0 });
    expect(calls).toHaveLength(2);
    const next = await service.run({
      pool: { band: 'adult', locale: 'ru' },
      mode: 'friends',
      slot: new Date('2026-10-03T17:00:00Z'),
    });
    expect(next).toMatchObject({ status: 'done', poolSize: 2, eligibleUsers: 1 });
  });

  it('treats "chat not found" (the user never started the bot) the same way', async () => {
    const { a } = await matchedPair();
    const { sender } = await buildSender(testDb, {
      answer: (call) =>
        call.chat_id === a.telegramId
          ? { ok: false, error_code: 400, description: 'Bad Request: chat not found' }
          : { ok: true },
    });
    expect(await sender.tick()).toMatchObject({ sent: 1, failed: 1 });
    expect(await outboxOf(a.id)).toMatchObject({ status: 'failed' });
  });

  it('retries a server error with growing pauses and gives up after six attempts', async () => {
    const { a } = await matchedPair();
    const { sender, calls, clock } = await buildSender(testDb, {
      answer: (call) =>
        call.chat_id === a.telegramId
          ? { ok: false, error_code: 502, description: 'Bad Gateway' }
          : { ok: true },
    });
    expect(await sender.tick()).toEqual({ sent: 1, cancelled: 0, failed: 0, retried: 1 });
    expect(await outboxOf(a.id)).toMatchObject({ status: 'pending', attempts: 1 });
    // Not due yet: 30 seconds after the first failure.
    clock.set(new Date(clock.now().getTime() + 29_000));
    expect(await sender.tick()).toEqual({ sent: 0, cancelled: 0, failed: 0, retried: 0 });
    for (let attempt = 2; attempt <= 6; attempt++) {
      clock.set(new Date(clock.now().getTime() + 3_600_000));
      await sender.tick();
    }
    expect(await outboxOf(a.id)).toMatchObject({
      status: 'failed',
      attempts: 6,
      last_error: '502: Bad Gateway',
    });
    clock.set(new Date(clock.now().getTime() + 3_600_000));
    await sender.tick();
    expect(calls.filter((c) => c.payload.chat_id === a.telegramId)).toHaveLength(6);
  });

  it('stops on a rate limit and waits as long as Telegram asks', async () => {
    const { a, b } = await matchedPair();
    const { sender, calls, clock } = await buildSender(testDb, {
      answer: (_call, attempt) =>
        attempt === 1
          ? { ok: false, error_code: 429, description: 'Too Many Requests', retry_after: 7 }
          : { ok: true },
    });
    expect(await sender.tick()).toEqual({ sent: 0, cancelled: 0, failed: 0, retried: 1 });
    // The first row hit the limit; the second was not even attempted.
    expect(calls).toHaveLength(1);
    clock.set(new Date(clock.now().getTime() + 7_000));
    expect(await sender.tick()).toEqual({ sent: 0, cancelled: 0, failed: 0, retried: 0 });
    clock.set(new Date(clock.now().getTime() + 60_000));
    expect(await sender.tick()).toMatchObject({ sent: 2 });
    expect(await outboxOf(a.id)).toMatchObject({ status: 'sent' });
    expect(await outboxOf(b.id)).toMatchObject({ status: 'sent' });
  });
});

describe('synthetic users (dev tooling)', () => {
  it('are matched with a real user, but only the real user gets a message', async () => {
    const { a, b } = await matchedPair({}, { synthetic: true });
    const { sender, calls } = await buildSender(testDb);
    expect(await sender.tick()).toEqual({ sent: 1, cancelled: 1, failed: 0, retried: 0 });
    expect(calls.map((c) => c.payload.chat_id)).toEqual([a.telegramId]);
    expect(await outboxOf(b.id)).toMatchObject({
      status: 'cancelled',
      cancel_reason: 'synthetic_user',
    });
  });
});
