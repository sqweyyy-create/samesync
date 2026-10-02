/** What the app needs from Telegram. The rest of the app depends on this, never on the SDK. */
export interface Platform {
  /** False when opened outside Telegram (and not in dev browser mode). */
  readonly inTelegram: boolean;
  /** Raw initData for `Authorization: tma <initData>`, or undefined outside Telegram. */
  initDataRaw(): string | undefined;
  /** Telegram client language, used only to pick the UI locale before the API answers. */
  languageCode(): string | undefined;
  /** Tells Telegram the app has rendered. */
  ready(): void;
}

/** Reads `user.language_code` from raw initData without trusting it for anything else. */
export function languageCodeFromInitData(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const user: unknown = JSON.parse(new URLSearchParams(raw).get('user') ?? 'null');
    if (typeof user === 'object' && user !== null && 'language_code' in user) {
      return typeof user.language_code === 'string' ? user.language_code : undefined;
    }
  } catch {
    // Malformed initData: fall back to the default locale; the server will reject it anyway.
  }
  return undefined;
}
