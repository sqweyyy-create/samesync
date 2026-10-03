/**
 * The hourly age-transition job (PLAN.md Phase 2). `users.age_band` is a cache: on an 18th
 * birthday it is stale until something writes the row. This job makes that write, which fires the
 * state-change trigger: the user's open u18 matches close with `band_change` and their pending
 * notifications are cancelled, in one transaction per user.
 *
 * Nothing depends on this job for safety: until it runs, the match trigger, the outbox sender and
 * every participant-scoped read already use the live band from the birth date.
 */
import type { UsersRepository } from '../db/repositories/users';
import type { Logger } from '../logger';

export interface AgeTransition {
  run(): Promise<{ reconciled: number; activated: number }>;
}

export function createAgeTransition(deps: {
  users: Pick<UsersRepository, 'staleBandUserIds' | 'reconcileBand' | 'activateWaitlisted'>;
  u18PoolEnabled: boolean;
  logger: Logger;
}): AgeTransition {
  return {
    async run() {
      const stale = await deps.users.staleBandUserIds();
      // One statement per user: no lock is held on two users at once, so this can't deadlock
      // with a match insert, which locks both of its users.
      for (const userId of stale) await deps.users.reconcileBand(userId);
      const activated = await deps.users.activateWaitlisted(deps.u18PoolEnabled);
      if (stale.length > 0 || activated > 0) {
        deps.logger.info({ reconciled: stale.length, activated }, 'age transition applied');
      }
      return { reconciled: stale.length, activated };
    },
  };
}
