/**
 * SAFETY SUITE — what a u18 chat carries (CLAUDE.md invariants 5, 6 and 10; PLAN.md Phase 5).
 * Under-18 chat is plain text only, and every message passes the contact filter before it is
 * relayed. Photos, voice, video, stickers, files, contacts, locations and text with entities are
 * rejected without delivery; a text with a contact in it is kept as evidence and never sent;
 * plain text goes through; without a filter, or with one that fails, nothing goes through at
 * all; and no consent to reveal can exist for a u18 user. None of it looks at U18_POOL_ENABLED.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { screen } from '../../src/domain/chat/relay';
import {
  consentRows,
  insertChat,
  insertConsent,
  insertMessage,
  messageRows,
  telegramUser,
} from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { matchRow } from '../support/matches';
import { mediaUpdate, textUpdate } from '../support/telegram';

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(() => testDb.drop());

/** Everything a Telegram user can send that is not plain text. */
const NOT_TEXT: Array<[string, Record<string, unknown>]> = [
  ['a photo', { photo: [{ file_id: 'p', file_unique_id: 'pu', width: 90, height: 90 }] }],
  ['a photo with a caption', { photo: [{ file_id: 'p' }], caption: 'просто подпись' }],
  ['a voice message', { voice: { file_id: 'v', file_unique_id: 'vu', duration: 2 } }],
  [
    'a video',
    { video: { file_id: 'vd', file_unique_id: 'vdu', width: 1, height: 1, duration: 1 } },
  ],
  [
    'a video note',
    { video_note: { file_id: 'vn', file_unique_id: 'vnu', length: 1, duration: 1 } },
  ],
  ['a sticker', { sticker: { file_id: 's', file_unique_id: 'su', type: 'regular' } }],
  ['a document', { document: { file_id: 'd', file_unique_id: 'du', file_name: 'a.pdf' } }],
  ['an audio file', { audio: { file_id: 'a', file_unique_id: 'au', duration: 1 } }],
  ['an animation', { animation: { file_id: 'g', file_unique_id: 'gu', duration: 1 } }],
  ['a contact', { contact: { phone_number: '+70000000000', first_name: 'Контакт' } }],
  ['a location', { location: { latitude: 55.75, longitude: 37.62 } }],
  [
    'a venue',
    { venue: { location: { latitude: 1, longitude: 1 }, title: 'Место', address: 'ул.' } },
  ],
  ['a poll', { poll: { id: '1', question: 'Да?', options: [], total_voter_count: 0 } }],
  ['a dice', { dice: { emoji: '🎲', value: 3 } }],
];

/** Text that Telegram marked up: a link, a mention, a phone number, formatting. */
const WITH_ENTITIES: Array<[string, string, { type: string; offset: number; length: number }]> = [
  ['a link', 'смотри example.com', { type: 'url', offset: 7, length: 11 }],
  ['a mention', 'пиши @someone_else', { type: 'mention', offset: 5, length: 13 }],
  ['a phone number', 'звони +70000000000', { type: 'phone_number', offset: 6, length: 12 }],
  ['an email', 'почта a@example.com', { type: 'email', offset: 6, length: 13 }],
  ['bold text', 'очень важно', { type: 'bold', offset: 0, length: 5 }],
  ['a hidden link', 'нажми сюда', { type: 'text_link', offset: 6, length: 4 }],
  ['a spoiler', 'секрет', { type: 'spoiler', offset: 0, length: 6 }],
  ['a custom emoji', 'привет 🙂', { type: 'custom_emoji', offset: 7, length: 2 }],
];

/** Two matched users of one band, and the bot around them. `fox` writes, `owl` must get nothing. */
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

