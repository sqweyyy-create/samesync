/**
 * The real chat on a test database: the relay, the bot, the outbox sender, the jobs and the HTTP
 * API, all talking to one fake Bot API (support/telegram.ts) that records every call.
 */
import type { Update } from 'grammy/types';
import { createBot, type BotContext } from '../../src/bot/bot';
import { fixedClock, type Clock } from '../../src/clock';
import type { ContentStore } from '../../src/content/store';
import { createChatRepository } from '../../src/db/repositories/chat';
import { createMatchesRepository } from '../../src/db/repositories/matches';
import { createOutboxRepository } from '../../src/db/repositories/outbox';
import { createRevealRepository } from '../../src/db/repositories/reveal';
import { createUsersRepository } from '../../src/db/repositories/users';
import { DEFAULT_CHAT_PARAMS, type ChatParams } from '../../src/domain/chat/params';
import type { ContactFilter } from '../../src/domain/chat/relay';
import { createChatDeadlines } from '../../src/jobs/chat-deadlines';
import { createRetention } from '../../src/jobs/retention';
import type { Logger } from '../../src/logger';
import { createChatService } from '../../src/services/chat';
import { createOutboxSender } from '../../src/services/outbox-sender';
import { createRelayService, type RelayTelegram } from '../../src/services/relay';
import { createRevealService } from '../../src/services/reveal';
import { createUsernames } from '../../src/services/usernames';
import type { TestDatabase } from './db';
import {
  TEST_BOT_INFO,
  TEST_BOT_TOKEN,
  TEST_MINIAPP_URL,
  memoryLogger,
  type TestUser,
} from './fixtures';
import { fakeTelegram, type FakeTelegram } from './telegram';

export interface ChatServicesOptions {
  content: ContentStore;
  clock: Clock;
  logger: Logger;
  telegram: FakeTelegram<BotContext>;
  params?: Partial<ChatParams>;
  contactFilter?: ContactFilter;
  /** The username a synthetic user has in this test; none by default, like in production. */
  syntheticUsername?: string;
  /** Runs instead of the relay's wait before it tries a delivery again. */
  onRetryWait?: () => Promise<void>;
}

/** The services of the chat, wired like in main.ts. */
export function chatServices(testDb: TestDatabase, options: ChatServicesOptions) {
  const { content, clock, logger, telegram } = options;
  const params = { ...DEFAULT_CHAT_PARAMS, ...options.params };
  const users = createUsersRepository(testDb.db);
  const matches = createMatchesRepository(testDb.db);
  const chat = createChatRepository(testDb.db);
  const relayTelegram: RelayTelegram = {
    sendMessage: (chatId, text, other) => telegram.bot.api.sendMessage(chatId, text, other),
  };
  const usernames = createUsernames({
    getChat: (chatId) => telegram.bot.api.getChat(chatId),
    syntheticUsername: options.syntheticUsername,
  });
  const relay = createRelayService({
    chat,
    users,
    content,
    telegram: relayTelegram,
    clock,
    logger,
    params,
    ...(options.contactFilter ? { contactFilter: options.contactFilter } : {}),
    sleep: () => options.onRetryWait?.() ?? Promise.resolve(),
  });
  const chats = createChatService({
    users,
    matches,
    chat,
    relay,
    telegram: relayTelegram,
    content,
    clock,
    logger,
  });
  const reveal = createRevealService({
    reveal: createRevealRepository(testDb.db),
    usernames,
    clock,
    logger,
  });
  return { params, users, matches, chat, relay, chats, reveal, usernames };
}

export interface ChatAppOptions {
  /** The real current time by default: the database's age checks use the real date. */
  clock?: Clock & { set(next: Date): void };
  params?: Partial<ChatParams>;
  contactFilter?: ContactFilter;
  syntheticUsername?: string;
  onRetryWait?: () => Promise<void>;
  /** `U18_POOL_ENABLED`, for the parts of the API that look at it. The chat never does. */
  u18PoolEnabled?: boolean;
}

export async function buildChatApp(testDb: TestDatabase, options: ChatAppOptions = {}) {
  // Imported here, not at the top: support/app.ts imports this module for its own chat service.
  const { buildTestApp, realContent } = await import('./app');
  const content = await realContent();
  const clock = options.clock ?? fixedClock(new Date());
  const { logger, lines } = memoryLogger();
  const telegram = fakeTelegram<BotContext>();
  const services = chatServices(testDb, { ...options, content, clock, logger, telegram });
  const { users, chat, relay, chats, reveal, usernames, params } = services;

  const bot = telegram.attach(
    createBot({
      token: TEST_BOT_TOKEN,
      miniAppUrl: TEST_MINIAPP_URL,
      logger,
      users,
      botInfo: TEST_BOT_INFO,
      chat: {
        chat,
        relay,
        chats,
        reveal,
        content,
        miniAppUrl: TEST_MINIAPP_URL,
        maxLength: params.maxLength,
      },
    }),
  );
  const sender = createOutboxSender({
    outbox: createOutboxRepository(testDb.db),
    users,
    content,
    telegram: {
      sendMessage: (chatId, text, other) => telegram.bot.api.sendMessage(chatId, text, other),
    },
    usernames,
    clock,
    logger,
    miniAppUrl: TEST_MINIAPP_URL,
    fallbackTimeZone: { ru: 'Europe/Moscow', en: 'UTC' },
    spacingMs: 0,
    perChatMs: 0,
    sleep: () => Promise.resolve(),
  });

  // The HTTP API on the same services and the same fake Bot API.
  const http = await buildTestApp(testDb, {
    content,
    clock,
    logger,
    chat: { chats, telegram },
    ...(options.u18PoolEnabled === undefined ? {} : { u18PoolEnabled: options.u18PoolEnabled }),
  });

  /** Log lines at level error or above: a handler that threw is caught by the bot and logged. */
  const errors = () =>
    lines().filter((line) => (JSON.parse(line) as { level: number }).level >= 50);

  return {
    ...services,
    content,
    clock,
    telegram,
    bot,
    sender,
    /** Requests to the HTTP API as a Telegram user, with signed initData. */
    as: (user: TestUser) => http.as(user),
    deadlines: createChatDeadlines({ chat, clock, logger, params }),
    retention: createRetention({ chat, clock, logger }),
    logLines: lines,
    /** Feeds one update to the bot, and fails if a handler threw. */
    async handle(update: Update): Promise<void> {
      const before = errors().length;
      await bot.handleUpdate(update);
      const failed = errors().slice(before);
      if (failed.length > 0) throw new Error(`bot handler failed: ${failed.join('\n')}`);
    },
  };
}

export type ChatApp = Awaited<ReturnType<typeof buildChatApp>>;
