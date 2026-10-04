/**
 * The deadlines of the game (PLAN.md Phase 3, Q2): a game that was not played within 48 hours of
 * the match expires, and every player who hasn't played gets one reminder before that.
 *
 * Both steps are idempotent. Expiry only touches matches that are still `pending_game`, and a
 * notification has one dedupe key per match and user, so a rerun, a crash in the middle or a
 * second instance never expires a match twice or notifies anyone twice.
 */
import type { Clock } from '../clock';
import type { GamesRepository } from '../db/repositories/games';
import type { GameParams } from '../domain/game/params';
import type { Logger } from '../logger';

export interface GameDeadlines {
  run(): Promise<{ expired: number; reminded: number }>;
}

const HOUR = 3_600_000;

export function createGameDeadlines(deps: {
  games: Pick<GamesRepository, 'expireOverdue' | 'remindUnplayed'>;
  clock: Clock;
  logger: Logger;
  params: Pick<GameParams, 'reminderHoursBefore'>;
  /** Matches (and reminders) handled per transaction. */
  batchSize?: number;
}): GameDeadlines {
  const batch = deps.batchSize ?? 200;
  const leadMs = deps.params.reminderHoursBefore * HOUR;

  /** Runs `step` until it has nothing left to do, one batch at a time. */
  async function drain(step: (now: Date) => Promise<number>): Promise<number> {
    let total = 0;
    for (;;) {
      const done = await step(deps.clock.now());
      total += done;
      if (done < batch) return total;
    }
  }

  return {
    async run() {
      // Expiry first: a game that is already over needs no reminder.
      const expired = await drain((now) => deps.games.expireOverdue(now, batch));
      const reminded = await drain((now) => deps.games.remindUnplayed(now, leadMs, batch));
      if (expired > 0 || reminded > 0) {
        deps.logger.info({ expired, reminded }, 'game deadlines applied');
      }
      return { expired, reminded };
    },
  };
}