describe.each([false, true])('a u18 match (U18_POOL_ENABLED=%s)', (u18PoolEnabled) => {
  const u18 = () => pair(16, { u18PoolEnabled });
  /** What became of a message `fox` sent. */
  const outcome = async ({ app, matchId, fox, owl }: Awaited<ReturnType<typeof u18>>) => ({
    toTheOther: texts(app, owl.id),
    stored: await messageRows(testDb.ownerPool, matchId),
    toTheSender: texts(app, fox.id),
    calls: app.telegram.calls.map((c) => c.method),
    match: (await matchRow(testDb.ownerPool, matchId))?.status,
  });
  /** Nothing reached the other person, nothing was stored, and the sender was told. */
  const nothing = (notice: string) => ({
    toTheOther: [],
    stored: [],
    toTheSender: [notice],
    calls: ['sendMessage'],
    match: 'results_ready',
  });

  it.each(NOT_TEXT)('rejects %s without delivery', async (_name, content) => {
    const world = await u18();
    await world.app.handle(mediaUpdate(world.fox, content));
    expect(await outcome(world)).toEqual(
      nothing('Пока можно отправлять только текст. Это сообщение не доставлено.'),
    );
  });

  it.each(WITH_ENTITIES)('rejects text with %s without delivery', async (_name, text, entity) => {
    const world = await u18();
    await world.app.handle(textUpdate(world.fox, text, { entities: [entity] }));
    expect(await outcome(world)).toEqual(
      nothing('Пока можно отправлять только текст. Это сообщение не доставлено.'),
    );
  });

  it('relays plain text that passes the contact filter, in both directions and from the Mini App', async () => {
    const world = await u18();
    await world.app.handle(textUpdate(world.fox, 'просто привет'));
    expect(texts(world.app, world.owl.id)).toEqual(['🦊 Лиса\nпросто привет']);
    expect(texts(world.app, world.fox.id)).toEqual([]);
    world.app.telegram.clear();
    await world.app.handle(textUpdate(world.owl, 'и тебе'));
    expect(texts(world.app, world.fox.id)).toEqual(['🦉 Сова\nи тебе']);
    expect((await matchRow(testDb.ownerPool, world.matchId))?.status).toBe('active');
    // The match says so itself: the Mini App offers the first message.
    const summary = await world.app
      .as({ id: world.fox.id, first_name: 'Dev' })
      .get(`/api/matches/${world.matchId}`);
    expect(await summary.json()).toMatchObject({ status: 'active', chat: true });
    // A message from the Mini App goes through the same filter.
    const fresh = await u18();
    const response = await fresh.app
      .as({ id: fresh.fox.id, first_name: 'Dev' })
      .post(`/api/matches/${fresh.matchId}/messages`, { text: 'из приложения' });
    expect(response.status).toBe(200);
    expect(texts(fresh.app, fresh.owl.id)).toEqual(['🦊 Лиса\nиз приложения']);
  });

  it('keeps a message with a contact in it as evidence and never sends it, from the bot and from the Mini App', async () => {
    const world = await u18();
    await world.app.handle(textUpdate(world.fox, 'мой тг @fox_08, пиши'));
    expect(await outcome(world)).toEqual({
      toTheOther: [],
      stored: [
        expect.objectContaining({
          verdict: 'blocked_by_filter',
          reason: 'handle',
          body: 'мой тг @fox_08, пиши',
          delivered: false,
        }),
      ],
      toTheSender: [
        'Сообщение не доставлено: в этом чате нельзя делиться контактами, ссылками и никами.',
      ],
      calls: ['sendMessage'],
      match: 'results_ready',
    });
    const response = await world.app
      .as({ id: world.fox.id, first_name: 'Dev' })
      .post(`/api/matches/${world.matchId}/messages`, { text: 'номер 8 926 123 45 67' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'forbidden', details: ['contact_blocked'] });
    expect(texts(world.app, world.owl.id)).toEqual([]);
    expect((await messageRows(testDb.ownerPool, world.matchId)).map((r) => r.verdict)).toEqual([
      'blocked_by_filter',
      'blocked_by_filter',
    ]);
    // The hits are counted: each one is a filter event.
    const { rows } = await testDb.ownerPool.query<{ kind: string }>(
      'SELECT kind::text AS kind FROM filter_events WHERE match_id = $1 ORDER BY created_at',
      [world.matchId],
    );
    expect(rows.map((r) => r.kind)).toEqual(['handle', 'phone']);
  });

  it('catches a contact split across messages: the filter reads the recent ones together', async () => {
    const world = await u18();
    await world.app.handle(textUpdate(world.fox, 'запиши мой номер'));
    await world.app.handle(textUpdate(world.fox, '8 926'));
    await world.app.handle(textUpdate(world.fox, '123 45 67'));
    expect(texts(world.app, world.owl.id)).toEqual(['🦊 Лиса\nзапиши мой номер', '🦊 Лиса\n8 926']);
    expect(texts(world.app, world.fox.id)).toEqual([
      'Сообщение не доставлено: в этом чате нельзя делиться контактами, ссылками и никами.',
    ]);
    expect((await messageRows(testDb.ownerPool, world.matchId)).map((r) => r.verdict)).toEqual([
      'delivered',
      'delivered',
      'blocked_by_filter',
    ]);
  });

  it('relays nothing without a contact filter, and nothing when the filter fails (fail closed)', async () => {
    const without = await pair(16, { u18PoolEnabled, contactFilter: null });
    await without.app.handle(textUpdate(without.fox, 'просто привет'));
    expect(await outcome(without)).toEqual(
      nothing('Не получилось доставить сообщение. Попробуй ещё раз чуть позже.'),
    );
    const broken = await pair(16, {
      u18PoolEnabled,
      contactFilter: () => Promise.reject(new Error('filter down')),
    });
    await broken.app.handle(textUpdate(broken.fox, 'просто привет'));
    expect(await outcome(broken)).toEqual(
      nothing('Не получилось доставить сообщение. Попробуй ещё раз чуть позже.'),
    );
    // In the adult band the filter is not asked, so a filter that is down changes nothing there.
    const adult = await pair(25, { contactFilter: () => Promise.reject(new Error('filter down')) });
    await adult.app.handle(textUpdate(adult.fox, 'просто привет'));
    expect(texts(adult.app, adult.owl.id)).toEqual(['🦊 Лиса\nпросто привет']);
  });

  it('is open in the database too: a message, and one the filter stopped, can be stored', async () => {
    const { matchId, a, b } = await u18();
    await insertMessage(testDb.appPool, { matchId, senderId: a, body: 'мимо приложения' });
    await insertMessage(testDb.appPool, {
      matchId,
      senderId: b,
      verdict: 'blocked_by_filter',
      reason: 'url',
    });
    expect((await messageRows(testDb.ownerPool, matchId)).map((r) => r.verdict)).toEqual([
      'delivered',
      'blocked_by_filter',
    ]);
  });

  it('has no consent to reveal usernames: the database refuses the row', async () => {
    const { matchId, a, b } = await u18();
    for (const userId of [a, b]) {
      await expect(insertConsent(testDb.appPool, matchId, userId)).rejects.toMatchObject({
        code: 'SS040',
        message: 'reveal rejected: not_adult',
      });
    }
    expect(await consentRows(testDb.ownerPool, matchId)).toEqual([]);
  });
});

