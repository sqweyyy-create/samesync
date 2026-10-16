/**
 * Composition root: ONE process running the bot, the HTTP API and the scheduler (PLAN.md §2).
 * Long polling only; webhook mode and static Mini App serving arrive with deployment (Phase 6).
 */
import { serve } from '@hono/node-server';
import { contentChecksum, loadValidContent } from '@samesync/content';
import { createBot } from './bot/bot';
import { registerCommands } from './bot/chat';
import { systemClock } from './clock';
import { ConfigError, loadConfig, type Config } from './config';
import { assertContentSeeded } from './content/seed';
import { createContentStore, type ContentStore } from './content/store';
import { createDb, createPool } from './db/client';
import { createAdminRepository } from './db/repositories/admin';
import { createChatRepository } from './db/repositories/chat';
import { createGamesRepository } from './db/repositories/games';
import { createMatchesRepository } from './db/repositories/matches';
import { createMatchingRepository } from './db/repositories/matching';
import { createOutboxRepository } from './db/repositories/outbox';
import { createProfileRepository } from './db/repositories/profile';
import { createRevealRepository } from './db/repositories/reveal';
import { createSafetyRepository } from './db/repositories/safety';
import { createUsersRepository } from './db/repositories/users';
import { DEFAULT_CHAT_PARAMS } from './domain/chat/params';
import { DEFAULT_GAME_PARAMS } from './domain/game/params';
import { DEFAULT_MATCHING_PARAMS } from './domain/matching/params';
import { DEFAULT_SAFETY_PARAMS } from './domain/safety/params';
import { createHttpApp } from './http/app';
import { createAgeTransition } from './jobs/age-transition';
import { createChatDeadlines } from './jobs/chat-deadlines';
import { createGameDeadlines } from './jobs/game-deadlines';
import {
  createAgeTransitionJob,
  createChatDeadlinesJob,
  createGameDeadlinesJob,
  createMatchingJob,
  createOutboxJob,
  createRetentionJob,
} from './jobs/jobs';
import { workerPlanner } from './jobs/matching-planner';
import { createRetention } from './jobs/retention';
import { createScheduler } from './jobs/scheduler';
import { createLogger } from './logger';
import { createAccountService } from './services/account';
import { createAdminService } from './services/admin';
import { createAdminNotifier } from './services/admin-alerts';
import { createChatService } from './services/chat';
import { createContactFilter } from './services/contact-filter';
import { createGameService } from './services/game';
import { createMatchesService } from './services/matches';
import { createMatchingService } from './services/matching';
import { createOutboxSender } from './services/outbox-sender';
import { createProfileService } from './services/profile';
import { createRelayService, type RelayTelegram } from './services/relay';
import { createRevealService } from './services/reveal';
import { createSafetyService } from './services/safety';
import { createSupportService } from './services/support';
import { DEV_SYNTHETIC_USERNAME, createUsernames } from './services/usernames';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  createLogger('info').fatal({ issues: error.issues }, 'invalid configuration, refusing to start');
  process.exit(1);
}

const logger = createLogger(config.logLevel);

// The content files must be valid before anything starts (they're also checked in CI).
let content: ContentStore;
try {
  const bundle = await loadValidContent(config.contentDir);
  content = createContentStore(bundle, contentChecksum(bundle));
} catch (error) {
  logger.fatal({ err: error }, 'content is invalid, refusing to start');
  process.exit(1);
}

const pool = createPool(config.databaseUrl);
const clock = systemClock;
const db = createDb(pool);
const users = createUsersRepository(db);
const matches = createMatchesRepository(db);
const games = createGamesRepository(db);
const chat = createChatRepository(db);
const safetyRepo = createSafetyRepository(db);
const adminRepo = createAdminRepository(db);

const profile = createProfileService({
  users,
  profile: createProfileRepository(db),
  content,
  clock,
  u18PoolEnabled: config.u18PoolEnabled,
});

// The bot is created after the services its handlers use, and they talk to Telegram through it:
// these two objects reach `bot.api` only when a message is actually sent.
// New plain-text messages only: no parse_mode, never forwardMessage or copyMessage.
const relayTelegram: RelayTelegram = {
  sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options),
};
const usernames = createUsernames({
  getChat: (chatId) => bot.api.getChat(chatId),
  // Synthetic users only exist on development databases; production ignores them regardless.
  syntheticUsername: config.nodeEnv === 'production' ? undefined : DEV_SYNTHETIC_USERNAME,
});
// Safety (Phase 5): admins are told straight away (they need not be users), reports and blocks
// go through one service, and the u18 relay runs the contact filter on every message.
const notifier = createAdminNotifier({
  adminTelegramIds: config.adminTelegramIds,
  users,
  telegram: { sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options) },
  logger,
});
const safety = createSafetyService({
  safety: safetyRepo,
  admin: adminRepo,
  users,
  matches,
  content,
  notifier,
  clock,
  logger,
  params: DEFAULT_SAFETY_PARAMS,
  systemActorId: () => bot.botInfo.id,
});
const relay = createRelayService({
  chat,
  users,
  content,
  telegram: relayTelegram,
  clock,
  logger,
  params: DEFAULT_CHAT_PARAMS,
  contactFilter: createContactFilter({ chat, params: DEFAULT_SAFETY_PARAMS }),
  safety,
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
  reveal: createRevealRepository(db),
  usernames,
  clock,
  logger,
});

