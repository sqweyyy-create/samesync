import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readDevEnv } from './dev-env';

let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('readDevEnv', () => {
  it('reads the dev-server settings without turning the build into a development build', () => {
    dir = mkdtempSync(join(tmpdir(), 'samesync-env-'));
    const envPath = join(dir, '.env');
    writeFileSync(
      envPath,
      'NODE_ENV=development\nMINIAPP_DEV_ALLOWED_HOSTS=.example.test, b.test\nHTTP_PORT=3100\n',
    );
    const nodeEnv = process.env['NODE_ENV'];
    delete process.env['VITE_USER_NODE_ENV'];

    expect(readDevEnv(envPath)).toEqual({
      allowedHosts: ['.example.test', 'b.test'],
      apiPort: '3100',
    });
    // Regression: Vite's loadEnv() set VITE_USER_NODE_ENV=development here and broke `vite build`.
    expect(process.env['VITE_USER_NODE_ENV']).toBeUndefined();
    expect(process.env['NODE_ENV']).toBe(nodeEnv);
  });

  it('falls back to defaults without a .env file', () => {
    expect(readDevEnv('/nonexistent/.env')).toEqual({
      allowedHosts: ['.trycloudflare.com'],
      apiPort: '3000',
    });
  });
});
