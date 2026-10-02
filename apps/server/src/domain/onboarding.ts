/** Pure onboarding rules (no I/O, no clock). */
import type { Band, Mode } from '@samesync/shared';
import { ONBOARDING, type OnboardingStep, type UserStatus } from '@samesync/shared/api';

export interface OnboardingState {
  status: UserStatus;
  localeConfirmed: boolean;
  birthDate: string | null;
  /** Live band from the birth date (null below 14). */
  band: Band | null;
  mode: Mode | null;
  /** Non-skip answers to takes in the user's current deck scope. */
  answered: number;
  /** Picked items in the user's current catalog scope. */
  interests: number;
  onboarded: boolean;
}

/** The screen a user has to see next. Order: language, birth date, mode, deck, interests, finish. */
export function nextStep(s: OnboardingState): OnboardingStep {
  if (!s.localeConfirmed) return 'locale';
  if (!s.birthDate) return 'birth_date';
  if (s.status === 'ineligible' || s.band === null) return 'ineligible';
  if (!s.mode) return 'mode';
  if (s.onboarded) return 'done';
  if (s.answered < ONBOARDING.minAnswers) return 'answers';
  if (s.interests < ONBOARDING.minInterests) return 'interests';
  return 'finish';
}

/** FNV-1a: a small, stable string hash for seeding. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a deterministic PRNG, good enough for shuffling a deck. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Draws `size` takes from `candidateIds` (Q5: 35 per band × mode). The draw is deterministic per
 * `seed` (the user ID), so a user who reopens the app sees the same deck in the same order.
 */
export function drawDeck(candidateIds: readonly string[], seed: string, size: number): string[] {
  const deck = [...candidateIds].sort();
  const random = prng(hash(seed));
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck.slice(0, size);
}

/** IANA time zone names only (validated with Intl), so quiet hours can use it later (Q22). */
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone });
    return /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+)*$/.test(timezone);
  } catch {
    return false;
  }
}
