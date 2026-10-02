/** Loads one catalog on demand, so bundlers split each locale into its own chunk. */
import type { Locale } from '../locale';
import type { Catalog } from './translator';

// No `with { type: 'json' }` here: this module is only consumed through a bundler, and in the
// Vite dev server the browser would then demand a JSON MIME type while Vite serves JSON as a
// JS module, so the import fails at runtime (unit tests can't see this; it shows only in a browser).
const loaders: Readonly<Record<Locale, () => Promise<Catalog>>> = {
  ru: () => import('./locales/ru.json').then((m) => m.default),
  en: () => import('./locales/en.json').then((m) => m.default),
};

export function loadCatalog(locale: Locale): Promise<Catalog> {
  return loaders[locale]();
}
