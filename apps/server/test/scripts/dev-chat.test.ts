/**
 * `pnpm dev:say` and `pnpm dev:reveal` on a real database: the synthetic counterpart of a
 * development chat writes and consents through the real relay and reveal services, so the real
 * user gets everything exactly as from a real person. Nothing is ever sent to the synthetic
 * user, nothing is done for a real one, and the scripts refuse to run in production.
 */
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consentAsCounterpart,
  describeDevChat,
  devChats,
  sayAsCounterpart,
  selectDevChats,
  transcript,
  type DevChat,
} from '../../scripts/lib/dev-chat';
import { insertAdult, insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { insertGame } from '../support/games';
import { insertMatch, matchRow } from '../support/matches';
import { callbackUpdate, lastIncomingId, textUpdate } from '../support/telegram';

let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

/**
 * A real user chatting with a synthetic one, who appears to them as `alias`. Returns the chat as
 * the tooling finds it.
 */
async function devChat(alias = 'a.fox', real = insertAdult(testDb.appPool)) {
  const me = await real;
  const synthetic = await insertAdult(testDb.appPool, { synthetic: true });
  const chat = await insertChat(testDb.appPool, {
    between: [me, synthetic],
    seenAs: ['a.owl', alias],
  });
  const found = (await devChats(testDb.appPool)).find((c) => c.matchId === chat.matchId);
  if (!found) throw new Error('the tooling does not see the chat');
  return { me, synthetic, matchId: chat.matchId, chat: found, user: telegramUser(me) };
}

describe('finding a development chat', () => {
  it('lists the open chats with exactly one synthetic side, and nothing else', async () => {
    const { me, synthetic, matchId, chat } = await devChat();
    expect(chat).toMatchObject({
      matchId,
      status: 'results_ready',
      real: { id: me.id, locale: 'ru' },
      synthetic: { id: synthetic.id, alias: 'a.fox' },
    });
    expect(chat.real.publicId).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);

    // Two real people, two synthetic users, a game still being played, a chat that has ended.
    await insertChat(testDb.appPool);
    await insertChat(testDb.appPool, {
      first: { synthetic: true },
      second: { synthetic: true },
    });
    const playing = await insertMatch(testDb.appPool, {
      a: me.id,
      b: (await insertAdult(testDb.appPool, { synthetic: true })).id,
    });
    await insertGame(testDb.appPool, playing.id);
    const ended = await devChat('a.wolf', Promise.resolve(me));
    await testDb.appPool.query(
      "UPDATE matches SET status = 'closed', close_reason = 'left', closed_at = now() WHERE id = $1",
      [ended.matchId],
    );
    expect((await devChats(testDb.appPool)).map((c) => c.matchId)).toEqual([matchId]);
  });

  it('finds a chat by its ID or by the alias the user sees, in any spelling', async () => {
    const app = await buildChatApp(testDb);
    const fox = await devChat('a.fox');
    const bear = await devChat('a.bear', Promise.resolve(fox.me));
    const chats = await devChats(testDb.appPool);
    const pick = (selector: string) =>
      selectDevChats(chats, app.content, selector).map((c) => c.matchId);
    for (const selector of ['a.fox', 'fox', 'FOX', 'Лиса', 'лиса', '🦊', '🦊 Лиса', ' Fox ']) {
      expect(pick(selector)).toEqual([fox.matchId]);
    }
    expect(pick('Медведь')).toEqual([bear.matchId]);
    expect(pick(bear.matchId)).toEqual([bear.matchId]);
    expect(pick(bear.matchId.toUpperCase())).toEqual([bear.matchId]);
    // The user's own alias, an unknown name, an unknown ID: nothing.
    expect(pick('owl')).toEqual([]);
    expect(pick('nobody')).toEqual([]);
    expect(pick('00000000-0000-7000-8000-000000000000')).toEqual([]);
    expect(describeDevChat(fox.chat, app.content)).toBe(
      `${fox.matchId}  🦊 Лиса  (results_ready, user ${fox.chat.real.publicId})`,
    );

    // The same alias in two chats (two users) is ambiguous: both are returned.
    const other = await devChat('a.fox');
    expect(
      selectDevChats(await devChats(testDb.appPool), app.content, 'fox')
        .map((c) => c.matchId)
        .sort(),
    ).toEqual([fox.matchId, other.matchId].sort());
  });
});

