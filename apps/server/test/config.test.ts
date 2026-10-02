import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { ConfigError, DEFAULT_CONTENT_DIR, loadConfig } from '../src/config';
import { TEST_BOT_TOKEN } from './support/fixtures';

const VALID = {
  BOT_TOKEN: TEST_BOT_TOKEN,
  DATABASE_URL: 'postgres://samesync_app:pw@127.0.0.1:5432/samesync',
  MINIAPP_URL: 'https://miniapp.samesync.test',
};

function issuesOf(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.issues.map((i) => i.variable);
    throw error;
  }
  return [];
}

describe('loadConfig', () => {
  it('applies safe defaults', () => {
    expect(loadConfig(VALID)).toEqual({
      nodeEnv: 'development',
      logLevel: 'info',
      botToken: TEST_BOT_TOKEN,
      databaseUrl: VALID.DATABASE_URL,
      miniAppUrl: 'https://miniapp.samesync.test',
      http: { host: '127.0.0.1', port: 3000 },
      initData: { maxAgeSec: 86_400, clockSkewSec: 60 },
      u18PoolEnabled: false,
      adminTelegramIds: [],
      contentDir: DEFAULT_CONTENT_DIR,
    });
  });

  it('names every missing required variable', () => {
    expect(issuesOf({}).sort()).toEqual(['BOT_TOKEN', 'DATABASE_URL', 'MINIAPP_URL']);
  });

  it('treats empty values (as copied from .env.example) as missing', () => {
    expect(issuesOf({ ...VALID, BOT_TOKEN: '', HTTP_PORT: '' })).toEqual(['BOT_TOKEN']);
  });

  it('rejects invalid values and names the variable, never the value', () => {
    const secret = '12345:this-is-not-a-valid-token';
    let message = '';
    try {
      loadConfig({ ...VALID, BOT_TOKEN: secret, DATABASE_URL: 'mysql://x', HTTP_PORT: 'eighty' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('BOT_TOKEN');
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('HTTP_PORT');
    expect(message).not.toContain(secret);
    expect(message).not.toContain('mysql://x');
  });

  it('defaults CONTENT_DIR to the repository content folder', async () => {
    const { existsSync } = await import('node:fs');
    expect(existsSync(`${DEFAULT_CONTENT_DIR}/release.json`)).toBe(true);
  });

  it('requires an https Mini App URL', () => {
    expect(issuesOf({ ...VALID, MINIAPP_URL: 'http://localhost:5173' })).toEqual(['MINIAPP_URL']);
  });

  it('parses booleans strictly and admin IDs as numbers', () => {
    expect(issuesOf({ ...VALID, U18_POOL_ENABLED: 'yes' })).toEqual(['U18_POOL_ENABLED']);
    expect(issuesOf({ ...VALID, ADMIN_TELEGRAM_IDS: '12,abc' })).toEqual(['ADMIN_TELEGRAM_IDS']);
    expect(loadConfig({ ...VALID, ADMIN_TELEGRAM_IDS: '12,34' }).adminTelegramIds).toEqual([
      12, 34,
    ]);
  });

  it('refuses U18_POOL_ENABLED=true in production (release gate G3)', () => {
    expect(issuesOf({ ...VALID, NODE_ENV: 'production', U18_POOL_ENABLED: 'true' })).toEqual([
      'U18_POOL_ENABLED',
    ]);
    expect(
      loadConfig({ ...VALID, NODE_ENV: 'development', U18_POOL_ENABLED: 'true' }).u18PoolEnabled,
    ).toBe(true);
  });
});

describe('server process', () => {
  it('refuses to start with missing env and names the variables', async () => {
    const tsxCli = createRequire(import.meta.url).resolve('tsx/cli');
    const main = fileURLToPath(new URL('../src/main.ts', import.meta.url));
    const run = promisify(execFile)(process.execPath, [tsxCli, main], {
      env: { PATH: process.env['PATH'] ?? '' },
      timeout: 15_000,
    });
    const failure = await run.then(
      () => null,
      (error: { code?: number; stdout?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toContain('invalid configuration, refusing to start');
    expect(failure?.stdout).toContain('BOT_TOKEN');
    expect(failure?.stdout).toContain('DATABASE_URL');
  });
});
