/**
 * A fake Bot API behind a real grammY bot object. Everything the server sends to Telegram in a
 * test goes through one of these and is recorded: the leak scanners read `calls`.
 */
import { Bot, type Context } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { TEST_BOT_INFO, TEST_BOT_TOKEN, type TestUser } from './fixtures';

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/** What the fake Bot API answers; an `error_code` makes grammY throw like the real API. */
export type ApiAnswer =
  { ok: true } | { ok: false; error_code: number; description: string; retry_after?: number };

export interface FakeTelegram<C extends Context = Context> {
  calls: ApiCall[];
  /** Calls of one method, e.g. every `sendMessage`. */
  of(method: string): ApiCall[];
  /** The messages sent to one chat, oldest first. */
  sentTo(chatId: number): Array<{ text: string; payload: Record<string, unknown> }>;
  /** Forget what was recorded so far. */
  clear(): void;
  /** Makes the fake API answer the calls of this bot object too. */
  attach<B extends Bot<C>>(bot: B): B;
  /** Decides the answer to each call; by default every call succeeds. */
  answer: (call: ApiCall) => ApiAnswer;
  /** What `getChat` knows about a Telegram account: its current username, if it has one. */
  usernames: Map<number, string>;
  /** A bare bot object on this fake API, for code that only needs `bot.api`. */
  bot: Bot;
}

export function fakeTelegram<C extends Context = Context>(
  botInfo: UserFromGetMe = TEST_BOT_INFO,
): FakeTelegram<C> {
  const calls: ApiCall[] = [];
  let messageId = 5000;
  const fake: FakeTelegram<C> = {
    calls,
    of: (method) => calls.filter((c) => c.method === method),
    sentTo: (chatId) =>
      calls
        .filter((c) => c.method === 'sendMessage' && c.payload['chat_id'] === chatId)
        .map((c) => ({ text: String(c.payload['text']), payload: c.payload })),
    clear: () => {
      calls.length = 0;
    },
    answer: () => ({ ok: true }),
    usernames: new Map(),
    attach(bot) {
      bot.api.config.use((_prev, method, payload) => {
        const call = { method, payload: payload as unknown as Record<string, unknown> };
        calls.push(call);
        const answer = fake.answer(call);
        if (!answer.ok) {
          return Promise.resolve({
            ok: false,
            error_code: answer.error_code,
            description: answer.description,
            ...(answer.retry_after ? { parameters: { retry_after: answer.retry_after } } : {}),
          } as never);
        }
        const chatId = Number(call.payload['chat_id']);
        let result: unknown = true;
        if (method === 'sendMessage' || method === 'editMessageText') {
          result = {
            message_id: method === 'sendMessage' ? ++messageId : call.payload['message_id'],
            date: 0,
            chat: { id: chatId, type: 'private' },
            text: call.payload['text'],
          };
        } else if (method === 'getChat') {
          const username = fake.usernames.get(chatId);
          result = { id: chatId, type: 'private', ...(username ? { username } : {}) };
        }
        return Promise.resolve({ ok: true, result } as never);
      });
      return bot;
    },
    bot: new Bot(TEST_BOT_TOKEN, { botInfo }),
  };
  fake.attach(fake.bot as unknown as Bot<C>);
  return fake;
}

let updateId = 0;
let incomingId = 100;

const sender = (from: TestUser) => ({ ...from, is_bot: false });
const privateChat = (from: TestUser) => ({
  id: from.id,
  type: 'private' as const,
  first_name: from.first_name,
  ...(from.last_name ? { last_name: from.last_name } : {}),
  ...(from.username ? { username: from.username } : {}),
});

export interface IncomingOptions {
  /** The bot's message (or the user's own) this one replies to. */
  replyTo?: number;
  /** Telegram's entities for the text, e.g. a link or bold. */
  entities?: Array<{ type: string; offset: number; length: number }>;
  messageId?: number;
}

/** A text message written to the bot in a private chat. A leading "/" makes it a command. */
export function textUpdate(from: TestUser, text: string, options: IncomingOptions = {}): Update {
  const command = /^\/[a-z_]+/.exec(text)?.[0];
  const entities = [
    ...(command ? [{ type: 'bot_command', offset: 0, length: command.length }] : []),
    ...(options.entities ?? []),
  ];
  return {
    update_id: ++updateId,
    message: {
      message_id: options.messageId ?? ++incomingId,
      date: 1_790_000_000,
      chat: privateChat(from),
      from: sender(from),
      text,
      ...(entities.length > 0 ? { entities } : {}),
      ...(options.replyTo === undefined
        ? {}
        : {
            reply_to_message: {
              message_id: options.replyTo,
              date: 1_790_000_000,
              chat: privateChat(from),
            },
          }),
    },
  } as Update;
}

/** Anything that is not a text message: `content` holds the media fields (photo, voice, …). */
export function mediaUpdate(from: TestUser, content: Record<string, unknown>): Update {
  return {
    update_id: ++updateId,
    message: {
      message_id: ++incomingId,
      date: 1_790_000_000,
      chat: privateChat(from),
      from: sender(from),
      ...content,
    },
  };
}

/** The user edited one of their messages. */
export function editUpdate(from: TestUser, messageId: number, text: string): Update {
  return {
    update_id: ++updateId,
    edited_message: {
      message_id: messageId,
      date: 1_790_000_000,
      edit_date: 1_790_000_100,
      chat: privateChat(from),
      from: sender(from),
      text,
    },
  };
}

/**
 * The user pressed an inline button under a message of the bot. `question` is that message; when
 * it was a reply to one of the user's messages, `original` is the message it replied to.
 */
export function callbackUpdate(
  from: TestUser,
  data: string,
  question: { messageId: number; original?: { messageId: number; text?: string; fromId?: number } },
): Update {
  const original = question.original;
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(updateId),
      from: sender(from),
      chat_instance: 'test',
      data,
      message: {
        message_id: question.messageId,
        date: 1_790_000_000,
        chat: privateChat(from),
        from: { id: TEST_BOT_INFO.id, is_bot: true, first_name: TEST_BOT_INFO.first_name },
        text: '…',
        ...(original
          ? {
              reply_to_message: {
                message_id: original.messageId,
                date: 1_790_000_000,
                chat: privateChat(from),
                from: { ...sender(from), id: original.fromId ?? from.id },
                ...(original.text === undefined ? {} : { text: original.text }),
              },
            }
          : {}),
      },
    },
  } as Update;
}

/** The ID Telegram gave the latest incoming message built here. */
export const lastIncomingId = () => incomingId;
