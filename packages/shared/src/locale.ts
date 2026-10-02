export const LOCALES = ['ru', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/** The locale every other catalog is checked against. */
export const SOURCE_LOCALE: Locale = 'ru';

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

/**
 * Maps a Telegram `language_code` to a supported locale.
 * Rule decided in PLAN.md Q13: `ru` and `ru-*` → ru, everything else → en.
 */
export function resolveLocale(languageCode: string | null | undefined): Locale {
  if (!languageCode) return 'en';
  const code = languageCode.toLowerCase();
  return code === 'ru' || code.startsWith('ru-') ? 'ru' : 'en';
}
