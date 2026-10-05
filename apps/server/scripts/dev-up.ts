/* eslint-disable no-console -- CLI output */
/**
 * `pnpm dev:up`: everything a manual check in Telegram needs, in one command.
 *
 *   0. Ports 5173 (Vite) and the API's are free; a process that holds one is named and, if you
 *      say so, stopped.
 *   1. Docker runs (colima start if not), and the database container is up and healthy.
 *   2. pnpm db:migrate and pnpm content:seed.
 *   3. A cloudflared quick tunnel to http://127.0.0.1:5173, logged to .dev/cloudflared.log.
 *   4. MINIAPP_URL in .env points at the tunnel; only that line changes, and the previous .env is
 *      kept in .dev/env.backup.
 *   5. The bot's menu button opens the tunnel (Bot API setChatMenuButton), so @BotFather is not
 *      needed.
 *   6. A summary: the tunnel, the support codes in the local database, the next command.
 *   7. pnpm dev in the foreground. Ctrl+C stops it and the tunnel; pnpm dev:down also stops the
 *      database.
 *
 * No .env value is printed or logged: .env is read for BOT_TOKEN and DATABASE_URL only, and is not
 * loaded into this process's environment, so the processes started here read the updated file
 * themselves. Refuses to run with NODE_ENV=production.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { SOURCE_LOCALE } from '@samesync/shared';
import { translatorFor } from '@samesync/shared/i18n/static';
import pg from 'pg';
import {
  DEV_FILES,
  REPO_ROOT,
  ensureDevDir,
  readState,
  removeState,
  writeState,
  type DevUpState,
} from './lib/dev-files';
import { refuseInProduction } from './lib/dev-runtime';
import { hostAllowed, readEnvFile, updateEnvFile } from './lib/local-env';
import { updateMenuButton } from './lib/menu-button';
import {
  describe,
  isAlive,
  listenersOn,
  processInfo,
  projectProcess,
  stopProcess,
} from './lib/processes';
import { startTunnel, waitForTunnel, waitForTunnelUrl } from './lib/tunnel';

refuseInProduction('dev:up');
const env = readEnvFile(DEV_FILES.env);
if (env['NODE_ENV'] === 'production') {
  console.error('dev:up refuses to run with NODE_ENV=production');
  process.exit(1);
}

const run = promisify(execFile);
const VITE_PORT = 5173;
const API_PORT = Number(env['HTTP_PORT'] ?? 3000);
const PORTS = [
  { port: VITE_PORT, name: 'Vite (5173)' },
  // The value of HTTP_PORT is not printed, like every other .env value.
  { port: API_PORT, name: env['HTTP_PORT'] ? 'the API (HTTP_PORT)' : 'the API (3000)' },
];
const STEPS = 7;

let tunnel: ChildProcess | null = null;
let dev: ChildProcess | null = null;
let stopping = false;
const state: DevUpState = {
  pid: process.pid,
  devPid: null,
  tunnelPid: null,
  tunnelUrl: null,
  startedAt: new Date().toISOString(),
};

/** Stops what this run started (pnpm dev, the tunnel) and exits. The database keeps running. */
async function shutdown(code: number): Promise<never> {
  if (stopping) return new Promise<never>(() => undefined);
  stopping = true;
  if (dev?.pid) {
    console.log('\ndev:up: stopping pnpm dev...');
    // The whole process group: pnpm, the server's watcher and Vite.
    await stopProcess(dev.pid, { group: true, graceMs: 8_000 });
  }
  if (tunnel?.pid) {
    console.log('dev:up: stopping the tunnel...');
    await stopProcess(tunnel.pid, { first: 'SIGTERM', graceMs: 5_000 });
  }
  removeState();
  if (dev || tunnel)
    console.log('dev:up: stopped. The database keeps running: pnpm dev:down stops it.');
  process.exit(code);
}
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => void shutdown(0));
}

/** Runs one numbered step; a failure names the step and why, stops what was started, and exits. */
async function step<T>(n: number, name: string, fn: () => Promise<T>): Promise<T> {
  console.log(`\n[${n}/${STEPS}] ${name}`);
  try {
    return await fn();
  } catch (error) {
    console.error(`\ndev:up stopped at step ${n} (${name}): ${(error as Error).message}`);
    return shutdown(1);
  }
}

