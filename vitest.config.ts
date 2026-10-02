import { defineConfig } from 'vitest/config';

// `pnpm test` runs every project; `pnpm test:safety` runs only `server-safety`.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'shared',
          root: './packages/shared',
          environment: 'node',
          include: ['src/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'content',
          root: './content',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
      {
        extends: './apps/server/vitest.config.ts',
        test: {
          name: 'server',
          root: './apps/server',
          include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
          exclude: ['test/safety/**'],
        },
      },
      {
        extends: './apps/server/vitest.config.ts',
        test: {
          name: 'server-safety',
          root: './apps/server',
          include: ['test/safety/**/*.test.ts'],
        },
      },
      './apps/miniapp/vite.config.ts',
    ],
  },
});
