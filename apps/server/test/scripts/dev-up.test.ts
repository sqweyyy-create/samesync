/**
 * The parts of `pnpm dev:up` and `pnpm dev:down` that can be checked without starting Docker, a
 * tunnel or the bot: the tunnel's address in cloudflared's log, the one-line change of .env, the
 * Vite host check, the process lookups, the menu button against a fake Bot API, and the refusal
 * to run in production. Nothing here reads or writes the repository's real .env.
 */
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readState, removeState, writeState } from '../../scripts/lib/dev-files';
import {
  hostAllowed,
  readEnvFile,
  replaceEnvValue,
  updateEnvFile,
} from '../../scripts/lib/local-env';
import { updateMenuButton } from '../../scripts/lib/menu-button';
import {
  groupAlive,
  isAlive,
  isInside,
  isPnpm,
  parseLsofCwd,
  parseLsofProcesses,
  parsePsLine,
  processInfo,
  stopProcess,
} from '../../scripts/lib/processes';
import { parseTunnelUrl, tunnelAnswered, waitForTunnel } from '../../scripts/lib/tunnel';

/** What cloudflared 2026.9 logs when it starts a quick tunnel (trimmed, real format). */
const CLOUDFLARED_LOG = `2026-10-06T08:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms. If you intend to use Tunnels in production you should use a pre-created named tunnel by following: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks
2026-10-06T08:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-10-06T08:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-10-06T08:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-10-06T08:00:01Z INF |  https://seasonal-deck-organisms-sf.trycloudflare.com                                      |
2026-10-06T08:00:01Z INF +--------------------------------------------------------------------------------------------+
2026-10-06T08:00:01Z INF Version 2026.9.3 (Checksum 0123456789abcdef)
2026-10-06T08:00:02Z INF Registered tunnel connection connIndex=0 connection=8a2c event=0 ip=198.41.192.7 location=ams01 protocol=quic
`;

describe('the tunnel address in the cloudflared log', () => {
  it('is found in the box cloudflared prints', () => {
    expect(parseTunnelUrl(CLOUDFLARED_LOG)).toBe(
      'https://seasonal-deck-organisms-sf.trycloudflare.com',
    );
  });

  it('is not the API cloudflared asks for a tunnel, nor any other cloudflare link', () => {
    const failed = `2026-10-06T08:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-10-06T08:00:05Z ERR Error unmarshaling QuickTunnel response: error="failed to request quick Tunnel: Post \\"https://api.trycloudflare.com/tunnel\\": dial tcp: lookup api.trycloudflare.com: no such host"
See https://www.cloudflare.com/website-terms/ and https://developers.cloudflare.com/`;
    expect(parseTunnelUrl(failed)).toBeNull();
    expect(parseTunnelUrl('')).toBeNull();
    // Not a subdomain of trycloudflare.com, only a lookalike.
    expect(parseTunnelUrl('https://some-words-here.trycloudflare.com.evil.example')).toBeNull();
  });

  it('takes the first one when there are several, and keeps digits', () => {
    expect(
      parseTunnelUrl(
        'https://first-tunnel-42.trycloudflare.com then https://second-one.trycloudflare.com',
      ),
    ).toBe('https://first-tunnel-42.trycloudflare.com');
  });
});

describe('waiting for the tunnel', () => {
  const answers = (...statuses: Array<number | Error>) => {
    let i = 0;
    const calls: string[] = [];
    const fake = (url: string | URL | Request) => {
      calls.push(url instanceof Request ? url.url : url.toString());
      const next = statuses[Math.min(i++, statuses.length - 1)]!;
      return next instanceof Error
        ? Promise.reject(next)
        : Promise.resolve(new Response('', { status: next }));
    };
    return { fake, calls };
  };

  it('counts any answer but 530 as up, a 502 of a dev server that is not running included', async () => {
    expect(tunnelAnswered(530)).toBe(false);
    for (const status of [200, 404, 502, 503]) expect(tunnelAnswered(status)).toBe(true);
    const { fake, calls } = answers(new Error('getaddrinfo ENOTFOUND'), 530, 502);
    await waitForTunnel('https://a-b.trycloudflare.com', { timeoutMs: 10_000, fetch: fake });
    expect(calls).toHaveLength(3);
  });

  it('gives up after the timeout, saying what it last got', async () => {
    const { fake } = answers(530);
    await expect(
      waitForTunnel('https://a-b.trycloudflare.com', { timeoutMs: 0, fetch: fake }),
    ).rejects.toThrow(/did not answer within 0 s \(HTTP 530\)/);
  });
});

