/**
 * Retention (PLAN.md Phase 4 and 5, Q20): the text of a message is removed when its retention
 * period is over (the row stays, without the text, so routing and counters keep working), and
 * the evidence a report kept is removed a while after the report was resolved.
 */
import type { Clock } from '../clock';
import type { AdminRepository } from '../db/repositories/admin';
import type { ChatRepository } from '../db/repositories/chat';
import type { SafetyParams } from '../domain/safety/params';
import type { Logger } from '../logger';

export interface Retention {
  run(): Promise<{ purged: number; evidencePurged: number }>;
}

const DAY = 86_400_000;

export function createRetention(deps: {
  chat: Pick<ChatRepository, 'purgeBodies'>;
  clock: Clock;
  logger: Logger;
  /** Without these, only message texts are purged (dev tooling). */
  admin?: Pick<AdminRepository, 'purgeEvidence'>;
  params?: Pick<SafetyParams, 'evidenceRetentionDays'>;
  /** Rows handled per statement. */
  batchSize?: number;
}): Retention {
  const batch = deps.batchSize ?? 1000;

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
      const purged = await drain((now) => deps.chat.purgeBodies(now, batch));
      const { admin, params } = deps;
      const evidencePurged =
        admin && params
          ? await drain((now) =>
              admin.purgeEvidence(
                new Date(now.getTime() - params.evidenceRetentionDays * DAY),
                batch,
              ),
            )
          : 0;
      // Counts only: never anything about the messages themselves.
      if (purged > 0 || evidencePurged > 0) {
        deps.logger.info({ purged, evidencePurged }, 'retention applied');
      }
      return { purged, evidencePurged };
    },
  };
}
