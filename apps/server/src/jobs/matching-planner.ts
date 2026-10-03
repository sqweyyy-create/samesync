/**
 * How a matching run gets its plan: in a worker thread in production, so scoring thousands of
 * users never blocks the event loop, or in-process for tests and small tools.
 */
import { createRequire } from 'node:module';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { planPool } from '../domain/matching/plan';
import type { PlanInput, PlanResult } from '../domain/matching/types';
import type { WorkerRequest, WorkerResponse } from './matching-worker';

export interface MatchPlanner {
  plan(input: PlanInput): Promise<PlanResult>;
}

export const inProcessPlanner: MatchPlanner = {
  plan: (input) => Promise.resolve(planPool(input)),
};

/** True when running the TypeScript sources (dev, tests); false in the bundle (dist/main.js). */
const FROM_SOURCE = import.meta.url.endsWith('.ts');
const WORKER_FILE = new URL(
  FROM_SOURCE ? './matching-worker.ts' : './matching-worker.js',
  import.meta.url,
);

/**
 * The worker needs tsx to load TypeScript. Started by the `tsx` CLI, the process already carries
 * the loader in execArgv and the worker inherits it; anywhere else (vitest) it is added here.
 */
function workerOptions(): WorkerOptions {
  if (!FROM_SOURCE) return {};
  const loader = createRequire(import.meta.url).resolve('tsx');
  if (process.execArgv.some((arg) => arg.endsWith(loader))) return {};
  return { execArgv: [...process.execArgv, '--import', pathToFileURL(loader).href] };
}

/** Users are handed to the worker in chunks, so copying them never holds the event loop long. */
const CHUNK = 250;

export const workerPlanner: MatchPlanner = {
  async plan({ users, ...input }) {
    const worker = new Worker(WORKER_FILE, workerOptions());
    try {
      const response = new Promise<WorkerResponse>((resolve, reject) => {
        worker.once('message', resolve);
        worker.once('error', reject);
        worker.once('exit', (code) =>
          reject(new Error(`matching worker exited with code ${code}`)),
        );
      });
      const send = (request: WorkerRequest) => worker.postMessage(request);
      for (let start = 0; start < users.length; start += CHUNK) {
        send({ type: 'users', users: users.slice(start, start + CHUNK) });
        await yieldToEventLoop();
      }
      send({ type: 'plan', input });
      const answer = await response;
      if (answer.type === 'error') throw new Error(`matching worker failed: ${answer.message}`);
      return answer.result;
    } finally {
      await worker.terminate();
    }
  },
};
