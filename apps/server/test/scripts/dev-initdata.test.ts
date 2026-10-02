import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { validateInitData } from '../../src/http/auth/init-data';
import { TEST_BOT_TOKEN } from '../support/fixtures';

const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
const script = fileURLToPath(new URL('../../scripts/dev-initdata.ts', import.meta.url));

function run(env: Record<string, string>, args: string[] = []) {
  return promisify(execFile)(process.execPath, [tsxCli, script, ...args], {
    env: { PATH: process.env['PATH'] ?? '', ...env },
    timeout: 15_000,
  });
}

describe('pnpm dev:initdata', () => {
  it('prints launch params whose initData our server accepts and the SDK can parse', async () => {
    const { stdout } = await run({ BOT_TOKEN: TEST_BOT_TOKEN }, [
      '--user-id',
      '700000001',
      '--lang',
      'en',
    ]);
    expect(stdout).not.toContain(TEST_BOT_TOKEN);

    const url = stdout.trim().split('\n').at(-1) ?? '';
    const launchParams = new URLSearchParams(new URL(url).hash.slice(1));
    expect(launchParams.get('tgWebAppVersion')).toBeTruthy();
    expect(launchParams.get('tgWebAppPlatform')).toBe('web');

    const initData = launchParams.get('tgWebAppData') ?? '';
    // Regression: the SDK rejects initData without `signature` (real Telegram always sends it).
    for (const field of ['auth_date', 'user', 'hash', 'signature']) {
      expect({ field, present: new URLSearchParams(initData).has(field) }).toEqual({
        field,
        present: true,
      });
    }
    const result = validateInitData(initData, {
      botToken: TEST_BOT_TOKEN,
      now: new Date(),
      maxAgeSec: 60,
      clockSkewSec: 60,
    });
    expect(result).toMatchObject({
      ok: true,
      data: { user: { id: 700000001, languageCode: 'en' } },
    });
  });

  it('refuses to run in production', async () => {
    await expect(run({ BOT_TOKEN: TEST_BOT_TOKEN, NODE_ENV: 'production' })).rejects.toMatchObject({
      code: 1,
    });
  });

  it('refuses to run without a valid BOT_TOKEN', async () => {
    await expect(run({ BOT_TOKEN: 'not-a-token' })).rejects.toMatchObject({ code: 1 });
  });
});
