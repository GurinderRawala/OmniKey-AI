import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Each test file gets its own isolated module graph; matches Jest semantics
    // and keeps `vi.mock` / `vi.doMock` scoping predictable.
    isolate: true,
    // Provide a default OPENAI_API_KEY so importing ./config doesn't throw
    // when individual test files (or transitively imported modules) touch the
    // config singleton. Tests that exercise other providers set their own.
    env: {
      OPENAI_API_KEY: 'sk-test-dummy',
    },
  },
});
