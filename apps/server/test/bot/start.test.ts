import type { Locale } from '@samesync/shared';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { createBot, type BotContext } from '../../src/bot/bot';
import { TEST_BOT_INFO, TEST_BOT_TOKEN, TEST_MINIAPP_URL, memoryLogger } from '../support/fixtures';

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

/**
 * Runs the real bot against fake updates and records every outgoing Bot API call. `stored` holds
 * the locale of users who already have a row (Q13). Username capture against a real DB is in
 * test/safety/username-capture.test.ts.
 */
function harness(stored: Record<number, Locale> = {}): {
  bot: Bot<BotContext>;
  calls: ApiCall[];
  reachable: Array<[number, boolean]>;
} {
  const calls: ApiCall[] = [];
  const reachable: Array<[number, boolean]> = [];
  const bot = createBot({
    token: TEST_BOT_TOKEN,
    miniAppUrl: TEST_MINIAPP_URL,
    logger: memoryLogger().logger,
    botInfo: TEST_BOT_INFO,
    users: {
      localeOf: (telegramId) => Promise.resolve(stored[telegramId] ?? null),
      storeUsernameIfAdult: () => Promise.resolve(),
      setBotReachable: (telegramId, value) => {
        reachable.push([telegramId, value]);
        return Promise.resolve();
      },
    },
  });
  bot.api.config.use((_prev, method, payload) => {
    calls.push({ method, payload });
    const result = { message_id: calls.length, date: 0, chat: { id: 1, type: 'private' } };
    return Promise.resolve({ ok: true, result } as never);
  });
  return { bot, calls, reachable };
}

/** The user blocked ("kicked") or unblocked ("member") the bot in their private chat. */
function blockUpdate(userId: number, status: 'kicked' | 'member'): Update {
  const user = { id: userId, is_bot: false, first_name: 'Аня' };
  const bot = { id: 1234567890, is_bot: true, first_name: 'SameSync' };
  return {
    update_id: ++updateId,
    my_chat_member: {
      chat: { id: userId, type: 'private', first_name: 'Аня' },
      from: user,
      date: 1_790_000_000,
      old_chat_member: {
        status: status === 'kicked' ? 'member' : 'kicked',
        user: bot,
        until_date: 0,
      },
      new_chat_member:
        status === 'kicked'
          ? { status: 'kicked', user: bot, until_date: 0 }
          : { status: 'member', user: bot },
    },
  };
}

let updateId = 0;
function command(
  text: string,
  from: { id: number; first_name: string; language_code?: string },
  chatType: 'private' | 'group' = 'private',
): Update {
  const chat =
    chatType === 'private'
      ? { id: from.id, type: 'private' as const, first_name: from.first_name }
      : { id: -100123, type: 'group' as const, title: 'Some group' };
  return {
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 1_790_000_000,
      chat,
      from: { ...from, is_bot: false },
      text,
      entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0]?.length ?? 0 }],
    },
  };
}

describe('bot /start and /help', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
  });

  it('replies to /start in Russian for a ru client, with a web_app button to the Mini App', async () => {
    await h.bot.handleUpdate(command('/start', { id: 42, first_name: 'Аня', language_code: 'ru' }));
    const ru = translatorFor('ru');
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toEqual({
      method: 'sendMessage',
      payload: {
        chat_id: 42,
        text: ru.t('bot.start.greeting', { name: 'Аня' }),
        reply_markup: {
          inline_keyboard: [
            [{ text: ru.t('bot.start.open_app'), web_app: { url: TEST_MINIAPP_URL } }],
          ],
        },
      },
    });
  });

  it.each([['en'], ['de'], [undefined]])(
    'replies to /start in English for language_code=%s',
    async (code) => {
      const from =
        code === undefined
          ? { id: 7, first_name: 'Sam' }
          : { id: 7, first_name: 'Sam', language_code: code };
      await h.bot.handleUpdate(command('/start', from));
      const en = translatorFor('en');
      expect(h.calls[0]?.payload).toMatchObject({
        text: en.t('bot.start.greeting', { name: 'Sam' }),
        reply_markup: {
          inline_keyboard: [
            [{ text: en.t('bot.start.open_app'), web_app: { url: TEST_MINIAPP_URL } }],
          ],
        },
      });
    },
  );

  it('never sets parse_mode, so user-controlled names are sent as plain text', async () => {
    await h.bot.handleUpdate(
      command('/start', { id: 9, first_name: '<b>*bold*</b>', language_code: 'en' }),
    );
    expect(h.calls[0]?.payload).not.toHaveProperty('parse_mode');
    expect(h.calls[0]?.payload['text']).toContain('<b>*bold*</b>');
  });

  it('replies to /help in the client language', async () => {
    await h.bot.handleUpdate(command('/help', { id: 42, first_name: 'Аня', language_code: 'ru' }));
    expect(h.calls[0]).toMatchObject({
      method: 'sendMessage',
      payload: { text: translatorFor('ru').t('bot.help') },
    });
  });

  it("uses a known user's stored locale, not the Telegram client language (Q13)", async () => {
    h = harness({ 42: 'en', 43: 'ru' });
    await h.bot.handleUpdate(command('/start', { id: 42, first_name: 'Аня', language_code: 'ru' }));
    await h.bot.handleUpdate(command('/start', { id: 43, first_name: 'Sam', language_code: 'en' }));
    expect(h.calls[0]?.payload['text']).toBe(
      translatorFor('en').t('bot.start.greeting', { name: 'Аня' }),
    );
    expect(h.calls[1]?.payload['text']).toBe(
      translatorFor('ru').t('bot.start.greeting', { name: 'Sam' }),
    );
  });

  it('ignores commands in group chats', async () => {
    await h.bot.handleUpdate(
      command('/start', { id: 42, first_name: 'Аня', language_code: 'ru' }, 'group'),
    );
    await h.bot.handleUpdate(
      command('/help', { id: 42, first_name: 'Аня', language_code: 'ru' }, 'group'),
    );
    expect(h.calls).toEqual([]);
  });
});

describe('bot reachability (unreachable users are not matched)', () => {
  it('marks a user reachable when they write to the bot', async () => {
    const h = harness();
    await h.bot.handleUpdate(command('/start', { id: 42, first_name: 'Аня', language_code: 'ru' }));
    expect(h.reachable).toEqual([[42, true]]);
  });

  it('marks a user unreachable when they block the bot, and reachable when they unblock it', async () => {
    const h = harness();
    await h.bot.handleUpdate(blockUpdate(42, 'kicked'));
    await h.bot.handleUpdate(blockUpdate(42, 'member'));
    expect(h.reachable).toEqual([
      [42, false],
      [42, true],
    ]);
    expect(h.calls).toEqual([]);
  });

  it('does nothing for group chats', async () => {
    const h = harness();
    await h.bot.handleUpdate(
      command('/start', { id: 42, first_name: 'Аня', language_code: 'ru' }, 'group'),
    );
    expect(h.reachable).toEqual([]);
  });
});
