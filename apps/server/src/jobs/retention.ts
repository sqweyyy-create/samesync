/**
 * Retention (PLAN.md Phase 4, Q20): the text of a message is removed when its retention period is
 * over. The row stays, without the text, so routing and counters keep working.
 */
import type { Clock } from '../clock';
import type { ChatRepository } from '../db/repositories/chat';
import type { Logger } from '../logger';

export interface Retention {
  run(): Promise<{ purged: number }>;
}

export function createRetention(deps: {
  chat: Pick<ChatRepository, 'purgeBodies'>;
  clock: Clock;
  logger: Logger;
  /** Messages handled per statement. */
  batchSize?: number;
}): Retention {
  const batch = deps.batchSize ?? 1000;
  return {
    async run() {
      let purged = 0;
      for (;;) {
        const done = await deps.chat.purgeBodies(deps.clock.now(), batch);
        purged += done;
        if (done < batch) break;
      }
      // A count only: never anything about the messages themselves.
      if (purged > 0) deps.logger.info({ purged }, 'message texts purged');
      return { purged };
    },
  };
}
