/**
 * The chat window (PLAN.md Phase 4, Q2): once results are ready the two have 48 hours to start
 * talking. Both get one reminder before the window closes, and a chat nobody wrote in expires.
 * After the first delivered message a chat never expires.
 *
 * Every step is idempotent. Expiry only touches matches that are still `results_ready` and have no
 * delivered message, and a notification has one dedupe key per match and user, so a rerun, a crash
 * in the middle or a second instance never expires a match twice or notifies anyone twice.
 */
import type { Clock } from '../clock';
import type { ChatRepository } from '../db/repositories/chat';
import { CHAT_BANDS, type ChatParams } from '../domain/chat/params';
import type { Logger } from '../logger';

export interface ChatDeadlines {
  run(): Promise<{ started: number; expired: number; reminded: number }>;
}

const HOUR = 3_600_000;

export function createChatDeadlines(deps: {
  chat: Pick<ChatRepository, 'startDelivered' | 'expireSilent' | 'remindSilent'>;
  clock: Clock;
  logger: Logger;
  params: Pick<ChatParams, 'reminderHoursBefore'>;
  /** Matches (and reminders) handled per transaction. */
  batchSize?: number;
}): ChatDeadlines {
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
      // A chat whose first message was delivered just before a crash is started first: it must
      // not be expired or reminded.
      const started = await deps.chat.startDelivered(deps.clock.now(), batch);
      // Expiry before reminders: a chat that is already over needs none.
      const expired = await drain((now) => deps.chat.expireSilent(now, batch));
      const reminded = await drain((now) => deps.chat.remindSilent(now, leadMs, batch, CHAT_BANDS));
      if (started > 0 || expired > 0 || reminded > 0) {
        deps.logger.info({ started, expired, reminded }, 'chat deadlines applied');
      }
      return { started, expired, reminded };
    },
  };
}
