import type { MeResponse } from '@samesync/shared/api';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; me: MeResponse }
  | { kind: 'unauthorized' }
  | { kind: 'network' };

/** Phase 0 screen: proves the round trip Telegram initData → server validation → /api/me. */
export function Hello({ api, inTelegram }: { api: ApiClient; inTelegram: boolean }) {
  const t = useT();
  const [state, setState] = useState<State>({ kind: 'loading' });

  const fetchMe = useCallback(
    () =>
      api.getMe().then((result) => {
        setState(result.kind === 'ok' ? { kind: 'ready', me: result.data } : result);
      }),
    [api],
  );

  useEffect(() => {
    if (inTelegram) void fetchMe();
  }, [inTelegram, fetchMe]);

  const retry = () => {
    setState({ kind: 'loading' });
    void fetchMe();
  };

  if (!inTelegram) return <Message text={t('miniapp.error.outside_telegram')} />;

  switch (state.kind) {
    case 'loading':
      return <Message text={t('miniapp.status.loading')} />;
    case 'ready':
      return (
        <main className="screen">
          <h1>{t('miniapp.hello.title', { name: state.me.firstName })}</h1>
          <p className="hint">{t('miniapp.hello.subtitle')}</p>
        </main>
      );
    case 'unauthorized':
      return <Message text={t('miniapp.error.unauthorized')} />;
    case 'network':
      return (
        <Message text={t('miniapp.error.network')}>
          <button type="button" onClick={retry}>
            {t('miniapp.action.retry')}
          </button>
        </Message>
      );
  }
}

function Message({ text, children }: { text: string; children?: ReactNode }) {
  return (
    <main className="screen">
      <p>{text}</p>
      {children}
    </main>
  );
}
