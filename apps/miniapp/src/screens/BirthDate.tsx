import { ageOn, birthDateProblem, type BirthDateProblem } from '@samesync/shared';
import { useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { PrimaryButton } from '../ui/chrome';
import { Screen } from '../ui/Screen';

/**
 * Birth date with a confirmation step ("You're 16 — right?"), because it can never be changed
 * by the user afterwards (CLAUDE.md invariant 7). The server validates it again.
 */
export function BirthDate({
  today,
  onConfirm,
  busy,
}: {
  today: string;
  onConfirm: (birthDate: string) => void;
  busy: boolean;
}) {
  const t = useT();
  const [value, setValue] = useState('');
  const [problem, setProblem] = useState<BirthDateProblem | null>(null);
  const [confirming, setConfirming] = useState(false);

  const next = () => {
    const found = birthDateProblem(value, today);
    setProblem(found);
    if (!found) setConfirming(true);
  };

  if (confirming) {
    return (
      <Screen
        title={t('miniapp.birth_date.confirm', { count: ageOn(value, today) })}
        hint={t('miniapp.birth_date.confirm_note')}
      >
        <div className="action-bar">
          <PrimaryButton bare disabled={busy} loading={busy} onClick={() => onConfirm(value)}>
            {t('miniapp.birth_date.confirm_yes')}
          </PrimaryButton>
          <button type="button" className="secondary" onClick={() => setConfirming(false)}>
            {t('miniapp.birth_date.confirm_no')}
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={t('miniapp.birth_date.title')} hint={t('miniapp.birth_date.hint')}>
      <label className="field">
        <span>{t('miniapp.birth_date.label')}</span>
        <input
          type="date"
          value={value}
          max={today}
          onChange={(e) => {
            setValue(e.target.value);
            setProblem(null);
          }}
        />
      </label>
      {problem && (
        <p className="error" role="alert">
          {t(`miniapp.birth_date.error.${problem}`)}
        </p>
      )}
      <PrimaryButton disabled={!value} onClick={next}>
        {t('miniapp.action.next')}
      </PrimaryButton>
    </Screen>
  );
}
