import type { DatingOptionsResponse, MeResponse, SetModeRequest } from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Choice, Screen } from '../ui/Screen';

/**
 * Adults only: friends or dating, and for dating "You are" + "Looking for" (Q11). u18 users never
 * see this screen; the server also refuses dating for them.
 */
export function Mode({
  api,
  me,
  onSave,
  busy,
}: {
  api: ApiClient;
  me: MeResponse;
  onSave: (request: SetModeRequest) => void;
  busy: boolean;
}) {
  const t = useT();
  const [mode, setMode] = useState(me.mode ?? 'friends');
  const [gender, setGender] = useState<string | null>(me.gender);
  const [seeking, setSeeking] = useState<string[]>(me.seeking ?? []);
  const [options, setOptions] = useState<DatingOptionsResponse['options']>([]);

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
  const ready = mode === 'friends' || (gender !== null && seeking.length > 0);

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
        </>
      )}
      <button
        type="button"
        disabled={!ready || busy}
        onClick={() => onSave(mode === 'friends' ? { mode } : { mode, gender: gender!, seeking })}
      >
        {t('miniapp.action.next')}
      </button>
    </Screen>
  );
}
