/* eslint-disable no-console -- CLI output */
/**
 * Lets the synthetic counterpart of a development chat say something, so the chat can be checked
 * in Telegram with one account: the message goes through the real relay, and the real user gets
 * it in the bot exactly as from a real person. Without a text it prints the chat so far, which
 * is how to see what the synthetic side "received" (nothing is ever sent to a synthetic user).
 * Refuses to run in production.
 *
 *   pnpm dev:say <match id or alias> "<text>"
 *   pnpm dev:say <match id or alias>            # the latest messages of that chat
 *   pnpm dev:say                                # the chats there are
 *
 * The alias is the counterpart's name as the bot shows it: "Лиса", "fox", "a.fox" or "🦊".
 */
import { parseArgs } from 'node:util';
import { Api } from 'grammy';
import { systemClock } from '../src/clock';
import { ConfigError, loadConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { createChatRepository } from '../src/db/repositories/chat';
import { createUsersRepository } from '../src/db/repositories/users';
import { DEFAULT_CHAT_PARAMS } from '../src/domain/chat/params';
import { createLogger } from '../src/logger';
import { createRelayService } from '../src/services/relay';
import {
  describeDevChat,
  devChats,
  sayAsCounterpart,
  selectDevChats,
  transcript,
} from './lib/dev-chat';
import { connect, fail, refuseInProduction } from './lib/dev-runtime';

refuseInProduction('dev:say');

const { positionals } = parseArgs({ allowPositionals: true, options: {} });
const [selector, ...words] = positionals;
const text = words.join(' ').trim();

const { db, content } = await connect();
let exitCode = 1;
try {
  const all = await devChats(db);
  const listed = () =>
    all.length === 0
      ? 'There is no open chat with a synthetic counterpart. Make one with\n' +
        '  pnpm dev:match-me <public_id> --counterpart-plays\n' +
        'and play your side of the game: the chat opens when the results are ready.'
      : `Open chats with a synthetic counterpart:\n${all.map((c) => `  ${describeDevChat(c, content)}`).join('\n')}`;
  if (!selector) {
    console.log(listed());
    console.log('\nUsage: pnpm dev:say <match id or alias> "<text>"');
    exitCode = 0;
  } else {
    const chats = selectDevChats(all, content, selector);
    const [chat, ...others] = chats;
    if (!chat) fail(`No open chat matches "${selector}".\n${listed()}`);
    if (others.length > 0) {
      fail(
        `"${selector}" names several chats. Use the match ID:\n` +
          chats.map((c) => `  ${describeDevChat(c, content)}`).join('\n'),
      );
    }
    if (!text) {
      const lines = await transcript(db, chat);
      console.log(describeDevChat(chat, content));
      if (lines.length === 0) console.log('  (nobody has written yet)');
      for (const line of lines) {
        const who = line.from === 'counterpart' ? 'counterpart' : 'you';
        console.log(`  ${who.padEnd(11)} [${line.state}] ${line.text ?? '(text removed)'}`);
      }
      exitCode = 0;
    } else {
      // The same configuration the server uses: the relay sends with the bot's own token.
      let botToken: string;
      try {
        botToken = loadConfig(process.env).botToken;
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        fail(error.message);
      }
      const api = new Api(botToken);
      const drizzle = createDb(db);
      const relay = createRelayService({
        chat: createChatRepository(drizzle),
        users: createUsersRepository(drizzle),
        content,
        // A new plain-text message, like every relayed one: never a forward or a copy.
        telegram: {
          sendMessage: (chatId, body, options) => api.sendMessage(chatId, body, options),
        },
        clock: systemClock,
        logger: createLogger('warn'),
        params: DEFAULT_CHAT_PARAMS,
      });
      const result = await sayAsCounterpart({ relay }, chat, text);
      if (result.status === 'delivered') {
        console.log(`Sent as the counterpart of ${describeDevChat(chat, content)}.`);
        console.log(
          result.first
            ? 'It was the first message: the chat has started and no longer expires.'
            : 'Check the bot chat in Telegram.',
        );
        exitCode = 0;
      } else if (result.status === 'refused') {
        console.log(`Not delivered: the relay refused it (${result.reason}).`);
        if (result.reason === 'not_delivered') {
          console.log(
            'If the bot is blocked or was never started, send /start to it and try again.',
          );
        }
      } else {
        console.log(`Not delivered (${result.status}).`);
      }
    }
  }
} finally {
  await db.end();
}
process.exit(exitCode);
