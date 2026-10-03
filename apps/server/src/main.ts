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
import { createMatchesRepository } from './db/repositories/matches';
import { createProfileRepository } from './db/repositories/profile';
import { createUsersRepository } from './db/repositories/users';
import { createHttpApp } from './http/app';
import { createScheduler } from './jobs/scheduler';
import { createLogger } from './logger';
import { createMatchesService } from './services/matches';
import { createProfileService } from './services/profile';

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
  matches: createMatchesService({ users, matches: createMatchesRepository(db), content, clock }),
});
const bot = createBot({ token: config.botToken, miniAppUrl: config.miniAppUrl, logger, users });
const scheduler = createScheduler({ logger, jobs: [] });

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
