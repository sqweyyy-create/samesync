/**
 * POST /api/matches/:id/report and /block (PLAN.md Phase 5): the Mini App's way to report and
 * block the other person of a match. Validated bodies, the caller's own matches only, and the
 * same outcomes as in the bot.
 */
import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { insertChat } from '../support/chat';
import { buildChatApp, type ChatApp } from '../support/chat-app';
import { createTestDatabase, type TestDatabase } from '../support/db';
import type { TestUser } from '../support/fixtures';
import { matchRow, withoutTriggers } from '../support/matches';
import { birthDateYearsAgo } from '../support/users';

let testDb: TestDatabase;
let app: ChatApp;
beforeAll(async () => {
  testDb = await createTestDatabase();
  app = await buildChatApp(testDb);
});
afterAll(() => testDb.drop());

async function matched() {
  const chat = await insertChat(testDb.appPool);
  const fox: TestUser = { id: chat.telegramA, first_name: 'Fox' };
  const owl: TestUser = { id: chat.telegramB, first_name: 'Owl' };
  return { ...chat, fox, owl };
}
const report = (who: TestUser, matchId: string, body: unknown) =>
  app.as(who).post(`/api/matches/${matchId}/report`, body);
const reportsOf = async (matchId: string) =>
  (
    await testDb.ownerPool.query<{ reason: string; note: string | null }>(
      'SELECT reason::text AS reason, note FROM reports WHERE match_id = $1 ORDER BY created_at',
      [matchId],
    )
  ).rows;

describe('POST /api/matches/:id/report', () => {
  it('stores a report with its reason and note, once per reporter and match', async () => {
    const { matchId, fox, owl } = await matched();
    const first = await report(fox, matchId, { reason: 'harassment', note: 'rude' });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ status: 'stored' });
    const again = await report(fox, matchId, { reason: 'spam' });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: 'duplicate' });
    const theirs = await report(owl, matchId, { reason: 'other', note: '' });
    expect(await theirs.json()).toEqual({ status: 'stored' });
    expect(await reportsOf(matchId)).toEqual([
      { reason: 'harassment', note: 'rude' },
      { reason: 'other', note: null },
    ]);
  });

  it('validates the body', async () => {
    const { matchId, fox } = await matched();
    for (const body of [
      {},
      { reason: 'rude' },
      { reason: 'spam', note: 'x'.repeat(501) },
      'spam',
    ]) {
      const response = await report(fox, matchId, body);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: 'invalid' });
    }
    expect(await reportsOf(matchId)).toEqual([]);
  });

  it("answers 404 for a match that is not the caller's, is unknown, or was closed for a band change", async () => {
    const { matchId, fox } = await matched();
    const stranger: TestUser = { id: randomInt(1, 2 ** 40), first_name: 'Stranger' };
    expect((await report(stranger, matchId, { reason: 'spam' })).status).toBe(404);
    expect(
      (await report(fox, '00000000-0000-7000-8000-000000000000', { reason: 'spam' })).status,
    ).toBe(404);
    expect((await report(fox, 'nope', { reason: 'spam' })).status).toBe(404);
    const moved = await matched();
    await withoutTriggers(testDb.ownerPool, (c) =>
      c.query('UPDATE users SET birth_date = $2, username = NULL WHERE id = $1', [
        moved.b,
        birthDateYearsAgo(16),
      ]),
    );
    expect(
      (await report(moved.fox, moved.matchId, { reason: 'age_misrepresentation' })).status,
    ).toBe(404);
    expect(await reportsOf(matchId)).toEqual([]);
  });
});

describe('POST /api/matches/:id/block', () => {
  it('closes the match and answers with it; a second block is harmless', async () => {
    const { matchId, fox } = await matched();
    const response = await app.as(fox).post(`/api/matches/${matchId}/block`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: matchId, status: 'closed' });
    expect(await matchRow(testDb.ownerPool, matchId)).toMatchObject({
      status: 'closed',
      close_reason: 'blocked',
    });
    const again = await app.as(fox).post(`/api/matches/${matchId}/block`);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ id: matchId, status: 'closed' });
  });

  it("answers 404 for a match that is not the caller's", async () => {
    const { matchId } = await matched();
    const stranger: TestUser = { id: randomInt(1, 2 ** 40), first_name: 'Stranger' };
    expect((await app.as(stranger).post(`/api/matches/${matchId}/block`)).status).toBe(404);
    expect((await matchRow(testDb.ownerPool, matchId))?.status).toBe('results_ready');
  });
});
