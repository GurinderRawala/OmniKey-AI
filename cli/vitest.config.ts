import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    isolate: true,
    // Fail fast on hung network/stdin paths instead of the 5s default hiding them.
    testTimeout: 20_000,
    // Never let a test touch the user's ~/.omnikey config or daemon.
    env: {
      HOME: process.env.TMPDIR || '/nonexistent-omnikey-test-home',
      USERPROFILE: process.env.TMPDIR || '/nonexistent-omnikey-test-home',
    },
  },
});
