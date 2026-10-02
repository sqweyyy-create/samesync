import type { Translator } from '@samesync/shared/i18n';
import { createContext, useContext, type ReactNode } from 'react';

const I18nContext = createContext<Translator | null>(null);

export function I18nProvider({
  translator,
  children,
}: {
  translator: Translator;
  children: ReactNode;
}) {
  return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useT(): Translator['t'] {
  const translator = useContext(I18nContext);
  if (!translator) throw new Error('useT() must be used inside <I18nProvider>');
  return translator.t;
}
