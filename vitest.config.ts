import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts because that file sets root to src/web.
export default defineConfig({
  test: {
    root: '.',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    // Integration files share one test database, so files run one at a time.
    fileParallelism: false,
    // Neon (Singapore) round trips plus cold starts: allow generous time.
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
