import type { ResultsResponse, Side } from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Screen } from '../ui/Screen';

/**
 * The results of a finished game: how well each read the other, every question side by side, and
 * last the take the two split on, with a first message to start from. The message can be edited
 * here; sending it through the bot arrives with the chat (PLAN.md Phase 4), so nothing is sent.
 */
export function Results({
  api,
  matchId,
  alias,
  onStale,
  onBack,
}: {
  api: ApiClient;
  matchId: string;
  alias: string;
  /** The results can't be shown (not ready, or the match ended): look at the match again. */
  onStale: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [opener, setOpener] = useState('');

  useEffect(() => {
    void api.results(matchId).then((result) => {
      if (result.kind !== 'ok') return onStale();
      setResults(result.data);
      setOpener(result.data.opener);
    });
  }, [api, matchId, onStale]);

  if (!results) return <Screen hint={t('miniapp.status.loading')} />;

  const label = (side: Side) =>
    t(side === 'agree' ? 'miniapp.deck.agree' : 'miniapp.deck.disagree');
  const mark = (right: boolean) => t(right ? 'miniapp.results.right' : 'miniapp.results.wrong');
  const answers = (round: ResultsResponse['rounds'][number]) =>
    t('miniapp.results.answers', {
      yours: label(round.yours),
      alias,
      theirs: label(round.theirs),
    });
  const closing = results.rounds.at(-1);

  return (
    <Screen title={t('miniapp.results.title')}>
      <p>{t('miniapp.results.you', { count: results.youGuessed, total: results.total })}</p>
      <p>
        {t('miniapp.results.they', { alias, count: results.theyGuessed, total: results.total })}
      </p>
      {results.rounds.slice(0, -1).map((round) => (
        <article key={round.questionId} className="round">
          <p>{round.text}</p>
          <p className="hint">{answers(round)}</p>
          <p className="hint">
            {t('miniapp.results.guesses', {
              you: mark(round.yourGuess === round.theirs),
              they: mark(round.theirGuess === round.yours),
            })}
          </p>
        </article>
      ))}
      {closing && (
        <>
          <h2>{t('miniapp.results.closing')}</h2>
          <article className="card">{closing.text}</article>
          <p className="hint">{answers(closing)}</p>
          <label className="field">
            {t('miniapp.results.opener')}
            <textarea value={opener} maxLength={2000} onChange={(e) => setOpener(e.target.value)} />
          </label>
          <button type="button" disabled>
            {t('miniapp.results.send')}
          </button>
          <p className="hint">{t('miniapp.results.send_soon')}</p>
        </>
      )}
      <button type="button" className="secondary" onClick={onBack}>
        {t('miniapp.action.back')}
      </button>
    </Screen>
  );
}