const admin = createAdminService({ admin: adminRepo, safety, clock, logger });
const support = createSupportService({ notifier, clock, logger, params: DEFAULT_SAFETY_PARAMS });
const account = createAccountService({ admin: adminRepo, logger });

const app = createHttpApp({
  botToken: config.botToken,
  initData: config.initData,
  clock,
  logger,
  profile,
  matches: createMatchesService({ users, matches, content, clock }),
  game: createGameService({ users, matches, games, content, clock }),
  chat: chats,
  safety,
});
const bot = createBot({
  token: config.botToken,
  miniAppUrl: config.miniAppUrl,
  logger,
  users,
  chat: {
    chat,
    relay,
    chats,
    reveal,
    content,
    miniAppUrl: config.miniAppUrl,
    maxLength: DEFAULT_CHAT_PARAMS.maxLength,
  },
  safety: { chat, chats, safety, support, account, content },
  admin: { adminTelegramIds: config.adminTelegramIds, admin, clock },
});

const matching = createMatchingService({
  pool,
  repo: createMatchingRepository(db),
  content,
  planner: workerPlanner,
  clock,
  logger,
  params: {
    ...DEFAULT_MATCHING_PARAMS,
    dailyLimit: config.matching.dailyLimit,
    openLimit: config.matching.openLimit,
  },
  u18PoolEnabled: config.u18PoolEnabled,
  // Synthetic users only exist on development databases; production ignores them regardless.
  allowSynthetic: config.nodeEnv !== 'production',
});
const sender = createOutboxSender({
  outbox: createOutboxRepository(db),
  users,
  content,
  // New plain-text messages only: no parse_mode, never forwardMessage or copyMessage.
  telegram: { sendMessage: (chatId, text, options) => bot.api.sendMessage(chatId, text, options) },
  usernames,
  clock,
  logger,
  miniAppUrl: config.miniAppUrl,
  fallbackTimeZone: {
    ru: config.matching.drops.ru.timeZone,
    en: config.matching.drops.en.timeZone,
  },
});
const scheduler = createScheduler({
  logger,
  jobs: [
    createAgeTransitionJob({
      pool,
      ageTransition: createAgeTransition({
        users,
        u18PoolEnabled: config.u18PoolEnabled,
        logger,
      }),
    }),
    createMatchingJob({ matching, clock, logger, drops: config.matching.drops }),
    createGameDeadlinesJob({
      pool,
      deadlines: createGameDeadlines({ games, clock, logger, params: DEFAULT_GAME_PARAMS }),
    }),
    createChatDeadlinesJob({
      pool,
      deadlines: createChatDeadlines({ chat, clock, logger, params: DEFAULT_CHAT_PARAMS }),
    }),
    createRetentionJob({
      pool,
      retention: createRetention({
        chat,
        clock,
        logger,
        admin: adminRepo,
        params: DEFAULT_SAFETY_PARAMS,
      }),
    }),
    createOutboxJob({ pool, sender }),
  ],
});

let shuttingDown = false;
async function shutdown(exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('shutting down');
  const force = setTimeout(() => process.exit(exitCode || 1), 10_000);
  force.unref();
  await Promise.allSettled([
    bot.isRunning() ? bot.stop() : Promise.resolve(),
    scheduler.stop(),
    new Promise<void>((resolve) => server.close(() => resolve())),
  ]);
  await pool.end();
  process.exit(exitCode);
}

// Fail fast: database reachable, content seeded, and bot token valid before we accept traffic.
try {
  await pool.query('select 1');
  await assertContentSeeded(pool, content.release, content.checksum);
} catch (error) {
  logger.fatal({ err: error }, 'database is not ready (unreachable or content not seeded)');
  process.exit(1);
}

const server = serve(
  { fetch: app.fetch, hostname: config.http.host, port: config.http.port },
  (info) => logger.info({ host: info.address, port: info.port }, 'http listening'),
);
process.once('SIGINT', () => void shutdown(0));
process.once('SIGTERM', () => void shutdown(0));

try {
  await bot.init();
} catch (error) {
  logger.fatal({ err: error }, 'bot initialisation failed (check BOT_TOKEN)');
  await shutdown(1);
}
// The command menu, per locale. The bot works without it, so a failure is only logged.
registerCommands(bot.api).catch((error: unknown) =>
  logger.warn({ err: error }, 'bot commands not registered'),
);

scheduler.start();
bot
  .start({ onStart: (me) => logger.info({ bot: me.username }, 'bot polling started') })
  .catch(async (error: unknown) => {
    logger.fatal({ err: error }, 'bot polling stopped unexpectedly');
    await shutdown(1);
  });
