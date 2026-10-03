import type { Logger } from '../logger';

export interface Job {
  name: string;
  intervalMs: number;
  /** Also run once right after the scheduler starts, not only after the first interval. */
  runOnStart?: boolean;
  run(signal: AbortSignal): Promise<void>;
}

export interface Scheduler {
  start(): void;
  /** Stops scheduling and waits for running jobs to finish. */
  stop(): Promise<void>;
}

/**
 * In-process scheduler (PLAN.md §2). Jobs take a Postgres advisory lock themselves (see
 * advisory-lock.ts), so a second instance never runs the same job concurrently.
 * A job never overlaps with itself.
 */
export function createScheduler(deps: { logger: Logger; jobs: readonly Job[] }): Scheduler {
  const controller = new AbortController();
  const timers: NodeJS.Timeout[] = [];
  const running = new Map<string, Promise<void>>();

  function tick(job: Job): void {
    if (controller.signal.aborted || running.has(job.name)) return;
    const run = job
      .run(controller.signal)
      .catch((error: unknown) => deps.logger.error({ err: error, job: job.name }, 'job failed'))
      .finally(() => running.delete(job.name));
    running.set(job.name, run);
  }

  return {
    start() {
      for (const job of deps.jobs) {
        timers.push(setInterval(() => tick(job), job.intervalMs));
        if (job.runOnStart) tick(job);
      }
      deps.logger.info({ jobs: deps.jobs.map((j) => j.name) }, 'scheduler started');
    },
    async stop() {
      controller.abort();
      for (const timer of timers) clearInterval(timer);
      await Promise.all(running.values());
    },
  };
}
