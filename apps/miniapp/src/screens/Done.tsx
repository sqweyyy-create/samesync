import type { MatchSummary, MeResponse } from '@samesync/shared/api';
import { useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import type { Platform } from '../platform/types';
import { Screen } from '../ui/Screen';
import { MatchList } from './Match';

/** Completes onboarding once all minimums are met, sending the device time zone (Q22). */
export function Finish({
  api,
  onDone,
  onError,
}: {
  api: ApiClient;
  onDone: (me: MeResponse) => void;
  onError: () => void;
}) {
  const t = useT();
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    void api
      .complete(timezone)
      .then((result) => (result.kind === 'ok' ? onDone(result.data) : onError()));
  }, [api, onDone, onError]);
  return <Screen hint={t('miniapp.status.loading')} />;
}

/**
 * The home screen once the profile is done: the user's matches, and settings. If the bot may not
 * message the user yet (`allows_write_to_pm` is false), asks Telegram for write access so match
 * notifications can reach them.
 */
export function Done({
  api,
  me,
  platform,
  onSettings,
  onOpenMatch,
}: {
  api: ApiClient;
  me: MeResponse;
  platform: Platform;
  onSettings: () => void;
  onOpenMatch: (match: MatchSummary) => void;
}) {
  const t = useT();
  const [needsAccess, setNeedsAccess] = useState(platform.allowsWriteToPm() === false);
  const asked = useRef(false);

  useEffect(() => {
    if (!needsAccess || asked.current) return;
    asked.current = true;
    void platform.requestWriteAccess().then((allowed) => setNeedsAccess(!allowed));
  }, [needsAccess, platform]);

  return (
    <Screen
      title={t('miniapp.done.title')}
      hint={me.status === 'waitlisted' ? t('miniapp.done.waitlisted') : t('miniapp.done.text')}
    >
      {needsAccess && (
        <>
          <p>{t('miniapp.done.write_access')}</p>
          <button
            type="button"
            onClick={() => void platform.requestWriteAccess().then((ok) => setNeedsAccess(!ok))}
          >
            {t('miniapp.done.allow')}
          </button>
        </>
      )}
      {me.status === 'active' && <MatchList api={api} onOpen={onOpenMatch} />}
      <button type="button" className="secondary" onClick={onSettings}>
        {t('miniapp.done.settings')}
      </button>
    </Screen>
  );
}
