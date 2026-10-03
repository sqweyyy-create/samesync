import { describe, expect, it } from 'vitest';
import { HOUR, NOW, SCOPE, answers, candidate, planInput } from '../../../test/support/matching';
import { prng } from '../random';
import { planPool, userIneligibility } from './plan';
import type { MatchCandidate, PlanInput } from './types';

/** A varied pool: every user waited long enough for all tiers, with random items and takes. */
function randomPool(size: number, seed: number): MatchCandidate[] {
  const random = prng(seed);
  return Array.from({ length: size }, () =>
    candidate({
      waitingSince: NOW - 100 * HOUR,
      items: SCOPE.items.filter(() => random() < 0.25).map((i) => i.id),
      answers: answers(
        Array.from({ length: 12 }, () => (random() < 0.45 ? 'A' : random() < 0.8 ? 'D' : '-')).join(
          '',
        ),
      ),
    }),
  );
}

describe('greedy assignment', () => {
  it('gives every user at most one match per run', () => {
    const { pairs, eligibleUsers } = planPool(planInput(randomPool(60, 7)));
    const matched = pairs.flatMap((p) => [p.userA, p.userB]);
    expect(pairs.length).toBeGreaterThan(10);
    expect(new Set(matched).size).toBe(matched.length);
    expect(matched.length).toBeLessThanOrEqual(eligibleUsers);
  });

  it('takes the best pair first: nobody is left with a worse partner while a better one is free', () => {
    // a's best partner is b, c's best partner is also b; a–b scores higher, so c gets d.
    const waited = { waitingSince: NOW - 100 * HOUR };
    const a = candidate({ ...waited, items: ['i.music.niche_a', 'i.games.indie_a'] });
    const b = candidate({
      ...waited,
      items: ['i.music.niche_a', 'i.games.indie_a'],
      answers: answers('AAAAAA'),
    });
    const c = candidate({
      ...waited,
      items: ['i.games.indie_a', 'i.books.manga'],
      answers: answers('DDDDDA'),
    });
    const d = candidate({ ...waited, items: ['i.books.manga'], answers: answers('DDDDAD') });
    const { pairs } = planPool(planInput([a, b, c, d]));
    const partner = (id: string) =>
      pairs.map((p) => (p.userA === id ? p.userB : p.userB === id ? p.userA : null)).find(Boolean);
    expect(partner(a.id)).toBe(b.id);
    expect(partner(c.id)).toBe(d.id);
  });

  it('puts the lower user ID first, as the matches table requires', () => {
    for (const pair of planPool(planInput(randomPool(40, 3))).pairs) {
      expect(pair.userA < pair.userB).toBe(true);
    }
  });
});

describe('determinism', () => {
  const users = randomPool(50, 11);

  it('gives the same plan for the same input and seed, whatever order the users arrive in', () => {
    const first = planPool(planInput(users, { seed: 42 }));
    const again = planPool(planInput(users, { seed: 42 }));
    const reversed = planPool(planInput([...users].reverse(), { seed: 42 }));
    expect(again).toEqual(first);
    expect(reversed.pairs).toEqual(first.pairs);
  });

  it('only uses the seed to break ties and to pick aliases', () => {
    // Four interchangeable users: any pairing has the same score, so the seed decides.
    const clones = Array.from({ length: 4 }, (_, i) =>
      candidate({
        waitingSince: NOW - 100 * HOUR,
        items: ['i.music.star'],
        answers: answers(i % 2 ? 'AAAAAA' : 'AAAAAD'),
      }),
    );
    const partnersOfFirst = new Set(
      Array.from({ length: 30 }, (_, seed) => {
        const { pairs } = planPool(planInput(clones, { seed }));
        const mine = pairs.find((p) => p.userA === clones[0]!.id || p.userB === clones[0]!.id)!;
        return mine.userA === clones[0]!.id ? mine.userB : mine.userA;
      }),
    );
    // clones[0] can pair with clones[1] or clones[3] (the two with a disagreement).
    expect(partnersOfFirst).toEqual(new Set([clones[1]!.id, clones[3]!.id]));
  });
});

