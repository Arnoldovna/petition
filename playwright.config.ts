import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against the production image in the isolated compose project `petition-e2e`, started by `pnpm test:e2e`
 * (scripts/run-e2e.mjs), which also sets E2E_BASE_URL. There is deliberately no `webServer`: nothing may silently
 * reuse the dev or demo stack (conventions §6, ADR 0017). Phase-5 units run against the URL `pnpm e2e:up` prints.
 */
const baseURL = process.env['E2E_BASE_URL'];
if (!baseURL) {
  throw new Error('E2E_BASE_URL is not set. Run `pnpm test:e2e`, or `pnpm e2e:up` and pass the URL it prints.');
}

/** Asserts the pristine seed (totals, page 2, city counts), so it runs first and alone (ADR 0015, 0017). */
const SEED_READONLY_SPECS = ['**/supporters.spec.ts'];

/**
 * README media has its own config, playwright.media.config.ts (portfolio-readme skill). A project's `testIgnore`
 * replaces the top-level one instead of adding to it, so every project that sets its own must list this too.
 */
const MEDIA_SPECS = ['**/readme-media.spec.ts'];

export default defineConfig({
  testDir: './e2e',
  testIgnore: MEDIA_SPECS,
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0, // a flaky test is a failing test: fix the cause (quality-gate), never retry it green
  // One app container (384 MiB, two concurrent password hashes) serves every worker (ADR 0019 section 6).
  workers: process.env['CI'] ? 2 : 4,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'seed-readonly',
      testMatch: SEED_READONLY_SPECS,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'desktop',
      testIgnore: [...SEED_READONLY_SPECS, ...MEDIA_SPECS],
      dependencies: ['seed-readonly'],
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      name: 'mobile',
      testIgnore: [...SEED_READONLY_SPECS, ...MEDIA_SPECS],
      dependencies: ['seed-readonly'],
      use: { ...devices['Pixel 7'], viewport: { width: 390, height: 844 } },
    },
    {
      // Pointer capture and touch fixes (B-36, B-37) matter most on iOS Safari. The spec signs, which changes the
      // totals seed-readonly asserts, so it waits for that project too (ADR 0019 section 6).
      name: 'webkit-iphone',
      testMatch: ['**/signature-pad.spec.ts'],
      dependencies: ['seed-readonly'],
      use: { ...devices['iPhone 15'] },
    },
  ],
});
