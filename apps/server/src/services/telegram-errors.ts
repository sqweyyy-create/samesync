/** What a failed Bot API call means for the message. Works on grammY's errors without importing it. */
export type TelegramFailure =
  /** The user blocked the bot or never started it. */
  | { kind: 'unreachable'; detail: string }
  /** Telegram will never accept this call. */
  | { kind: 'permanent'; detail: string }
  /** Worth another try. */
  | { kind: 'transient'; detail: string }
  | { kind: 'rate_limited'; detail: string; retryAfterSec: number };

export function classifyTelegramError(error: unknown): TelegramFailure {
  const e = error as {
    error_code?: unknown;
    description?: unknown;
    parameters?: { retry_after?: unknown };
  } | null;
  const code = typeof e?.error_code === 'number' ? e.error_code : null;
  // Telegram's descriptions name the problem ("Forbidden: bot was blocked by the user"), not the user.
  const detail =
    code === null
      ? 'network'
      : `${code}: ${typeof e?.description === 'string' ? e.description : ''}`;
  if (code === 403 || (code === 400 && /chat not found/i.test(detail))) {
    return { kind: 'unreachable', detail };
  }
  if (code === 429) {
    const retryAfter = e?.parameters?.retry_after;
    return {
      kind: 'rate_limited',
      detail,
      retryAfterSec: typeof retryAfter === 'number' ? retryAfter : 5,
    };
  }
  if (code !== null && code >= 400 && code < 500 && code !== 401 && code !== 409) {
    return { kind: 'permanent', detail };
  }
  return { kind: 'transient', detail };
}
