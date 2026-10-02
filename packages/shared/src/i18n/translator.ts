import type { Locale } from '../locale';
import type ruCatalog from './locales/ru.json';

/** Every key of the source (ru) catalog. Other catalogs must have exactly the same keys. */
export type MessageKey = keyof typeof ruCatalog;

/** Plural forms keyed by Intl.PluralRules category. `other` is always required. */
export type PluralForms = Partial<Record<Intl.LDMLPluralRule, string>> & { other: string };
export type MessageValue = string | PluralForms;
export type Catalog<K extends string = MessageKey> = Readonly<Record<K, MessageValue>>;

export type Params = Readonly<Record<string, string | number>>;

export interface Translator<K extends string = MessageKey> {
  readonly locale: Locale;
  /** A plain function (no `this`), so `const { t } = translator` is safe. */
  readonly t: (key: K, params?: Params) => string;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Placeholder names used in a message value, e.g. `{name}` → `name`. */
export function placeholdersOf(value: MessageValue): string[] {
  const texts = typeof value === 'string' ? [value] : Object.values(value);
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(PLACEHOLDER)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function interpolate(text: string, params: Params | undefined): string {
  if (!params) return text;
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

export interface TranslatorOptions {
  /** Called for keys missing at runtime (types should make this impossible). */
  onMissing?: (key: string) => void;
}

export function createTranslator<K extends string = MessageKey>(
  locale: Locale,
  catalog: Catalog<K>,
  options: TranslatorOptions = {},
): Translator<K> {
  const plurals = new Intl.PluralRules(locale);
  return {
    locale,
    t(key, params) {
      const value = catalog[key] as MessageValue | undefined;
      if (value === undefined) {
        options.onMissing?.(key);
        return key;
      }
      if (typeof value === 'string') return interpolate(value, params);
      const count = params?.['count'];
      const category = typeof count === 'number' ? plurals.select(count) : 'other';
      return interpolate(value[category] ?? value.other, params);
    },
  };
}
