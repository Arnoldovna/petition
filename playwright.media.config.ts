import { defineConfig, devices } from '@playwright/test';

/**
 * Media only, against the seeded `pnpm demo` stack, never in CI. Two projects:
 *
 * - `media` (`pnpm media:readme`, portfolio-readme skill): the README screenshots (e2e/readme-media.spec.ts) and the
 *   GitHub social preview (e2e/social-preview.spec.ts, a local page that needs no server).
 * - `recording` (`pnpm media:record`, run through scripts/record-demo.mjs): the demo video of the whole journey on
 *   desktop and mobile (e2e/demo-recording.spec.ts), which the script encodes to WebM, MP4 and the README GIF.
 *
 * playwright.config.ts ignores all three specs, so the normal e2e run never captures media. Like that config, this one
 * has no `webServer`: it needs E2E_BASE_URL set to the URL `pnpm demo` prints (scripts/record-demo.mjs sets it from
 * APP_PORT when it is missing).
 */
const baseURL = process.env['E2E_BASE_URL'];
if (!baseURL) throw new Error('E2E_BASE_URL is not set (the URL `pnpm demo` prints).');

export default defineConfig({
  testDir: './e2e',
  outputDir: 'test-results/media',
  forbidOnly: true,
  retries: 0,
  workers: 1,
  fullyParallel: false,
  reporter: 'list',
  use: { ...devices['Desktop Chrome'], baseURL, trace: 'off', screenshot: 'off', video: 'off' },
  projects: [
    { name: 'media', testMatch: ['readme-media.spec.ts', 'social-preview.spec.ts'] },
    { name: 'recording', testMatch: ['demo-recording.spec.ts'] },
  ],
});