/** Runs a command with its output on this terminal. */
function inherit(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO_ROOT, stdio: 'inherit' });
    child.once('error', (error) =>
      reject(
        (error as { code?: string }).code === 'ENOENT'
          ? new Error(`${command} is not installed`)
          : error,
      ),
    );
    child.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} ${args.join(' ')} exited with ${code ?? signal}`)),
    );
  });
}

async function succeeds(command: string, args: string[]): Promise<boolean> {
  try {
    await run(command, args, { cwd: REPO_ROOT, timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Ctrl+C at the question stops dev:up like anywhere else.
  rl.on('SIGINT', () => {
    rl.close();
    void shutdown(130);
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** A port held by another process: name it, and stop it if the developer says so. */
async function freePort(port: number, name: string): Promise<void> {
  for (let round = 0; round < 5; round++) {
    const [holder] = await listenersOn(port);
    if (!holder) return;
    const project = await projectProcess(holder.pid, REPO_ROOT);
    const info = project?.info ?? (await processInfo(holder.pid));
    const what = project?.pnpm
      ? `a pnpm dev of this repository (${describe(project.info)})`
      : `${holder.command} (${info ? describe(info) : `pid ${holder.pid}`})`;
    console.log(`Port of ${name} is taken by ${what}.`);
    if (!process.stdin.isTTY) throw new Error(`the port of ${name} is taken; stop that process`);
    const answer = (await ask('Stop it? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') throw new Error(`the port of ${name} is taken`);
    const target = project ?? { pid: holder.pid, group: false, pnpm: false };
    // A pnpm dev is stopped the way Ctrl+C stops it; anything else is asked to terminate.
    const stopped = await stopProcess(target.pid, {
      group: target.group,
      first: target.group || target.pnpm ? 'SIGINT' : 'SIGTERM',
    });
    if (!stopped) throw new Error(`pid ${target.pid} did not stop`);
    await sleep(300);
  }
  throw new Error(`the port of ${name} stays taken`);
}

async function waitHealthy(): Promise<void> {
  const { stdout } = await run('docker-compose', ['ps', '-q', 'db'], { cwd: REPO_ROOT });
  const container = stdout.trim();
  if (!container) throw new Error('the db container did not start');
  const until = Date.now() + 90_000;
  for (;;) {
    const { stdout: health } = await run('docker', [
      'inspect',
      '-f',
      '{{.State.Health.Status}}',
      container,
    ]);
    const status = health.trim();
    if (status === 'healthy') return;
    if (status === 'unhealthy')
      throw new Error('Postgres is unhealthy: see docker-compose logs db');
    if (Date.now() > until) throw new Error(`Postgres is not healthy after 90 s (${status})`);
    await sleep(1_000);
  }
}

/** The support codes of the real (not synthetic) users in the local database. */
async function supportCodes(): Promise<string[]> {
  const connectionString = env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is missing in .env');
  const db = new pg.Client({ connectionString });
  await db.connect();
  try {
    const { rows } = await db.query<{ public_id: string; status: string }>(
      'SELECT public_id, status FROM users WHERE NOT synthetic ORDER BY created_at, id',
    );
    return rows.map((r) => `${r.public_id} (${r.status})`);
  } finally {
    await db.end();
  }
}

// One dev:up at a time.
const previous = readState();
if (previous && previous.pid !== process.pid && isAlive(previous.pid)) {
  const info = await processInfo(previous.pid);
  if (info?.args.includes('dev-up')) {
    console.error(
      `dev:up is already running (pid ${previous.pid}). Stop it there, or run pnpm dev:down.`,
    );
    process.exit(1);
  }
}
// A dev:up that died without cleaning up may have left its tunnel running.
if (previous?.tunnelPid && isAlive(previous.tunnelPid)) {
  const info = await processInfo(previous.tunnelPid);
  if (info?.args.includes('cloudflared')) {
    console.log(`Stopping the tunnel a previous dev:up left running (${describe(info)}).`);
    await stopProcess(previous.tunnelPid, { first: 'SIGTERM', graceMs: 5_000 });
  }
}
removeState();

await step(0, 'Ports', async () => {
  for (const { port, name } of PORTS) await freePort(port, name);
  console.log('Ports are free.');
});

await step(1, 'Docker and the database', async () => {
  if (!(await succeeds('docker', ['info']))) {
    console.log('Docker is not running: colima start');
    await inherit('colima', ['start']);
    if (!(await succeeds('docker', ['info'])))
      throw new Error('Docker does not answer after colima start');
  }
  await inherit('docker-compose', ['up', '-d', 'db']);
  await waitHealthy();
  console.log('Postgres is healthy.');
});

await step(2, 'Migrations and content', async () => {
  await inherit('pnpm', ['db:migrate']);
  await inherit('pnpm', ['content:seed']);
});

const url = await step(3, 'Tunnel', async () => {
  ensureDevDir();
  const started = { exited: false, error: null as Error | null };
  tunnel = startTunnel({ target: `http://127.0.0.1:${VITE_PORT}`, logPath: DEV_FILES.tunnelLog });
  tunnel.once('error', (error) => {
    started.error =
      (error as { code?: string }).code === 'ENOENT'
        ? new Error('cloudflared is not installed')
        : error;
    started.exited = true;
  });
  tunnel.once('exit', () => {
    started.exited = true;
  });
  if (tunnel.pid) {
    state.tunnelPid = tunnel.pid;
    writeState(state);
  }
  let found: string;
  try {
    found = await waitForTunnelUrl({
      logPath: DEV_FILES.tunnelLog,
      exited: () => started.exited,
      timeoutMs: 45_000,
    });
  } catch (error) {
    throw started.error ?? error;
  }
  console.log(`${found}: waiting until it answers...`);
  await waitForTunnel(found, { timeoutMs: 90_000 });
  state.tunnelUrl = found;
  writeState(state);
  console.log('The tunnel answers (log: .dev/cloudflared.log).');
  return found;
});