describe('the screening hook', () => {
  const clean = () => Promise.resolve({ hit: false as const });
  const u18 = (text: string | null, hasEntities = false) =>
    screen(
      { band: 'u18', content: { text, hasEntities }, matchId: 'm', senderId: 's' },
      { contactFilter: clean },
    );

  it('still lets nothing but plain text through in the u18 band', async () => {
    expect(await u18('просто привет')).toEqual({ pass: true });
    expect(await u18(null)).toEqual({ pass: false, verdict: 'rejected', reason: 'not_text' });
    expect(await u18('со ссылкой', true)).toEqual({
      pass: false,
      verdict: 'rejected',
      reason: 'entities',
    });
  });

  it('does not deliver when the filter fails or finds something', async () => {
    const input = {
      band: 'u18' as const,
      content: { text: 'привет', hasEntities: false },
      matchId: 'm',
      senderId: 's',
    };
    expect(await screen(input, { contactFilter: () => Promise.reject(new Error('down')) })).toEqual(
      { pass: false, verdict: 'rejected', reason: 'filter_error' },
    );
    expect(
      await screen(input, { contactFilter: () => Promise.resolve({ hit: true, kind: 'phone' }) }),
    ).toEqual({ pass: false, verdict: 'blocked_by_filter', reason: 'phone' });
    expect(await screen(input)).toEqual({
      pass: false,
      verdict: 'rejected',
      reason: 'no_contact_filter',
    });
  });
});

describe('the adult pool', () => {
  it.each(NOT_TEXT)('rejects %s without delivery as well (Q19)', async (_name, content) => {
    const { app, matchId, fox, owl } = await pair(25);
    await app.handle(mediaUpdate(fox, content));
    expect(texts(app, owl.id)).toEqual([]);
    expect(texts(app, fox.id)).toEqual([
      'Пока можно отправлять только текст. Это сообщение не доставлено.',
    ]);
    expect(await messageRows(testDb.ownerPool, matchId)).toEqual([]);
  });

  it('relays plain text, so the refusals above are not an accident', async () => {
    const { app, fox, owl } = await pair(25);
    await app.handle(textUpdate(fox, 'просто привет'));
    expect(texts(app, owl.id)).toEqual(['🦊 Лиса\nпросто привет']);
  });
});