describe('the synthetic counterpart writes', () => {
  it('through the real relay: the user gets it exactly as from a real person, and can answer', async () => {
    const app = await buildChatApp(testDb);
    const { me, synthetic, matchId, chat, user } = await devChat();

    const result = await sayAsCounterpart(app, chat, 'привет от синтетики');
    expect(result).toMatchObject({ status: 'delivered', first: true });
    expect(app.telegram.calls).toHaveLength(1);
    expect(app.telegram.calls[0]).toEqual({
      method: 'sendMessage',
      payload: {
        chat_id: me.telegramId,
        text: '🦊 Лиса\nпривет от синтетики',
        reply_markup: {
          inline_keyboard: [
            [{ text: 'Ответить', callback_data: `c:to:${matchId}` }],
            [
              { text: 'Пожаловаться', callback_data: `c:report:${matchId}` },
              { text: 'Заблокировать', callback_data: `c:block:${matchId}` },
            ],
          ],
        },
        link_preview_options: { is_disabled: true },
      },
    });
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('active');

    // The answer is stored and counted as delivered, and never sent to the synthetic user.
    app.telegram.clear();
    const relayed = Number(
      (await messageRows(testDb.ownerPool, matchId))[0]?.recipient_tg_message_id,
    );
    await app.handle(textUpdate(user, 'и тебе привет', { replyTo: relayed }));
    expect(app.telegram.calls).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({ sender_id: synthetic.id, delivered: true }),
      expect.objectContaining({
        sender_id: me.id,
        body: 'и тебе привет',
        delivered: true,
        recipient_tg_message_id: null,
        sender_tg_message_id: String(lastIncomingId()),
      }),
    ]);

    expect(await transcript(testDb.appPool, chat)).toEqual([
      { from: 'counterpart', text: 'привет от синтетики', state: 'delivered' },
      { from: 'user', text: 'и тебе привет', state: 'delivered' },
    ]);
    expect(await transcript(testDb.appPool, chat, 1)).toEqual([
      { from: 'user', text: 'и тебе привет', state: 'delivered' },
    ]);
  });

  it('under the same rules as anyone: a chat that has ended gets nothing', async () => {
    const app = await buildChatApp(testDb);
    const { me, matchId, chat } = await devChat();
    await app.chat.leave(me.id, matchId, app.clock.now());
    expect(await sayAsCounterpart(app, chat, 'поздно')).toEqual({
      status: 'refused',
      reason: 'chat_ended',
    });
    expect(app.telegram.calls).toEqual([]);
    expect(await transcript(testDb.appPool, chat)).toEqual([]);
  });

  it('and reports a user the bot cannot reach', async () => {
    const app = await buildChatApp(testDb);
    const { chat } = await devChat('a.fox', insertAdult(testDb.appPool, { botReachable: false }));
    expect(await sayAsCounterpart(app, chat, 'ау')).toEqual({
      status: 'refused',
      reason: 'not_delivered',
    });
    expect(await transcript(testDb.appPool, chat)).toEqual([
      { from: 'counterpart', text: 'ау', state: 'unreachable' },
    ]);
  });
});

describe('the synthetic counterpart consents to a reveal', () => {
  const USERNAME = 'real_dev_user';
  const setup = async () => {
    const app = await buildChatApp(testDb, { syntheticUsername: 'synthetic_user' });
    const world = await devChat();
    app.telegram.usernames.set(world.me.telegramId, USERNAME);
    return { app, ...world };
  };
  const texts = (app: Awaited<ReturnType<typeof buildChatApp>>, chatId: number) =>
    app.telegram.sentTo(chatId).map((m) => m.text);

  it('first: the user is asked by the bot, agrees, and gets the username', async () => {
    const { app, me, matchId, chat, user } = await setup();
    expect(await consentAsCounterpart(app, chat)).toEqual({ status: 'waiting', alias: 'a.owl' });
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(app.telegram.sentTo(me.telegramId)[0]?.payload).toMatchObject({
      text: '🦊 Лиса предлагает обменяться никами в Telegram. Ники откроются, только если согласятся обе стороны.',
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Согласиться', callback_data: `c:reveal_yes:${matchId}` },
            { text: 'Не сейчас', callback_data: `c:reveal_no:${matchId}` },
          ],
        ],
      },
    });

    await app.handle(callbackUpdate(user, `c:reveal_yes:${matchId}`, { messageId: 7000 }));
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, me.telegramId).at(-1)).toBe('🦊 Лиса в Telegram: @synthetic_user');
    // Every message went to the real user, and their own username went nowhere.
    expect(
      app.telegram.of('sendMessage').every((c) => c.payload['chat_id'] === me.telegramId),
    ).toBe(true);
    expect(JSON.stringify(app.telegram.of('sendMessage'))).not.toContain(USERNAME);
  });

  it('second: the user asked first, and the consent of the counterpart completes the reveal', async () => {
    const { app, me, matchId, chat, user } = await setup();
    await app.handle(callbackUpdate(user, `c:reveal_yes:${matchId}`, { messageId: 7000 }));
    await app.sender.tick();
    expect(texts(app, me.telegramId)).toEqual([]);

    expect(await consentAsCounterpart(app, chat)).toEqual({
      status: 'revealed',
      alias: 'a.owl',
      already: false,
    });
    expect(await app.sender.tick()).toMatchObject({ sent: 1 });
    expect(texts(app, me.telegramId)).toEqual(['🦊 Лиса в Telegram: @synthetic_user']);
    expect(await consentAsCounterpart(app, chat)).toMatchObject({
      status: 'revealed',
      already: true,
    });
  });

  it('is refused for a u18 chat, like for anyone, while a message goes through the contact filter there', async () => {
    const app = await buildChatApp(testDb, { syntheticUsername: 'synthetic_user' });
    const u18 = await insertChat(testDb.appPool, { years: 16, second: { synthetic: true } });
    const chat = (await devChats(testDb.appPool)).find((c) => c.matchId === u18.matchId);
    expect(chat).toBeDefined();
    expect(await consentAsCounterpart(app, chat as DevChat)).toEqual({ status: 'unavailable' });
    expect(await sayAsCounterpart(app, chat as DevChat, 'мой тг @synthetic_user')).toEqual({
      status: 'refused',
      reason: 'contact_blocked',
    });
    expect(app.telegram.calls).toEqual([]);
    expect(await sayAsCounterpart(app, chat as DevChat, 'привет')).toMatchObject({
      status: 'delivered',
    });
    expect(app.telegram.sentTo(u18.telegramA).map((m) => m.text)).toEqual(['🦉 Сова\nпривет']);
  });
});

