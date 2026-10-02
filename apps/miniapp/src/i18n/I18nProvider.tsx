import type { Locale } from '@samesync/shared';
import { createTranslator, type Catalog, type Translator } from '@samesync/shared/i18n';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface I18nState {
  translator: Translator;
  /** Loads the catalog for `locale` (if needed) and switches the whole UI to it. */
  readonly switchTo: (locale: Locale) => Promise<void>;
}

const I18nContext = createContext<I18nState | null>(null);

export function I18nProvider({
  translator: initial,
  loadCatalog,
  children,
}: {
  translator: Translator;
  loadCatalog: (locale: Locale) => Promise<Catalog>;
  children: ReactNode;
}) {
  const [translator, setTranslator] = useState(initial);
  const switchTo = useCallback(
    async (locale: Locale) => {
      if (locale === translator.locale) return;
      setTranslator(createTranslator(locale, await loadCatalog(locale)));
    },
    [translator.locale, loadCatalog],
  );
  const value = useMemo(() => ({ translator, switchTo }), [translator, switchTo]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

function useI18n(): I18nState {
  const state = useContext(I18nContext);
  if (!state) throw new Error('useT() must be used inside <I18nProvider>');
  return state;
}

export function useT(): Translator['t'] {
  return useI18n().translator.t;
}

export function useLocale(): { locale: Locale; switchTo: (locale: Locale) => Promise<void> } {
  const { translator, switchTo } = useI18n();
  return { locale: translator.locale, switchTo };
}
