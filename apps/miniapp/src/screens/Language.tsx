import { LOCALES, type Locale } from '@samesync/shared';
import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { Choice, Screen } from '../ui/Screen';

/** First screen (Q13): the language is preselected from Telegram and stored once chosen. */
export function Language({
  initial,
  onChoose,
  busy,
}: {
  initial: Locale;
  onChoose: (locale: Locale) => void;
  busy: boolean;
}) {
  const t = useT();
  const [locale, setLocale] = useState<Locale>(initial);
  return (
    <Screen title={t('miniapp.language.title')} hint={t('miniapp.language.note')}>
      {LOCALES.map((l) => (
        <Choice key={l} selected={l === locale} onClick={() => setLocale(l)}>
          {t(`miniapp.language.${l}`)}
        </Choice>
      ))}
      <button type="button" disabled={busy} onClick={() => onChoose(locale)}>
        {t('miniapp.action.continue')}
      </button>
    </Screen>
  );
}
