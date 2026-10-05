/* eslint-disable no-console -- CLI output */
/**
 * `pnpm dev:down`: stops what `pnpm dev:up` started (pnpm dev and the tunnel), a `pnpm dev` of
 * this repository started by hand, and the database container. The container is stopped, never
 * removed, and its volume is always kept. A process outside this repository is left alone, and a
 * recorded PID is checked before it is signalled. Refuses to run with NODE_ENV=production.
 */
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { DEV_FILES, REPO_ROOT, readState, removeState } from './lib/dev-files';
import { refuseInProduction } from './lib/dev-runtime';
import { readEnvFile } from './lib/local-env';
import {
  describe,
  isAlive,
  listenersOn,
  processInfo,
  projectProcess,
  stopProcess,
} from './lib/processes';

refuseInProduction('dev:down');
const env = readEnvFile(DEV_FILES.env);
if (env['NODE_ENV'] === 'production') {
  console.error('dev:down refuses to run with NODE_ENV=production');
  process.exit(1);
}

const run = promisify(execFile);
const PORTS = [
  { port: 5173, name: 'Vite (5173)' },
  {
    port: Number(env['HTTP_PORT'] ?? 3000),
    name: env['HTTP_PORT'] ? 'the API (HTTP_PORT)' : 'the API (3000)',
  },
];

const state = readState();

// 1. A dev:up that is still running stops its own pnpm dev and tunnel, like Ctrl+C there.
if (state && isAlive(state.pid) && (await processInfo(state.pid))?.args.includes('dev-up')) {
  console.log(`Stopping dev:up (pid ${state.pid}): pnpm dev and the tunnel...`);
  await stopProcess(state.pid, { graceMs: 25_000 });
}

// 2. What a dev:up that did not clean up left behind.
if (state?.tunnelPid && isAlive(state.tunnelPid)) {
  const info = await processInfo(state.tunnelPid);
  if (info?.args.includes('cloudflared')) {
    console.log(`Stopping the tunnel (${describe(info)})...`);
    await stopProcess(state.tunnelPid, { first: 'SIGTERM', graceMs: 5_000 });
  }
}

// 3. pnpm dev, also one started by hand: whatever of this repository listens on its ports.
for (const { port, name } of PORTS) {
  for (const holder of await listenersOn(port)) {
    const project = await projectProcess(holder.pid, REPO_ROOT);
    if (!project) {
      console.log(
        `The port of ${name} is used by ${holder.command} (pid ${holder.pid}), outside this repository: left alone.`,
      );
      continue;
    }
    console.log(
      `Stopping ${project.pnpm ? 'pnpm dev' : holder.command} (${describe(project.info)})...`,
    );
    await stopProcess(project.pid, { group: project.group });
  }
}
removeState();

// 4. The database container: stopped, never removed, its volume kept.
let dockerUp = true;
try {
  await run('docker', ['info'], { cwd: REPO_ROOT, timeout: 30_000 });
} catch {
  dockerUp = false;
}
if (dockerUp) {
  const code = await new Promise<number | null>((resolve) => {
    const child = spawn('docker-compose', ['stop', 'db'], { cwd: REPO_ROOT, stdio: 'inherit' });
    child.once('error', () => resolve(-1));
    child.once('exit', (exit) => resolve(exit));
  });
  if (code !== 0) {
    console.error('docker-compose stop db failed (see above).');
    process.exit(1);
  }
} else {
  console.log('Docker is not running: the database is not running either.');
}
console.log('dev:down: done. The database volume is kept.');
