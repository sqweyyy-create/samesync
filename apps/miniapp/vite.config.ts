import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import { readDevEnv } from './dev-env';

const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));

export default defineConfig(() => {
  // Only the dev-server settings are read from the root .env, and only by this Node-side config.
  // Nothing is exposed to client code (Vite only exposes VITE_* variables, and we define none).
  const { allowedHosts, apiPort } = readDevEnv(rootEnv);

  return {
    plugins: [react()],
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      allowedHosts,
      // Same-origin API in dev, as in production: no CORS needed.
      proxy: { '/api': { target: `http://127.0.0.1:${apiPort}` } },
    },
    build: { target: 'es2022' },
    test: {
      name: 'miniapp',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}', 'dev-env.test.ts'],
    },
  };
});
