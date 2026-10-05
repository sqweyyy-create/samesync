/**
 * Composition root: ONE process running the bot, the HTTP API and the scheduler (PLAN.md §2).
 * Long polling only; webhook mode and static Mini App serving arrive with deployment (Phase 6).
 */
import { serve } from '@hono/node-server';
import { contentChecksum, loadValidContent } from '@samesync/content';
import { createBot } from './bot/bot';
import { systemClock } from './clock';
import { ConfigError, loadConfig, type Config } from './config';
import { assertContentSeeded } from './content/seed';
import { createContentStore, type ContentStore } from './content/store';
import { createDb, createPool } from './db/client';
import { createGamesRepository } from './db/repositories/games';
import { createMatchesRepository } from './db/repositories/matches';
import { createMatchingRepository } from './db/repositories/matching';
import { createOutboxRepository } from './db/repositories/outbox';
import { createProfileRepository } from './db/repositories/profile';
import { createUsersRepository } from './db/repositories/users';
import { DEFAULT_GAME_PARAMS } from './domain/game/params';
import { DEFAULT_MATCHING_PARAMS } from './domain/matching/params';
import { createHttpApp } from './http/app';
import { createAgeTransition } from './jobs/age-transition';
import { createGameDeadlines } from './jobs/game-deadlines';
import {
  createAgeTransitionJob,
  createGameDeadlinesJob,
  createMatchingJob,
  createOutboxJob,
} from './jobs/jobs';
import { workerPlanner } from './jobs/matching-planner';
import { createScheduler } from './jobs/scheduler';
import { createLogger } from './logger';
import { createGameService } from './services/game';
import { createMatchesService } from './services/matches';
import { createMatchingService } from './services/matching';
import { createOutboxSender } from './services/outbox-sender';
import { createProfileService } from './services/profile';
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

const profile = createProfileService({
  users,
  profile: createProfileRepository(db),
  content,
  clock,
  u18PoolEnabled: config.u18PoolEnabled,
});
const app = createHttpApp({
  botToken: config.botToken,
  initData: config.initData,
  clock,
  logger,
  profile,
  matches: createMatchesService({ users, matches, content, clock }),
  game: createGameService({ users, matches, games, content, clock }),
});
const bot = createBot({ token: config.botToken, miniAppUrl: config.miniAppUrl, logger, users });
// The current username, read from Telegram, for the one notification that reveals it.
const usernames = createUsernames({
  getChat: (chatId) => bot.api.getChat(chatId),
  // Synthetic users only exist on development databases; production ignores them regardless.
  syntheticUsername: config.nodeEnv === 'production' ? undefined : DEV_SYNTHETIC_USERNAME,
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

scheduler.start();
bot
  .start({ onStart: (me) => logger.info({ bot: me.username }, 'bot polling started') })
  .catch(async (error: unknown) => {
    logger.fatal({ err: error }, 'bot polling stopped unexpectedly');
    await shutdown(1);
  });
