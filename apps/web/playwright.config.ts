import { defineConfig } from '@playwright/test';

// PW_CHROMIUM_PATH lets a machine that already has a Chromium reuse it; normally Playwright's own download is used.
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const launchOptions = { executablePath };

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
  projects: [
    {
      name: 'mobile-375',
      testIgnore: /production\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:3100',
        viewport: { width: 375, height: 812 },
        launchOptions,
      },
    },
    {
      name: 'desktop-1280',
      testIgnore: /production\.spec\.ts/,
      use: {
        baseURL: 'http://localhost:3100',
        viewport: { width: 1280, height: 800 },
        launchOptions,
      },
    },
    {
      name: 'production-build',
      testMatch: /production\.spec\.ts/,
      use: { baseURL: 'http://localhost:3101', launchOptions },
    },
  ],
  webServer: [
    {
      command: 'pnpm exec next dev -p 3100',
      url: 'http://localhost:3100/',
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: 'pnpm exec next build && pnpm exec next start -p 3101',
      url: 'http://localhost:3101/',
      env: { NEXT_DIST_DIR: '.next-prod' },
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