describe('MINIAPP_URL in .env', () => {
  const URL_ = 'https://new-tunnel-here.trycloudflare.com';

  it('changes only that one line, and keeps every other byte', () => {
    const before = [
      '# Telegram',
      'BOT_TOKEN=123:secret-token-value',
      'MINIAPP_URL=https://old-tunnel.trycloudflare.com',
      'MINIAPP_URL_COMMENT=keep me',
      'XMINIAPP_URL=keep me too',
      '# MINIAPP_URL=https://commented.example',
      'DATABASE_URL=postgres://user:secret-password@localhost/samesync',
      '',
    ].join('\n');
    const { content, replaced } = replaceEnvValue(before, 'MINIAPP_URL', URL_);
    expect(replaced).toBe(1);
    expect(content).toBe(before.replace('https://old-tunnel.trycloudflare.com', URL_));
  });

  it('keeps Windows line endings, an export prefix, and replaces quoted values and spaces', () => {
    expect(replaceEnvValue('A=1\r\nMINIAPP_URL="x"\r\nB=2\r\n', 'MINIAPP_URL', URL_).content).toBe(
      `A=1\r\nMINIAPP_URL=${URL_}\r\nB=2\r\n`,
    );
    expect(replaceEnvValue('export MINIAPP_URL=x\n', 'MINIAPP_URL', URL_).content).toBe(
      `export MINIAPP_URL=${URL_}\n`,
    );
    expect(replaceEnvValue('  MINIAPP_URL = x # old\n', 'MINIAPP_URL', URL_).content).toBe(
      `  MINIAPP_URL=${URL_}\n`,
    );
  });

  it('changes every assignment when there are several, and appends a missing one', () => {
    expect(replaceEnvValue('MINIAPP_URL=a\nMINIAPP_URL=b\n', 'MINIAPP_URL', URL_)).toEqual({
      content: `MINIAPP_URL=${URL_}\nMINIAPP_URL=${URL_}\n`,
      replaced: 2,
    });
    expect(replaceEnvValue('A=1\n', 'MINIAPP_URL', URL_).content).toBe(
      `A=1\nMINIAPP_URL=${URL_}\n`,
    );
    expect(replaceEnvValue('A=1', 'MINIAPP_URL', URL_).content).toBe(`A=1\nMINIAPP_URL=${URL_}\n`);
    expect(replaceEnvValue('', 'MINIAPP_URL', URL_).content).toBe(`MINIAPP_URL=${URL_}\n`);
    expect(replaceEnvValue('A=1\r\n', 'MINIAPP_URL', URL_).content).toBe(
      `A=1\r\nMINIAPP_URL=${URL_}\r\n`,
    );
  });

  it('refuses a value of two lines and a key that is not a name', () => {
    expect(() => replaceEnvValue('', 'MINIAPP_URL', 'a\nB=evil')).toThrow();
    expect(() => replaceEnvValue('', 'MINIAPP.URL', 'x')).toThrow();
  });

  describe('in a file', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'samesync-env-'));
    });
    afterEach(() => rm(dir, { recursive: true, force: true }));

    it('keeps a backup of the file as it was, readable by the owner only, and keeps the mode', async () => {
      const envPath = join(dir, '.env');
      const backupPath = join(dir, '.dev', 'env.backup');
      const before = 'BOT_TOKEN=123:secret\nMINIAPP_URL=https://old.trycloudflare.com\n';
      await writeFile(envPath, before, { mode: 0o640 });
      expect(await updateEnvFile({ envPath, backupPath, key: 'MINIAPP_URL', value: URL_ })).toEqual(
        { changed: true },
      );
      expect(await readFile(envPath, 'utf8')).toBe(`BOT_TOKEN=123:secret\nMINIAPP_URL=${URL_}\n`);
      expect(await readFile(backupPath, 'utf8')).toBe(before);
      expect((await stat(backupPath)).mode & 0o777).toBe(0o600);
      expect((await stat(envPath)).mode & 0o777).toBe(0o640);
      expect(readEnvFile(envPath)).toEqual({ BOT_TOKEN: '123:secret', MINIAPP_URL: URL_ });

      // Already pointing at the tunnel: nothing is written, the backup stays the older file.
      expect(await updateEnvFile({ envPath, backupPath, key: 'MINIAPP_URL', value: URL_ })).toEqual(
        { changed: false },
      );
      expect(await readFile(backupPath, 'utf8')).toBe(before);
    });

    it('fails without touching anything when there is no .env', async () => {
      await expect(
        updateEnvFile({
          envPath: join(dir, '.env'),
          backupPath: join(dir, 'backup'),
          key: 'MINIAPP_URL',
          value: URL_,
        }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(readEnvFile(join(dir, '.env'))).toEqual({});
    });
  });
});

