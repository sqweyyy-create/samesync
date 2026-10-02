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
