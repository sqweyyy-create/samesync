import { describe, expect, it } from 'vitest';
import { fixedClock } from '../../src/clock';
import { createMatchingJob } from '../../src/jobs/jobs';
import type { MatchingService, RunOutcome, RunRequest } from '../../src/services/matching';
import { memoryLogger } from '../support/fixtures';

const DROPS = {
  ru: { times: ['13:00', '20:00'], timeZone: 'Europe/Moscow' },
  en: { times: ['13:00', '20:00'], timeZone: 'UTC' },
};
const signal = new AbortController().signal;

function setup(at: string, respond: (request: RunRequest) => RunOutcome | Error = () => DONE) {
  const clock = fixedClock(new Date(at));
  const calls: string[] = [];
  const matching: MatchingService = {
    run(request) {
      const { pool, mode, slot } = request;
      calls.push(`${pool.band}:${pool.locale}:${mode}@${slot.toISOString()}`);
      const answer = respond(request);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const { logger, lines } = memoryLogger();
  const job = createMatchingJob({ matching, clock, logger, drops: DROPS });
  return { job, calls, clock, logLines: lines };
}
const DONE: RunOutcome = {
  status: 'done',
  runId: 'r',
  poolSize: 0,
  eligibleUsers: 0,
  pairsCreated: 0,
  pairsRejected: 0,
  tierCounts: { 1: 0, 2: 0, 3: 0 },
};

describe('the matching job', () => {
  it('runs every pool × mode of a locale once per drop, in that locale time zone', async () => {
    // 13:05 in Moscow: the ru drop of 13:00 is due. In UTC it is 10:05: the last en drop was
    // 14 hours ago, too old to catch up.
    const { job, calls, clock } = setup('2026-10-03T10:05:00Z');
    await job.run(signal);
    expect(calls).toEqual([
      'u18:ru:friends@2026-10-03T10:00:00.000Z',
      'adult:ru:friends@2026-10-03T10:00:00.000Z',
      'adult:ru:dating@2026-10-03T10:00:00.000Z',
    ]);
    // The same drop is not run again a minute later.
    clock.set(new Date('2026-10-03T10:06:00Z'));
    await job.run(signal);
    expect(calls).toHaveLength(3);
    // 13:00 UTC: the en drop.
    clock.set(new Date('2026-10-03T13:00:30Z'));
    await job.run(signal);
    expect(calls.slice(3)).toEqual([
      'u18:en:friends@2026-10-03T13:00:00.000Z',
      'adult:en:friends@2026-10-03T13:00:00.000Z',
      'adult:en:dating@2026-10-03T13:00:00.000Z',
    ]);
    // 20:00 in Moscow: the second ru drop of the day.
    clock.set(new Date('2026-10-03T17:01:00Z'));
    await job.run(signal);
    expect(calls.slice(6)).toEqual([
      'u18:ru:friends@2026-10-03T17:00:00.000Z',
      'adult:ru:friends@2026-10-03T17:00:00.000Z',
      'adult:ru:dating@2026-10-03T17:00:00.000Z',
    ]);
  });

  it('catches up a recent drop after a restart, but not one older than three hours', async () => {
    const recent = setup('2026-10-03T12:30:00Z'); // 2.5 hours after the ru drop
    await recent.job.run(signal);
    expect(recent.calls).toHaveLength(3);
    const stale = setup('2026-10-03T16:30:00Z'); // 6.5 hours after it, 3.5 after the en drop
    await stale.job.run(signal);
    expect(stale.calls).toEqual([]);
  });

  it('tries again next minute when another instance holds the lock', async () => {
    let locked = true;
    const { job, calls } = setup('2026-10-03T10:05:00Z', (request) =>
      locked && request.mode === 'dating' ? { status: 'locked' } : DONE,
    );
    await job.run(signal);
    expect(calls).toHaveLength(3);
    locked = false;
    await job.run(signal);
    expect(calls.slice(3)).toEqual(['adult:ru:dating@2026-10-03T10:00:00.000Z']);
  });

  it('keeps going when one pool fails, and retries that pool', async () => {
    let failing = true;
    const { job, calls, logLines } = setup('2026-10-03T10:05:00Z', (request) =>
      failing && request.pool.band === 'u18' ? new Error('database went away') : DONE,
    );
    await job.run(signal);
    expect(calls).toHaveLength(3);
    expect(logLines().some((l) => l.includes('matching run failed'))).toBe(true);
    failing = false;
    await job.run(signal);
    expect(calls.slice(3)).toEqual(['u18:ru:friends@2026-10-03T10:00:00.000Z']);
  });

  it('treats a disabled u18 pool as handled', async () => {
    const { job, calls } = setup('2026-10-03T10:05:00Z', (request) =>
      request.pool.band === 'u18' ? { status: 'disabled' } : DONE,
    );
    await job.run(signal);
    await job.run(signal);
    expect(calls).toHaveLength(3);
  });
});
