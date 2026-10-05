/**
 * The cloudflared quick tunnel of `pnpm dev:up`: a public https:// address for the local Vite dev
 * server, which Telegram needs to open the Mini App. A quick tunnel gets a new random hostname
 * under trycloudflare.com every time it starts.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

/** A quick tunnel's hostname is several words joined by hyphens; `api.trycloudflare.com` is not one. */
const QUICK_TUNNEL = /https:\/\/([a-z0-9]+(?:-[a-z0-9]+)+)\.trycloudflare\.com(?![a-z0-9.-])/;

/** The tunnel's address as cloudflared logs it, or null if the log doesn't have it (yet). */
export function parseTunnelUrl(log: string): string | null {
  const match = QUICK_TUNNEL.exec(log);
  return match ? `https://${match[1]}.trycloudflare.com` : null;
}

/**
 * Whether an HTTP status means the tunnel is up. Until cloudflared has registered with the edge,
 * Cloudflare answers 530 (error 1033). Anything else comes through the tunnel, a 502 included: that
 * one only says the local dev server isn't running yet.
 */
export const tunnelAnswered = (status: number): boolean => status !== 530;

/** Starts cloudflared in the background, logging to `logPath`. It keeps running after we exit. */
export function startTunnel(input: { target: string; logPath: string }): ChildProcess {
  const log = openSync(input.logPath, 'w', 0o600);
  try {
    const child = spawn(
      'cloudflared',
      ['tunnel', '--no-autoupdate', '--grace-period', '2s', '--url', input.target],
      { detached: true, stdio: ['ignore', log, log] },
    );
    child.unref();
    return child;
  } finally {
    closeSync(log);
  }
}

/** The last lines of the tunnel's log, for an error message. The log holds no secrets. */
export function logTail(logPath: string, lines = 8): string {
  if (!existsSync(logPath)) return '(no log)';
  return readFileSync(logPath, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
}

/** Waits until cloudflared has logged the tunnel's address. Fails if cloudflared exits first. */
export async function waitForTunnelUrl(input: {
  logPath: string;
  exited: () => boolean;
  timeoutMs: number;
}): Promise<string> {
  const until = Date.now() + input.timeoutMs;
  for (;;) {
    const url = existsSync(input.logPath)
      ? parseTunnelUrl(readFileSync(input.logPath, 'utf8'))
      : null;
    if (url) return url;
    if (input.exited()) throw new Error(`cloudflared exited:\n${logTail(input.logPath)}`);
    if (Date.now() > until) {
      throw new Error(
        `no tunnel address after ${input.timeoutMs / 1000} s:\n${logTail(input.logPath)}`,
      );
    }
    await sleep(250);
  }
}

/** Waits until the tunnel's address answers through the tunnel (see `tunnelAnswered`). */
export async function waitForTunnel(
  url: string,
  options: { timeoutMs: number; fetch?: typeof fetch },
): Promise<void> {
  const get = options.fetch ?? fetch;
  const until = Date.now() + options.timeoutMs;
  for (;;) {
    let last: string;
    try {
      const response = await get(url, { redirect: 'manual', signal: AbortSignal.timeout(5_000) });
      await response.body?.cancel();
      if (tunnelAnswered(response.status)) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : 'network error';
    }
    if (Date.now() > until) {
      throw new Error(`the tunnel did not answer within ${options.timeoutMs / 1000} s (${last})`);
    }
    await sleep(1_000);
  }
}
