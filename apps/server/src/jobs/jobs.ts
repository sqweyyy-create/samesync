/**
 * The scheduled jobs: matching drops, the outbox sender, the age transition, the deadlines of the
 * game and of the chat, and retention.
 */
import { BANDS, LOCALES, type Band, type Locale, type Mode } from '@samesync/shared';
import type pg from 'pg';
import type { Clock } from '../clock';
import { latestDropSlot, type DropSchedule } from '../domain/drops';
import type { Logger } from '../logger';
import type { MatchingService } from '../services/matching';
import type { OutboxSender } from '../services/outbox-sender';
import { LOCK, withAdvisoryLock } from './advisory-lock';
import type { AgeTransition } from './age-transition';
import type { ChatDeadlines } from './chat-deadlines';
import type { GameDeadlines } from './game-deadlines';
import type { Retention } from './retention';
import type { Job } from './scheduler';

const MINUTE = 60_000;

/** The modes a band is matched in: u18 users are friends-only. */
const MODES_OF: Readonly<Record<Band, readonly Mode[]>> = {
  u18: ['friends'],
  adult: ['friends', 'dating'],
};

/**
 * Runs each pool × mode once per drop (Q8). Checked every minute: a drop that is due and has not
 * run yet is run now. After downtime only a recent drop is caught up; an older one is skipped and
 * the next drop runs on time.
 */
export function createMatchingJob(deps: {
  matching: MatchingService;
  clock: Clock;
  logger: Logger;
  drops: Readonly<Record<Locale, DropSchedule>>;
  maxCatchUpMs?: number;
}): Job {
  const maxCatchUpMs = deps.maxCatchUpMs ?? 3 * 60 * MINUTE;
  /** The last drop handled per pool × mode, so an idle minute costs no database round trip. */
  const handled = new Map<string, number>();

  return {
    name: 'matching',
    intervalMs: MINUTE,
    runOnStart: true,
    async run(signal) {
      for (const locale of LOCALES) {
        for (const band of BANDS) {
          for (const mode of MODES_OF[band]) {
            if (signal.aborted) return;
            const now = deps.clock.now();
            const slot = latestDropSlot(now, deps.drops[locale]);
            const key = `${band}:${locale}:${mode}`;
            if (handled.get(key) === slot.getTime()) continue;
            if (now.getTime() - slot.getTime() > maxCatchUpMs) {
              handled.set(key, slot.getTime());
              continue;
            }
            try {
              const outcome = await deps.matching.run({ pool: { band, locale }, mode, slot });
              // "locked": another instance is on it; look again next minute.
              if (outcome.status !== 'locked') handled.set(key, slot.getTime());
            } catch (error) {
              // One pool failing must not stop the others; the run is resumed next minute.
              deps.logger.error({ err: error, band, locale, mode }, 'matching run failed');
            }
          }
        }
      }
    },
  };
}

/** Sends due notifications every couple of seconds; one sender at a time across instances. */
export function createOutboxJob(deps: { pool: pg.Pool; sender: OutboxSender }): Job {
  return {
    name: 'outbox',
    intervalMs: 2_000,
    runOnStart: true,
    async run() {
      await withAdvisoryLock(deps.pool, LOCK.outbox, () => deps.sender.tick());
    },
  };
}

/** Hourly, and once at startup so a restart loop can't starve it. */
export function createAgeTransitionJob(deps: { pool: pg.Pool; ageTransition: AgeTransition }): Job {
  return {
    name: 'age-transition',
    intervalMs: 60 * MINUTE,
    runOnStart: true,
    async run() {
      await withAdvisoryLock(deps.pool, LOCK.ageTransition, () => deps.ageTransition.run());
    },
  };
}

/** Every minute: expires games past their deadline and queues the reminders that are due (Q2). */
export function createGameDeadlinesJob(deps: { pool: pg.Pool; deadlines: GameDeadlines }): Job {
  return {
    name: 'game-deadlines',
    intervalMs: MINUTE,
    runOnStart: true,
    async run() {
      await withAdvisoryLock(deps.pool, LOCK.gameDeadlines, () => deps.deadlines.run());
    },
  };
}

/** Every minute: expires chats nobody wrote in and queues the reminders that are due (Q2). */
export function createChatDeadlinesJob(deps: { pool: pg.Pool; deadlines: ChatDeadlines }): Job {
  return {
    name: 'chat-deadlines',
    intervalMs: MINUTE,
    runOnStart: true,
    async run() {
      await withAdvisoryLock(deps.pool, LOCK.chatDeadlines, () => deps.deadlines.run());
    },
  };
}

/** Hourly, and once at startup: removes message texts that are past their retention (Q20). */
export function createRetentionJob(deps: { pool: pg.Pool; retention: Retention }): Job {
  return {
    name: 'retention',
    intervalMs: 60 * MINUTE,
    runOnStart: true,
    async run() {
      await withAdvisoryLock(deps.pool, LOCK.retention, () => deps.retention.run());
    },
  };
}