describe('the Vite host check', () => {
  it('follows allowedHosts: a leading dot allows the domain and its subdomains', () => {
    const tunnel = 'new-tunnel-here.trycloudflare.com';
    expect(hostAllowed(tunnel, ['.trycloudflare.com'])).toBe(true);
    expect(hostAllowed(tunnel, [' .TryCloudflare.com '])).toBe(true);
    expect(hostAllowed(tunnel, ['old-tunnel.trycloudflare.com'])).toBe(false);
    expect(hostAllowed(tunnel, [tunnel])).toBe(true);
    expect(hostAllowed(tunnel, ['.example.com', 'localhost'])).toBe(false);
    expect(hostAllowed('eviltrycloudflare.com', ['.trycloudflare.com'])).toBe(false);
  });
});

describe('process lookups', () => {
  it('read lsof and ps output', () => {
    expect(parseLsofProcesses('p53094\ncnode\np53095\ncvite\np53094\ncnode\n')).toEqual([
      { pid: 53094, command: 'node' },
      { pid: 53095, command: 'vite' },
    ]);
    expect(parseLsofProcesses('')).toEqual([]);
    expect(parsePsLine('  53094  53070  53070 node /repo/node_modules/vite/bin/vite.js\n')).toEqual(
      {
        pid: 53094,
        ppid: 53070,
        pgid: 53070,
        args: 'node /repo/node_modules/vite/bin/vite.js',
      },
    );
    expect(parsePsLine('')).toBeNull();
    expect(parseLsofCwd('p53094\nfcwd\nn/Users/dev/syns/apps/miniapp\n')).toBe(
      '/Users/dev/syns/apps/miniapp',
    );
    expect(parseLsofCwd('p1\n')).toBeNull();
  });

  it('tell pnpm itself from a path under node_modules/.pnpm', () => {
    expect(isPnpm('pnpm dev')).toBe(true);
    expect(isPnpm('/opt/homebrew/bin/pnpm dev')).toBe(true);
    expect(isPnpm('node /usr/local/lib/node_modules/pnpm/bin/pnpm.cjs dev')).toBe(true);
    expect(isPnpm('pnpm --parallel --filter @samesync/server run dev')).toBe(true);
    expect(
      isPnpm('node /repo/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/cli.mjs watch'),
    ).toBe(false);
    expect(isPnpm("sh -c trap 'x' INT; vite")).toBe(false);
    expect(isPnpm('-zsh')).toBe(false);
  });

  it('tell whether a path is inside the repository', () => {
    expect(isInside('/Users/dev/syns', '/Users/dev/syns/')).toBe(true);
    expect(isInside('/Users/dev/syns/apps/miniapp', '/Users/dev/syns')).toBe(true);
    expect(isInside('/Users/dev/syns-other', '/Users/dev/syns')).toBe(false);
    expect(isInside('/Users/dev', '/Users/dev/syns')).toBe(false);
  });

  it('stop a whole process group: Ctrl+C first, then harder', async () => {
    // A group whose leader ignores SIGINT, with a child of its own: only SIGTERM stops them.
    const leader = spawn(
      process.execPath,
      [
        '-e',
        "process.on('SIGINT', () => {}); require('node:child_process').spawn(process.execPath, ['-e', \"process.on('SIGINT', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); setInterval(() => {}, 1000)",
      ],
      { detached: true, stdio: 'ignore' },
    );
    const pgid = leader.pid!;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(groupAlive(pgid)).toBe(true);
    expect(await stopProcess(pgid, { group: true, graceMs: 500 })).toBe(true);
    expect(groupAlive(pgid)).toBe(false);
    // Nothing left to stop is a success, too.
    expect(await stopProcess(pgid, { group: true, graceMs: 500 })).toBe(true);
  });

  it('find this very process, and know a dead one', async () => {
    const me = await processInfo(process.pid);
    expect(me?.pid).toBe(process.pid);
    expect(me?.ppid).toBe(process.ppid);
    expect(isAlive(process.pid)).toBe(true);
    expect(isAlive(2 ** 22 + 12_345)).toBe(false);
    expect(await processInfo(2 ** 22 + 12_345)).toBeNull();
  });
});

