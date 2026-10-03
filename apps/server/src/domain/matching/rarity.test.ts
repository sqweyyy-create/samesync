import { describe, expect, it } from 'vitest';
import { answers, bornYearsAgo, candidate, planInput } from '../../../test/support/matching';
import { DEFAULT_MATCHING_PARAMS } from './params';
import { planPool } from './plan';
import { anyOfPrior, rarityWeight, smoothedShare } from './rarity';

const { alpha, popularityPrior } = DEFAULT_MATCHING_PARAMS;

describe('smoothedShare', () => {
  it('blends the observed share with the prior: (n + α·prior) / (N + α)', () => {
    expect(smoothedShare(10, 150, 0.08, 50)).toBeCloseTo((10 + 4) / 200, 12);
    expect(smoothedShare(0, 0, 0.3, 50)).toBeCloseTo(0.3, 12);
  });

  it('follows the prior in a small pool and the data in a large one', () => {
    // Nobody among 10 users picked a "known" item: still close to the 8% prior.
    expect(smoothedShare(0, 10, 0.08, alpha)).toBeCloseTo(0.0667, 3);
    // 4,000 of 10,000 picked it: the 8% prior hardly matters any more.
    expect(smoothedShare(4000, 10_000, 0.08, alpha)).toBeCloseTo(0.3984, 3);
  });
});

describe('rarityWeight', () => {
  it('is −ln(share): rarer weighs more', () => {
    expect(rarityWeight(0.01)).toBeCloseTo(4.605, 3);
    expect(rarityWeight(0.5)).toBeCloseTo(0.693, 3);
    expect(rarityWeight(0.9)).toBeCloseTo(0.105, 3);
  });

  it('is never negative, even for a share of 1', () => {
    expect(rarityWeight(1)).toBe(0);
  });

  it('orders the curator priors niche > known > mainstream before any data exists', () => {
    const weight = (popularity: keyof typeof popularityPrior) =>
      rarityWeight(smoothedShare(0, 0, popularityPrior[popularity], alpha));
    expect(weight('niche')).toBeGreaterThan(weight('known'));
    expect(weight('known')).toBeGreaterThan(weight('mainstream'));
  });
});

describe('anyOfPrior', () => {
  it('is the chance of having at least one of the items, capped below 1', () => {
    expect(anyOfPrior([0.08])).toBeCloseTo(0.08, 12);
    expect(anyOfPrior([0.3, 0.3])).toBeCloseTo(0.51, 12);
    expect(anyOfPrior(Array.from({ length: 60 }, () => 0.3))).toBe(0.95);
  });
});

describe('pool statistics from planPool', () => {
  const stat = (result: ReturnType<typeof planPool>, key: string) =>
    result.stats.find((s) => s.key === key);

  it('counts every member of the pool once, in both modes', () => {
    const users = [
      candidate({ items: ['i.music.star', 'i.music.niche_a'] }),
      candidate({ items: ['i.music.star'] }),
      candidate({
        items: ['i.music.star'],
        mode: 'dating',
        gender: 'g.man',
        seeking: ['g.woman'],
        datingAgeMin: 18,
        datingAgeMax: 99,
      }),
    ];
    const result = planPool(planInput(users));
    expect(result.poolSize).toBe(3);
    expect(stat(result, 'i.music.star')).toMatchObject({ n: 3, total: 3 });
    expect(stat(result, 'i.music.niche_a')).toMatchObject({ n: 1, total: 3 });
    expect(stat(result, 'c.music.pop')).toMatchObject({ n: 3 });
    expect(stat(result, 'domain.music')).toMatchObject({ n: 3 });
    expect(stat(result, 'domain.games')).toMatchObject({ n: 0 });
  });

  it('never counts users of another band, locale or status', () => {
    const users = [
      candidate({ items: ['i.music.niche_a'] }),
      candidate({ items: ['i.music.niche_a'], birthDate: bornYearsAgo(16) }),
      candidate({ items: ['i.music.niche_a'], locale: 'en' }),
      candidate({ items: ['i.music.niche_a'], status: 'frozen' }),
      candidate({ items: ['i.music.niche_a'], status: 'waitlisted' }),
    ];
    const result = planPool(planInput(users));
    expect(result.poolSize).toBe(1);
    expect(stat(result, 'i.music.niche_a')).toMatchObject({ n: 1, total: 1 });
  });

  it('measures a take among the people who answered it, with skips left out', () => {
    const users = [
      candidate({ answers: answers('AD') }),
      candidate({ answers: answers('A-') }),
      candidate({ answers: answers('D-') }),
      candidate({ answers: answers('--') }),
    ];
    const result = planPool(planInput(users));
    expect(stat(result, 'q.t01:agree')).toMatchObject({ n: 2, total: 3 });
    expect(stat(result, 'q.t01:disagree')).toMatchObject({ n: 1, total: 3 });
    expect(stat(result, 'q.t02:disagree')).toMatchObject({ n: 1, total: 1 });
    expect(stat(result, 'q.t02:disagree')?.weight).toBeCloseTo(
      rarityWeight(smoothedShare(1, 1, 0.5, alpha)),
      12,
    );
  });

  it('gives the minority side of a take the higher weight', () => {
    const result = planPool(planInput([candidate()]));
    // t11: 90% expected to agree; t12: 10%.
    expect(stat(result, 'q.t11:disagree')!.weight).toBeGreaterThan(
      stat(result, 'q.t11:agree')!.weight,
    );
    expect(stat(result, 'q.t12:agree')!.weight).toBeGreaterThan(
      stat(result, 'q.t12:disagree')!.weight,
    );
  });

  it('ignores items and takes outside the pool scope', () => {
    const users = [
      candidate({
        items: ['i.music.star', 'i.music.not_in_scope'],
        answers: [...answers('AAAAAD'), ['q.other_mode_only', 'agree']],
      }),
    ];
    const result = planPool(planInput(users));
    expect(result.stats.some((s) => s.key.includes('not_in_scope'))).toBe(false);
    expect(result.stats.some((s) => s.key.includes('other_mode_only'))).toBe(false);
  });
});
