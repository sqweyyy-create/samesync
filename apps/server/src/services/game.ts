/**
 * The game of a match (PLAN.md Phase 3): each player guesses the other's answers to a few takes,
 * and once both have submitted, the results show how well they read each other and end on the
 * one take they split on, with a ready-made opener.
 *
 * Safety: everything is read through the participant-scoped repositories, so a stranger, and both
 * former participants of a match closed for a band change, get 404. Before a player has submitted
 * and both are done, nothing here can return the other person's answers: the game endpoint only
 * has the questions, and the results query yields no answers until both players have finished.
 * Frozen and deleted accounts can't call this (CLAUDE.md invariant 9).
 */
import type { Locale } from '@samesync/shared';
import type {
  GameResponse,
  MatchSummary,
  PredictionsRequest,
  ResultsResponse,
} from '@samesync/shared/api';
import { translatorFor } from '@samesync/shared/i18n/static';
import type { Clock } from '../clock';
import { localized, type ContentStore } from '../content/store';
import type { GamesRepository, SubmitOutcome } from '../db/repositories/games';
import type { MatchesRepository } from '../db/repositories/matches';
import type { UsersRepository } from '../db/repositories/users';
import { renderOpener } from '../domain/game/opener';
import { CHAT_DEADLINE_HOURS } from '../domain/game/params';
import { gameResults } from '../domain/game/results';
import { playOrder } from '../domain/game/select';
import type { Stance } from '../domain/matching/types';
import { hashString } from '../domain/random';
import type { ValidatedInitData } from '../http/auth/init-data';
import { loadCurrentUser } from './current-user';
import { ServiceError } from './errors';
import { UUID, presentMatch } from './matches';

export interface GameService {
  /** The takes to guess. 409 once the caller has submitted or the game is over. */
  game(auth: ValidatedInitData, matchId: string): Promise<GameResponse>;
  /** Stores the caller's guesses, once. Returns the match as it is afterwards. */
  submit(
    auth: ValidatedInitData,
    matchId: string,
    request: PredictionsRequest,
  ): Promise<MatchSummary>;
  /** 409 until both players have submitted. */
  results(auth: ValidatedInitData, matchId: string): Promise<ResultsResponse>;
}

/** Submitting guesses for a user who is already identified (the API, and dev tooling). */
export interface GamePlay {
  submit(
    userId: string,
    matchId: string,
    predictions: ReadonlyArray<{ questionId: string; value: Stance }>,
  ): Promise<SubmitOutcome>;
}

const HOUR = 3_600_000;

export function createGamePlay(deps: { games: GamesRepository; clock: Clock }): GamePlay {
  return {
    submit(userId, matchId, predictions) {
      const now = deps.clock.now();
      return deps.games.submitPredictions({
        userId,
        matchId,
        predictions,
        now,
        // Q2: the chat window opens when the results are ready.
        chatDeadline: new Date(now.getTime() + CHAT_DEADLINE_HOURS * HOUR),
      });
    },
  };
}

export function createGameService(deps: {
  users: UsersRepository;
  matches: MatchesRepository;
  games: GamesRepository;
  content: ContentStore;
  clock: Clock;
}): GameService {
  const { games, matches, content, clock } = deps;
  const play = createGamePlay(deps);

  async function caller(auth: ValidatedInitData) {
    const user = await loadCurrentUser(deps, auth);
    if (user.status === 'frozen' || user.status === 'deleted') throw new ServiceError('forbidden');
    return user;
  }

  const questionText = (questionId: string, locale: Locale) => {
    const question = content.game.question(questionId);
    return question ? localized(question.text, locale) : '';
  };

  return {
    async game(auth, matchId) {
      const user = await caller(auth);
      // Not a participant, closed for a band change, or simply unknown: all look the same.
      const game = UUID.test(matchId) ? await games.getForPlayer(user.id, matchId) : null;
      if (!game) throw new ServiceError('not_found');
      const open = game.status === 'pending_game' && game.gameDeadlineAt > clock.now();
      if (!open || game.youDone) throw new ServiceError('conflict');
      // Each player gets their own order: the stored one ends on the split, which would give
      // that answer away.
      const order = playOrder(game.questionIds, hashString(`${game.matchId}:${user.id}`));
      return { questions: order.map((id) => ({ id, text: questionText(id, user.locale) })) };
    },

    async submit(auth, matchId, request) {
      const user = await caller(auth);
      if (!UUID.test(matchId)) throw new ServiceError('not_found');
      const outcome = await play.submit(user.id, matchId, request.predictions);
      switch (outcome.status) {
        case 'not_found':
          throw new ServiceError('not_found');
        case 'invalid':
          throw new ServiceError('invalid', ['predictions']);
        case 'not_playable':
        case 'already_submitted':
          throw new ServiceError('conflict');
        case 'submitted': {
          const view = await matches.getForParticipant(user.id, matchId);
          if (!view) throw new ServiceError('not_found');
          return presentMatch(view, user.locale, content);
        }
      }
    },

    async results(auth, matchId) {
      const user = await caller(auth);
      const view = UUID.test(matchId)
        ? await games.getResultsForParticipant(user.id, matchId)
        : null;
      if (!view) throw new ServiceError('not_found');
      if (!view.ready) throw new ServiceError('out_of_order');
      // Results belong to an open match: once it has ended, the other person's answers are gone.
      if (view.status !== 'results_ready' && view.status !== 'active') {
        throw new ServiceError('conflict');
      }
      const results = gameResults(view);
      const closing = results?.rounds.at(-1);
      if (!results || !closing || closing.questionId !== view.closingQuestionId) {
        throw new ServiceError('out_of_order');
      }
      return {
        total: results.total,
        youGuessed: results.youGuessed,
        theyGuessed: results.theyGuessed,
        rounds: results.rounds.map((round) => ({
          ...round,
          text: questionText(round.questionId, user.locale),
        })),
        // In the language of the match, not of the reader: it is meant for the other person.
        opener: renderOpener(
          { questionId: closing.questionId, side: closing.yours },
          content.game,
          translatorFor(view.locale),
        ),
      };
    },
  };
}
