import { REPORT_NOTE_MAX_LENGTH, ReportReason } from '@samesync/shared/api';
import type { MatchSummary, ReportReason as Reason } from '@samesync/shared/api';
import { useState } from 'react';
import type { ApiClient } from '../api/client';
import { useT } from '../i18n/I18nProvider';
import { Choice } from '../ui/Screen';

/**
 * Report and block the other person of a match (PLAN.md Phase 5). Both are reachable from every
 * match screen. A report asks for a reason and takes a note; a block asks once and then ends
 * the match for good (the server closes it, the pair is never matched again).
 */
export function Safety({
  api,
  match,
  alias,
  onBlocked,
}: {
  api: ApiClient;
  match: Pick<MatchSummary, 'id'>;
  alias: string;
  /** The block went through: the match as it is now (closed). */
  onBlocked: (match: MatchSummary) => void;
}) {
  const t = useT();
  const [view, setView] = useState<'buttons' | 'report' | 'block' | 'reported' | 'blocked'>(
    'buttons',
  );
  const [reason, setReason] = useState<Reason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [outcome, setOutcome] = useState<'stored' | 'duplicate'>('stored');

  const report = async () => {
    if (!reason) return;
    setBusy(true);
    setFailed(false);
    const result = await api.report(match.id, {
      reason,
      ...(note.trim() === '' ? {} : { note: note.trim() }),
    });
    setBusy(false);
    if (result.kind === 'ok') {
      setOutcome(result.data.status);
      setView('reported');
    } else {
      setFailed(true);
    }
  };

  const block = async () => {
    setBusy(true);
    setFailed(false);
    const result = await api.block(match.id);
    setBusy(false);
    if (result.kind === 'ok') {
      setView('blocked');
      onBlocked(result.data);
    } else {
      setFailed(true);
    }
  };

  if (view === 'reported') {
    return (
      <p className="hint">
        {t(outcome === 'stored' ? 'miniapp.report.sent' : 'miniapp.report.duplicate')}
      </p>
    );
  }
  if (view === 'blocked') return <p className="hint">{t('miniapp.block.done')}</p>;
  if (view === 'report') {
    return (
      <section className="safety">
        <h2>{t('miniapp.report.title')}</h2>
        <div className="row">
          {ReportReason.options.map((value) => (
            <Choice
              key={value}
              selected={reason === value}
              disabled={busy}
              onClick={() => setReason(value)}
            >
              {t(`report.reason.${value}`)}
            </Choice>
          ))}
        </div>
        <label className="field">
          {t('miniapp.report.note')}
          <textarea
            value={note}
            maxLength={REPORT_NOTE_MAX_LENGTH}
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        <button type="button" disabled={busy || reason === null} onClick={() => void report()}>
          {t('miniapp.report.send')}
        </button>
        {failed && <p className="hint">{t('miniapp.report.failed')}</p>}
        <button type="button" className="secondary" onClick={() => setView('buttons')}>
          {t('miniapp.action.cancel')}
        </button>
      </section>
    );
  }
  if (view === 'block') {
    return (
      <section className="safety">
        <p>{t('miniapp.block.confirm', { alias })}</p>
        <button type="button" disabled={busy} onClick={() => void block()}>
          {t('miniapp.block.yes')}
        </button>
        {failed && <p className="hint">{t('miniapp.block.failed')}</p>}
        <button type="button" className="secondary" onClick={() => setView('buttons')}>
          {t('miniapp.action.cancel')}
        </button>
      </section>
    );
  }
  return (
    <div className="row safety">
      <button type="button" className="secondary" onClick={() => setView('report')}>
        {t('miniapp.safety.report')}
      </button>
      <button type="button" className="secondary" onClick={() => setView('block')}>
        {t('miniapp.safety.block')}
      </button>
    </div>
  );
}
