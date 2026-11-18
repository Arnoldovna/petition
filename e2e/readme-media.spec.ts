import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { type Browser, type BrowserContextOptions, type Page, test } from '@playwright/test';

// Only the form helpers: this spec drives its own browser contexts against the demo stack, so it keeps the plain
// Playwright `test` instead of the harness fixtures (CSP guard, worker user) of the e2e suite.
import { expect, logOut, postStatus, submitLogin } from './fixtures.ts';
import { DESKTOP, deviceOptions, drawSignature, MEDIA_DIR, MOBILE, settle } from './media.ts';

/**
 * README media (portfolio-readme skill), run on demand against the seeded `pnpm demo` stack, never in CI:
 *
 *   E2E_BASE_URL=http://127.0.0.1:3000 pnpm media:readme
 *
 * (`media:readme` loads `.env` for SEED_DEMO_PASSWORD; use the URL `pnpm demo` prints.) It writes the four PNGs to
 * docs/media/. The demo video and the README GIF come from demo-recording.spec.ts (`pnpm media:record`).
 *
 * Signs in as the seeded demo account (`demo@petition.test`, `SEED_DEMO_PASSWORD`), which the seed leaves unsigned.
 * It signs the petition with a drawn signature for the thank-you screenshot; `afterAll` deletes that signature again
 * through the real `/signature/delete` form, so the demo database ends exactly as the seed left it. If the demo account has already
 * signed, nothing is captured and nothing is changed.
 */
const DEMO_EMAIL = 'demo@petition.test';

type Scheme = 'light' | 'dark';

test.describe.configure({ mode: 'serial' });

let storageState: BrowserContextOptions['storageState'];

function demoPassword(): string {
  const password = process.env['SEED_DEMO_PASSWORD'];
  if (!password) throw new Error('SEED_DEMO_PASSWORD is not set: run with node --env-file=.env (see the file header)');
  return password;
}

function contextOptions(viewport: { width: number; height: number }, scheme: Scheme): BrowserContextOptions {
  return {
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: 'reduce',
    storageState,
    ...deviceOptions(viewport),
  };
}

/** Opens `url` in a fresh context, runs the optional `prepare` step and writes the screenshot to docs/media/`path`. */
async function capture(
  browser: Browser,
  path: string,
  options: BrowserContextOptions,
  url: string,
  prepare?: (page: Page) => Promise<void>,
): Promise<void> {
  const context = await browser.newContext(options);
  try {
    const page = await context.newPage();
    await page.goto(url);
    await settle(page);
    await prepare?.(page);
    await page.screenshot({ path: join(MEDIA_DIR, path) });
  } finally {
    await context.close();
  }
}

test.beforeAll(async ({ browser }) => {
  await mkdir(MEDIA_DIR, { recursive: true });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto('/login');
    const login = await submitLogin(page, DEMO_EMAIL, demoPassword());
    // A 401 re-renders /login in place, so waiting for another URL would only time out without saying why.
    expect(login, 'demo login failed: does SEED_DEMO_PASSWORD in .env match the seeded demo stack?').toBe(303);
    await page.waitForURL((url) => url.pathname !== '/login');
    const landedOn = new URL(page.url()).pathname;
    // The seed leaves the demo account unsigned; anything else means a reviewer is using it, so leave it alone and
    // end the session this run opened (logging out also ends it in Redis, so no live session is left behind).
    if (landedOn !== '/signature') await logOut(page);
    expect(landedOn, 'the demo account must be unsigned').toBe('/signature');
    storageState = await context.storageState();
  } finally {
    await context.close();
  }
});

test.afterAll(async ({ browser }) => {
  if (!storageState) return;
  const context = await browser.newContext({ storageState });
  try {
    const page = await context.newPage();
    await page.goto('/signature/delete');
    if (new URL(page.url()).pathname === '/signature/delete') {
      const deleted = await postStatus(page, '/signature/delete', () =>
        page.getByRole('button', { name: 'delete my signature' }).click(),
      );
      expect(deleted, 'delete the demo signature').toBe(303);
      await page.waitForURL('**/signature');
    }
    await logOut(page);
  } finally {
    await context.close();
  }
});

for (const scheme of ['light', 'dark'] as const) {
  test(`@media desktop ${scheme}: supporters list`, async ({ browser }) => {
    await capture(browser, `desktop-${scheme}.png`, contextOptions(DESKTOP, scheme), '/supporters');
  });
}

test('@media mobile light: drawn signature on the pad', async ({ browser }) => {
  await capture(browser, 'mobile-light.png', contextOptions(MOBILE, 'light'), '/signature', async (page) => {
    await drawSignature(page);
    await page.evaluate(() => {
      window.scrollTo({ top: 0, behavior: 'instant' });
    });
  });
});

// The thank-you screenshot below needs a signature: the demo account signs here with the drawn "Mara", and `afterAll`
// deletes it again.
test('@media sign as the demo account', async ({ browser }) => {
  const context = await browser.newContext({ viewport: DESKTOP, storageState });
  try {
    const page = await context.newPage();
    await page.goto('/signature');
    await settle(page);
    await drawSignature(page);
    await page.getByRole('button', { name: 'sign the petition' }).click();
    await page.waitForURL('**/thank-you');
  } finally {
    await context.close();
  }
});

test('@media mobile dark: thank-you page', async ({ browser }) => {
  await capture(browser, 'mobile-dark.png', contextOptions(MOBILE, 'dark'), '/thank-you');
});
