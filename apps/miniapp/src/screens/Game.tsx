import type { GameResponse, MatchSummary, Side } from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { PrimaryButton, useBackButton, useHaptic } from '../ui/chrome';
import { Meter, Screen } from '../ui/Screen';
import { useSwipe } from '../ui/swipe';

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
  const haptic = useHaptic();
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

  const current = questions?.[position];
  const goBack = () => {
    if (!questions || position <= 0) onBack();
    else if (position >= questions.length) setPosition(questions.length - 1);
    else setPosition(position - 1);
  };
  useBackButton(goBack);

  const pick = (side: Side) => {
    if (!current) return;
    haptic('light');
    setPicks(new Map(picks).set(current.id, side));
    setPosition(position + 1);
  };
  const swipe = useSwipe(pick, current !== undefined);

  const label = (side: Side) =>
    t(side === 'agree' ? 'miniapp.deck.agree' : 'miniapp.deck.disagree');

  const send = async () => {
    if (!questions) return;
    setSending(true);
    setFailed(false);
    const result = await api.submitPredictions(
      matchId,
      questions.map((q) => ({ questionId: q.id, value: picks.get(q.id) ?? 'agree' })),
    );
    setSending(false);
    if (result.kind === 'ok') {
      haptic('success');
      onSubmitted(result.data);
      // 409: the game ended or was already submitted; anything else can be tried again.
    } else if (result.kind === 'error' && result.code !== 'invalid') {
      haptic('error');
      onStale();
    } else {
      haptic('error');
      setFailed(true);
    }
  };

  if (!questions) return <Screen hint={t('miniapp.status.loading')} />;

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
        {failed && (
          <p className="error" role="alert">
            {t('miniapp.game.submit_failed')}
          </p>
        )}
        <div className="action-bar">
          <PrimaryButton bare disabled={sending} loading={sending} onClick={() => void send()}>
            {t('miniapp.game.submit')}
          </PrimaryButton>
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

  const progress = t('miniapp.deck.progress', { current: position + 1, total: questions.length });
  return (
    <Screen title={t('miniapp.game.title')} hint={t('miniapp.game.prompt', { alias })}>
      <Meter current={position + 1} total={questions.length} label={progress} />
      <p className="progress">{progress}</p>
      <article
        className="card"
        aria-live="polite"
        data-swipe={swipe.direction}
        style={swipe.style}
        {...swipe.bind}
      >
        {current.text}
      </article>
      <p className="hint">{t('miniapp.deck.swipe')}</p>
      <div className="row decide">
        <button type="button" onClick={() => pick('agree')}>
          {label('agree')}
        </button>
        <button type="button" className="alt" onClick={() => pick('disagree')}>
          {label('disagree')}
        </button>
      </div>
      <button type="button" className="secondary" onClick={goBack}>
        {t('miniapp.action.back')}
      </button>
    </Screen>
  );
}
