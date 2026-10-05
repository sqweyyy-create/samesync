/**
 * SAFETY SUITE — usernames in the u18 band (CLAUDE.md invariants 1 and 6; PLAN.md Phase 4).
 * A leak scanner: it drives everything two matched u18 users can do with the bot, the API and the
 * jobs, `/reveal` attempts and forged buttons included, records every outgoing Bot API call and
 * every API response, and then looks for either side's username, first name, last name and
 * Telegram ID in what the other side was sent. A username must not appear anywhere at all, must
 * not be stored, and Telegram must not even be asked for one.
 * The last test turns the scanner on an adult reveal, where it has to find the username: a
 * scanner that can't find a leak proves nothing.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encodeCallback, CHAT_ACTIONS } from '../../src/domain/chat/callbacks';
import { consentRows, insertChat, insertConsent, messageRows } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import { insertOutbox, matchRow, outboxRow, withoutTriggers } from '../support/matches';
import {
  callbackUpdate,
  editUpdate,
  lastIncomingId,
  mediaUpdate,
  textUpdate,
} from '../support/telegram';

// The outbox and the jobs see everything in a database: each test gets its own.
let testDb: TestDatabase;
beforeEach(async () => {
  testDb = await createTestDatabase();
});
afterEach(() => testDb.drop());

type Identity = Required<Pick<TestUser, 'id' | 'first_name' | 'last_name' | 'username'>> & TestUser;

/** Two Telegram accounts whose every identifier is unlike anything else the server handles. */
const ANNA: Identity = {
  id: 7_700_000_000_001,
  first_name: 'Аннабелла',
  last_name: 'Скрытнова',
  username: 'annabella_private',
  language_code: 'ru',
};
const BORIS: Identity = {
  id: 7_700_000_000_002,
  first_name: 'Бориславий',
  last_name: 'Потайнов',
  username: 'borislav_private',
  language_code: 'ru',
};

const identifiers = (who: Identity) => [
  who.first_name,
  who.last_name,
  who.username,
  String(who.id),
];
const found = (text: string, needles: string[]) => needles.filter((n) => text.includes(n));

interface Recorded {
  /** Who received it; null for a call that names no chat (the answer to a button press). */
  to: Identity | null;
  what: string;
  text: string;
}

/** Everything that left the server: Bot API calls and API responses, each with its recipient. */
function recorder(app: ChatApp, people: Identity[]) {
  const responses: Recorded[] = [];
  return {
    async api(who: Identity, method: 'get' | 'post' | 'put', path: string, body?: unknown) {
      const response = await app.as(who)[method](path, body);
      const text = await response.text();
      responses.push({
        to: who,
        what: `${method.toUpperCase()} ${path} → ${response.status}`,
        text,
      });
      return response.status;
    },
    all(): Recorded[] {
      const calls = app.telegram.calls.map((call) => ({
        to: people.find((p) => p.id === call.payload['chat_id']) ?? null,
        what: call.method,
        text: JSON.stringify(call.payload),
      }));
      return [...calls, ...responses];
    },
  };
}

/**
 * The leaks in what was recorded: anything of the other person's identity in something sent to
 * one of them, and a username of either of them anywhere.
 */
function leaks(records: Recorded[], people: [Identity, Identity]): string[] {
  const problems: string[] = [];
  for (const record of records) {
    for (const person of people) {
      // What was sent to me may hold my own name and ID (a greeting, my chat's ID); never theirs.
      const others = record.to?.id === person.id ? [] : identifiers(person);
      for (const hit of found(record.text, [...others, person.username])) {
        problems.push(`${record.what} to ${record.to?.first_name ?? 'nobody'}: ${hit}`);
      }
    }
  }
  return [...new Set(problems)];
}

const storedUsernames = async (ids: string[]) =>
  (
    await testDb.ownerPool.query<{ username: string | null }>(
      'SELECT username FROM users WHERE id = ANY($1::uuid[])',
      [ids],
    )
  ).rows.map((r) => r.username);