describe('the scripts', () => {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const script = (name: string) =>
    fileURLToPath(new URL(`../../scripts/${name}.ts`, import.meta.url));
  const runScript = (name: string, args: string[], env: Record<string, string>) =>
    promisify(execFile)(process.execPath, [tsxCli, script(name), ...args], {
      env: { PATH: process.env['PATH'] ?? '', ...env },
      timeout: 30_000,
    }).then(
      (ok) => ({ code: 0, ...ok }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? -1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );
  const appUrl = () => {
    const url = new URL(testDb.ownerUrl);
    url.searchParams.set('options', '-c role=samesync_app');
    return url.toString();
  };

  it.each([
    ['dev-say', ['fox', 'привет']],
    ['dev-reveal', ['fox']],
  ])('%s refuses to run with NODE_ENV=production', async (name, args) => {
    const { matchId } = await devChat();
    const result = await runScript(name, args, {
      NODE_ENV: 'production',
      // Would work if the script went on: it must stop before using any of it.
      DATABASE_URL: appUrl(),
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${name.replace('-', ':')} refuses to run with NODE_ENV=production`,
    );
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
    const consents = await testDb.ownerPool.query('SELECT 1 FROM reveal_consents');
    expect(consents.rowCount).toBe(0);
  });

  it('dev-say lists the chats, shows one, and asks for a known chat before it needs a bot token', async () => {
    const { matchId, chat, synthetic } = await devChat();
    await testDb.appPool.query(
      `INSERT INTO messages (id, match_id, sender_id, body, verdict, purge_after)
       VALUES (gen_random_uuid(), $1, $2, 'раньше сказанное', 'delivered', now() + interval '30 days')`,
      [matchId, synthetic.id],
    );
    const env = { DATABASE_URL: appUrl() };

    const list = await runScript('dev-say', [], env);
    expect(list.stderr).toBe('');
    expect(list.code).toBe(0);
    expect(list.stdout).toContain('Open chats with a synthetic counterpart:');
    expect(list.stdout).toContain(
      `${matchId}  🦊 Лиса  (results_ready, user ${chat.real.publicId})`,
    );

    const shown = await runScript('dev-say', ['лиса'], env);
    expect(shown.stderr).toBe('');
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain('counterpart [on its way] раньше сказанное');

    const unknown = await runScript('dev-say', ['wolf', 'привет'], env);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('No open chat matches "wolf".');
    expect(unknown.stderr).toContain(matchId);

    // Saying something needs the bot's token: without one nothing is sent and nothing is stored.
    const noToken = await runScript('dev-say', ['fox', 'привет'], env);
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain('BOT_TOKEN');
    expect(await messageRows(testDb.ownerPool, matchId)).toHaveLength(1);
  });

  it('dev-reveal needs a chat and the configuration, and does nothing without them', async () => {
    await devChat();
    const noChat = await runScript('dev-reveal', [], { DATABASE_URL: appUrl() });
    expect(noChat.code).toBe(1);
    expect(noChat.stderr).toContain('Usage: pnpm dev:reveal <match id or alias>');
    const noToken = await runScript('dev-reveal', ['fox'], { DATABASE_URL: appUrl() });
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain('BOT_TOKEN');
    const consents = await testDb.ownerPool.query('SELECT 1 FROM reveal_consents');
    expect(consents.rowCount).toBe(0);
  });
});
