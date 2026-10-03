import { describe, expect, it } from 'vitest';
import { HOUR, NOW, SCOPE, answers, candidate, planInput } from '../../../test/support/matching';
import { DEFAULT_MATCHING_PARAMS } from './params';
import { planPool, scorePairIn } from './plan';
import type { MatchCandidate } from './types';

/** Fillers nobody else has, so two users can each carry "something else" of equal weight. */
const filler = (n: number) => `i.memes.filler_${String(n).padStart(2, '0')}`;
/** Waited 100 hours: long enough for every tier, so pairs without a niche item compare too. */
const patient = (over: Partial<MatchCandidate>) =>
  candidate({ waitingSince: NOW - 100 * HOUR, ...over });
/** Same takes as the default candidate except the last one: six in common, one disagreement. */
const SPLIT = answers('AAAAAA');
const { gamma, waitCapHours } = DEFAULT_MATCHING_PARAMS;
/** The waiting bonus of two `patient` users. */
const PATIENT_BONUS = 1 + gamma * (100 / waitCapHours);

const score = (users: MatchCandidate[], a: MatchCandidate, b: MatchCandidate, params = {}) =>
  scorePairIn(planInput(users, { params }), a.id, b.id)!;
const weightsOf = (users: MatchCandidate[], params = {}) => {
  const { stats } = planPool(planInput(users, { params }));
  return (key: string) => stats.find((s) => s.key === key)!.weight;
};

describe('ranking', () => {
  it('a shared niche item beats a shared mainstream one', () => {
    const a = patient({ items: ['i.music.niche_a', filler(1), filler(2)] });
    const b = patient({ items: ['i.music.niche_a', filler(3), filler(4)], answers: SPLIT });
    const c = patient({ items: ['i.music.star', filler(5), filler(6)] });
    const d = patient({ items: ['i.music.star', filler(7), filler(8)], answers: SPLIT });
    const users = [a, b, c, d];
    expect(score(users, a, b).tier).toBe(1);
    expect(score(users, c, d).tier).toBe(2);
    expect(score(users, a, b).score).toBeGreaterThan(score(users, c, d).score);
  });

  it('a shared minority take beats a shared majority take', () => {
    // t12 agree is a 10% view, t11 agree a 90% view; everything else is identical.
    const base = { items: [filler(1)] };
    const a = patient({ ...base, answers: answers('AAAAD------A') });
    const b = patient({ ...base, answers: answers('DDDDA------A') });
    const c = patient({ ...base, answers: answers('AAAAD-----A-') });
    const d = patient({ ...base, answers: answers('DDDDA-----A-') });
    const users = [a, b, c, d];
    const minority = score(users, a, b);
    const majority = score(users, c, d);
    expect(minority.tier).toBe(2);
    expect(minority.score).toBeGreaterThan(majority.score);
  });

  it('a "picked everything" profile does not dominate', () => {
    const mine = ['i.music.niche_a', 'i.games.indie_a', 'i.shows.anime_a'];
    const everything = patient({ items: SCOPE.items.map((i) => i.id), answers: SPLIT });
    const a = patient({ items: mine });
    const twin = patient({ items: mine, answers: SPLIT });
    const users = [everything, a, twin];
    // `everything` shares all three of a's items too, yet the twin is the better match.
    expect(score(users, a, twin).score).toBeGreaterThan(score(users, a, everything).score);
    const [pair] = planPool(planInput(users)).pairs;
    expect([pair?.userA, pair?.userB].sort()).toEqual([a.id, twin.id].sort());
  });
});

