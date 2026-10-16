/**
 * SAFETY SUITE — the u18 contact filter fails closed (CLAUDE.md invariants 5 and 10; PLAN.md
 * Phase 5). When the filter throws, the message is not delivered, not stored, and the sender is
 * told; a filter that finds something stops the message and keeps it as evidence; nothing passes
 * in the u18 band without a filter at all. The adult band never asks the filter.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertChat, messageRows, telegramUser } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { textUpdate } from '../support/telegram';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

async function pair(years: number, options: Parameters<typeof buildChatApp>[1] = {}) {
  const app = await buildChatApp(testDb, options);
  const chat = await insertChat(testDb.appPool, { years });
  return {
    ...chat,
    app,
    fox: telegramUser({ id: chat.a, telegramId: chat.telegramA }),
    owl: telegramUser({ id: chat.b, telegramId: chat.telegramB }),
  };
}
const texts = (app: ChatApp, chatId: number) => app.telegram.sentTo(chatId).map((m) => m.text);
const NOT_DELIVERED = 'Не получилось доставить сообщение. Попробуй ещё раз чуть позже.';
const STOPPED =
  'Сообщение не доставлено: в этом чате нельзя делиться контактами, ссылками и никами.';

describe('a filter that throws', () => {
  it('means no delivery, nothing stored, and a notice to the sender, from the bot and the Mini App', async () => {
    const { app, matchId, fox, owl } = await pair(16, {
      contactFilter: () => Promise.reject(new Error('filter down')),
    });
    await app.handle(textUpdate(fox, 'просто привет'));
    expect(texts(app, owl.id)).toEqual([]);
    expect(texts(app, fox.id)).toEqual([NOT_DELIVERED]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
    expect(app.telegram.calls.map((c) => c.method)).toEqual(['sendMessage']);

    const response = await app
      .as({ id: fox.id, first_name: 'Dev' })
      .post(`/api/matches/${matchId}/messages`, { text: 'из приложения' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
    expect(texts(app, owl.id)).toEqual([]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
    // The filter's failure is logged, the text is not.
    const logs = app.logLines().join('\n');
    expect(logs).not.toContain('просто привет');
    expect(logs).not.toContain('из приложения');
  });

  it('stops only the messages it fails on: the next one goes through once it works again', async () => {
    let calls = 0;
    const { app, matchId, fox, owl } = await pair(16, {
      contactFilter: () => {
        calls++;
        return calls === 2 ? Promise.reject(new Error('hiccup')) : Promise.resolve({ hit: false });
      },
    });
    await app.handle(textUpdate(fox, 'раз'));
    await app.handle(textUpdate(fox, 'два'));
    await app.handle(textUpdate(fox, 'три'));
    expect(texts(app, owl.id)).toEqual(['🦊 Лиса\nраз', '🦊 Лиса\nтри']);
    expect(texts(app, fox.id)).toEqual([NOT_DELIVERED]);
    expect((await messageRows(testDb.ownerPool, matchId)).map((r) => r.body)).toEqual([
      'раз',
      'три',
    ]);
  });

  it('is never asked in the adult band, where nothing changes', async () => {
    const { app, fox, owl } = await pair(25, {
      contactFilter: () => Promise.reject(new Error('filter down')),
    });
    await app.handle(textUpdate(fox, 'мой тг @fox_08'));
    expect(texts(app, owl.id)).toEqual(['🦊 Лиса\nмой тг @fox_08']);
  });
});

describe('a filter that finds something', () => {
  it('stops the message, keeps it as evidence with the kind it found, and tells the sender', async () => {
    const { app, matchId, fox, owl } = await pair(16, {
      contactFilter: ({ text }) =>
        Promise.resolve(text.includes('secret') ? { hit: true, kind: 'social' } : { hit: false }),
    });
    await app.handle(textUpdate(fox, 'secret handle here'));
    await app.handle(textUpdate(fox, 'и просто привет'));
    expect(texts(app, owl.id)).toEqual(['🦊 Лиса\nи просто привет']);
    expect(texts(app, fox.id)).toEqual([STOPPED]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([
      expect.objectContaining({
        verdict: 'blocked_by_filter',
        reason: 'social',
        body: 'secret handle here',
        delivered: false,
      }),
      expect.objectContaining({ verdict: 'delivered', body: 'и просто привет', delivered: true }),
    ]);
  });
});

describe('no filter at all', () => {
  it('relays nothing in the u18 band, and everything in the adult one', async () => {
    const minors = await pair(16, { contactFilter: null });
    await minors.app.handle(textUpdate(minors.fox, 'привет'));
    expect(texts(minors.app, minors.owl.id)).toEqual([]);
    expect(texts(minors.app, minors.fox.id)).toEqual([NOT_DELIVERED]);
    expect(await messageRows(testDb.ownerPool, minors.matchId)).toEqual([]);

    const adults = await pair(25, { contactFilter: null });
    await adults.app.handle(textUpdate(adults.fox, 'привет'));
    expect(texts(adults.app, adults.owl.id)).toEqual(['🦊 Лиса\nпривет']);
  });
});
