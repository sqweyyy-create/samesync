/**
 * Picks the questions of a game (PLAN.md Phase 3). Pure: the same takes and seed always give the
 * same game.
 *
 * Every question is a take both users answered. The last one, the closing question, is a take
 * they split on: the game ends on a disagreement worth talking about. The others are mostly views
 * the two share, rare ones first, with one more disagreement mixed in when there is one.
 */
import type { Stance } from '../matching/types';
import { prng, shuffle } from '../random';

/** A take both users answered (never a skip), with how the pool is split on it. */
export interface CommonTake {
  questionId: string;
  a: Stance;
  b: Stance;
  /** The share of the pool that agrees, among the people who answered: between 0 and 1. */
  agreeShare: number;
}

export interface GameSelection {
  /** In the order of the results: the closing question is last. */
  questionIds: string[];
  closingQuestionId: string;
  /** Each user's own answers, aligned with `questionIds`. */
  answersA: Stance[];
  answersB: Stance[];
}

/**
 * The takes of `deck` that both users answered (skips are not answers), with the pool's split on
 * each. Only the deck of the match's pool × mode counts, as in matching.
 */
export function commonTakes(
  deck: ReadonlyArray<{ id: string; priorAgree: number }>,
  a: ReadonlyMap<string, Stance>,
  b: ReadonlyMap<string, Stance>,
  /** The pool's agree share of a take, if the run measured one; else the take's prior is used. */
  agreeShare: (questionId: string) => number | undefined,
): CommonTake[] {
  const common: CommonTake[] = [];
  for (const take of deck) {
    const mine = a.get(take.id);
    const theirs = b.get(take.id);
    if (!mine || !theirs) continue;
    common.push({
      questionId: take.id,
      a: mine,
      b: theirs,
      agreeShare: agreeShare(take.id) ?? take.priorAgree,
    });
  }
  return common;
}

/** How far a take is from an even split: 0 for 50/50. */
const imbalance = (take: CommonTake) => Math.abs(take.agreeShare - 0.5);

/** How many people hold the view the two share: the smaller, the rarer. */
const sharedShare = (take: CommonTake) =>
  take.a === 'agree' ? take.agreeShare : 1 - take.agreeShare;

/**
 * The game of one pair, or null when their takes can't make one: fewer than `count` in common, or
 * no disagreement to end on. Matching only pairs people who have both (PLAN.md §5, hard filters).
 *
 * `known` are takes whose answer a player already knows before the game, such as the shared view
 * the match teaser names. Asking about them would be no guess at all, so they are used only when
 * nothing else is left.
 */
export function selectGame(
  common: readonly CommonTake[],
  count: number,
  seed: number,
  known: ReadonlySet<string> = new Set(),
): GameSelection | null {
  if (!Number.isInteger(count) || count < 1) throw new Error('a game needs at least one question');
  const unique = new Map(common.map((take) => [take.questionId, take]));
  // A seeded order first: every choice below is a stable sort, so ties fall back on it.
  const takes = shuffle(
    [...unique.values()].sort((x, y) => (x.questionId < y.questionId ? -1 : 1)),
    prng(seed),
  );
  const splits = takes
    .filter((take) => take.a !== take.b)
    .sort((x, y) => imbalance(x) - imbalance(y));
  const agreements = takes
    .filter((take) => take.a === take.b)
    .sort(
      (x, y) =>
        Number(known.has(x.questionId)) - Number(known.has(y.questionId)) ||
        sharedShare(x) - sharedShare(y),
    );
  const closing = splits[0];
  if (!closing || takes.length < count) return null;

  // The other questions: at most one more disagreement, unless the shared views run out.
  const others = count - 1;
  const moreSplits = splits.slice(1);
  const wantedAgreements = moreSplits.length > 0 ? others - 1 : others;
  const picked = agreements.slice(0, Math.max(0, Math.min(agreements.length, wantedAgreements)));
  picked.push(...moreSplits.slice(0, others - picked.length));
  if (picked.length < others) return null;

  const ordered = [...shuffle(picked, prng(seed ^ 0x2545f491)), closing];
  return {
    questionIds: ordered.map((take) => take.questionId),
    closingQuestionId: closing.questionId,
    answersA: ordered.map((take) => take.a),
    answersB: ordered.map((take) => take.b),
  };
}

/**
 * The order one player sees the questions in while guessing. It differs from the stored order,
 * where the closing question is last: a player who knew which card is the disagreement could
 * "guess" it from their own answer.
 */
export function playOrder(questionIds: readonly string[], seed: number): string[] {
  return shuffle([...questionIds], prng(seed));
}
