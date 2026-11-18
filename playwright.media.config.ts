import { defineConfig, devices } from '@playwright/test';

/**
 * README media only (portfolio-readme skill): `pnpm media:readme` against the seeded `pnpm demo` stack, never in CI.
 * It runs the README screenshots and clip (e2e/readme-media.spec.ts) and the GitHub social preview
 * (e2e/social-preview.spec.ts, a local page that needs no server). playwright.config.ts ignores both specs, so the
 * normal e2e run never captures media. Like that config, this one has no `webServer`: it needs E2E_BASE_URL set to the
 * URL `pnpm demo` prints.
 */
const baseURL = process.env['E2E_BASE_URL'];
if (!baseURL) throw new Error('E2E_BASE_URL is not set (the URL `pnpm demo` prints).');

export default defineConfig({
  testDir: './e2e',
  testMatch: ['readme-media.spec.ts', 'social-preview.spec.ts'],
  outputDir: 'test-results/media',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { baseURL, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [{ name: 'media', use: { ...devices['Desktop Chrome'] } }],
});
