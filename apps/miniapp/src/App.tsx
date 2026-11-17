import type { MatchSummary, MeResponse } from '@samesync/shared/api';
import type { MessageKey } from '@samesync/shared/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, ApiResult } from './api/client';
import { useLocale, useT } from './i18n/I18nProvider';
import type { Platform } from './platform/types';
import { BirthDate } from './screens/BirthDate';
import { Deck } from './screens/Deck';
import { Done, Finish } from './screens/Done';
import { Interests } from './screens/Interests';
import { Language } from './screens/Language';
import { Match } from './screens/Match';
import { Mode } from './screens/Mode';
import { Settings, type SettingsTarget } from './screens/Settings';
import { Screen } from './ui/Screen';
import { PrimaryButton } from './ui/chrome';

type Failure = 'unauthorized' | 'network' | 'forbidden' | 'generic';
const FAILURE_TEXT: Record<Failure, MessageKey> = {
  unauthorized: 'miniapp.error.unauthorized',
  network: 'miniapp.error.network',
  forbidden: 'miniapp.error.forbidden',
  generic: 'miniapp.error.generic',
};

/**
 * Routes by the onboarding step the server reports, so the server stays the only judge of order,
 * band and minimums. The UI language follows the stored locale once /api/me answers (Q13).
 */
export function App({
  api,
  platform,
  today,
  initialMatchId,
}: {
  api: ApiClient;
  platform: Platform;
  today: string;
  /** From the bot notification button (`?match=<id>`): open this match first. */
  initialMatchId?: string | undefined;
}) {
  const t = useT();
  const { switchTo } = useLocale();
  const [me, setMe] = useState<MeResponse | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<'flow' | 'settings' | SettingsTarget>('flow');
  const [openMatch, setOpenMatch] = useState<{ id: string; match?: MatchSummary } | null>(
    initialMatchId ? { id: initialMatchId } : null,
  );

  const accept = useCallback(
    (next: MeResponse) => {
      setMe(next);
      void switchTo(next.locale);
    },
    [switchTo],
  );

  const settle = useCallback(
    (result: ApiResult<MeResponse>) => {
      if (result.kind === 'ok') {
        accept(result.data);
        return true;
      }
      if (result.kind === 'error')
        setFailure(result.code === 'forbidden' ? 'forbidden' : 'generic');
      else setFailure(result.kind);
      return false;
    },
    [accept],
  );

  const run = useCallback(
    async (call: () => Promise<ApiResult<MeResponse>>) => {
      setBusy(true);
      const result = await call();
      setBusy(false);
      return settle(result);
    },
    [settle],
  );

  const load = useCallback(() => {
    setFailure(null);
    void run(api.getMe);
  }, [api, run]);
  const fail = useCallback(() => setFailure('generic'), []);

  // First load: state is only set once the request settles (no setState inside the effect body).
  useEffect(() => {
    if (platform.inTelegram) void api.getMe().then(settle);
  }, [platform.inTelegram, api, settle]);

  if (!platform.inTelegram) return <Screen hint={t('miniapp.error.outside_telegram')} />;
  if (failure) {
    return (
      <Screen hint={t(FAILURE_TEXT[failure])}>
        <PrimaryButton onClick={load}>{t('miniapp.action.retry')}</PrimaryButton>
      </Screen>
    );
  }
  if (!me) return <Screen hint={t('miniapp.status.loading')} />;
  // A frozen account can only read this (and write to /support in the bot); a deleted one nothing.
  if (me.status === 'frozen') return <Screen hint={t('miniapp.account.frozen')} />;
  if (me.status === 'deleted') return <Screen hint={t('miniapp.account.deleted')} />;

  const backToSettings = () => setView('settings');
  if (view === 'settings') {
    return (
      <Settings
        me={me}
        busy={busy}
        onLocale={(locale) => void run(() => api.setLocale(locale))}
        onOpen={setView}
        onBack={() => setView('flow')}
      />
    );
  }
  if (view === 'mode') {
    return (
      <Mode
        api={api}
        me={me}
        busy={busy}
        editing
        onSave={(request) =>
          void run(() => api.setMode(request)).then((ok) => ok && backToSettings())
        }
      />
    );
  }
  if (view === 'answers') {
    return (
      <Deck
        api={api}
        editing
        onError={fail}
        onDone={(next) => {
          if (next) accept(next);
          backToSettings();
        }}
      />
    );
  }
  if (view === 'interests') {
    return (
      <Interests
        api={api}
        onError={fail}
        onDone={(next) => {
          accept(next);
          backToSettings();
        }}
      />
    );
  }

  switch (me.step) {
    case 'locale':
      return (
        <Language
          initial={me.locale}
          busy={busy}
          onChoose={(l) => void run(() => api.setLocale(l))}
        />
      );
    case 'birth_date':
      return (
        <BirthDate
          today={today}
          busy={busy}
          onConfirm={(d) => void run(() => api.setBirthDate(d))}
        />
      );
    case 'ineligible':
      return <Screen title={t('miniapp.ineligible.title')} hint={t('miniapp.ineligible.text')} />;
    case 'mode':
      return (
        <Mode
          api={api}
          me={me}
          busy={busy}
          onSave={(request) => void run(() => api.setMode(request))}
        />
      );
    case 'answers':
      return <Deck api={api} onError={fail} onDone={(next) => (next ? accept(next) : load())} />;
    case 'interests':
      return <Interests api={api} onError={fail} onDone={accept} />;
    case 'finish':
      return <Finish api={api} onError={fail} onDone={accept} />;
    case 'done':
      if (openMatch && me.status === 'active') {
        return (
          <Match
            api={api}
            matchId={openMatch.id}
            match={openMatch.match}
            onOpenChat={platform.close}
            onBack={() => setOpenMatch(null)}
          />
        );
      }
      return (
        <Done
          api={api}
          me={me}
          platform={platform}
          onSettings={() => setView('settings')}
          onOpenMatch={(match) => setOpenMatch({ id: match.id, match })}
        />
      );
  }
}
