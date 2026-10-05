import { MESSAGE_MAX_LENGTH } from '@samesync/shared/api';
import type { MatchSummary, ResultsResponse, Side } from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Screen } from '../ui/Screen';

/**
 * The results of a finished game: how well each read the other, every question side by side, and
 * last the take the two split on, with a first message to start from. The message can be edited,
 * and "Написать" sends it through the bot as the first message of the chat. The chat itself
 * takes place in the bot: once it has started, this screen only points there.
 */
export function Results({
  api,
  match,
  alias,
  onSent,
  onStale,
  onOpenChat,
  onBack,
}: {
  api: ApiClient;
  match: Pick<MatchSummary, 'id' | 'status' | 'chat'>;
  alias: string;
  /** The first message went out: the match as it is now (its chat has started). */
  onSent: (match: MatchSummary) => void;
  /** The results can't be shown (not ready, or the match ended): look at the match again. */
  onStale: () => void;
  /** Leaves the Mini App for the bot chat, where the conversation goes on. */
  onOpenChat: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [opener, setOpener] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    void api.results(match.id).then((result) => {
      if (result.kind !== 'ok') return onStale();
      setResults(result.data);
      setOpener(result.data.opener);
    });
  }, [api, match.id, onStale]);

  if (!results) return <Screen hint={t('miniapp.status.loading')} />;

  const send = async () => {
    setSending(true);
    setFailed(false);
    const result = await api.sendMessage(match.id, opener);
    setSending(false);
    if (result.kind === 'ok') {
      setSent(true);
      onSent(result.data);
      // The chat is over or was never ours: the match screen says which.
    } else if (result.kind === 'error' && ['conflict', 'not_found'].includes(result.code)) {
      onStale();
    } else {
      setFailed(true);
    }
  };

  const label = (side: Side) =>
    t(side === 'agree' ? 'miniapp.deck.agree' : 'miniapp.deck.disagree');
  const mark = (right: boolean) => t(right ? 'miniapp.results.right' : 'miniapp.results.wrong');
  const answers = (round: ResultsResponse['rounds'][number]) =>
    t('miniapp.results.answers', {
      yours: label(round.yours),
      alias,
      theirs: label(round.theirs),
    });
  const guesses = (round: ResultsResponse['rounds'][number]) =>
    t('miniapp.results.guesses', {
      you: mark(round.yourGuess === round.theirs),
      they: mark(round.theirGuess === round.yours),
    });
  const closing = results.rounds.at(-1);
  const started = sent || match.status === 'active';

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
          <p className="hint">{guesses(round)}</p>
        </article>
      ))}
      {closing && (
        <>
          <h2>{t('miniapp.results.closing')}</h2>
          <article className="card">{closing.text}</article>
          <p className="hint">{answers(closing)}</p>
          <p className="hint">{guesses(closing)}</p>
        </>
      )}
      {!match.chat && <p className="hint">{t('miniapp.results.chat_unavailable')}</p>}
      {match.chat && started && (
        <>
          <p>{t(sent ? 'miniapp.results.sent' : 'miniapp.results.chat_active')}</p>
          <button type="button" onClick={onOpenChat}>
            {t('miniapp.results.to_chat')}
          </button>
        </>
      )}
      {match.chat && !started && closing && (
        <>
          <label className="field">
            {t('miniapp.results.opener')}
            <textarea
              value={opener}
              maxLength={MESSAGE_MAX_LENGTH}
              onChange={(e) => setOpener(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={sending || opener.trim() === ''}
            onClick={() => void send()}
          >
            {t('miniapp.results.send')}
          </button>
          {failed && <p className="hint">{t('miniapp.results.send_failed')}</p>}
        </>
      )}
      <button type="button" className="secondary" onClick={onBack}>
        {t('miniapp.action.back')}
      </button>
    </Screen>
  );
}
