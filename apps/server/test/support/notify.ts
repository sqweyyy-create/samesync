/** The real outbox sender on a test database, talking to a fake Bot API through grammY. */
import { Bot } from 'grammy';
import { fixedClock } from '../../src/clock';
import { createOutboxRepository } from '../../src/db/repositories/outbox';
import { createUsersRepository } from '../../src/db/repositories/users';
import { createOutboxSender } from '../../src/services/outbox-sender';
import { realContent } from './app';
import type { TestDatabase } from './db';
import { TEST_BOT_INFO, TEST_BOT_TOKEN, TEST_MINIAPP_URL, memoryLogger } from './fixtures';

export interface SentMessage {
  chat_id: number;
  text: string;
  reply_markup: { inline_keyboard: Array<Array<{ text: string; web_app: { url: string } }>> };
  disable_notification?: boolean;
}

/** What the fake Bot API answers; an `error_code` makes grammY throw like the real API. */
export type ApiAnswer =
  { ok: true } | { ok: false; error_code: number; description: string; retry_after?: number };

export async function buildSender(
  testDb: TestDatabase,
  options: {
    /** Defaults to a weekday afternoon in every time zone used by the tests. */
    now?: Date;
    answer?: (call: SentMessage, attempt: number) => ApiAnswer;
  } = {},
) {
  const bot = new Bot(TEST_BOT_TOKEN, { botInfo: TEST_BOT_INFO });
  const calls: Array<{ method: string; payload: SentMessage }> = [];
  bot.api.config.use((_prev, method, payload) => {
    const call = payload as unknown as SentMessage;
    calls.push({ method, payload: call });
    const answer = options.answer?.(call, calls.length) ?? { ok: true };
    if (answer.ok) {
      const result = {
        message_id: calls.length,
        date: 0,
        chat: { id: call.chat_id, type: 'private' },
      };
      return Promise.resolve({ ok: true, result } as never);
    }
    return Promise.resolve({
      ok: false,
      error_code: answer.error_code,
      description: answer.description,
      ...(answer.retry_after ? { parameters: { retry_after: answer.retry_after } } : {}),
    } as never);
  });
  const clock = fixedClock(options.now ?? new Date('2026-10-03T12:00:00Z'));
  const { logger, lines } = memoryLogger();
  const sender = createOutboxSender({
    outbox: createOutboxRepository(testDb.db),
    users: createUsersRepository(testDb.db),
    content: await realContent(),
    telegram: {
      sendMessage: (chatId, text, other) => bot.api.sendMessage(chatId, text, other),
    },
    clock,
    logger,
    miniAppUrl: TEST_MINIAPP_URL,
    fallbackTimeZone: { ru: 'Europe/Moscow', en: 'UTC' },
    spacingMs: 0,
    perChatMs: 0,
    sleep: () => Promise.resolve(),
  });
  return { sender, calls, clock, logLines: lines };
}
