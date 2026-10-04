import { describe, expect, it } from 'vitest';
import type { Stance } from '../matching/types';
import { gameResults, type FinishedGame } from './results';

const IDS = ['q.a', 'q.b', 'q.c', 'q.d', 'q.e'];
const guesses = (pattern: string) =>
  new Map(
    [...pattern].map((char, i): [string, Stance] => [IDS[i]!, char === 'A' ? 'agree' : 'disagree']),
  );
const answers = (pattern: string) =>
  [...pattern].map((char): Stance => (char === 'A' ? 'agree' : 'disagree'));
const game = (over: Partial<FinishedGame> = {}): FinishedGame => ({
  questionIds: IDS,
  yourAnswers: answers('AADDA'),
  theirAnswers: answers('ADDAD'),
  yourGuesses: guesses('ADDAD'),
  theirGuesses: guesses('AADDA'),
  ...over,
});

describe('gameResults', () => {
  it('counts each side: your guesses against their answers, their guesses against yours', () => {
    const results = gameResults(
      game({ yourGuesses: guesses('AADAD'), theirGuesses: guesses('DADDD') }),
    );
    // Their answers are ADDAD: you got the 1st, 4th and 5th. Yours are AADDA: they got 2nd–4th.
    expect(results).toMatchObject({ total: 5, youGuessed: 4, theyGuessed: 3 });
  });

  it('puts the answers and guesses of every question side by side, in the stored order', () => {
    const results = gameResults(
      game({ yourGuesses: guesses('AAAAA'), theirGuesses: guesses('DDDDD') }),
    );
    expect(results?.rounds.map((r) => r.questionId)).toEqual(IDS);
    expect(results?.rounds[1]).toEqual({
      questionId: 'q.b',
      yours: 'agree',
      theirs: 'disagree',
      yourGuess: 'agree',
      theirGuess: 'disagree',
    });
    // The closing question (last) is a split.
    expect(results?.rounds.at(-1)).toMatchObject({ yours: 'agree', theirs: 'disagree' });
  });

  it('handles the edges: everything right, and nothing right', () => {
    expect(gameResults(game())).toMatchObject({ total: 5, youGuessed: 5, theyGuessed: 5 });
    expect(
      gameResults(game({ yourGuesses: guesses('DAADA'), theirGuesses: guesses('DDAAD') })),
    ).toMatchObject({ total: 5, youGuessed: 0, theyGuessed: 0 });
  });

  it('does not depend on the order the guesses were stored in', () => {
    const reversed = new Map([...guesses('ADDAD')].reverse());
    expect(gameResults(game({ yourGuesses: reversed }))).toEqual(gameResults(game()));
  });

  it('gives nothing while a guess or an answer is missing', () => {
    const missing = guesses('ADDAD');
    missing.delete('q.c');
    expect(gameResults(game({ yourGuesses: missing }))).toBeNull();
    expect(gameResults(game({ theirGuesses: new Map() }))).toBeNull();
    expect(gameResults(game({ theirAnswers: answers('ADDA') }))).toBeNull();
    expect(gameResults(game({ questionIds: [] }))).toBeNull();
  });
});
