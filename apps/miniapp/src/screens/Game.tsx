import type { GameResponse, MatchSummary, Side } from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Screen } from '../ui/Screen';

type Question = GameResponse['questions'][number];

/**
 * The game of a match: one card per take, "what did the other person answer?". The guesses are
 * sent together after a last look, because they can't be changed afterwards. Nothing here knows
 * the other person's answers: the server only hands out the takes.
 */
export function Game({
  api,
  matchId,
  alias,
  onSubmitted,
  onStale,
  onBack,
}: {
  api: ApiClient;
  matchId: string;
  /** The other person's alias, e.g. "🦊 Лиса". */
  alias: string;
  onSubmitted: (match: MatchSummary) => void;
  /** The game can't be played any more (it ended, or was submitted elsewhere): look again. */
  onStale: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [picks, setPicks] = useState<Map<string, Side>>(new Map());
  const [position, setPosition] = useState(0);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    void api.game(matchId).then((result) => {
      if (result.kind === 'ok') setQuestions(result.data.questions);
      else onStale();
    });
  }, [api, matchId, onStale]);

  if (!questions) return <Screen hint={t('miniapp.status.loading')} />;

  const label = (side: Side) =>
    t(side === 'agree' ? 'miniapp.deck.agree' : 'miniapp.deck.disagree');
  const current = questions[position];

  const pick = (side: Side) => {
    if (!current) return;
    setPicks(new Map(picks).set(current.id, side));
    setPosition(position + 1);
  };

  const send = async () => {
    setSending(true);
    setFailed(false);
    const result = await api.submitPredictions(
      matchId,
      questions.map((q) => ({ questionId: q.id, value: picks.get(q.id) ?? 'agree' })),
    );
    setSending(false);
    if (result.kind === 'ok') onSubmitted(result.data);
    // 409: the game ended or was already submitted; anything else can be tried again.
    else if (result.kind === 'error' && result.code !== 'invalid') onStale();
    else setFailed(true);
  };

  // After the last card: one look at all guesses, then send.
  if (!current) {
    return (
      <Screen title={t('miniapp.game.review.title')} hint={t('miniapp.game.review.hint')}>
        {questions.map((q) => (
          <article key={q.id} className="round">
            <p>{q.text}</p>
            <p className="hint">
              {t('miniapp.game.review.pick', { alias, answer: label(picks.get(q.id) ?? 'agree') })}
            </p>
          </article>
        ))}
        {failed && <p className="error">{t('miniapp.game.submit_failed')}</p>}
        <div className="row">
          <button type="button" disabled={sending} onClick={() => void send()}>
            {t('miniapp.game.submit')}
          </button>
          <button
            type="button"
            className="secondary"
            disabled={sending}
            onClick={() => setPosition(questions.length - 1)}
          >
            {t('miniapp.action.back')}
          </button>
        </div>
      </Screen>
    );
  }

  return (
    <Screen title={t('miniapp.game.title')} hint={t('miniapp.game.prompt', { alias })}>
      <p className="progress">
        {t('miniapp.deck.progress', { current: position + 1, total: questions.length })}
      </p>
      <article className="card" aria-live="polite">
        {current.text}
      </article>
      <div className="row">
        <button type="button" onClick={() => pick('agree')}>
          {label('agree')}
        </button>
        <button type="button" onClick={() => pick('disagree')}>
          {label('disagree')}
        </button>
      </div>
      <button
        type="button"
        className="secondary"
        onClick={() => (position === 0 ? onBack() : setPosition(position - 1))}
      >
        {t('miniapp.action.back')}
      </button>
    </Screen>
  );
}
