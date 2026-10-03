/**
 * Rarity statistics (PLAN.md §5): a feature shared by few people in the pool weighs more than one
 * nearly everybody has. Pure functions; the statistics only ever see one pool's own users.
 */
import type { Stance } from './types';

/**
 * The share of people who have a feature, blended with a prior worth `alpha` pseudo-users, so a
 * pool of 20 doesn't call an item "rare" just because nobody picked it yet.
 */
export function smoothedShare(n: number, total: number, prior: number, alpha: number): number {
  return (n + alpha * prior) / (total + alpha);
}

/** −ln(share): shared by 1% ≈ 4.6, by 50% ≈ 0.7, by 90% ≈ 0.1. Never negative. */
export function rarityWeight(share: number): number {
  return Math.max(0, -Math.log(share));
}

/**
 * Prior share of users who have at least one of several items (a category or a domain), assuming
 * the picks are independent. Capped below 1 so the weight stays positive.
 */
export function anyOfPrior(itemPriors: readonly number[]): number {
  let none = 1;
  for (const prior of itemPriors) none *= 1 - prior;
  return Math.min(0.95, 1 - none);
}

/** Stable keys for `feature_stats`. Content IDs are unique across kinds, so they are used as is. */
export const featureKey = {
  item: (itemId: string) => itemId,
  category: (categoryId: string) => categoryId,
  domain: (domain: string) => `domain.${domain}`,
  take: (questionId: string, stance: Stance) => `${questionId}:${stance}`,
};
