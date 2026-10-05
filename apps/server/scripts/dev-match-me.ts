/* eslint-disable no-console -- CLI output */
/**
 * Gives one real development user a match, so the bot notifications and the game can be checked
 * in Telegram. It creates synthetic users compatible with that user (same pool and mode, dating
 * compatibility), runs one matching run for the pool, and delivers the user's notifications.
 * Synthetic users never get a message. Refuses to run in production.
 *
 *   pnpm dev:match-me <public_id> [--n 300] [--lookalikes 3] [--counterpart-plays]
 *                     [--ignore-limits] [--strict] [--no-send]
 *
 * <public_id> is the support code shown in the Mini App settings.
 *   --counterpart-plays  the synthetic counterpart submits its guesses right away, so the game
 *                        can be finished alone: play your side and the results are ready
 *   --ignore-limits      lift the free-tier limits (3 new matches a day, 5 open) for this run
 *   --strict             keep the 24 h / 72 h waiting thresholds of the fallback tiers
 *   --no-send            leave the notifications in the outbox (a running server sends them)
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Api } from 'grammy';
import { systemClock } from '../src/clock';
import { ConfigError, loadConfig, type Config } from '../src/config';
import { createDb } from '../src/db/client';
import { createGamesRepository } from '../src/db/repositories/games';
import { createMatchingRepository } from '../src/db/repositories/matching';
import { createOutboxRepository } from '../src/db/repositories/outbox';
import { createUsersRepository } from '../src/db/repositories/users';
import { DEFAULT_MATCHING_PARAMS } from '../src/domain/matching/params';
import { LOCK, withAdvisoryLock } from '../src/jobs/advisory-lock';
import { inProcessPlanner } from '../src/jobs/matching-planner';
import { createLogger } from '../src/logger';
import { createGamePlay } from '../src/services/game';
import { createMatchingService } from '../src/services/matching';
import { createOutboxSender } from '../src/services/outbox-sender';
import { DEV_SYNTHETIC_USERNAME, createUsernames } from '../src/services/usernames';
import { connect, fail, refuseInProduction } from './lib/dev-runtime';
import { INELIGIBLE_HINT, matchMe } from './lib/match-me';

refuseInProduction('dev:match-me');

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    n: { type: 'string', default: '300' },
    lookalikes: { type: 'string', default: '3' },
    'counterpart-plays': { type: 'boolean', default: false },
    'ignore-limits': { type: 'boolean', default: false },
    strict: { type: 'boolean', default: false },
    'no-send': { type: 'boolean', default: false },
  },
});
const publicId = positionals[0]?.toUpperCase();
if (!publicId || !/^[0-9A-HJKMNP-TV-Z]{10}$/.test(publicId)) {
  fail('Usage: pnpm dev:match-me <public_id>   (the 10-character support code from Settings)');
}
const poolSize = Number(values.n);
const lookalikes = Number(values.lookalikes);
if (!Number.isInteger(poolSize) || poolSize < 0 || poolSize > 20_000) fail('--n must be 0–20000');
if (!Number.isInteger(lookalikes) || lookalikes < 1 || lookalikes > 20) {
  fail('--lookalikes must be 1–20');
}

// The same configuration the server uses. Sending needs BOT_TOKEN and MINIAPP_URL.
let config: Config | null = null;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  if (!values['no-send']) fail(`${error.message}\n(or pass --no-send to skip sending)`);
}

const { db, content } = await connect();
const logger = createLogger('warn');
const drizzle = createDb(db);
const repo = createMatchingRepository(drizzle);
const params = {
  ...DEFAULT_MATCHING_PARAMS,
  ...(config
    ? { dailyLimit: config.matching.dailyLimit, openLimit: config.matching.openLimit }
    : {}),
};
let exitCode = 1;
try {
  const result = await matchMe(
    {
      db,
      content,
      repo,
      params,
      now: new Date(),
      play: createGamePlay({ games: createGamesRepository(drizzle), clock: systemClock }),
      matching: createMatchingService({
        pool: db,
        repo,
        content,
        planner: inProcessPlanner,
        clock: systemClock,
        logger,
        params,
        u18PoolEnabled: config?.u18PoolEnabled ?? false,
        allowSynthetic: true,
      }),
    },
    {
      publicId,
      poolSize,
      lookalikes,
      counterpartPlays: values['counterpart-plays'],
      ignoreLimits: values['ignore-limits'],
      strict: values.strict,
      seed: Math.floor(Math.random() * 2 ** 31),
    },
  );

  if (result.status === 'user_not_found') fail(`No user with the support code ${publicId}.`);
  if (result.status === 'user_not_ready') fail(`Can't match this user: ${result.reason}.`);

  const { pool, mode, added, run } = result;
  console.log(`Pool ${pool.band}:${pool.locale}, ${mode} mode.`);
  console.log(`Synthetic users added: ${added.fillers} fillers, ${added.lookalikes} lookalikes.`);
  if (run.status === 'done') {
    const tiers = run.tierCounts;
    console.log(
      `Matching run: ${run.pairsCreated} pairs (tier 1: ${tiers[1]}, tier 2: ${tiers[2]}, tier 3: ${tiers[3]}), ` +
        `${run.eligibleUsers} of ${run.poolSize} users eligible, ${run.pairsRejected} refused by the database.`,
    );
  } else if (run.status === 'disabled') {
    console.log('Matching run: skipped, the u18 pool is disabled (U18_POOL_ENABLED=false).');
  } else {
    console.log('Matching run: another run for this pool is in progress. Try again in a moment.');
  }

  if (result.status === 'not_matched' || !result.match) {
    const why = result.ineligible
      ? INELIGIBLE_HINT[result.ineligible]
      : values.strict
        ? 'no partner was found under the real waiting thresholds (try without --strict)'
        : 'no partner was found';
    console.log(`No match for ${publicId}: ${why}.`);
  } else {
    const { match } = result;
    console.log(`\nMatch for ${publicId}: ${match.alias}, tier ${match.tier}.`);
    console.log(`Teaser: ${match.teaser}`);
    if (match.counterpart === 'played') {
      console.log('Counterpart: its guesses are in. Play your side and the results are ready.');
    } else if (match.counterpart === 'real_user') {
      console.log('Counterpart: a real user, so nobody played for them.');
    } else if (match.counterpart === 'refused') {
      console.log('Counterpart: could not play (the game refused the guesses).');
    }
    exitCode = 0;

    if (values['no-send'] || !config) {
      console.log('Notifications: left in the outbox (--no-send). A running server sends them.');
    } else {
      const api = new Api(config.botToken);
      const sender = createOutboxSender({
        outbox: createOutboxRepository(drizzle),
        users: createUsersRepository(drizzle),
        content,
        telegram: {
          sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
        },
        usernames: createUsernames({
          getChat: (chatId) => api.getChat(chatId),
          syntheticUsername: DEV_SYNTHETIC_USERNAME,
        }),
        clock: systemClock,
        logger,
        miniAppUrl: config.miniAppUrl,
        fallbackTimeZone: {
          ru: config.matching.drops.ru.timeZone,
          en: config.matching.drops.en.timeZone,
        },
      });
      // Send what is due (a running server may be doing the same; the lock keeps it to one).
      // The user gets "new match" and, when the counterpart has played, "your turn".
      interface Queued {
        kind: string;
        status: string;
        cancel_reason: string | null;
        last_error: string | null;
      }
      let queued: Queued[] = [];
      for (let attempt = 0; attempt < 60; attempt++) {
        ({ rows: queued } = await db.query<Queued>(
          `SELECT kind::text AS kind, status::text AS status, cancel_reason, last_error
           FROM outbox WHERE match_id = $1 AND user_id = $2 ORDER BY created_at, id`,
          [match.id, result.userId],
        ));
        if (!queued.some((row) => row.status === 'pending')) break;
        const ticked = await withAdvisoryLock(db, LOCK.outbox, () => sender.tick());
        if (!ticked.acquired) await sleep(500);
      }
      const NAMES: Record<string, string> = {
        match_created: 'new match',
        game_turn: 'your turn',
      };
      for (const row of queued) {
        const name = `Notification (${NAMES[row.kind] ?? row.kind})`;
        if (row.status === 'sent') console.log(`${name}: sent. Check the bot chat in Telegram.`);
        else if (row.status === 'failed') {
          console.log(`${name}: not delivered (${row.last_error ?? 'unknown error'}).`);
          console.log(
            'If the bot is blocked or was never started, send /start to it and run this again.',
          );
          exitCode = 1;
        } else if (row.status === 'cancelled') {
          console.log(`${name}: dropped before sending (${row.cancel_reason ?? 'unknown'}).`);
          exitCode = 1;
        } else {
          console.log(`${name}: still pending. Is the server holding the outbox? Check its log.`);
          exitCode = 1;
        }
      }
      if (queued.length === 0) {
        console.log('Notifications: none were queued for this user.');
        exitCode = 1;
      }
    }
  }
} finally {
  await db.end();
}
process.exit(exitCode);
