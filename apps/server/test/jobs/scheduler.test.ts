import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScheduler, type Job } from '../../src/jobs/scheduler';
import { memoryLogger } from '../support/fixtures';

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('starts and stops cleanly with no jobs (Phase 0)', async () => {
    const scheduler = createScheduler({ logger: memoryLogger().logger, jobs: [] });
    scheduler.start();
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('never overlaps a job with itself and waits for a running job on stop', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    let runs = 0;
    const job: Job = {
      name: 'slow',
      intervalMs: 100,
      run: () => {
        runs++;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    };
    const scheduler = createScheduler({ logger: memoryLogger().logger, jobs: [job] });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(runs).toBe(1);

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(runs).toBe(1);
  });
});
