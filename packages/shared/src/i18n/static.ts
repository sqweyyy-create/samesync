/**
 * All catalogs, imported statically. For the server (bot replies, notifications).
 * The Mini App must use `./load` instead so it only downloads the active locale.
 */
import type { Locale } from '../locale';
import en from './locales/en.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
import { createTranslator, type Catalog, type Translator } from './translator';

export const catalogs: Readonly<Record<Locale, Catalog>> = { ru, en };

const translators = new Map<Locale, Translator>();

export function translatorFor(locale: Locale): Translator {
  let translator = translators.get(locale);
  if (!translator) {
    translator = createTranslator(locale, catalogs[locale]);
    translators.set(locale, translator);
  }
  return translator;
}
