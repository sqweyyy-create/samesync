/**
 * Tunable matching numbers (PLAN.md §5). Everything here is provisional unless a decided question
 * says otherwise, and is passed in as data, so a run can be reproduced or tuned without code
 * changes. Safety rules (bands, the u18 two-year gap, dating compatibility) are not parameters.
 */
import type { Popularity } from '@samesync/content';

export interface MatchingParams {
  /** Pseudo-users blended into every observed share, so small pools aren't noisy. */
  alpha: number;
  /** Assumed share of a pool that picks an item of each curator-set popularity. */
  popularityPrior: Readonly<Record<Popularity, number>>;
  /** Factor for shared takes; interests are the more specific signal. */
  beta: number;
  /** Partial credit for the same category (tier 2+) and the same domain (tier 3). */
  lambdaCategory: number;
  lambdaDomain: number;
  /** Waiting bonus: a pair's score is multiplied by 1 + gamma × wait, wait in [0, 1]. */
  gamma: number;
  /** Hours of waiting after which the bonus stops growing. */
  waitCapHours: number;
  /** Tier 1 needs a shared item at least this rare: −ln(0.05), shared by at most 5% of the pool. */
  nicheWeight: number;
  /** Hours unmatched before a user accepts tier 2 and tier 3 matches. */
  tier2AfterHours: number;
  tier3AfterHours: number;
  /** A pair needs this many takes both answered (and at least one disagreement among them). */
  minCommonTakes: number;
  /** Free tier (Q27, decided): new matches per rolling 24 hours, and open matches at once. */
  dailyLimit: number;
  openLimit: number;
  /** Users who haven't opened the Mini App for longer than this are not matched. */
  activeWithinDays: number;
}

export const DEFAULT_MATCHING_PARAMS: MatchingParams = {
  alpha: 50,
  popularityPrior: { mainstream: 0.3, known: 0.08, niche: 0.01 },
  beta: 0.5,
  lambdaCategory: 0.3,
  lambdaDomain: 0.1,
  gamma: 0.5,
  waitCapHours: 168,
  nicheWeight: Math.log(20),
  tier2AfterHours: 24,
  tier3AfterHours: 72,
  minCommonTakes: 5,
  dailyLimit: 3,
  openLimit: 5,
  activeWithinDays: 14,
};

/** Q14 (decided): u18 partners' birth dates are at most this many calendar years apart. */
export const U18_MAX_BIRTH_GAP_YEARS = 2;
