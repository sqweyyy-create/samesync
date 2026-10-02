import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

export interface DevEnv {
  allowedHosts: string[];
  apiPort: string;
}

/**
 * Reads the two dev-server settings from the repository's root .env.
 *
 * Deliberately not Vite's loadEnv(): it treats `NODE_ENV=development` in an env file as a request
 * for a development build (it sets VITE_USER_NODE_ENV), so a normal root .env would turn
 * `vite build` into a dev build with React's development runtime and the dev-only Telegram mock.
 * parseEnv has no side effects on process.env.
 */
export function readDevEnv(envPath: string): DevEnv {
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  return {
    allowedHosts: (env['MINIAPP_DEV_ALLOWED_HOSTS'] ?? '.trycloudflare.com')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    apiPort: env['HTTP_PORT'] ?? '3000',
  };
}
