/**
 * Composition root: ONE process running the bot, the HTTP API and the scheduler (PLAN.md §2).
 * Phase 0: long polling only; webhook mode and static Mini App serving arrive with deployment.
 */
import { serve } from '@hono/node-server';
import { createBot } from './bot/bot';
import { systemClock } from './clock';
import { ConfigError, loadConfig, type Config } from './config';
import { createDb, createPool } from './db/client';
import { createUsersRepository } from './db/repositories/users';
import { createHttpApp } from './http/app';
import { createScheduler } from './jobs/scheduler';
import { createLogger } from './logger';
import { createSessionService } from './services/session';

let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  createLogger('info').fatal({ issues: error.issues }, 'invalid configuration, refusing to start');
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const pool = createPool(config.databaseUrl);
const clock = systemClock;

const session = createSessionService({ users: createUsersRepository(createDb(pool)), clock });
const app = createHttpApp({
  botToken: config.botToken,
  initData: config.initData,
  clock,
  logger,
  session,
});
const bot = createBot({ token: config.botToken, miniAppUrl: config.miniAppUrl, logger });
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

// Fail fast: database reachable and bot token valid before we accept traffic.
try {
  await pool.query('select 1');
} catch (error) {
  logger.fatal({ err: error }, 'database is not reachable');
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
