import type { ReactNode } from 'react';

/** A full-height screen with an optional title and hint. */
export function Screen({
  title,
  hint,
  children,
}: {
  title?: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <main className="screen">
      {title && <h1>{title}</h1>}
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
  return (
    <button
      type="button"
      className={selected ? 'choice selected' : 'choice'}
      aria-pressed={selected}
      onClick={onClick}
      disabled={disabled}
    >
      <span>{children}</span>
      {hint && <small>{hint}</small>}
    </button>
  );
}