describe('quotas and user eligibility', () => {
  const pairOf = (over: Partial<MatchCandidate>, inputOver: Partial<PlanInput> = {}) => {
    const subject = candidate({ items: ['i.music.niche_a'], ...over });
    const partner = candidate({ items: ['i.music.niche_a'], answers: answers('AAAAAA') });
    const input = planInput([subject, partner], inputOver);
    return { subject, input, pairs: planPool(input).pairs };
  };

  it('matches two eligible users (the control case)', () => {
    expect(pairOf({}).pairs).toHaveLength(1);
  });

  it.each([
    ['at the daily limit of new matches', { recentMatches: 3 }, 'daily_limit'],
    ['at the open-match limit', { openMatches: 5 }, 'open_limit'],
    ['the bot cannot reach', { botReachable: false }, 'unreachable'],
    ['inactive for more than 14 days', { lastActiveAt: NOW - 15 * 24 * HOUR }, 'inactive'],
    ['frozen', { status: 'frozen' as const }, 'not_active'],
    ['waitlisted', { status: 'waitlisted' as const }, 'not_active'],
    ['in another mode', { mode: 'dating' as const }, 'other_mode'],
    ['in another locale', { locale: 'en' as const }, 'other_pool'],
  ])('skips a user who is %s', (_label, over, reason) => {
    const { subject, input, pairs } = pairOf(over);
    expect(pairs).toEqual([]);
    expect(userIneligibility(subject, input)).toBe(reason);
  });

  it('still matches users just under the limits, and respects configured limits', () => {
    expect(pairOf({ recentMatches: 2, openMatches: 4 }).pairs).toHaveLength(1);
    expect(pairOf({ lastActiveAt: NOW - 13 * 24 * HOUR }).pairs).toHaveLength(1);
    const raised = planInput([], { params: { dailyLimit: 10, openLimit: 10 } }).params;
    expect(pairOf({ recentMatches: 3, openMatches: 5 }, { params: raised }).pairs).toHaveLength(1);
  });

  it('skips synthetic users entirely in production, and counts them out of the statistics', () => {
    const { subject, input } = pairOf({ synthetic: true }, { allowSynthetic: false });
    const result = planPool(input);
    expect(result.pairs).toEqual([]);
    expect(result.poolSize).toBe(1);
    expect(userIneligibility(subject, input)).toBe('synthetic');
    expect(pairOf({ synthetic: true }).pairs).toHaveLength(1);
  });

  it('skips users who already got a match in this run (a resumed run)', () => {
    const { subject, input } = pairOf({});
    expect(planPool({ ...input, alreadyMatched: [subject.id] }).pairs).toEqual([]);
  });

  it('never plans a pair that is excluded (matched before or blocked), in either order', () => {
    const { subject, input, pairs } = pairOf({});
    const partner = pairs[0]!.userA === subject.id ? pairs[0]!.userB : pairs[0]!.userA;
    expect(planPool({ ...input, excludedPairs: [[subject.id, partner]] }).pairs).toEqual([]);
    expect(planPool({ ...input, excludedPairs: [[partner, subject.id]] }).pairs).toEqual([]);
  });

  it('skips dating users with an incomplete dating profile', () => {
    const dating = { mode: 'dating' as const, gender: 'g.man', seeking: ['g.woman'] };
    const subject = candidate({ ...dating, items: ['i.music.niche_a'] });
    const input = planInput([subject], { mode: 'dating' });
    expect(userIneligibility(subject, input)).toBe('incomplete_dating_profile');
    expect(userIneligibility({ ...subject, datingAgeMin: 18, datingAgeMax: 40 }, input)).toBeNull();
  });

  it('refuses to plan a u18 dating run at all', () => {
    expect(() =>
      planPool(planInput([], { pool: { band: 'u18', locale: 'ru' }, mode: 'dating' })),
    ).toThrow(/friends-only/);
  });
});
