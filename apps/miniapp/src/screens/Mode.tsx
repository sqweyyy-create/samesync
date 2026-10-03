import { ADULT_AGE, MAX_AGE, defaultDatingAgeRange } from '@samesync/shared';
import type { DatingOptionsResponse, MeResponse, SetModeRequest } from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Choice, Screen } from '../ui/Screen';

/** A whole number of years within the allowed partner ages, or null. */
function parseAge(text: string): number | null {
  if (!/^\d{1,3}$/.test(text)) return null;
  const age = Number(text);
  return age >= ADULT_AGE && age <= MAX_AGE ? age : null;
}

/**
 * Adults only: friends or dating, and for dating "You are" + "Looking for" (Q11). u18 users never
 * see this screen; the server also refuses dating for them. In settings (`editing`) dating also
 * shows the partner age range (Q12); during onboarding the server applies the default.
 */
export function Mode({
  api,
  me,
  onSave,
  busy,
  editing = false,
}: {
  api: ApiClient;
  me: MeResponse;
  onSave: (request: SetModeRequest) => void;
  busy: boolean;
  editing?: boolean;
}) {
  const t = useT();
  const [mode, setMode] = useState(me.mode ?? 'friends');
  const [gender, setGender] = useState<string | null>(me.gender);
  const [seeking, setSeeking] = useState<string[]>(me.seeking ?? []);
  const [options, setOptions] = useState<DatingOptionsResponse['options']>([]);
  const initialRange =
    me.datingAgeMin !== null && me.datingAgeMax !== null
      ? { min: me.datingAgeMin, max: me.datingAgeMax }
      : defaultDatingAgeRange(me.age ?? ADULT_AGE);
  const [ageFrom, setAgeFrom] = useState(String(initialRange.min));
  const [ageTo, setAgeTo] = useState(String(initialRange.max));

  useEffect(() => {
    if (mode !== 'dating' || options.length > 0) return;
    void api.datingOptions().then((result) => {
      if (result.kind === 'ok') setOptions(result.data.options);
    });
  }, [api, mode, options.length]);

  const toggleSeeking = (id: string) =>
    setSeeking((current) =>
      current.includes(id) ? current.filter((s) => s !== id) : [...current, id],
    );
  const ageMin = parseAge(ageFrom);
  const ageMax = parseAge(ageTo);
  const rangeOk = !editing || (ageMin !== null && ageMax !== null && ageMin <= ageMax);
  const ready = mode === 'friends' || (gender !== null && seeking.length > 0 && rangeOk);
  const save = () => {
    if (mode === 'friends') return onSave({ mode });
    const dating = { mode, gender: gender!, seeking };
    onSave(editing ? { ...dating, ageMin: ageMin!, ageMax: ageMax! } : dating);
  };

  return (
    <Screen title={t('miniapp.mode.title')}>
      <Choice
        selected={mode === 'friends'}
        onClick={() => setMode('friends')}
        hint={t('miniapp.mode.friends_hint')}
      >
        {t('miniapp.mode.friends')}
      </Choice>
      <Choice
        selected={mode === 'dating'}
        onClick={() => setMode('dating')}
        hint={t('miniapp.mode.dating_hint')}
      >
        {t('miniapp.mode.dating')}
      </Choice>
      {mode === 'dating' && (
        <>
          <h2>{t('miniapp.dating.self')}</h2>
          <div className="chips">
            {options.map((o) => (
              <Choice key={o.id} selected={gender === o.id} onClick={() => setGender(o.id)}>
                {o.self}
              </Choice>
            ))}
          </div>
          <h2>{t('miniapp.dating.seeking')}</h2>
          <p className="hint">{t('miniapp.dating.seeking_hint')}</p>
          <div className="chips">
            {options.map((o) => (
              <Choice
                key={o.id}
                selected={seeking.includes(o.id)}
                onClick={() => toggleSeeking(o.id)}
              >
                {o.seeking}
              </Choice>
            ))}
          </div>
          {editing && (
            <>
              <h2>{t('miniapp.dating.age_range')}</h2>
              <p className="hint">{t('miniapp.dating.age_hint')}</p>
              <div className="row">
                <label className="field">
                  <span>{t('miniapp.dating.age_from')}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={ADULT_AGE}
                    max={MAX_AGE}
                    value={ageFrom}
                    onChange={(e) => setAgeFrom(e.target.value)}
                  />
                </label>
                <label className="field">
                  <span>{t('miniapp.dating.age_to')}</span>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={ADULT_AGE}
                    max={MAX_AGE}
                    value={ageTo}
                    onChange={(e) => setAgeTo(e.target.value)}
                  />
                </label>
              </div>
            </>
          )}
        </>
      )}
      <button type="button" disabled={!ready || busy} onClick={save}>
        {editing ? t('miniapp.action.save') : t('miniapp.action.next')}
      </button>
    </Screen>
  );
}
