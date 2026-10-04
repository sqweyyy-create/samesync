/**
 * The results of a finished game, from one player's side (PLAN.md Phase 3): how many of the other
 * person's answers they guessed, how many of theirs the other person guessed, and the answers of
 * each question side by side. Pure.
 */
import type { Stance } from '../matching/types';

/** One question of a finished game, as the viewer sees it. */
export interface GameRound {
  questionId: string;
  /** The viewer's own answer, and the other person's. */
  yours: Stance;
  theirs: Stance;
  /** What the viewer guessed the other person answered, and the other way round. */
  yourGuess: Stance;
  theirGuess: Stance;
}

export interface GameResults {
  /** In the stored order of the game: the closing question is last. */
  rounds: GameRound[];
  total: number;
  /** Rounds where the viewer's guess matches the other person's answer. */
  youGuessed: number;
  /** Rounds where the other person's guess matches the viewer's answer. */
  theyGuessed: number;
}

/** Both players' answers and guesses, aligned with `questionIds`. */
export interface FinishedGame {
  questionIds: readonly string[];
  yourAnswers: readonly Stance[];
  theirAnswers: readonly Stance[];
  yourGuesses: ReadonlyMap<string, Stance>;
  theirGuesses: ReadonlyMap<string, Stance>;
}

/** Null when a guess or an answer is missing: results exist only once both have finished. */
export function gameResults(game: FinishedGame): GameResults | null {
  const rounds: GameRound[] = [];
  for (const [index, questionId] of game.questionIds.entries()) {
    const yours = game.yourAnswers[index];
    const theirs = game.theirAnswers[index];
    const yourGuess = game.yourGuesses.get(questionId);
    const theirGuess = game.theirGuesses.get(questionId);
    if (!yours || !theirs || !yourGuess || !theirGuess) return null;
    rounds.push({ questionId, yours, theirs, yourGuess, theirGuess });
  }
  if (rounds.length === 0) return null;
  return {
    rounds,
    total: rounds.length,
    youGuessed: rounds.filter((round) => round.yourGuess === round.theirs).length,
    theyGuessed: rounds.filter((round) => round.theirGuess === round.yours).length,
  };
}
