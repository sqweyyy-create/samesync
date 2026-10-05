/* eslint-disable no-console -- CLI output */
/**
 * Makes the synthetic counterpart of a development chat consent to a username reveal, so the
 * whole reveal can be checked in Telegram with one account. The consent goes through the real
 * reveal service, and the database decides like for anyone else (adults only, an open chat).
 * A synthetic user has no Telegram account: outside production it "has" the username
 * @synthetic_user, and nothing is ever sent to it. Refuses to run in production.
 *
 *   pnpm dev:reveal <match id or alias>
 *
 * Either order works:
 *   - run this first: the bot asks you "Agree / Not now"; agree, and you get the username;
 *   - or send /reveal to the bot and agree first, then run this: you get the username.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Api } from 'grammy';
import { systemClock } from '../src/clock';
import { ConfigError, loadConfig, type Config } from '../src/config';
import { createDb } from '../src/db/client';
import { createOutboxRepository } from '../src/db/repositories/outbox';
import { createRevealRepository } from '../src/db/repositories/reveal';
import { createUsersRepository } from '../src/db/repositories/users';
import { LOCK, withAdvisoryLock } from '../src/jobs/advisory-lock';
import { createLogger } from '../src/logger';
import { createOutboxSender } from '../src/services/outbox-sender';
import { createRevealService } from '../src/services/reveal';
import { DEV_SYNTHETIC_USERNAME, createUsernames } from '../src/services/usernames';
import { consentAsCounterpart, describeDevChat, devChats, selectDevChats } from './lib/dev-chat';
import { connect, fail, refuseInProduction } from './lib/dev-runtime';

refuseInProduction('dev:reveal');

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const selector = positionals[0];
if (!selector)
  fail('Usage: pnpm dev:reveal <match id or alias>   (see pnpm dev:say for the chats)');

// The same configuration the server uses: Telegram is asked for your current username, and the
// bot's messages to you go out with its own token.
let config: Config;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  fail(error.message);
}

const { db, content } = await connect();
let exitCode = 1;
try {
  const all = await devChats(db);
  const chats = selectDevChats(all, content, selector);
  const [chat, ...others] = chats;
  if (!chat) {
    fail(
      `No open chat matches "${selector}".` +
        (all.length > 0
          ? `\nOpen chats with a synthetic counterpart:\n${all.map((c) => `  ${describeDevChat(c, content)}`).join('\n')}`
          : '\nThere is no open chat with a synthetic counterpart (see pnpm dev:match-me).'),
    );
  }
  if (others.length > 0) {
    fail(
      `"${selector}" names several chats. Use the match ID:\n` +
        chats.map((c) => `  ${describeDevChat(c, content)}`).join('\n'),
    );
  }

  const api = new Api(config.botToken);
  const drizzle = createDb(db);
  const logger = createLogger('warn');
  const usernames = createUsernames({
    getChat: (chatId) => api.getChat(chatId),
    syntheticUsername: DEV_SYNTHETIC_USERNAME,
  });
  const reveal = createRevealService({
    reveal: createRevealRepository(drizzle),
    usernames,
    clock: systemClock,
    logger,
  });
  const outcome = await consentAsCounterpart({ reveal }, chat);
  console.log(`Chat: ${describeDevChat(chat, content)}`);
  switch (outcome.status) {
    case 'unavailable':
      console.log(
        'The reveal is not available in this chat (adults only, and the chat must be open).',
      );
      break;
    case 'username_needed':
      console.log('The counterpart has no username here: synthetic usernames are off.');
      break;
    case 'waiting':
      console.log('The counterpart agreed. The bot now asks you: "Agree / Not now".');
      exitCode = 0;
      break;
    case 'other_username_missing':
      console.log(
        'The counterpart agreed, and so did you, but your Telegram account has no username.\n' +
          'Set one in Telegram, then send /reveal to the bot.',
      );
      break;
    case 'revealed':
      console.log(
        outcome.already
          ? 'The usernames were exchanged before.'
          : `Both agreed: the bot sends you the username (@${DEV_SYNTHETIC_USERNAME}).`,
      );
      exitCode = 0;
      break;
  }

  if (outcome.status === 'waiting' || (outcome.status === 'revealed' && !outcome.already)) {
    // Deliver what was queued for you (a running server may be doing the same; the lock keeps
    // it to one sender).
    const sender = createOutboxSender({
      outbox: createOutboxRepository(drizzle),
      users: createUsersRepository(drizzle),
      content,
      telegram: {
        sendMessage: (chatId, text, options) => api.sendMessage(chatId, text, options),
      },
      usernames,
      clock: systemClock,
      logger,
      miniAppUrl: config.miniAppUrl,
      fallbackTimeZone: {
        ru: config.matching.drops.ru.timeZone,
        en: config.matching.drops.en.timeZone,
      },
    });
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
         FROM outbox
         WHERE match_id = $1 AND user_id = $2 AND kind IN ('reveal_request', 'reveal_done')
         ORDER BY created_at, id`,
        [chat.matchId, chat.real.id],
      ));
      if (!queued.some((row) => row.status === 'pending')) break;
      const ticked = await withAdvisoryLock(db, LOCK.outbox, () => sender.tick());
      if (!ticked.acquired) await sleep(500);
    }
    const NAMES: Record<string, string> = {
      reveal_request: 'the question to you',
      reveal_done: 'the username',
    };
    for (const row of queued) {
      const name = `Message (${NAMES[row.kind] ?? row.kind})`;
      if (row.status === 'sent') console.log(`${name}: sent. Check the bot chat in Telegram.`);
      else if (row.status === 'cancelled') {
        console.log(`${name}: not sent (${row.cancel_reason ?? 'unknown'}).`);
      } else if (row.status === 'failed') {
        console.log(`${name}: not delivered (${row.last_error ?? 'unknown error'}).`);
        exitCode = 1;
      } else {
        console.log(`${name}: still pending. Is the server holding the outbox? Check its log.`);
      }
    }
  }
} finally {
  await db.end();
}
process.exit(exitCode);
