/**
 * Mutual username reveal (PLAN.md Phase 4, Q25; CLAUDE.md invariant 6).
 *
 * Safety:
 * - It exists only in the adult band. A match in any other band, and a match that isn't the
 *   caller's or isn't readable, is "unavailable" before anything is written; the database then
 *   refuses a consent row for anyone under 18 by birth date on its own.
 * - Nothing is revealed until both users have consented, and the database records that for both
 *   rows at once (`revealed_at`), checking both live bands again.
 * - No username passes through here. This service only asks Telegram whether each user has one
 *   right now. The usernames are sent by the outbox sender, which reads them again at that moment
 *   and re-checks the match, both bands and both consents first.
 */
import type { Clock } from '../clock';
import type { RevealRepository, RevealView } from '../db/repositories/reveal';
import { revealAllowedIn } from '../domain/chat/params';
import type { Logger } from '../logger';
import type { Usernames } from './usernames';

/** What `/reveal` can show for one chat. `alias` is the other person's alias (a content ID). */
export type RevealState =
  /** Not an adult chat of the caller, or not open. */
  | { status: 'unavailable' }
  /** The caller has not consented: they can be asked. */
  | { status: 'offer'; alias: string; theyConsented: boolean }
  /** The caller has consented, and the reveal has not happened yet. */
  | { status: 'pending'; alias: string }
  | { status: 'revealed'; alias: string };

export type ConsentOutcome =
  | { status: 'unavailable' }
  /** Consent is recorded, but the caller has no username: nothing else happens until they do. */
  | { status: 'username_needed' }
  /** Consent is recorded and the other person has been asked. */
  | { status: 'waiting'; alias: string }
  /** Both consented, but the other person has no username right now. */
  | { status: 'other_username_missing'; alias: string }
  /** Both consented: each of them is being sent the other's username. */
  | { status: 'revealed'; alias: string; already: boolean };

export interface RevealService {
  state(userId: string, matchId: string): Promise<RevealState>;
  /** Records the caller's consent and, when both have consented, reveals. Safe to repeat. */
  consent(userId: string, matchId: string): Promise<ConsentOutcome>;
}

export function createRevealService(deps: {
  reveal: RevealRepository;
  usernames: Usernames;
  clock: Clock;
  logger: Logger;
}): RevealService {
  const { reveal, usernames, clock, logger } = deps;

  /** The match, if a reveal is possible in it at all right now. */
  async function possible(userId: string, matchId: string): Promise<RevealView | null> {
    const view = await reveal.view(userId, matchId);
    if (!view) return null;
    if (!revealAllowedIn(view.band)) return null;
    if (view.status !== 'results_ready' && view.status !== 'active') return null;
    return view.bothActive ? view : null;
  }

  return {
    async state(userId, matchId) {
      const view = await possible(userId, matchId);
      if (!view) return { status: 'unavailable' };
      const alias = view.counterpartAlias;
      if (view.revealed) return { status: 'revealed', alias };
      if (view.youConsented) return { status: 'pending', alias };
      return { status: 'offer', alias, theyConsented: view.theyConsented };
    },

    async consent(userId, matchId) {
      const view = await possible(userId, matchId);
      if (!view) return { status: 'unavailable' };
      const alias = view.counterpartAlias;
      if (view.revealed) return { status: 'revealed', alias, already: true };

      if (!view.youConsented) {
        // The insert trigger decides once more: an adult match, both adults by birth date.
        const stored = await reveal.consent(userId, matchId, clock.now());
        if (stored === 'refused') {
          logger.warn({ userId, matchId }, 'reveal consent refused by the db');
          return { status: 'unavailable' };
        }
        logger.info({ userId, matchId }, 'reveal consent recorded');
      }

      // Q25: a username is required. Without one the consent stays, and nothing else moves.
      if ((await usernames.current(view.you)) === null) return { status: 'username_needed' };

      if (!view.theyConsented) {
        await reveal.ask(matchId, view.they.id, clock.now());
        return { status: 'waiting', alias };
      }
      if ((await usernames.current(view.they)) === null) {
        return { status: 'other_username_missing', alias };
      }

      if (await reveal.reveal(matchId, clock.now())) {
        logger.info({ matchId }, 'usernames revealed');
        return { status: 'revealed', alias, already: false };
      }
      // Refused by the trigger, or done by the other person's request at the same moment.
      const after = await possible(userId, matchId);
      return after?.revealed
        ? { status: 'revealed', alias, already: true }
        : { status: 'unavailable' };
    },
  };
}
