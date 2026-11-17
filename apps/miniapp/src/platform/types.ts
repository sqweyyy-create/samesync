/** What the app needs from Telegram. The rest of the app depends on this, never on the SDK. */

export type HapticKind = 'select' | 'light' | 'success' | 'warning' | 'error';

/** The single primary action, mirrored to Telegram's MainButton when it is available. */
export interface MainButtonState {
  text: string;
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}

export interface Platform {
  /** False when opened outside Telegram (and not in dev browser mode). */
  readonly inTelegram: boolean;
  /** Raw initData for `Authorization: tma <initData>`, or undefined outside Telegram. */
  readonly initDataRaw: () => string | undefined;
  /** Telegram client language, used only to pick the UI locale before the API answers. */
  readonly languageCode: () => string | undefined;
  /** Tells Telegram the app has rendered. */
  readonly ready: () => void;
  /** Whether the bot may message the user (initData `allows_write_to_pm`); undefined if unknown. */
  readonly allowsWriteToPm: () => boolean | undefined;
  /** Asks Telegram to let the bot message the user. Resolves true if allowed. */
  readonly requestWriteAccess: () => Promise<boolean>;
  /** Closes the Mini App: the user is back in the chat it was opened from, the bot's. */
  readonly close: () => void;
  /**
   * True when Telegram is drawing the native MainButton, so the in-page copy stays hidden.
   * Outside Telegram this is false and the in-page button is the control.
   */
  readonly nativeButtons: boolean;
  /** Shows Telegram's MainButton, or hides it when `null`. No-op outside Telegram. */
  readonly setMainButton: (state: MainButtonState | null) => void;
  /** Shows Telegram's BackButton bound to `onClick`, or hides it when `null`. */
  readonly setBackButton: (onClick: (() => void) | null) => void;
  /** A short haptic tap. No-op when the client has no haptic feedback. */
  readonly haptic: (kind: HapticKind) => void;
}

/** Reads a field of the `user` object in raw initData, without trusting it for anything else. */
function userField(raw: string | undefined, field: string): unknown {
  if (!raw) return undefined;
  try {
    const user: unknown = JSON.parse(new URLSearchParams(raw).get('user') ?? 'null');
    if (typeof user === 'object' && user !== null && field in user) {
      return (user as Record<string, unknown>)[field];
    }
  } catch {
    // Malformed initData: the server rejects it anyway.
  }
  return undefined;
}

export function allowsWriteToPmFromInitData(raw: string | undefined): boolean | undefined {
  const value = userField(raw, 'allows_write_to_pm');
  return typeof value === 'boolean' ? value : undefined;
}

/** `user.language_code`, used only to preselect the language on first use (Q13). */
export function languageCodeFromInitData(raw: string | undefined): string | undefined {
  const value = userField(raw, 'language_code');
  return typeof value === 'string' ? value : undefined;
}
