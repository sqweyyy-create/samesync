import type { MatchSummary } from '@samesync/shared/api';
import type { MessageKey } from '@samesync/shared/i18n';
import { useCallback, useEffect, useState } from 'react';
import type { ApiClient, ApiResult } from '../api/client';
import { useLocale, useT } from '../i18n/I18nProvider';
import { PrimaryButton, useBackButton } from '../ui/chrome';
import { Screen } from '../ui/Screen';
import { Game } from './Game';
import { Results } from './Results';
import { Safety } from './Safety';

/** Where a match stands for the person looking at it. */
type Stage = 'play' | 'waiting' | 'results' | 'ended';

function stageOf(match: MatchSummary): Stage {
  if (match.status === 'results_ready' || match.status === 'active') return 'results';
  if (match.status === 'pending_game' && match.game) return match.game.youDone ? 'waiting' : 'play';
  return 'ended';
}

const STATE_HINT: Partial<Record<Stage, MessageKey>> = {
  play: 'miniapp.match.state.play',
  waiting: 'miniapp.match.state.waiting',
  results: 'miniapp.match.state.results',
};

/** What the list says about a match: whose turn it is, or that the chat is going on in the bot. */
const hintOf = (match: MatchSummary): MessageKey | undefined =>
  match.status === 'active' ? 'miniapp.match.state.chat' : STATE_HINT[stageOf(match)];

/** The matches the user has right now: who (an alias), what they share, and whose turn it is. */
export function MatchList({
  api,
  onOpen,
}: {
  api: ApiClient;
  onOpen: (match: MatchSummary) => void;
}) {
  const t = useT();
  const [matches, setMatches] = useState<MatchSummary[] | null>(null);
  useEffect(() => {
    void api.matches().then((result) => {
      setMatches(result.kind === 'ok' ? result.data.matches : []);
    });
  }, [api]);
  if (matches === null) return null;
  if (matches.length === 0) {
    return (
      <div className="empty">
        <span className="empty-mark" aria-hidden="true" />
        <p>{t('miniapp.matches.empty')}</p>
      </div>
    );
  }
  return (
    <>
      <h2>{t('miniapp.matches.title')}</h2>
      {matches.map((match) => {
        const hint = hintOf(match);
        return (
          <button key={match.id} type="button" className="match-card" onClick={() => onOpen(match)}>
            <span className="avatar" aria-hidden="true">
              {match.alias.emoji}
            </span>
            <span className="match-name">{match.alias.name}</span>
            <span className="match-teaser">{match.teaser}</span>
            {hint && <span className="pill">{t(hint)}</span>}
          </button>
        );
      })}
    </>
  );
}

/**
 * One match, from the teaser to the results: play the game, wait for the other person, then see
 * how well you read each other and send the first message. Opened from the list, or straight from
 * a bot notification by ID.
 * While waiting, the match is looked up again whenever the app comes back to the foreground
 * (there are no WebSockets).
 */
export function Match({
  api,
  match: known,
  matchId,
  onOpenChat,
  onBack,
}: {
  api: ApiClient;
  match?: MatchSummary | undefined;
  matchId: string;
  /** Leaves the Mini App for the bot chat. */
  onOpenChat: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  const [match, setMatch] = useState<MatchSummary | 'unavailable' | null>(known ?? null);
  const [playing, setPlaying] = useState(false);
  useBackButton(onBack);

  const apply = useCallback((result: ApiResult<MatchSummary>) => {
    if (result.kind === 'ok') setMatch(result.data);
    // Gone for this user (closed for good, or never theirs). A network hiccup changes nothing.
    else if (result.kind === 'error') setMatch('unavailable');
  }, []);
  const reload = useCallback(() => void api.match(matchId).then(apply), [api, matchId, apply]);
  const stale = useCallback(() => {
    setPlaying(false);
    reload();
  }, [reload]);

  useEffect(() => {
    if (!known) void api.match(matchId).then(apply);
  }, [api, known, matchId, apply]);

  const stage = match && match !== 'unavailable' ? stageOf(match) : null;
  useEffect(() => {
    if (stage !== 'waiting') return;
    const refresh = () => {
      if (document.visibilityState === 'visible') reload();
    };
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('focus', refresh);
    return () => {
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('focus', refresh);
    };
  }, [stage, reload]);

  const back = (
    <button type="button" className="secondary" onClick={onBack}>
      {t('miniapp.action.back')}
    </button>
  );
  if (match === null) return <Screen hint={t('miniapp.status.loading')} />;
  if (match === 'unavailable' || stage === null) {
    return (
      <Screen hint={t('miniapp.match.unavailable')}>
        <div className="action-bar">{back}</div>
      </Screen>
    );
  }

  const alias = `${match.alias.emoji} ${match.alias.name}`;
  // Report and block are reachable from every match the user can see (PLAN.md Phase 5).
  const safety = <Safety api={api} match={match} alias={alias} onBlocked={setMatch} />;
  if (stage === 'results') {
    return (
      <Results
        api={api}
        match={match}
        alias={alias}
        onSent={setMatch}
        onStale={stale}
        onOpenChat={onOpenChat}
        onBack={onBack}
        safety={safety}
      />
    );
  }
  if (stage === 'play' && playing) {
    return (
      <Game
        api={api}
        matchId={match.id}
        alias={alias}
        onSubmitted={(next) => {
          setPlaying(false);
          setMatch(next);
        }}
        onStale={stale}
        onBack={() => setPlaying(false)}
      />
    );
  }
  if (stage === 'play') {
    const until = new Intl.DateTimeFormat(locale, {
      day: 'numeric',
      month: 'long',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(match.gameDeadlineAt));
    return (
      <Screen title={alias} hint={match.teaser}>
        <p>{t('miniapp.game.intro', { count: match.game?.questions ?? 0 })}</p>
        <p className="hint">{t('miniapp.game.deadline', { time: until })}</p>
        {safety}
        <div className="action-bar">
          <PrimaryButton bare onClick={() => setPlaying(true)}>
            {t('miniapp.game.play')}
          </PrimaryButton>
          {back}
        </div>
      </Screen>
    );
  }
  if (stage === 'waiting') {
    return (
      <Screen title={alias} hint={match.teaser}>
        <p>{t('miniapp.game.waiting', { alias })}</p>
        <button type="button" className="secondary" onClick={reload}>
          {t('miniapp.game.refresh')}
        </button>
        {safety}
        <div className="action-bar">{back}</div>
      </Screen>
    );
  }
  return (
    <Screen title={alias} hint={match.teaser}>
      <p>{t('miniapp.match.ended')}</p>
      {safety}
      <div className="action-bar">{back}</div>
    </Screen>
  );
}
