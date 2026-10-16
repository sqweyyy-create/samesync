/**
 * Tunable numbers of the chat (PLAN.md Phase 4). Provisional unless a decided question says
 * otherwise, and passed in as data, like the matching and game parameters.
 */
import type { Band } from '@samesync/shared';

export interface ChatParams {
  /** Longest message that is relayed, in characters. */
  maxLength: number;
  /** Messages one user may send per minute, over all their chats (provisional). */
  ratePerMinute: number;
  /** One reminder this long before the chat window closes (Q37, provisional). */
  reminderHoursBefore: number;
  /** The text of a message is removed this long after it was sent (Q20, provisional). */
  retentionDays: number;
  /**
   * Whether both users must still use the language of the match to chat in it. Off: a language
   * change affects future matches only (Q13), so an existing chat goes on (Q36, provisional).
   */
  requireSameLocale: boolean;
}

export const DEFAULT_CHAT_PARAMS: ChatParams = {
  maxLength: 2000,
  ratePerMinute: 20,
  reminderHoursBefore: 12,
  retentionDays: 30,
  requireSameLocale: false,
};

/**
 * The bands whose matches can chat. Every u18 message passes the contact filter before it is
 * relayed (CLAUDE.md invariant 5): the screening hook in relay.ts refuses a u18 message without a
 * filter, and on any error of it, so the band is open only where the filter is plugged in. This
 * is a constant on purpose: it does not follow U18_POOL_ENABLED (while the pool is off, u18 users
 * are waitlisted and can't chat anyway), and the database decides on its own (migration 0014).
 */
export const CHAT_BANDS: readonly Band[] = ['u18', 'adult'];

export const chatOpenIn = (band: Band): boolean => CHAT_BANDS.includes(band);

/** Usernames can be revealed only in the adult band (CLAUDE.md invariant 6). Never changes. */
export const revealAllowedIn = (band: Band): boolean => band === 'adult';
