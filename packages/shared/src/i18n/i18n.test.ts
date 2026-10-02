import { describe, expect, it } from 'vitest';
import { LOCALES, SOURCE_LOCALE, resolveLocale, type Locale } from '../locale';
import { loadCatalog } from './load';
import { catalogs, translatorFor } from './static';
import { createTranslator, placeholdersOf, type Catalog } from './translator';

const EXPECTED_PLURAL_CATEGORIES: Record<Locale, string[]> = {
  ru: ['few', 'many', 'one', 'other'],
  en: ['one', 'other'],
};

function pluralCategories(locale: Locale): string[] {
  return [...new Intl.PluralRules(locale).resolvedOptions().pluralCategories].sort();
}

describe('locale catalogs', () => {
  const source = catalogs[SOURCE_LOCALE];
  const sourceKeys = Object.keys(source).sort();

  it('has a non-empty source catalog', () => {
    expect(sourceKeys.length).toBeGreaterThan(0);
  });

  it.each(LOCALES)('%s has exactly the same keys as the source locale', (locale) => {
    expect(Object.keys(catalogs[locale]).sort()).toEqual(sourceKeys);
  });

  it.each(LOCALES)('%s uses the same placeholders as the source locale for every key', (locale) => {
    const catalog: Catalog = catalogs[locale];
    for (const key of sourceKeys) {
      const k = key as keyof typeof source;
      expect({ key, placeholders: placeholdersOf(catalog[k]) }).toEqual({
        key,
        placeholders: placeholdersOf(source[k]),
      });
    }
  });

  it.each(LOCALES)('%s has every plural category for each plural key', (locale) => {
    expect(pluralCategories(locale)).toEqual(EXPECTED_PLURAL_CATEGORIES[locale]);
    const catalog: Catalog = catalogs[locale];
    for (const [key, value] of Object.entries(catalog)) {
      if (typeof value === 'string') continue;
      expect({ key, categories: Object.keys(value).sort() }).toEqual({
        key,
        categories: EXPECTED_PLURAL_CATEGORIES[locale],
      });
    }
  });

  it.each(LOCALES)('%s has no empty messages', (locale) => {
    for (const [key, value] of Object.entries(catalogs[locale])) {
      const texts = typeof value === 'string' ? [value] : Object.values(value);
      for (const text of texts)
        expect({ key, empty: text.trim() === '' }).toEqual({ key, empty: false });
    }
  });

  it.each(LOCALES)(
    'loadCatalog(%s) returns the same catalog as the static import',
    async (locale) => {
      expect(await loadCatalog(locale)).toEqual(catalogs[locale]);
    },
  );
});

describe('createTranslator', () => {
  const fixture = {
    greeting: 'Привет, {name}!',
    unknownParam: 'Hi {who}',
    days: {
      one: 'Остался {count} день',
      few: 'Осталось {count} дня',
      many: 'Осталось {count} дней',
      other: 'Осталось {count} дня',
    },
  } as const;
  type FixtureKey = keyof typeof fixture;

  it('interpolates parameters', () => {
    const { t } = createTranslator<FixtureKey>('ru', fixture);
    expect(t('greeting', { name: 'Аня' })).toBe('Привет, Аня!');
  });

  it('leaves a placeholder visible when its parameter is missing', () => {
    const { t } = createTranslator<FixtureKey>('ru', fixture);
    expect(t('unknownParam')).toBe('Hi {who}');
  });

  it.each([
    [1, 'Остался 1 день'],
    [2, 'Осталось 2 дня'],
    [5, 'Осталось 5 дней'],
    [11, 'Осталось 11 дней'],
    [21, 'Остался 21 день'],
    [22, 'Осталось 22 дня'],
  ])('selects the Russian plural form for %i', (count, expected) => {
    const { t } = createTranslator<FixtureKey>('ru', fixture);
    expect(t('days', { count })).toBe(expected);
  });

  it('selects English plural forms', () => {
    const { t } = createTranslator('en', {
      days: { one: '{count} day left', other: '{count} days left' },
    });
    expect(t('days', { count: 1 })).toBe('1 day left');
    expect(t('days', { count: 2 })).toBe('2 days left');
    expect(t('days', { count: 21 })).toBe('21 days left');
  });

  it('reports and returns the key when a message is missing at runtime', () => {
    const missing: string[] = [];
    const { t } = createTranslator<string>('en', {}, { onMissing: (k) => missing.push(k) });
    expect(t('nope')).toBe('nope');
    expect(missing).toEqual(['nope']);
  });

  it('translatorFor renders real catalog messages per locale', () => {
    expect(translatorFor('ru').t('miniapp.hello.title', { name: 'Аня' })).toBe('Привет, Аня!');
    expect(translatorFor('en').t('miniapp.hello.title', { name: 'Ann' })).toBe('Hi, Ann!');
  });
});

describe('resolveLocale', () => {
  it.each([
    ['ru', 'ru'],
    ['RU', 'ru'],
    ['ru-RU', 'ru'],
    ['en', 'en'],
    ['de', 'en'],
    ['uk', 'en'],
    ['rue', 'en'],
    ['', 'en'],
    [undefined, 'en'],
    [null, 'en'],
  ] as const)('%s → %s', (code, expected) => {
    expect(resolveLocale(code)).toBe(expected);
  });
});
