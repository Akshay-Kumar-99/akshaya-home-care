import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// End-to-end tests drive the real production build against the Neon TEST branch (which the
// global setup wipes). Android Chrome (Pixel 7) is the primary target; the Master's desktop
// is 1366×768. Run: npm run build && npm run test:e2e

if (existsSync('.env')) process.loadEnvFile('.env');
const testDb = process.env.TEST_DATABASE_URL;
if (!testDb) throw new Error('TEST_DATABASE_URL must be set for e2e tests');
if (process.env.DATABASE_URL && new URL(process.env.DATABASE_URL).hostname === new URL(testDb).hostname) {
  throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL');
}

const PORT = 3200;

export default defineConfig({
  testDir: 'tests/e2e',
  globalSetup: './tests/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'android',
      testMatch: /mobile\.spec\.ts/,
      // Light on the phone project, dark on desktop: both themes are exercised every run.
      use: { ...devices['Pixel 7'], colorScheme: 'light', permissions: ['clipboard-read', 'clipboard-write'] },
    },
    {
      name: 'desktop',
      testMatch: /desktop\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1366, height: 768 },
        colorScheme: 'dark',
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],
  webServer: {
    command: 'node src/server/index.ts',
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: 'production',
      PORT: String(PORT),
      DATABASE_URL: testDb,
      // Same pepper the e2e setup hashes PINs with (tests/integration/helpers.ts TEST_PEPPER).
      PIN_PEPPER: Buffer.alloc(32, 7).toString('base64'),
      TRUST_PROXY: 'false',
    },
  },
});
