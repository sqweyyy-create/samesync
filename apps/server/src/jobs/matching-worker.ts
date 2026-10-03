/**
 * Worker thread entry: plans one matching run off the main thread, so the bot and the API stay
 * responsive (PLAN.md §2). Pure computation only: no database, no network, no logging of data.
 * Bundled as its own file (build.mjs); in development it runs through tsx.
 */
import { parentPort } from 'node:worker_threads';
import { planPool } from '../domain/matching/plan';
import type { MatchCandidate, PlanInput, PlanResult } from '../domain/matching/types';

export type WorkerRequest =
  { type: 'users'; users: MatchCandidate[] } | { type: 'plan'; input: Omit<PlanInput, 'users'> };
export type WorkerResponse =
  { type: 'result'; result: PlanResult } | { type: 'error'; message: string };

if (!parentPort) throw new Error('matching-worker must run as a worker thread');
const port = parentPort;
const users: MatchCandidate[] = [];

port.on('message', (request: WorkerRequest) => {
  if (request.type === 'users') {
    for (const user of request.users) users.push(user);
    return;
  }
  let response: WorkerResponse;
  try {
    response = { type: 'result', result: planPool({ ...request.input, users }) };
  } catch (error) {
    response = { type: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  port.postMessage(response);
});
