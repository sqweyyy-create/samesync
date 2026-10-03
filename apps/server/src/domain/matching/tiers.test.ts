import { describe, expect, it } from 'vitest';
import {
  HOUR,
  NOW,
  answers,
  bornYearsAgo,
  candidate,
  planInput,
} from '../../../test/support/matching';
import { DEFAULT_MATCHING_PARAMS } from './params';
import { planPool, scorePairIn } from './plan';
import { relaxedTier, waitShare } from './tiers';
import type { MatchCandidate } from './types';

const waited = (hours: number, over: Partial<MatchCandidate>) =>
  candidate({ waitingSince: NOW - hours * HOUR, ...over });
const tierOf = (users: MatchCandidate[]) =>
  scorePairIn(planInput(users), users[0]!.id, users[1]!.id)!.tier;

describe('relaxedTier', () => {
  it.each([
    [0, 1],
    [23.9, 1],
    [24, 2],
    [71.9, 2],
    [72, 3],
    [500, 3],
  ])('after %f hours unmatched a user accepts tier %i', (hours, tier) => {
    expect(relaxedTier(NOW - hours * HOUR, NOW, DEFAULT_MATCHING_PARAMS)).toBe(tier);
  });

  it('treats a waitingSince in the future as not waiting', () => {
    expect(relaxedTier(NOW + HOUR, NOW, DEFAULT_MATCHING_PARAMS)).toBe(1);
    expect(waitShare(NOW + HOUR, NOW, DEFAULT_MATCHING_PARAMS)).toBe(0);
  });
});

describe('a pair forms only at a tier both users have relaxed to', () => {
  // Same category, different items: a tier 2 overlap.
  const related = (hoursA: number, hoursB: number) => [
    waited(hoursA, { items: ['i.games.indie_a'] }),
    waited(hoursB, { items: ['i.games.indie_b'], answers: answers('AAAAAA') }),
  ];
  // Same domain only: a tier 3 overlap.
  const broad = (hoursA: number, hoursB: number) => [
    waited(hoursA, { items: ['i.games.indie_a'] }),
    waited(hoursB, { items: ['i.games.shooter'], answers: answers('AAAAAA') }),
  ];
  // Nothing in common but takes: allowed at tier 3 only.
  const takesOnly = (hoursA: number, hoursB: number) => [
    waited(hoursA, { items: ['i.games.indie_a'] }),
    waited(hoursB, { items: ['i.music.star'], answers: answers('AAAAAA') }),
  ];

  it('tier 2 (same category) needs both users unmatched for 24 hours', () => {
    expect(tierOf(related(0, 0))).toBe(0);
    expect(tierOf(related(30, 1))).toBe(0);
    expect(tierOf(related(24, 24))).toBe(2);
    expect(tierOf(related(100, 30))).toBe(2);
  });

  it('tier 3 (same domain, or takes only) needs both unmatched for 72 hours', () => {
    expect(tierOf(broad(30, 30))).toBe(0);
    expect(tierOf(broad(100, 30))).toBe(0);
    expect(tierOf(broad(72, 72))).toBe(3);
    expect(tierOf(takesOnly(71, 100))).toBe(0);
    expect(tierOf(takesOnly(100, 100))).toBe(3);
  });

  it('a shared mainstream item is not "niche": it only counts from tier 2', () => {
    const pair = (hours: number) => [
      waited(hours, { items: ['i.music.star'] }),
      waited(hours, { items: ['i.music.star'], answers: answers('AAAAAA') }),
    ];
    expect(tierOf(pair(0))).toBe(0);
    expect(tierOf(pair(24))).toBe(2);
  });

  it('a shared niche item matches at tier 1 straight away, however long anyone waited', () => {
    const pair = (hoursA: number, hoursB: number) => [
      waited(hoursA, { items: ['i.music.niche_a'] }),
      waited(hoursB, { items: ['i.music.niche_a'], answers: answers('AAAAAA') }),
    ];
    expect(tierOf(pair(0, 0))).toBe(1);
    expect(tierOf(pair(0, 500))).toBe(1);
  });
});

describe('fallback in a run', () => {
  it('gives a user with no tier 1 partner a broader match once they have waited', () => {
    const lonely = (hours: number) => waited(hours, { items: ['i.games.indie_a'] });
    const neighbour = (hours: number) =>
      waited(hours, { items: ['i.games.indie_b'], answers: answers('AAAAAA') });
    expect(planPool(planInput([lonely(0), neighbour(0)])).pairs).toEqual([]);
    const { pairs, tierCounts } = planPool(planInput([lonely(30), neighbour(30)]));
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.tier).toBe(2);
    expect(tierCounts).toEqual({ 1: 0, 2: 1, 3: 0 });
  });

  it('prefers a tier 1 partner over a broader one, even one with a higher score', () => {
    // a–niche share one rare item among many; a–twin share a whole category profile (tier 2).
    const a = waited(200, {
      items: ['i.music.niche_a', 'i.games.indie_a', 'i.shows.anime_a', 'i.books.manga'],
    });
    const niche = waited(200, {
      items: ['i.music.niche_a', 'i.memes.filler_01', 'i.memes.filler_02', 'i.memes.filler_03'],
      answers: answers('DDDDDD'),
    });
    const twin = waited(200, {
      items: ['i.games.indie_a', 'i.shows.anime_a', 'i.books.manga'],
      answers: answers('AAAAAA'),
    });
    const users = [a, niche, twin];
    const input = planInput(users);
    expect(scorePairIn(input, a.id, twin.id)!.score).toBeGreaterThan(
      scorePairIn(input, a.id, niche.id)!.score,
    );
    const { pairs } = planPool(input);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ tier: 1 });
    expect([pairs[0]?.userA, pairs[0]?.userB].sort()).toEqual([a.id, niche.id].sort());
  });

  it('never relaxes the hard filters, at any tier', () => {
    const long = 500;
    // u18, more than two years apart, with identical tastes and a long wait.
    const older = waited(long, { birthDate: bornYearsAgo(17), items: ['i.games.indie_a'] });
    const younger = waited(long, {
      birthDate: bornYearsAgo(14),
      items: ['i.games.indie_a'],
      answers: answers('AAAAAA'),
    });
    const u18 = planInput([older, younger], { pool: { band: 'u18', locale: 'ru' } });
    expect(planPool(u18).pairs).toEqual([]);
    expect(scorePairIn(u18, older.id, younger.id)?.tier).toBe(0);

    // Dating: he is not looking for men, however long both waited.
    const dating = { mode: 'dating' as const, datingAgeMin: 18, datingAgeMax: 99 };
    const man = waited(long, {
      ...dating,
      gender: 'g.man',
      seeking: ['g.woman'],
      items: ['i.music.star'],
    });
    const otherMan = waited(long, {
      ...dating,
      gender: 'g.man',
      seeking: ['g.man'],
      items: ['i.music.star'],
      answers: answers('AAAAAA'),
    });
    expect(planPool(planInput([man, otherMan], { mode: 'dating' })).pairs).toEqual([]);
  });
});
