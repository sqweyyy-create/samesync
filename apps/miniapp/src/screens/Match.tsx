import type { MatchSummary } from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Screen } from '../ui/Screen';

const OPEN: ReadonlyArray<MatchSummary['status']> = ['pending_game', 'results_ready', 'active'];

/** The matches the user has right now: who (an alias) and what they share (the teaser). */
export function MatchList({
  api,
  onOpen,
}: {
  api: ApiClient;
  onOpen: (match: MatchSummary) => void;
}) {
  const t = useT();
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  useEffect(() => {
    void api.matches().then((result) => {
      if (result.kind === 'ok') setMatches(result.data.matches);
    });
  }, [api]);
  if (matches.length === 0) return null;
  return (
    <>
      <h2>{t('miniapp.matches.title')}</h2>
      {matches.map((match) => (
        <button key={match.id} type="button" className="choice" onClick={() => onOpen(match)}>
          <span>{`${match.alias.emoji} ${match.alias.name}`}</span>
          <small>{match.teaser}</small>
        </button>
      ))}
    </>
  );
}

/**
 * One match. A placeholder until Phase 3 brings the game: it shows the other person's alias and
 * what the two share. Opened from the list, or straight from the bot notification by ID.
 */
export function Match({
  api,
  match: known,
  matchId,
  onBack,
}: {
  api: ApiClient;
  match?: MatchSummary | undefined;
  matchId: string;
  onBack: () => void;
}) {
  const t = useT();
  const [loaded, setLoaded] = useState<MatchSummary | 'unavailable' | null>(null);
  useEffect(() => {
    if (known) return;
    void api
      .match(matchId)
      .then((result) => setLoaded(result.kind === 'ok' ? result.data : 'unavailable'));
  }, [api, known, matchId]);

  const match = known ?? loaded;
  const back = (
    <button type="button" className="secondary" onClick={onBack}>
      {t('miniapp.action.back')}
    </button>
  );
  if (match === null) return <Screen hint={t('miniapp.status.loading')} />;
  if (match === 'unavailable') {
    return <Screen hint={t('miniapp.match.unavailable')}>{back}</Screen>;
  }
  return (
    <Screen title={`${match.alias.emoji} ${match.alias.name}`} hint={match.teaser}>
      <p>
        {OPEN.includes(match.status) ? t('miniapp.match.placeholder') : t('miniapp.match.ended')}
      </p>
      {back}
    </Screen>
  );
}
