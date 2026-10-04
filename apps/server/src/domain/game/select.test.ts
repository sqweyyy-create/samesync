import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Stance } from '../matching/types';
import { playOrder, selectGame, type CommonTake } from './select';

const COUNT = 5;
const stance = fc.constantFrom<Stance>('agree', 'disagree');
const take = (n: number, a: Stance, b: Stance, agreeShare = 0.5): CommonTake => ({
  questionId: `q.t${String(n).padStart(2, '0')}`,
  a,
  b,
  agreeShare,
});

/** What matching guarantees for every pair: at least five takes in common, one of them a split. */
const eligibleTakes = fc
  .uniqueArray(
    fc.record({
      n: fc.integer({ min: 0, max: 99 }),
      a: stance,
      b: stance,
      // Coarse steps, so equally balanced takes (ties) are common.
      agreeShare: fc.integer({ min: 1, max: 19 }).map((step) => step / 20),
    }),
    { minLength: COUNT, maxLength: 40, selector: (t) => t.n },
  )
  .map((list) => list.map((t) => take(t.n, t.a, t.b, t.agreeShare)))
  .filter((list) => list.some((t) => t.a !== t.b));
const seed = fc.integer({ min: 0, max: 2 ** 31 - 1 });

const imbalance = (t: CommonTake) => Math.abs(t.agreeShare - 0.5);
const sharedShare = (t: CommonTake) => (t.a === 'agree' ? t.agreeShare : 1 - t.agreeShare);

