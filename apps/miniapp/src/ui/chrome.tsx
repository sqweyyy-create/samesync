import { useCallback, useEffect, useId, useRef } from 'react';
import { useChromeStack, usePlatform } from '../platform/context';
import type { HapticKind } from '../platform/types';

/** The platform from context. Safe to call from any screen; outside a provider it does nothing. */
export function useHaptic(): (kind: HapticKind) => void {
  const platform = usePlatform();
  return useCallback((kind: HapticKind) => platform.haptic(kind), [platform]);
}

/**
 * Mirrors one primary action to Telegram's MainButton. The in-page button stays for tests, for
 * browsers, and for clients where the native button did not mount.
 */
export function useMainButton(state: {
  text: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}): void {
  const platform = usePlatform();
  const chrome = useChromeStack();
  const id = useId();
  const onClick = useRef(state.onClick);
  const { text, disabled, loading } = state;
  useEffect(() => {
    onClick.current = state.onClick;
  }, [state.onClick]);
  useEffect(() => {
    const entry = {
      text,
      disabled,
      loading,
      fn: () => onClick.current(),
    };
    if (!chrome) {
      platform.setMainButton({ ...entry, onClick: entry.fn });
      return () => platform.setMainButton(null);
    }
    chrome.pushMain({ id, ...entry });
    return () => chrome.popMain(id);
  }, [chrome, platform, id, text, disabled, loading]);
}

/** Registers this screen as the native BackButton target until it unmounts. */
export function useBackButton(onBack: () => void): void {
  const chrome = useChromeStack();
  const id = useId();
  const onBackRef = useRef(onBack);
  useEffect(() => {
    onBackRef.current = onBack;
  }, [onBack]);
  useEffect(() => {
    if (!chrome) return;
    chrome.pushBack(id, () => onBackRef.current());
    return () => chrome.popBack(id);
  }, [chrome, id]);
}

/**
 * The screen's one main action. Rendered as a bottom bar, and mirrored to Telegram's MainButton.
 * When the native button is showing, the in-page copy is omitted so the two don't stack.
 */
export function PrimaryButton({
  children,
  disabled = false,
  loading = false,
  onClick,
  bare = false,
}: {
  children: string;
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
  /** Render only the button, for a bar the screen composes itself. */
  bare?: boolean;
}) {
  const platform = usePlatform();
  const haptic = useHaptic();
  useMainButton({ text: children, disabled: disabled || loading, loading, onClick });
  if (platform.nativeButtons) return null;
  const button = (
    <button
      type="button"
      className="primary"
      disabled={disabled || loading}
      onClick={() => {
        haptic('light');
        onClick();
      }}
    >
      {children}
    </button>
  );
  if (bare) return button;
  return <div className="action-bar">{button}</div>;
}
