import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScheduler, type Job } from '../../src/jobs/scheduler';
import { memoryLogger } from '../support/fixtures';

afterEach(() => {
  vi.useRealTimers();
});

describe('scheduler', () => {
  it('starts and stops cleanly with no jobs', async () => {
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

  it('runs a job right at the start when asked to, and then on its interval', async () => {
    vi.useFakeTimers();
    const runs = { eager: 0, lazy: 0 };
    const job = (name: 'eager' | 'lazy', runOnStart: boolean): Job => ({
      name,
      intervalMs: 1000,
      runOnStart,
      run: () => {
        runs[name]++;
        return Promise.resolve();
      },
    });
    const scheduler = createScheduler({
      logger: memoryLogger().logger,
      jobs: [job('eager', true), job('lazy', false)],
    });
    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(runs).toEqual({ eager: 1, lazy: 0 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(runs).toEqual({ eager: 2, lazy: 1 });
    await scheduler.stop();
  });
});
