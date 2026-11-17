import type { ReactNode } from 'react';
import { useT } from '../i18n/I18nProvider';
import { useHaptic } from './chrome';

/** A full-height screen: the wordmark, an optional title, and the screen's own content. */
export function Screen({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children?: ReactNode;
}) {
  const t = useT();
  return (
    <main className={title ? 'screen' : 'screen status'}>
      <p className="brand">
        <span className="logo" aria-hidden="true" />
        {t('miniapp.brand')}
      </p>
      {title ? <h1>{title}</h1> : <span className="mark" aria-hidden="true" />}
      {hint && <p className="hint">{hint}</p>}
      {children}
    </main>
  );
}

/** A toggle button that shows whether it is selected (for choices and chips). */
export function Choice({
  selected,
  onClick,
  children,
  hint,
  disabled,
}: {
  selected: boolean;
  onClick: () => void;
  children: ReactNode;
  hint?: string;
  disabled?: boolean;
}) {
  const haptic = useHaptic();
  return (
    <button
      type="button"
      className={selected ? 'choice selected' : 'choice'}
      aria-pressed={selected}
      onClick={() => {
        haptic('select');
        onClick();
      }}
      disabled={disabled}
    >
      <span>{children}</span>
      {hint && <small>{hint}</small>}
    </button>
  );
}

/** A thin progress bar for the deck and the game. `label` is the accessible name. */
export function Meter({
  current,
  total,
  label,
}: {
  current: number;
  total: number;
  label: string;
}) {
  const width = total === 0 ? 0 : Math.min(100, Math.max(0, (current / total) * 100));
  return (
    <div
      className="meter"
      role="progressbar"
      aria-valuemin={1}
      aria-valuemax={total}
      aria-valuenow={current}
      aria-label={label}
    >
      <span style={{ width: `${width}%` }} />
    </div>
  );
}
