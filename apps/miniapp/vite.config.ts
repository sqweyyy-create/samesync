import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  // Only these keys are read from the root .env, and only by this Node-side config.
  // Nothing is exposed to client code (Vite only exposes VITE_* variables, and we define none).
  const env = loadEnv(mode, repoRoot, ['MINIAPP_DEV_', 'HTTP_PORT']);
  const apiPort = env['HTTP_PORT'] ?? '3000';
  const allowedHosts = (env['MINIAPP_DEV_ALLOWED_HOSTS'] ?? '.trycloudflare.com')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

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
      include: ['src/**/*.test.{ts,tsx}'],
    },
  };
});
