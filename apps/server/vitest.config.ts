import { defineProject } from 'vitest/config';

/** Shared settings for the `server` and `server-safety` projects (see the root vitest.config.ts). */
export default defineProject({
  test: {
    environment: 'node',
    globalSetup: ['./test/support/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
