import { LOCALES, type Locale } from '@samesync/shared';
import type { MeResponse } from '@samesync/shared/api';
import { useT } from '../i18n/I18nProvider';
import { Choice, Screen } from '../ui/Screen';

export type SettingsTarget = 'mode' | 'answers' | 'interests';

/**
 * Settings: language (Q13), mode for adults (Q10), editing answers and interests (Q5). The birth
 * date is read-only, with the support code to quote when asking for a correction.
 */
export function Settings({
  me,
  onLocale,
  onOpen,
  onBack,
  busy,
}: {
  me: MeResponse;
  onLocale: (locale: Locale) => void;
  onOpen: (target: SettingsTarget) => void;
  onBack: () => void;
  busy: boolean;
}) {
  const t = useT();
  return (
    <Screen title={t('miniapp.settings.title')}>
      <h2>{t('miniapp.settings.language')}</h2>
      <p className="hint">{t('miniapp.language.note')}</p>
      <div className="row">
        {LOCALES.map((l) => (
          <Choice key={l} selected={me.locale === l} disabled={busy} onClick={() => onLocale(l)}>
            {t(`miniapp.language.${l}`)}
          </Choice>
        ))}
      </div>
      {me.band === 'adult' && (
        <button type="button" className="secondary" onClick={() => onOpen('mode')}>
          {t('miniapp.settings.mode')}
        </button>
      )}
      <button type="button" className="secondary" onClick={() => onOpen('answers')}>
        {t('miniapp.settings.answers')}
      </button>
      <button type="button" className="secondary" onClick={() => onOpen('interests')}>
        {t('miniapp.settings.interests')}
      </button>
      <h2>{t('miniapp.settings.birth_date')}</h2>
      <p>{me.birthDate}</p>
      <p className="hint">{t('miniapp.settings.birth_date_hint', { code: me.publicId })}</p>
      <button type="button" onClick={onBack}>
        {t('miniapp.action.back')}
      </button>
    </Screen>
  );
}
