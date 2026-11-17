import { MESSAGE_MAX_LENGTH } from '@samesync/shared/api';
import type { MatchSummary, ResultsResponse, Side } from '@samesync/shared/api';
import { useEffect, useState, type ReactNode } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { PrimaryButton, useBackButton, useHaptic } from '../ui/chrome';
import { Choice, Screen } from '../ui/Screen';

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
  safety,
}: {
  api: ApiClient;
  match: Pick<MatchSummary, 'id' | 'status' | 'chat'>;
  alias: string;
  /** Report and block, rendered by the match screen. */
  safety?: ReactNode;
  /** The first message went out: the match as it is now (its chat has started). */
  onSent: (match: MatchSummary) => void;
  /** The results can't be shown (not ready, or the match ended): look at the match again. */
  onStale: () => void;
  /** Leaves the Mini App for the bot chat, where the conversation goes on. */
  onOpenChat: () => void;
  onBack: () => void;
}) {
  const t = useT();
  const haptic = useHaptic();
  const [results, setResults] = useState<ResultsResponse | null>(null);
  const [opener, setOpener] = useState('');
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState<'generic' | 'contact_blocked' | null>(null);
  const [sent, setSent] = useState(false);
  useBackButton(onBack);

  useEffect(() => {
    void api.results(match.id).then((result) => {
      if (result.kind !== 'ok') return onStale();
      setResults(result.data);
      setOpener(result.data.opener);
    });
  }, [api, match.id, onStale]);

  const send = async () => {
    setSending(true);
    setFailed(null);
    const result = await api.sendMessage(match.id, opener);
    setSending(false);
    if (result.kind === 'ok') {
      haptic('success');
      setSent(true);
      onSent(result.data);
      // The chat is over or was never ours: the match screen says which.
    } else if (result.kind === 'error' && ['conflict', 'not_found'].includes(result.code)) {
      haptic('error');
      onStale();
    } else if (result.kind === 'error' && result.details.includes('contact_blocked')) {
      // The u18 contact filter stopped it: the one refusal that is explained.
      haptic('warning');
      setFailed('contact_blocked');
    } else {
      haptic('error');
      setFailed('generic');
    }
  };

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
  const guesses = (round: ResultsResponse['rounds'][number]) =>
    t('miniapp.results.guesses', {
      you: mark(round.yourGuess === round.theirs),
      they: mark(round.theirGuess === round.yours),
    });
  const closing = results.rounds.at(-1);
  const started = sent || match.status === 'active';
  const prompts = [
    { id: 'game', label: t('miniapp.results.prompt.game'), text: results.opener },
    {
      id: 'why',
      label: t('miniapp.results.prompt.why_label'),
      text: t('miniapp.results.prompt.why'),
    },
    {
      id: 'soft',
      label: t('miniapp.results.prompt.soft_label'),
      text: t('miniapp.results.prompt.soft'),
    },
    { id: 'hi', label: t('miniapp.results.prompt.hi_label'), text: t('miniapp.results.prompt.hi') },
  ] as const;

  return (
    <Screen title={t('miniapp.results.title')}>
      <div className="scores">
        <p className="score">
          {t('miniapp.results.you', { count: results.youGuessed, total: results.total })}
        </p>
        <p className="score">
          {t('miniapp.results.they', { alias, count: results.theyGuessed, total: results.total })}
        </p>
      </div>
      {results.rounds.slice(0, -1).map((round) => (
        <article key={round.questionId} className="round">
          <p>{round.text}</p>
          <p className="hint">{answers(round)}</p>
          <p className="hint">{guesses(round)}</p>
        </article>
      ))}
      {closing && (
        <section className="split">
          <h2>{t('miniapp.results.closing')}</h2>
          <article className="card">{closing.text}</article>
          <p className="hint">{answers(closing)}</p>
          <p className="hint">{guesses(closing)}</p>
          {!match.chat && <p className="hint">{t('miniapp.results.chat_unavailable')}</p>}
          {match.chat && started && (
            <p>{t(sent ? 'miniapp.results.sent' : 'miniapp.results.chat_active')}</p>
          )}
          {match.chat && !started && (
            <>
              <p className="kicker">{t('miniapp.results.icebreakers')}</p>
              <div className="chips" role="group" aria-label={t('miniapp.results.icebreakers')}>
                {prompts.map((prompt) => (
                  <Choice
                    key={prompt.id}
                    selected={opener === prompt.text}
                    onClick={() => {
                      setOpener(prompt.text);
                      setFailed(null);
                    }}
                  >
                    {prompt.label}
                  </Choice>
                ))}
              </div>
              <p className="hint">{t('miniapp.results.nudge')}</p>
              <label className="field">
                {t('miniapp.results.opener')}
                <textarea
                  value={opener}
                  maxLength={MESSAGE_MAX_LENGTH}
                  onChange={(e) => setOpener(e.target.value)}
                />
              </label>
              <p className="hint">{t('miniapp.results.privacy')}</p>
              {failed && (
                <p className="error" role="alert">
                  {t(
                    failed === 'contact_blocked'
                      ? 'miniapp.results.contact_blocked'
                      : 'miniapp.results.send_failed',
                  )}
                </p>
              )}
            </>
          )}
        </section>
      )}
      {safety}
      <div className="action-bar">
        {match.chat && started && (
          <PrimaryButton bare onClick={onOpenChat}>
            {t('miniapp.results.to_chat')}
          </PrimaryButton>
        )}
        {match.chat && !started && closing && (
          <PrimaryButton
            bare
            disabled={sending || opener.trim() === ''}
            loading={sending}
            onClick={() => void send()}
          >
            {t('miniapp.results.send')}
          </PrimaryButton>
        )}
        <button type="button" className="secondary" onClick={onBack}>
          {t('miniapp.action.back')}
        </button>
      </div>
    </Screen>
  );
}
