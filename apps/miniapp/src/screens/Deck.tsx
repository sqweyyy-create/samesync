import {
  ONBOARDING,
  type AnswerValue,
  type DeckResponse,
  type MeResponse,
} from '@samesync/shared/api';
import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Screen } from '../ui/Screen';

type Question = DeckResponse['questions'][number];

/**
 * The swipe deck (Q5): 35 takes, agree / disagree / skip, at least 25 non-skip answers. Every
 * answer is saved right away, so closing the app never loses progress. "Back" returns to the
 * previous card to change its answer. After the last card, skipped cards come back until the
 * minimum is reached. In settings (`editing`), the deck starts from the first card.
 */
export function Deck({
  api,
  onDone,
  onError,
  editing = false,
}: {
  api: ApiClient;
  onDone: (me: MeResponse | null) => void;
  onError: () => void;
  editing?: boolean;
}) {
  const t = useT();
  const [questions, setQuestions] = useState<Question[] | null>(null);
  const [answers, setAnswers] = useState<Map<string, AnswerValue>>(new Map());
  const [queue, setQueue] = useState<string[]>([]);
  const [position, setPosition] = useState(0);
  const [history, setHistory] = useState<number[]>([]);
  const [revisiting, setRevisiting] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void api.deck().then((result) => {
      if (result.kind !== 'ok') return onError();
      const known = new Map(result.data.answers.map((a) => [a.questionId, a.value]));
      const ids = result.data.questions.map((q) => q.id);
      const firstOpen = ids.findIndex((id) => !known.has(id));
      setQuestions(result.data.questions);
      setAnswers(known);
      setQueue(ids);
      setPosition(editing || firstOpen < 0 ? 0 : firstOpen);
    });
  }, [api, editing, onError]);

  if (!questions) return <Screen hint={t('miniapp.status.loading')} />;

  const byId = new Map(questions.map((q) => [q.id, q]));
  const nonSkip = (map: Map<string, AnswerValue>) =>
    [...map.values()].filter((v) => v !== 'skip').length;

  const finishOrRevisit = (map: Map<string, AnswerValue>, me: MeResponse | null) => {
    if (nonSkip(map) >= ONBOARDING.minAnswers) return onDone(me);
    const skipped = queue.filter((id) => map.get(id) === 'skip' || !map.has(id));
    setQueue(skipped.length > 0 ? skipped : queue);
    setPosition(0);
    setHistory([]);
    setRevisiting(true);
  };

  const answer = async (value: AnswerValue) => {
    const id = queue[position]!;
    setSaving(true);
    const result = await api.saveAnswers([{ questionId: id, value }]);
    setSaving(false);
    if (result.kind !== 'ok') return onError();
    const next = new Map(answers).set(id, value);
    setAnswers(next);
    setHistory((h) => [...h, position]);
    // While revisiting skipped cards, stop as soon as the minimum is reached.
    if (revisiting && nonSkip(next) >= ONBOARDING.minAnswers) onDone(result.data);
    else if (position + 1 < queue.length) setPosition(position + 1);
    else finishOrRevisit(next, result.data);
  };

  const back = () => {
    const previous = history.at(-1);
    if (previous === undefined) return;
    setHistory((h) => h.slice(0, -1));
    setPosition(previous);
  };

  const current = byId.get(queue[position] ?? '');
  return (
    <Screen title={t('miniapp.deck.title')}>
      <p className="hint">
        {revisiting
          ? t('miniapp.deck.revisit', { answered: nonSkip(answers), min: ONBOARDING.minAnswers })
          : t('miniapp.deck.min_hint', { count: ONBOARDING.minAnswers })}
      </p>
      <p className="progress">
        {t('miniapp.deck.progress', { current: position + 1, total: queue.length })}
      </p>
      <article className="card" aria-live="polite">
        {current?.text}
      </article>
      <div className="row">
        <button type="button" disabled={saving} onClick={() => void answer('agree')}>
          {t('miniapp.deck.agree')}
        </button>
        <button type="button" disabled={saving} onClick={() => void answer('disagree')}>
          {t('miniapp.deck.disagree')}
        </button>
      </div>
      <div className="row">
        <button
          type="button"
          className="secondary"
          disabled={saving}
          onClick={() => void answer('skip')}
        >
          {t('miniapp.deck.skip')}
        </button>
        <button
          type="button"
          className="secondary"
          disabled={saving || history.length === 0}
          onClick={back}
        >
          {t('miniapp.deck.undo')}
        </button>
      </div>
    </Screen>
  );
}
