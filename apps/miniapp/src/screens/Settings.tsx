import { LOCALES, type Locale } from '@samesync/shared';
import type { MeResponse } from '@samesync/shared/api';
import { useT } from '../i18n/I18nProvider';
import { useBackButton } from '../ui/chrome';
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
  useBackButton(onBack);
  return (
    <Screen title={t('miniapp.settings.title')}>
      <section className="panel">
        <h2>{t('miniapp.settings.language')}</h2>
        <p className="hint">{t('miniapp.settings.language_note')}</p>
        <div className="row">
          {LOCALES.map((l) => (
            <Choice key={l} selected={me.locale === l} disabled={busy} onClick={() => onLocale(l)}>
              {t(`miniapp.language.${l}`)}
            </Choice>
          ))}
        </div>
      </section>
      <section className="panel">
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
      </section>
      <section className="panel">
        <h2>{t('miniapp.settings.birth_date')}</h2>
        <p className="birth">{me.birthDate}</p>
        <p className="hint">{t('miniapp.settings.birth_date_hint', { code: me.publicId })}</p>
      </section>
      <div className="action-bar">
        <button type="button" className="secondary" onClick={onBack}>
          {t('miniapp.action.back')}
        </button>
      </div>
    </Screen>
  );
}
