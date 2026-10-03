import { describe, expect, it } from 'vitest';
import { prng } from '../../src/domain/random';
import { inProcessPlanner, workerPlanner } from '../../src/jobs/matching-planner';
import { HOUR, NOW, SCOPE, answers, candidate, planInput } from '../support/matching';

function pool(size: number) {
  const random = prng(5);
  return Array.from({ length: size }, () =>
    candidate({
      waitingSince: NOW - 100 * HOUR,
      items: SCOPE.items.filter(() => random() < 0.25).map((i) => i.id),
      answers: answers(
        Array.from({ length: 12 }, () => (random() < 0.5 ? 'A' : random() < 0.8 ? 'D' : '-')).join(
          '',
        ),
      ),
    }),
  );
}

describe('the worker-thread planner', () => {
  it('plans exactly what the in-process planner plans (more users than one chunk)', async () => {
    const input = planInput(pool(600), { seed: 77 });
    const [inWorker, inProcess] = await Promise.all([
      workerPlanner.plan(input),
      inProcessPlanner.plan(input),
    ]);
    expect(inWorker.pairs.length).toBeGreaterThan(100);
    expect(inWorker).toEqual(inProcess);
  });

  it('reports a planning error instead of hanging', async () => {
    const input = planInput(pool(4), { pool: { band: 'u18', locale: 'ru' }, mode: 'dating' });
    await expect(workerPlanner.plan(input)).rejects.toThrow(
      'matching worker failed: u18 pools are friends-only',
    );
  });
});
