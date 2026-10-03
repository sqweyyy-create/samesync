/** The fallback ladder (PLAN.md §5): how broad a match a user accepts grows with their waiting time. */
import type { MatchingParams } from './params';
import type { Tier } from './types';

const HOUR = 3_600_000;

const hoursWaiting = (waitingSince: number, now: number) => Math.max(0, now - waitingSince) / HOUR;

/** The broadest tier a user accepts right now. Everyone starts at tier 1. */
export function relaxedTier(
  waitingSince: number,
  now: number,
  params: Pick<MatchingParams, 'tier2AfterHours' | 'tier3AfterHours'>,
): Tier {
  const hours = hoursWaiting(waitingSince, now);
  if (hours >= params.tier3AfterHours) return 3;
  if (hours >= params.tier2AfterHours) return 2;
  return 1;
}

/** Waiting time as a number in [0, 1] for the waiting bonus; capped so nobody waits "infinitely". */
export function waitShare(
  waitingSince: number,
  now: number,
  params: Pick<MatchingParams, 'waitCapHours'>,
): number {
  return Math.min(1, hoursWaiting(waitingSince, now) / params.waitCapHours);
}
