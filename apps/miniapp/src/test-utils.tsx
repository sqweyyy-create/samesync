import type { Locale } from '@samesync/shared';
import type { MeResponse } from '@samesync/shared/api';
import { createTranslator } from '@samesync/shared/i18n';
import { catalogs } from '@samesync/shared/i18n/static';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { vi } from 'vitest';
import type { ApiClient, ApiResult } from './api/client';
import { I18nProvider } from './i18n/I18nProvider';
import type { Platform } from './platform/types';

export function renderWithI18n(ui: ReactNode, locale: Locale = 'ru') {
  return render(
    <I18nProvider
      translator={createTranslator(locale, catalogs[locale])}
      loadCatalog={(l) => Promise.resolve(catalogs[l])}
    >
      {ui}
    </I18nProvider>,
  );
}

export const ok = <T,>(data: T): Promise<ApiResult<T>> => Promise.resolve({ kind: 'ok', data });

export function me(over: Partial<MeResponse> = {}): MeResponse {
  return {
    publicId: 'ABCDEFGH12',
    firstName: 'Аня',
    locale: 'ru',
    status: 'onboarding',
    step: 'locale',
    birthDate: null,
    age: null,
    band: null,
    mode: null,
    gender: null,
    seeking: null,
    datingAgeMin: null,
    datingAgeMax: null,
    progress: { answered: 0, interests: 0 },
    ...over,
  };
}

/** An ApiClient whose every method is a vi.fn(); override what a test needs. */
export function fakeApi(over: Partial<{ [K in keyof ApiClient]: ApiClient[K] }> = {}): ApiClient {
  const unused = () => Promise.reject(new Error('unexpected API call'));
  return {
    getMe: vi.fn(() => ok(me())),
    setLocale: vi.fn(unused),
    setBirthDate: vi.fn(unused),
    setMode: vi.fn(unused),
    datingOptions: vi.fn(() =>
      ok({
        options: [
          { id: 'g.man', self: 'Мужчина', seeking: 'Мужчин' },
          { id: 'g.woman', self: 'Женщина', seeking: 'Женщин' },
        ],
      }),
    ),
    deck: vi.fn(unused),
    saveAnswers: vi.fn(unused),
    interests: vi.fn(unused),
    saveInterests: vi.fn(unused),
    complete: vi.fn(unused),
    matches: vi.fn(() => ok({ matches: [] })),
    match: vi.fn(unused),
    game: vi.fn(unused),
    submitPredictions: vi.fn(unused),
    results: vi.fn(unused),
    sendMessage: vi.fn(unused),
    ...over,
  };
}

export function fakePlatform(over: Partial<Platform> = {}): Platform {
  return {
    inTelegram: true,
    initDataRaw: () => 'raw-init-data',
    languageCode: () => 'ru',
    ready: () => undefined,
    allowsWriteToPm: () => true,
    requestWriteAccess: vi.fn(() => Promise.resolve(true)),
    close: vi.fn(),
    ...over,
  };
}