describe('normalization and factors', () => {
  it('scores near-identical profiles just under 1 (before the waiting bonus)', () => {
    const mine = ['i.music.niche_a', 'i.games.indie_a'];
    const a = patient({ items: mine });
    // Identical answers would leave no disagreement to end the game on, so one take differs.
    const almost = patient({ items: mine, answers: SPLIT });
    const other = patient({ items: ['i.music.niche_a', 'i.shows.anime_a'], answers: SPLIT });
    const users = [a, almost, other];
    const close = score(users, a, almost).score / PATIENT_BONUS;
    expect(close).toBeGreaterThan(0.8);
    expect(close).toBeLessThan(1);
    expect(score(users, a, other).score / PATIENT_BONUS).toBeLessThan(close);
  });

  it('weights shared takes by β', () => {
    const a = candidate({ items: ['i.music.niche_a', filler(1)] });
    const b = candidate({ items: ['i.music.niche_a', filler(2)], answers: SPLIT });
    const users = [a, b];
    const w = weightsOf(users);
    const item = w('i.music.niche_a');
    const fill = w(filler(1));
    const shared = 5 * w('q.t01:agree');
    const massA = item + fill + 0.5 * (shared + w('q.t06:disagree'));
    const massB = item + fill + 0.5 * (shared + w('q.t06:agree'));
    expect(score(users, a, b).score).toBeCloseTo(
      (item + 0.5 * shared) / Math.sqrt(massA * massB),
      10,
    );
    expect(score(users, a, b, { beta: 0 }).score).toBeCloseTo(item / (item + fill), 10);
  });

  it('gives partial credit λ for a common category (tier 2) and a common domain (tier 3)', () => {
    const a = patient({ items: ['i.games.indie_a'] });
    const sameCategory = patient({ items: ['i.games.indie_b'], answers: SPLIT });
    const sameDomain = patient({ items: ['i.games.shooter'], answers: SPLIT });
    const users = [a, sameCategory, sameDomain];
    const params = { beta: 0 };
    const w = weightsOf(users, params);

    const category = score(users, a, sameCategory, params);
    expect(category.tier).toBe(2);
    expect(category.score).toBeCloseTo(
      ((0.3 * w('c.games.indie')) / Math.sqrt(w('i.games.indie_a') * w('i.games.indie_b'))) *
        PATIENT_BONUS,
      10,
    );
    const domain = score(users, a, sameDomain, params);
    expect(domain.tier).toBe(3);
    expect(domain.score).toBeCloseTo(
      ((0.1 * w('domain.games')) / Math.sqrt(w('i.games.indie_a') * w('i.games.shooter'))) *
        PATIENT_BONUS,
      10,
    );
    expect(score(users, a, sameCategory, { beta: 0, lambdaCategory: 0.6 }).score).toBeCloseTo(
      category.score * 2,
      10,
    );
    expect(score(users, a, sameDomain, { beta: 0, lambdaDomain: 0.05 }).score).toBeCloseTo(
      domain.score / 2,
      10,
    );
  });

  it('does not add category credit on top of a shared item in that category', () => {
    const a = patient({ items: ['i.games.indie_a', 'i.games.indie_b'] });
    const b = patient({ items: ['i.games.indie_a'], answers: SPLIT });
    const users = [a, b];
    const params = { beta: 0, gamma: 0 };
    const w = weightsOf(users, params);
    const { tier, score: value } = score(users, a, b, params);
    expect(tier).toBe(2);
    expect(value).toBeCloseTo(
      w('i.games.indie_a') /
        Math.sqrt((w('i.games.indie_a') + w('i.games.indie_b')) * w('i.games.indie_a')),
      10,
    );
  });

  it('multiplies by the waiting bonus 1 + γ·wait, capped', () => {
    const profile = { items: ['i.music.niche_a', filler(1)] };
    const pair = (hoursA: number, hoursB: number) => {
      const a = candidate({ ...profile, waitingSince: NOW - hoursA * HOUR });
      const b = candidate({ ...profile, answers: SPLIT, waitingSince: NOW - hoursB * HOUR });
      return score([a, b], a, b).score;
    };
    const fresh = pair(0, 0);
    expect(pair(168, 168)).toBeCloseTo(fresh * 1.5, 10);
    expect(pair(1000, 1000)).toBeCloseTo(fresh * 1.5, 10);
    expect(pair(84, 84)).toBeCloseTo(fresh * 1.25, 10);
    expect(pair(168, 0)).toBeCloseTo(fresh * 1.25, 10);
  });
});

describe('hard filters on takes', () => {
  const items = ['i.music.star'];

  it('ignores skipped takes: they are neither common nor shared', () => {
    const a = patient({ items, answers: answers('AAAAD-') });
    const fiveCommon = patient({ items, answers: answers('AAAAAA') });
    const fourCommon = patient({ items, answers: answers('AAAA-A') });
    const users = [a, fiveCommon, fourCommon];
    expect(score(users, a, fiveCommon).tier).toBe(2);
    expect(score(users, a, fourCommon).tier).toBe(0);
  });

  it('needs at least one disagreement among the common takes', () => {
    const a = patient({ items, answers: answers('AAAAAA') });
    const b = patient({ items, answers: answers('AAAAAA') });
    const c = patient({ items, answers: answers('AAAAAD') });
    const users = [a, b, c];
    expect(score(users, a, b).tier).toBe(0);
    expect(score(users, a, c).tier).toBe(2);
  });

  it('needs five common takes (a config value)', () => {
    const a = patient({ items, answers: answers('AAAD') });
    const b = patient({ items, answers: answers('AAAA') });
    expect(score([a, b], a, b).tier).toBe(0);
    expect(score([a, b], a, b, { minCommonTakes: 4 }).tier).toBe(2);
  });
});
