import { defineConfig } from 'vitest/config';
import path from 'path';
import { config as loadDotenv } from 'dotenv';

// Load the repo-root .env so tests resolve required env vars (DATABASE_URL,
// IS_SELF_HOSTED, etc.) the same way the original single-package layout did.
loadDotenv({ path: path.resolve(__dirname, '..', '.env') });

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Each test file gets its own isolated module graph; matches Jest semantics
    // and keeps `vi.mock` / `vi.doMock` scoping predictable.
    isolate: true,
    // Provide defaults so importing ./config doesn't throw when individual
    // test files (or transitively imported modules) touch the config singleton.
    // Tests that exercise other providers set their own.
    env: {
      OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-dummy',
      DATABASE_URL: process.env.DATABASE_URL || 'postgres://user:pass@localhost:5432/omnikey_test',
      IS_SELF_HOSTED: process.env.IS_SELF_HOSTED || 'true',
    },
  },
});