describe('the dev:up state file', () => {
  it('round-trips, and a broken or foreign file counts as no state', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'samesync-state-'));
    try {
      const path = join(dir, 'dev-up.json');
      const state = {
        pid: 101,
        devPid: 102,
        tunnelPid: 103,
        tunnelUrl: 'https://a-b.trycloudflare.com',
        startedAt: '2026-10-06T08:00:00.000Z',
      };
      writeState(state, path);
      expect(readState(path)).toEqual(state);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      await writeFile(path, '{"pid": "not a number"}');
      expect(readState(path)).toBeNull();
      await writeFile(path, 'not json');
      expect(readState(path)).toBeNull();
      removeState(path);
      expect(readState(path)).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('the menu button', () => {
  const TOKEN = '1234567890:SECRET_TOKEN_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const URL_ = 'https://new-tunnel-here.trycloudflare.com';
  let server: Server;
  let apiRoot: string;
  let calls: Array<{ path: string; body: unknown }>;
  let answers: Record<string, unknown>;

  beforeEach(async () => {
    calls = [];
    answers = {};
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        const path = request.url ?? '';
        calls.push({ path, body: body ? (JSON.parse(body) as unknown) : null });
        const method = path.split('/').pop() ?? '';
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify(
            answers[method] ?? { ok: false, error_code: 404, description: 'Not Found' },
          ),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    apiRoot = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it('keeps the label of the existing web-app button and points it at the tunnel', async () => {
    answers['getChatMenuButton'] = {
      ok: true,
      result: {
        type: 'web_app',
        text: 'Открыть SameSync',
        web_app: { url: 'https://old.example' },
      },
    };
    answers['setChatMenuButton'] = { ok: true, result: true };
    const outcome = await updateMenuButton({
      token: TOKEN,
      url: URL_,
      fallbackLabel: 'Fallback',
      apiRoot,
    });
    expect(outcome).toEqual({ ok: true, label: 'Открыть SameSync', keptLabel: true });
    expect(calls.map((c) => c.path)).toEqual([
      `/bot${TOKEN}/getChatMenuButton`,
      `/bot${TOKEN}/setChatMenuButton`,
    ]);
    // No chat_id: the default button of every private chat.
    expect(calls[1]?.body).toEqual({
      menu_button: { type: 'web_app', text: 'Открыть SameSync', web_app: { url: URL_ } },
    });
  });

  it('uses the fallback label when the bot has no web-app button yet', async () => {
    answers['getChatMenuButton'] = { ok: true, result: { type: 'commands' } };
    answers['setChatMenuButton'] = { ok: true, result: true };
    expect(
      await updateMenuButton({
        token: TOKEN,
        url: URL_,
        fallbackLabel: 'Открыть SameSync',
        apiRoot,
      }),
    ).toEqual({ ok: true, label: 'Открыть SameSync', keptLabel: false });
  });

  it("reports Telegram's description, or an unreachable API, and never the token", async () => {
    answers['getChatMenuButton'] = { ok: true, result: { type: 'default' } };
    answers['setChatMenuButton'] = {
      ok: false,
      error_code: 400,
      description: 'Bad Request: invalid web app URL',
    };
    const refused = await updateMenuButton({
      token: TOKEN,
      url: URL_,
      fallbackLabel: 'x',
      apiRoot,
    });
    expect(refused).toEqual({ ok: false, error: 'Bad Request: invalid web app URL' });

    const closed = 'http://127.0.0.1:1';
    const unreachable = await updateMenuButton({
      token: TOKEN,
      url: URL_,
      fallbackLabel: 'x',
      apiRoot: closed,
    });
    expect(unreachable).toEqual({ ok: false, error: 'the Bot API could not be reached' });
    for (const outcome of [refused, unreachable]) {
      expect(JSON.stringify(outcome)).not.toContain('SECRET_TOKEN');
    }
  });
});

describe('the scripts', () => {
  const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
  const script = (name: string) =>
    fileURLToPath(new URL(`../../scripts/${name}.ts`, import.meta.url));
  // No PATH: even a broken refusal could not reach Docker, cloudflared, lsof or pnpm.
  const runScript = (name: string) =>
    promisify(execFile)(process.execPath, [tsxCli, script(name)], {
      env: { PATH: '', NODE_ENV: 'production' },
      timeout: 30_000,
    }).then(
      (ok) => ({ code: 0, ...ok }),
      (error: { code?: number; stdout?: string; stderr?: string }) => ({
        code: error.code ?? -1,
        stdout: error.stdout ?? '',
        stderr: error.stderr ?? '',
      }),
    );

  it.each(['dev-up', 'dev-down'])('%s refuses to run with NODE_ENV=production', async (name) => {
    const result = await runScript(name);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `${name.replace('-', ':')} refuses to run with NODE_ENV=production`,
    );
    expect(result.stdout).toBe('');
  });
});