describe('selectGame', () => {
  it('always ends on a split, uses only takes both answered, and has exactly the configured size', () => {
    fc.assert(
      fc.property(eligibleTakes, seed, (takes, s) => {
        const game = selectGame(takes, COUNT, s);
        if (!game) throw new Error('an eligible pair must get a game');
        const byId = new Map(takes.map((t) => [t.questionId, t]));

        expect(game.questionIds).toHaveLength(COUNT);
        expect(new Set(game.questionIds).size).toBe(COUNT);
        // Every question was answered by both, and the stored answers are theirs.
        game.questionIds.forEach((id, i) => {
          const source = byId.get(id);
          expect(source).toBeDefined();
          expect([game.answersA[i], game.answersB[i]]).toEqual([source?.a, source?.b]);
        });
        // The closing question is last, and the two split on it.
        expect(game.questionIds.at(-1)).toBe(game.closingQuestionId);
        expect(game.answersA.at(-1)).not.toBe(game.answersB.at(-1));
      }),
      { numRuns: 500 },
    );
  });

  it('closes on the most balanced split of the pool', () => {
    fc.assert(
      fc.property(eligibleTakes, seed, (takes, s) => {
        const game = selectGame(takes, COUNT, s);
        const closing = takes.find((t) => t.questionId === game?.closingQuestionId);
        if (!closing) throw new Error('the closing question must be one of the takes');
        for (const other of takes.filter((t) => t.a !== t.b)) {
          expect(imbalance(closing)).toBeLessThanOrEqual(imbalance(other));
        }
      }),
      { numRuns: 500 },
    );
  });

  it('fills the rest with the rarest shared views and at most one more disagreement', () => {
    fc.assert(
      fc.property(eligibleTakes, seed, (takes, s) => {
        const game = selectGame(takes, COUNT, s);
        if (!game) throw new Error('an eligible pair must get a game');
        const byId = new Map(takes.map((t) => [t.questionId, t]));
        const others = game.questionIds.slice(0, -1).map((id) => byId.get(id)!);
        const pickedSplits = others.filter((t) => t.a !== t.b);
        const pickedAgreements = others.filter((t) => t.a === t.b);
        const allAgreements = takes.filter((t) => t.a === t.b);
        const otherSplits = takes.filter((t) => t.a !== t.b).length - 1;

        if (allAgreements.length >= COUNT - 2) {
          // Enough shared views: exactly one more disagreement when there is one, else none.
          expect(pickedSplits).toHaveLength(Math.min(1, otherSplits));
        } else {
          // Too few shared views: all of them are used, and disagreements fill the gap.
          expect(pickedAgreements).toHaveLength(allAgreements.length);
        }
        // No shared view that was left out is rarer than one that was picked.
        const picked = new Set(pickedAgreements.map((t) => t.questionId));
        const leftOut = allAgreements.filter((t) => !picked.has(t.questionId));
        for (const chosen of pickedAgreements) {
          for (const skipped of leftOut) {
            expect(sharedShare(chosen)).toBeLessThanOrEqual(sharedShare(skipped));
          }
        }
        // The extra disagreement is the next most balanced one.
        const [extra] = pickedSplits;
        if (extra && pickedSplits.length === 1) {
          const rest = takes.filter(
            (t) => t.a !== t.b && t.questionId !== game.closingQuestionId && t !== extra,
          );
          for (const other of rest) expect(imbalance(extra)).toBeLessThanOrEqual(imbalance(other));
        }
      }),
      { numRuns: 500 },
    );
  });

  it('is deterministic for a seed, whatever order the takes come in', () => {
    fc.assert(
      fc.property(eligibleTakes, seed, seed, (takes, s, shuffleSeed) => {
        const reordered = fc.sample(fc.shuffledSubarray(takes, { minLength: takes.length }), {
          seed: shuffleSeed,
          numRuns: 1,
        })[0]!;
        expect(selectGame(reordered, COUNT, s)).toEqual(selectGame(takes, COUNT, s));
        expect(selectGame(takes, COUNT, s)).toEqual(selectGame(takes, COUNT, s));
      }),
      { numRuns: 200 },
    );
  });

  it('uses the seed only to break ties and to order the questions', () => {
    // Two equally balanced splits and many equally rare shared views: seeds may pick differently.
    const takes = [
      take(1, 'agree', 'disagree'),
      take(2, 'disagree', 'agree'),
      ...Array.from({ length: 10 }, (_, i) => take(10 + i, 'agree', 'agree')),
    ];
    const games = Array.from({ length: 40 }, (_, s) => selectGame(takes, COUNT, s)!);
    expect(new Set(games.map((g) => g.closingQuestionId))).toEqual(new Set(['q.t01', 'q.t02']));
    expect(new Set(games.map((g) => g.questionIds.join())).size).toBeGreaterThan(10);
    // A clearly more balanced split wins for every seed.
    const clear = [
      take(1, 'agree', 'disagree', 0.9),
      take(2, 'disagree', 'agree', 0.55),
      ...takes.slice(2),
    ];
    for (let s = 0; s < 40; s++)
      expect(selectGame(clear, COUNT, s)?.closingQuestionId).toBe('q.t02');
  });

  it('prefers rare shared views: a minority view both hold beats a majority one', () => {
    const takes = [
      take(1, 'agree', 'disagree'),
      take(2, 'agree', 'agree', 0.1), // both agree with what 10% think
      take(3, 'disagree', 'disagree', 0.9), // both disagree with what 90% think
      take(4, 'agree', 'agree', 0.2),
      take(5, 'disagree', 'disagree', 0.7),
      take(6, 'agree', 'agree', 0.9),
      take(7, 'disagree', 'disagree', 0.2),
      take(8, 'agree', 'agree', 0.6),
    ];
    const game = selectGame(takes, COUNT, 7)!;
    expect(new Set(game.questionIds.slice(0, -1))).toEqual(
      new Set(['q.t02', 'q.t03', 'q.t04', 'q.t05']),
    );
    expect(game.closingQuestionId).toBe('q.t01');
  });

  it('leaves out a take the players already know the answer to, unless nothing else is left', () => {
    // t02 is the rarest shared view: without the hint it is always picked.
    const takes = [
      take(1, 'agree', 'disagree'),
      take(2, 'agree', 'agree', 0.05),
      ...Array.from({ length: 5 }, (_, i) => take(10 + i, 'agree', 'agree', 0.5)),
    ];
    for (let s = 0; s < 30; s++) {
      expect(selectGame(takes, COUNT, s)?.questionIds).toContain('q.t02');
      expect(selectGame(takes, COUNT, s, new Set(['q.t02']))?.questionIds).not.toContain('q.t02');
    }
    // With exactly five takes in common there is no choice: the known one is asked too.
    const tight = takes.slice(0, 5);
    const game = selectGame(tight, COUNT, 1, new Set(['q.t02']));
    expect(game?.questionIds).toHaveLength(COUNT);
    expect(game?.questionIds).toContain('q.t02');
    expect(game?.closingQuestionId).toBe('q.t01');
  });

  it('gives no game without a split, or with fewer takes in common than questions', () => {
    const agreeOnly = Array.from({ length: 8 }, (_, i) => take(i, 'agree', 'agree'));
    expect(selectGame(agreeOnly, COUNT, 1)).toBeNull();
    const few = [
      take(1, 'agree', 'disagree'),
      take(2, 'agree', 'agree'),
      take(3, 'agree', 'agree'),
    ];
    expect(selectGame(few, COUNT, 1)).toBeNull();
    expect(selectGame(few, 3, 1)?.questionIds).toHaveLength(3);
    expect(selectGame([], COUNT, 1)).toBeNull();
  });

  it('can be made of disagreements alone when the two share no view', () => {
    const splits = Array.from({ length: 6 }, (_, i) => take(i, 'agree', 'disagree', 0.3 + i / 20));
    const game = selectGame(splits, COUNT, 3)!;
    expect(game.questionIds).toHaveLength(COUNT);
    expect(game.closingQuestionId).toBe('q.t04'); // share 0.5
    game.answersA.forEach((a, i) => expect(a).not.toBe(game.answersB[i]));
  });
});

describe('playOrder', () => {
  const ids = ['q.a', 'q.b', 'q.c', 'q.d', 'q.e'];

  it('is a permutation of the questions, stable for a seed', () => {
    for (let s = 0; s < 50; s++) {
      expect([...playOrder(ids, s)].sort()).toEqual(ids);
      expect(playOrder(ids, s)).toEqual(playOrder(ids, s));
    }
  });

  it('does not give away which question is the closing one', () => {
    // Over many seeds the last stored question lands on every position.
    const positions = new Set(
      Array.from({ length: 200 }, (_, s) => playOrder(ids, s).indexOf('q.e')),
    );
    expect(positions).toEqual(new Set([0, 1, 2, 3, 4]));
  });
});