await step(4, 'MINIAPP_URL in .env', async () => {
  const { changed } = await updateEnvFile({
    envPath: DEV_FILES.env,
    backupPath: DEV_FILES.envBackup,
    key: 'MINIAPP_URL',
    value: url,
  });
  console.log(
    changed
      ? 'MINIAPP_URL updated; the previous .env is in .dev/env.backup.'
      : 'MINIAPP_URL already points at this tunnel.',
  );
  const allowed = (env['MINIAPP_DEV_ALLOWED_HOSTS'] ?? '.trycloudflare.com').split(',');
  if (!hostAllowed(new URL(url).host, allowed)) {
    console.log(
      'Warning: MINIAPP_DEV_ALLOWED_HOSTS in .env does not allow this tunnel, so Vite will refuse ' +
        'the Mini App. Add .trycloudflare.com to it.',
    );
  }
});

await step(5, 'Menu button', async () => {
  const token = env['BOT_TOKEN'];
  if (!token) throw new Error('BOT_TOKEN is missing in .env');
  const outcome = await updateMenuButton({
    token,
    url,
    fallbackLabel: translatorFor(SOURCE_LOCALE).t('bot.start.open_app'),
  });
  if (!outcome.ok) throw new Error(outcome.error);
  console.log('menu button updated');
});

await step(6, 'Summary', async () => {
  const codes = await supportCodes();
  console.log(`Tunnel:         ${url}`);
  console.log(
    `Support codes:  ${codes.length > 0 ? codes.join(', ') : 'none yet: open the Mini App from the bot and finish onboarding'}`,
  );
  console.log(
    'Next:           pnpm dev:scenario phase4   (in another terminal, once the server is up)',
  );
});

console.log(`\n[7/${STEPS}] pnpm dev   (Ctrl+C stops it and the tunnel)\n`);
// Its own process group, so that stopping it reaches the server's watcher and Vite too. Stdin is
// not passed on: a background group must not read from the terminal.
dev = spawn('pnpm', ['dev'], {
  cwd: REPO_ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  detached: true,
});
dev.once('error', (error) => {
  console.error(`\ndev:up stopped at step 7 (pnpm dev): ${error.message}`);
  void shutdown(1);
});
dev.once('exit', (code, signal) => {
  if (stopping) return;
  console.log(`\npnpm dev exited (${code ?? signal}).`);
  void shutdown(code ?? 1);
});
if (dev.pid) {
  state.devPid = dev.pid;
  writeState(state);
}
