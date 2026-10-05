/**
 * Local processes, for `pnpm dev:up` and `pnpm dev:down`: who listens on a port, which command
 * a process is, and stopping one, or the whole `pnpm dev` it belongs to. macOS and Linux (lsof, ps).
 * Before a process is signalled, its identity is checked, so a stale PID never hits a stranger.
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessInfo {
  pid: number;
  ppid: number;
  pgid: number;
  args: string;
}

/** `lsof -F pc` output → the processes in it, with their command names. */
export function parseLsofProcesses(output: string): Array<{ pid: number; command: string }> {
  const found: Array<{ pid: number; command: string }> = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = Number(line.slice(1));
      if (Number.isInteger(pid) && pid > 0) found.push({ pid, command: '' });
    } else if (line.startsWith('c')) {
      const last = found.at(-1);
      if (last) last.command = line.slice(1);
    }
  }
  return [...new Map(found.map((p) => [p.pid, p])).values()];
}

/** `ps -o pid=,ppid=,pgid=,args=` output (one line) → the process, or null. */
export function parsePsLine(output: string): ProcessInfo | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(output.trim());
  if (!match) return null;
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    args: match[4] ?? '',
  };
}

/** `lsof -a -p PID -d cwd -Fn` output → the working directory, or null. */
export function parseLsofCwd(output: string): string | null {
  const line = output.split('\n').find((l) => l.startsWith('n'));
  return line ? line.slice(1) : null;
}

/** The processes listening on a TCP port of this machine. */
export async function listenersOn(port: number): Promise<Array<{ pid: number; command: string }>> {
  try {
    const { stdout } = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']);
    return parseLsofProcesses(stdout);
  } catch (error) {
    // lsof exits with 1 when nothing matches.
    if ((error as { code?: unknown }).code === 1) return [];
    throw error;
  }
}

export async function processInfo(pid: number): Promise<ProcessInfo | null> {
  try {
    const { stdout } = await run('ps', ['-o', 'pid=,ppid=,pgid=,args=', '-p', String(pid)]);
    return parsePsLine(stdout);
  } catch {
    return null;
  }
}

export async function processCwd(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    return parseLsofCwd(stdout);
  } catch {
    return null;
  }
}

/** Whether `path` is `root` or inside it, comparing real paths. */
export function isInside(path: string, root: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const base = real(root).replace(/\/+$/, '');
  const target = real(path);
  return target === base || target.startsWith(`${base}/`);
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

export function groupAlive(pgid: number): boolean {
  return isAlive(-pgid);
}

function signal(target: number, name: NodeJS.Signals): void {
  try {
    process.kill(target, name);
  } catch {
    // Gone already.
  }
}

async function waitUntil(done: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > until) return false;
    await sleep(200);
  }
  return true;
}

/**
 * Stops a process (or, with `group`, its whole process group) the way Ctrl+C would, then harder
 * if it doesn't go: SIGINT, SIGTERM after `graceMs`, SIGKILL after as long again.
 */
export async function stopProcess(
  pid: number,
  options: { group?: boolean; graceMs?: number; first?: NodeJS.Signals } = {},
): Promise<boolean> {
  const target = options.group ? -pid : pid;
  const alive = () => (options.group ? groupAlive(pid) : isAlive(pid));
  const grace = options.graceMs ?? 10_000;
  if (!alive()) return true;
  for (const name of [options.first ?? 'SIGINT', 'SIGTERM', 'SIGKILL'] as const) {
    signal(target, name);
    if (await waitUntil(() => !alive(), grace)) return true;
  }
  return !alive();
}

/** Whether a command line is pnpm itself, not merely a path under `node_modules/.pnpm/`. */
export const isPnpm = (args: string): boolean => /(^|\/)pnpm(\.c?js)?(\s|$)/.test(args);

/** `pid` and every process above it, up to init. */
async function lineage(pid: number): Promise<Set<number>> {
  const seen = new Set<number>();
  for (let current: number | undefined = pid; current && current > 1 && !seen.has(current);) {
    seen.add(current);
    current = (await processInfo(current))?.ppid;
  }
  return seen;
}

export interface ProjectTarget {
  pid: number;
  /** Signal the whole process group that `pid` leads, like Ctrl+C in its terminal. */
  group: boolean;
  info: ProcessInfo;
  /** The outermost pnpm of the repository that the listener runs under (a `pnpm dev`). */
  pnpm: boolean;
}

/**
 * What to stop for a process that listens on a dev port. For one of this repository: the
 * outermost pnpm it runs under, inside the repository (the `pnpm dev` someone started; stopping it
 * the way Ctrl+C does stops everything it started), else its own process group when the group's
 * leader works in the repository too, else the listener alone. Null for a process outside the
 * repository: those are left alone. Never this process or anything above it.
 */
export async function projectProcess(pid: number, root: string): Promise<ProjectTarget | null> {
  const listener = await processInfo(pid);
  const cwd = await processCwd(pid);
  if (!listener || !cwd || !isInside(cwd, root)) return null;
  const mine = await lineage(process.pid);
  if (mine.has(listener.pid)) return null;

  let outermost: ProcessInfo | null = null;
  for (let current = listener; current.ppid > 1;) {
    const parent = await processInfo(current.ppid);
    if (!parent || mine.has(parent.pid)) break;
    const parentCwd = await processCwd(parent.pid);
    if (!parentCwd || !isInside(parentCwd, root)) break;
    if (isPnpm(parent.args)) outermost = parent;
    current = parent;
  }
  if (outermost) {
    return {
      pid: outermost.pid,
      group: outermost.pgid === outermost.pid,
      info: outermost,
      pnpm: true,
    };
  }
  const leader = listener.pgid > 1 ? await processInfo(listener.pgid) : null;
  const leaderCwd = leader ? await processCwd(leader.pid) : null;
  if (leader && leaderCwd && isInside(leaderCwd, root) && !mine.has(leader.pid)) {
    return { pid: leader.pid, group: true, info: leader, pnpm: false };
  }
  return { pid, group: false, info: listener, pnpm: false };
}

/** A short description of a process for a message: its command line, shortened. */
export function describe(info: ProcessInfo): string {
  const args = info.args.length > 120 ? `${info.args.slice(0, 117)}...` : info.args;
  return `pid ${info.pid}: ${args}`;
}
