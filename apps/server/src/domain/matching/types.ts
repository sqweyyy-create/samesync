import type { Domain, Popularity } from '@samesync/content';
import type { Band, Locale, Mode } from '@samesync/shared';
import type { UserStatus } from '@samesync/shared/api';
import type { MatchingParams } from './params';

/** Band × locale. Matching and rarity statistics never cross a pool. */
export interface PoolKey {
  band: Band;
  locale: Locale;
}

/** The catalog and question bank of one pool × mode, taken from the content files. */
export interface PoolScope {
  /** Items a user of this pool may pick. */
  items: ReadonlyArray<{ id: string; categoryId: string; domain: Domain; popularity: Popularity }>;
  /** Takes in this pool × mode deck. */
  takes: ReadonlyArray<{ id: string; priorAgree: number }>;
  /** Alias IDs to draw the two anonymous names of a match from. */
  aliases: readonly string[];
}

export type Stance = 'agree' | 'disagree';

/** One user as loaded for a run. Plain data, so it can cross to a worker thread. */
export interface MatchCandidate {
  id: string;
  birthDate: string;
  locale: Locale;
  mode: Mode | null;
  status: UserStatus;
  botReachable: boolean;
  synthetic: boolean;
  /** Epoch milliseconds. */
  lastActiveAt: number;
  /** Epoch milliseconds: the later of onboarding and the user's last match. */
  waitingSince: number;
  gender: string | null;
  seeking: readonly string[] | null;
  datingAgeMin: number | null;
  datingAgeMax: number | null;
  /** Matches created in the last 24 hours, and matches that are open right now. */
  recentMatches: number;
  openMatches: number;
  /** Aliases of the people this user already sees in open matches. */
  aliasesInUse: readonly string[];
  items: readonly string[];
  /** Non-skip answers. */
  answers: ReadonlyArray<readonly [questionId: string, stance: Stance]>;
}

export interface PlanInput {
  pool: PoolKey;
  mode: Mode;
  /** Today's UTC date (`YYYY-MM-DD`); live ages and bands are derived from it. */
  today: string;
  /** Epoch milliseconds. */
  now: number;
  seed: number;
  users: readonly MatchCandidate[];
  scope: PoolScope;
  /** Pairs that must never be matched: matched before (Q9) or blocked. Order doesn't matter. */
  excludedPairs: ReadonlyArray<readonly [string, string]>;
  /** Users who already got their match in this run (a resumed run). */
  alreadyMatched: readonly string[];
  params: MatchingParams;
  /** False in production: synthetic users are then ignored completely. */
  allowSynthetic: boolean;
}

/** What two matched users share. Content IDs only; text is rendered per reader (PLAN.md §5). */
export interface Teaser {
  interest: { kind: 'item' | 'category' | 'domain'; id: string } | null;
  take: { id: string; value: Stance } | null;
}

export type Tier = 1 | 2 | 3;

export interface PlannedPair {
  /** `userA` is the lower ID, as the `matches` table requires. */
  userA: string;
  userB: string;
  tier: Tier;
  score: number;
  teaser: Teaser;
  /** How A (B) appears to the other user. */
  aliasA: string;
  aliasB: string;
}

export interface FeatureStat {
  key: string;
  /** Users who have the feature. */
  n: number;
  /** The denominator: the pool for interests, the people who answered for a take. */
  total: number;
  weight: number;
}

export interface PlanResult {
  pairs: PlannedPair[];
  stats: FeatureStat[];
  /** Users the statistics were computed over, and users who could be matched in this run. */
  poolSize: number;
  eligibleUsers: number;
  tierCounts: Record<Tier, number>;
}

/** Why a user is not matched in a run; null means eligible. */
export type Ineligibility =
  | 'not_active'
  | 'other_pool'
  | 'other_mode'
  | 'synthetic'
  | 'unreachable'
  | 'inactive'
  | 'daily_limit'
  | 'open_limit'
  | 'already_matched'
  | 'incomplete_dating_profile'
  | 'empty_profile';
