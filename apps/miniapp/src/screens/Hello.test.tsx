import { createTranslator } from '@samesync/shared/i18n';
import { catalogs } from '@samesync/shared/i18n/static';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, type ApiClient } from '../api/client';
import { I18nProvider } from '../i18n/I18nProvider';
import { Hello } from './Hello';

afterEach(cleanup);

const ru = createTranslator('ru', catalogs.ru);
const en = createTranslator('en', catalogs.en);

function renderWith(translator: typeof ru, ui: ReactNode) {
  return render(<I18nProvider translator={translator}>{ui}</I18nProvider>);
}

function fakeApi(result: Awaited<ReturnType<ApiClient['getMe']>>): ApiClient {
  return { getMe: vi.fn().mockResolvedValue(result) };
}

describe('<Hello>', () => {
  it('greets the user by the first name returned from /api/me', async () => {
    const api = fakeApi({
      kind: 'ok',
      data: { publicId: 'ABCDEFGH12', firstName: 'Аня', locale: 'ru' },
    });
    renderWith(ru, <Hello api={api} inTelegram />);
    expect(await screen.findByRole('heading', { name: 'Привет, Аня!' })).toBeTruthy();
    expect(api.getMe).toHaveBeenCalledTimes(1);
  });

  it('renders in English with the English catalog', async () => {
    const api = fakeApi({
      kind: 'ok',
      data: { publicId: 'ABCDEFGH12', firstName: 'Ann', locale: 'en' },
    });
    renderWith(en, <Hello api={api} inTelegram />);
    expect(await screen.findByRole('heading', { name: 'Hi, Ann!' })).toBeTruthy();
  });

  it('shows a localized error when the server rejects the session', async () => {
    renderWith(ru, <Hello api={fakeApi({ kind: 'unauthorized' })} inTelegram />);
    expect(
      await screen.findByText(catalogs.ru['miniapp.error.unauthorized'] as string),
    ).toBeTruthy();
  });

  it('offers a retry after a network error', async () => {
    const getMe = vi
      .fn<ApiClient['getMe']>()
      .mockResolvedValueOnce({ kind: 'network' })
      .mockResolvedValueOnce({
        kind: 'ok',
        data: { publicId: 'ABCDEFGH12', firstName: 'Ann', locale: 'en' },
      });
    renderWith(en, <Hello api={{ getMe }} inTelegram />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'Hi, Ann!' })).toBeTruthy();
    expect(getMe).toHaveBeenCalledTimes(2);
  });

  it('asks to open the app in Telegram and does not call the API outside Telegram', () => {
    const api = fakeApi({ kind: 'unauthorized' });
    renderWith(en, <Hello api={api} inTelegram={false} />);
    expect(screen.getByText('Open SameSync inside Telegram.')).toBeTruthy();
    expect(api.getMe).not.toHaveBeenCalled();
  });
});

describe('createApiClient', () => {
  it('sends initData only in the Authorization header with the tma scheme', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ publicId: 'ABCDEFGH12', firstName: 'Ann', locale: 'en' }), {
        status: 200,
      }),
    );
    const api = createApiClient({ getInitData: () => 'raw-init-data', fetch: fetchMock });
    expect(await api.getMe()).toEqual({
      kind: 'ok',
      data: { publicId: 'ABCDEFGH12', firstName: 'Ann', locale: 'en' },
    });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe('/api/me');
    expect(init?.headers).toEqual({ Authorization: 'tma raw-init-data' });
  });

  it('maps 401 to unauthorized and does not call fetch without initData', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    expect(await createApiClient({ getInitData: () => 'x', fetch: fetchMock }).getMe()).toEqual({
      kind: 'unauthorized',
    });
    const noInitData = vi.fn<typeof fetch>();
    expect(
      await createApiClient({ getInitData: () => undefined, fetch: noInitData }).getMe(),
    ).toEqual({
      kind: 'unauthorized',
    });
    expect(noInitData).not.toHaveBeenCalled();
  });
});
