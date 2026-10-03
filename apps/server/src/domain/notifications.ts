/**
 * Rules for sending a queued bot message (pure). The outbox sender applies them immediately before
 * every Telegram call (CLAUDE.md invariant 3): a message queued while everything was fine must not
 * go out after a match closed, a user was frozen or a band changed.
 */
import { OPEN_MATCH_STATUSES, type Band, type Locale, type MatchStatus } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';

/** Everything the sender re-checks, read in one query right before sending. */
export interface SendContext {
  recipient: {
    telegramId: number;
    locale: Locale;
    status: UserStatus;
    botReachable: boolean;
    synthetic: boolean;
    timezone: string | null;
    /** From `birth_date` right now, not the cached column. */
    liveBand: Band | null;
  } | null;
  match: {
    id: string;
    status: MatchStatus;
    band: Band;
    teaser: unknown;
    /** The alias the recipient sees for the other user; null if the recipient isn't in the match. */
    counterpartAlias: string | null;
    counterpartStatus: UserStatus | null;
    counterpartLiveBand: Band | null;
  } | null;
}

/** Why a message is dropped instead of sent. Stored in `outbox.cancel_reason`. */
export type DropReason =
  | 'recipient_missing'
  | 'synthetic_user'
  | 'recipient_frozen'
  | 'recipient_not_active'
  | 'bot_unreachable'
  | 'match_missing'
  | 'not_participant'
  | 'match_closed'
  | 'band_mismatch'
  | 'counterpart_not_active';

/** Null means "send". Anything unknown or missing is a drop: fail closed (invariant 10). */
export function dropReason(context: SendContext): DropReason | null {
  const { recipient, match } = context;
  if (!recipient) return 'recipient_missing';
  // Dev tooling users have no Telegram account behind them.
  if (recipient.synthetic) return 'synthetic_user';
  if (recipient.status === 'frozen') return 'recipient_frozen';
  if (recipient.status !== 'active') return 'recipient_not_active';
  if (!recipient.botReachable) return 'bot_unreachable';
  if (!match) return 'match_missing';
  if (match.counterpartAlias === null) return 'not_participant';
  if (!(OPEN_MATCH_STATUSES as readonly string[]).includes(match.status)) return 'match_closed';
  // Both live bands must equal the match band, even if the age-transition job hasn't run yet.
  if (recipient.liveBand !== match.band || match.counterpartLiveBand !== match.band)
    return 'band_mismatch';
  if (match.counterpartStatus !== 'active') return 'counterpart_not_active';
  return null;
}

/** Q22 (decided): between 23:00 and 08:00 local time messages are sent silently, never held. */
export const QUIET_HOURS = { from: 23, to: 8 } as const;

/** The hour (0–23) in an IANA time zone, or null for a zone Intl doesn't know. */
export function localHour(now: Date, timeZone: string): number | null {
  try {
    const hour = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour: 'numeric',
      hourCycle: 'h23',
    }).format(now);
    return Number(hour);
  } catch {
    return null;
  }
}

/** Whether a message sent now should be silent for a user in `timeZone` (else `fallbackZone`). */
export function isQuietHour(now: Date, timeZone: string | null, fallbackZone: string): boolean {
  const hour = (timeZone ? localHour(now, timeZone) : null) ?? localHour(now, fallbackZone);
  if (hour === null) return false;
  return hour >= QUIET_HOURS.from || hour < QUIET_HOURS.to;
}

/** A temporary delivery failure is retried this many times in total, further apart each time. */
export const MAX_SEND_ATTEMPTS = 6;

/** Exponential backoff: 30 s, 1 min, 2 min, … capped at 1 hour. `attempts` counts from 1. */
export function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);
}