describe('a u18 conversation', () => {
  it.each([false, true])(
    'never shows, stores or asks for a username, a name or a Telegram ID (U18_POOL_ENABLED=%s)',
    async (u18PoolEnabled) => {
      const app = await buildChatApp(testDb, { u18PoolEnabled });
      // A legitimate u18 match: both 16, friends mode, the game finished, results ready.
      const chat = await insertChat(testDb.appPool, {
        years: 16,
        first: { telegramId: ANNA.id },
        second: { telegramId: BORIS.id },
      });
      const { matchId } = chat;
      const people: [Identity, Identity] = [ANNA, BORIS];
      // Telegram does know their usernames: nothing may ever ask.
      for (const person of people) app.telegram.usernames.set(person.id, person.username);
      const record = recorder(app, people);
      expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');

      for (const [me, them] of [people, [BORIS, ANNA]] as Array<[Identity, Identity]>) {
        // The commands, /reveal first of all.
        for (const command of ['/start', '/help', '/chats', '/leave', '/reveal', '/reveal now']) {
          await app.handle(textUpdate(me, command));
        }
        // Messages: plain, with their own contact in them, as a reply, edited, and not text.
        await app.handle(textUpdate(me, 'привет!'));
        const sent = lastIncomingId();
        await app.handle(textUpdate(me, `пиши мне: @${me.username}, я ${me.first_name}`));
        await app.handle(textUpdate(me, 'ответ', { replyTo: 5001 }));
        await app.handle(editUpdate(me, sent, 'привет ещё раз'));
        await app.handle(mediaUpdate(me, { photo: [{ file_id: 'p' }], caption: me.username }));
        await app.handle(
          mediaUpdate(me, {
            contact: { phone_number: '+70000000000', first_name: me.first_name, user_id: me.id },
          }),
        );
        // Every button there is, pressed for their own match: forged, since none was ever shown.
        for (const action of CHAT_ACTIONS) {
          await app.handle(
            callbackUpdate(me, encodeCallback(action, matchId), {
              messageId: 7000,
              original: { messageId: sent, text: 'привет!' },
            }),
          );
        }
        // The services behind the buttons, asked directly.
        const meId = me.id === ANNA.id ? chat.first.id : chat.second.id;
        expect(await app.reveal.state(meId, matchId)).toEqual({ status: 'unavailable' });
        expect(await app.reveal.consent(meId, matchId)).toEqual({ status: 'unavailable' });

        // The API, with initData that carries the caller's own name and username.
        expect(await record.api(me, 'get', '/api/me')).toBe(200);
        expect(await record.api(me, 'get', '/api/matches')).toBe(200);
        expect(await record.api(me, 'get', `/api/matches/${matchId}`)).toBe(200);
        expect(await record.api(me, 'get', `/api/matches/${matchId}/results`)).toBe(200);
        expect(await record.api(me, 'get', `/api/matches/${matchId}/game`)).toBe(409);
        expect(
          await record.api(me, 'post', `/api/matches/${matchId}/messages`, { text: 'привет' }),
        ).toBe(403);
        // There is no reveal in the API at all.
        expect(await record.api(me, 'post', `/api/matches/${matchId}/reveal`, {})).toBe(404);
        expect(await record.api(me, 'get', `/api/matches/${matchId}/reveal`)).toBe(404);
        expect(await record.api(me, 'get', `/api/users/${them.id}`)).toBe(404);
      }

      // The database refuses a consent for each of them, whoever asks.
      for (const userId of [chat.first.id, chat.second.id]) {
        await expect(insertConsent(testDb.appPool, matchId, userId)).rejects.toMatchObject({
          code: 'SS040',
        });
      }
      // Even if a reveal were queued by mistake, with consent rows forced past the triggers,
      // the sender drops it without asking Telegram for anything.
      await withoutTriggers(testDb.ownerPool, (client) =>
        client.query(
          `INSERT INTO reveal_consents (match_id, user_id, consented_at, revealed_at)
           SELECT $1, u, now(), now() FROM unnest($2::uuid[]) AS u`,
          [matchId, [chat.first.id, chat.second.id]],
        ),
      );
      const forged = [];
      for (const userId of [chat.first.id, chat.second.id]) {
        for (const kind of ['reveal_request', 'reveal_done'] as const) {
          forged.push(await insertOutbox(testDb.appPool, { userId, matchId, kind }));
        }
      }
      // The rows were queued by the database's clock: move the app's clock past it.
      const clock = app.clock as { set(next: Date): void };
      clock.set(new Date(Date.now() + 1000));
      expect(await app.sender.tick()).toMatchObject({ sent: 0, cancelled: 4 });
      for (const row of forged) {
        expect(await outboxRow(testDb.ownerPool, row.id)).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'reveal_not_allowed',
        });
      }

      // The jobs: no reminder, then the chat nobody could write in expires, and both are told.
      const deadline = (
        await testDb.ownerPool.query<{ at: Date }>(
          'SELECT chat_deadline_at AS at FROM matches WHERE id = $1',
          [matchId],
        )
      ).rows[0]!.at.getTime();
      clock.set(new Date(deadline - 3_600_000));
      await app.deadlines.run();
      await app.sender.tick();
      clock.set(new Date(deadline + 1));
      expect(await app.deadlines.run()).toMatchObject({ expired: 1 });
      expect(await app.sender.tick()).toMatchObject({ sent: 2 });

      // Nothing was relayed, nothing was consented to by them, nothing was stored.
      expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
      expect(await storedUsernames([chat.first.id, chat.second.id])).toEqual([null, null]);
      // Telegram was never asked who they are.
      expect(app.telegram.of('getChat')).toEqual([]);
      // Only these Bot API methods were used at all: nothing forwards or copies a message.
      expect([...new Set(app.telegram.calls.map((c) => c.method))].sort()).toEqual([
        'answerCallbackQuery',
        'editMessageText',
        'sendMessage',
      ]);

      // And the scan itself.
      const records = record.all();
      expect(records.length).toBeGreaterThan(60);
      expect(leaks(records, people)).toEqual([]);
      // Each of them did hear from the bot, by alias only.
      for (const person of people) {
        const mine = records.filter((r) => r.to?.id === person.id).map((r) => r.text);
        expect(mine.join('\n')).toContain('Обмен никами недоступен.');
        expect(mine.join('\n')).toContain('Чат пока недоступен.');
        expect(mine.join('\n')).toMatch(/Сова|Лиса/);
      }
    },
  );

  it('leaves nothing of a u18 user in the logs either', async () => {
    const app = await buildChatApp(testDb);
    await insertChat(testDb.appPool, {
      years: 16,
      first: { telegramId: ANNA.id },
      second: { telegramId: BORIS.id },
    });
    for (const me of [ANNA, BORIS]) {
      await app.handle(textUpdate(me, '/reveal'));
      await app.handle(textUpdate(me, `мой ник @${me.username}`));
      await app.as(me).get('/api/me');
    }
    const logs = app.logLines().join('\n');
    expect(logs.length).toBeGreaterThan(0);
    for (const person of [ANNA, BORIS]) {
      expect(found(logs, identifiers(person))).toEqual([]);
    }
  });
});

