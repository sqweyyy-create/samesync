import { describe, expect, it, vi } from 'vitest';
import { me } from '../test-utils';
import { createApiClient } from './client';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('createApiClient', () => {
  it('sends initData only in the Authorization header with the tma scheme', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(me()));
    const api = createApiClient({ getInitData: () => 'raw-init-data', fetch: fetchMock });
    expect(await api.getMe()).toEqual({ kind: 'ok', data: me() });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/me');
    expect(init?.headers).toEqual({ Authorization: 'tma raw-init-data' });
  });

  it('sends JSON bodies and maps API errors to their codes', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: 'conflict', details: ['birth_date_already_set'] }, 409));
    const api = createApiClient({ getInitData: () => 'x', fetch: fetchMock });
    expect(await api.setBirthDate('2010-05-20')).toEqual({
      kind: 'error',
      code: 'conflict',
      details: ['birth_date_already_set'],
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/onboarding/birth-date');
    expect(init).toMatchObject({
      method: 'POST',
      body: JSON.stringify({ birthDate: '2010-05-20' }),
    });
  });

  it('builds the interests query', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ items: [], selected: [] }));
    await createApiClient({ getInitData: () => 'x', fetch: fetchMock }).interests({
      domain: 'music',
      q: 'молчат',
    });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      '/api/interests?domain=music&q=%D0%BC%D0%BE%D0%BB%D1%87%D0%B0%D1%82',
    );
  });

  it('reads the matches list and one match by ID', async () => {
    const match = {
      id: '01a10238-d68a-76a8-87cc-960f650dd8c3',
      alias: { emoji: '🦊', name: 'Лиса' },
      teaser: 'У кого-то в плейлисте тоже Молчат Дома.',
      status: 'pending_game',
      createdAt: '2026-10-03T10:00:00.000Z',
      gameDeadlineAt: '2026-10-05T10:00:00.000Z',
      resultsReadyAt: null,
      chatDeadlineAt: null,
      game: { questions: 5, youDone: false, theyDone: true },
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ matches: [match] }))
      .mockResolvedValueOnce(json(match))
      .mockResolvedValueOnce(json({ error: 'not_found' }, 404));
    const api = createApiClient({ getInitData: () => 'x', fetch: fetchMock });
    expect(await api.matches()).toEqual({ kind: 'ok', data: { matches: [match] } });
    expect(await api.match(match.id)).toEqual({ kind: 'ok', data: match });
    expect(await api.match('../me')).toEqual({ kind: 'error', code: 'not_found', details: [] });
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual([
      '/api/matches',
      `/api/matches/${match.id}`,
      '/api/matches/..%2Fme',
    ]);
  });

  it('reads the game, sends all guesses in one request, and reads the results', async () => {
    const id = '01a10238-d68a-76a8-87cc-960f650dd8c3';
    const game = { questions: [{ id: 'q.a', text: 'Take A' }] };
    const summary = {
      id,
      alias: { emoji: '🦊', name: 'Лиса' },
      teaser: 'У кого-то здесь в плейлисте тоже Молчат Дома.',
      status: 'results_ready',
      createdAt: '2026-10-04T10:00:00.000Z',
      gameDeadlineAt: '2026-10-06T10:00:00.000Z',
      resultsReadyAt: '2026-10-04T12:00:00.000Z',
      chatDeadlineAt: '2026-10-06T12:00:00.000Z',
      game: { questions: 1, youDone: true, theyDone: true },
    };
    const results = {
      total: 1,
      youGuessed: 1,
      theyGuessed: 0,
      rounds: [
        {
          questionId: 'q.a',
          text: 'Take A',
          yours: 'agree',
          theirs: 'disagree',
          yourGuess: 'disagree',
          theirGuess: 'disagree',
        },
      ],
      opener: 'Я за. А ты почему против?',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(game))
      .mockResolvedValueOnce(json(summary))
      .mockResolvedValueOnce(json(results))
      .mockResolvedValueOnce(json({ error: 'out_of_order' }, 409))
      // A side that is not "agree" or "disagree" breaks the contract.
      .mockResolvedValueOnce(
        json({ ...results, rounds: [{ ...results.rounds[0], theirs: 'skip' }] }),
      );
    const api = createApiClient({ getInitData: () => 'x', fetch: fetchMock });
    const predictions = [{ questionId: 'q.a', value: 'disagree' as const }];
    expect(await api.game(id)).toEqual({ kind: 'ok', data: game });
    expect(await api.submitPredictions(id, predictions)).toEqual({ kind: 'ok', data: summary });
    expect(await api.results(id)).toEqual({ kind: 'ok', data: results });
    expect(await api.results(id)).toEqual({ kind: 'error', code: 'out_of_order', details: [] });
    expect(await api.results(id)).toEqual({ kind: 'network' });
    expect(fetchMock.mock.calls.map((c) => [c[1]?.method, c[0]])).toEqual([
      ['GET', `/api/matches/${id}/game`],
      ['PUT', `/api/matches/${id}/predictions`],
      ['GET', `/api/matches/${id}/results`],
      ['GET', `/api/matches/${id}/results`],
      ['GET', `/api/matches/${id}/results`],
    ]);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({ predictions }));
  });

  it('maps 401 to unauthorized and does not call fetch without initData', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({}, 401));
    expect(await createApiClient({ getInitData: () => 'x', fetch: fetchMock }).getMe()).toEqual({
      kind: 'unauthorized',
    });
    const noInitData = vi.fn<typeof fetch>();
    expect(
      await createApiClient({ getInitData: () => undefined, fetch: noInitData }).getMe(),
    ).toEqual({ kind: 'unauthorized' });
    expect(noInitData).not.toHaveBeenCalled();
  });

  it('treats a response that does not match the contract as a network problem', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ unexpected: true }));
    expect(await createApiClient({ getInitData: () => 'x', fetch: fetchMock }).getMe()).toEqual({
      kind: 'network',
    });
  });
});