describe('the scanner', () => {
  it('finds the username where one is revealed on purpose: between two adults who both agreed', async () => {
    const app = await buildChatApp(testDb);
    const chat = await insertChat(testDb.appPool, {
      first: { telegramId: ANNA.id },
      second: { telegramId: BORIS.id },
    });
    const people: [Identity, Identity] = [ANNA, BORIS];
    for (const person of people) app.telegram.usernames.set(person.id, person.username);
    const record = recorder(app, people);

    await app.handle(textUpdate(ANNA, 'привет'));
    await app.handle(textUpdate(BORIS, 'привет!'));
    // A whole adult conversation carries nothing of either identity…
    expect(leaks(record.all(), people)).toEqual([]);

    for (const me of people) {
      await app.handle(
        callbackUpdate(me, encodeCallback('reveal_yes', chat.matchId), { messageId: 7000 }),
      );
    }
    expect(leaks(record.all(), people)).toEqual([]);
    await app.sender.tick();
    // …until the one message that is meant to: each gets the other's username, and only that.
    expect(leaks(record.all(), people).sort()).toEqual(
      [
        `sendMessage to ${ANNA.first_name}: ${BORIS.username}`,
        `sendMessage to ${BORIS.first_name}: ${ANNA.username}`,
      ].sort(),
    );
    expect(await consentRows(testDb.ownerPool, chat.matchId)).toHaveLength(2);
  });
});
