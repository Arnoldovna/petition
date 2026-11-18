import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { type Browser, type BrowserContextOptions, type Page, test, type Video } from '@playwright/test';

// Only the form helpers: this spec drives its own browser contexts against the demo stack, so it keeps the plain
// Playwright `test` instead of the harness fixtures (CSP guard, worker user) of the e2e suite.
import { expect, logOut, postStatus, submitLogin } from './fixtures.ts';

/**
 * README media (portfolio-readme skill), run on demand against the seeded `pnpm demo` stack, never in CI:
 *
 *   E2E_BASE_URL=http://127.0.0.1:3000 pnpm media:readme
 *
 * (`media:readme` loads `.env` for SEED_DEMO_PASSWORD; use the URL `pnpm demo` prints.) It writes the four PNGs to
 * docs/media/ and the sign-flow clip to test-results/media/sign-flow.webm. GitHub does not play WebM in a README, so
 * convert the clip to the GIF the README shows (keep it under 3 MB):
 *
 *   ffmpeg -i test-results/media/sign-flow.webm \
 *     -vf "setpts=PTS/1.4,fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse" \
 *     -loop 0 docs/media/sign-flow.gif
 *
 * Signs in as the seeded demo account (`demo@petition.test`, `SEED_DEMO_PASSWORD`), which the seed leaves unsigned.
 * The clip signs the petition with a drawn signature; `afterAll` deletes that signature again through the real
 * `/signature/delete` form, so the demo database ends exactly as the seed left it. If the demo account has already
 * signed, nothing is captured and nothing is changed.
 */
/** Resolved from this file, not the working directory, so the media always lands in the repository's docs/media. */
const OUT = resolve(import.meta.dirname, '..', 'docs', 'media');
/** The clip's file name inside the config's outputDir, which is gitignored and cleaned at the start of every run. */
const CLIP = 'sign-flow.webm';
const DEMO_EMAIL = 'demo@petition.test';
const DESKTOP = { width: 1440, height: 900 } as const;
const MOBILE = { width: 390, height: 844 } as const;

type Scheme = 'light' | 'dark';

/** A point on the pad, 0..1 on both axes. */
type PadPoint = readonly [x: number, y: number];

test.describe.configure({ mode: 'serial' });

let storageState: BrowserContextOptions['storageState'];

function demoPassword(): string {
  const password = process.env['SEED_DEMO_PASSWORD'];
  if (!password) throw new Error('SEED_DEMO_PASSWORD is not set: run with node --env-file=.env (see the file header)');
  return password;
}

async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.getByRole('main')).toBeVisible();
}

function contextOptions(viewport: { width: number; height: number }, scheme: Scheme): BrowserContextOptions {
  return {
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: 'reduce',
    storageState,
    ...(viewport.width < 640 ? { isMobile: true, hasTouch: true } : {}),
  };
}

/** Control points of a cursive "Mara" with a flourish, then an underline: two strokes, smoothed below. */
const SIGNATURE_CONTROL_POINTS: readonly (readonly PadPoint[])[] = [
  [
    [0.08, 0.7],
    [0.11, 0.4],
    [0.135, 0.18],
    [0.155, 0.45],
    [0.175, 0.66],
    [0.2, 0.38],
    [0.225, 0.2],
    [0.245, 0.48],
    [0.265, 0.68],
    [0.3, 0.58],
    [0.335, 0.48],
    [0.315, 0.45],
    [0.29, 0.52],
    [0.295, 0.63],
    [0.32, 0.64],
    [0.34, 0.52],
    [0.345, 0.47],
    [0.35, 0.6],
    [0.365, 0.66],
    [0.385, 0.55],
    [0.4, 0.47],
    [0.415, 0.5],
    [0.43, 0.47],
    [0.445, 0.52],
    [0.455, 0.62],
    [0.48, 0.66],
    [0.51, 0.56],
    [0.53, 0.48],
    [0.515, 0.46],
    [0.49, 0.5],
    [0.49, 0.62],
    [0.515, 0.64],
    [0.535, 0.53],
    [0.54, 0.47],
    [0.545, 0.6],
    [0.56, 0.67],
    [0.62, 0.62],
    [0.72, 0.5],
    [0.8, 0.4],
  ],
  [
    [0.12, 0.84],
    [0.35, 0.8],
    [0.6, 0.79],
    [0.78, 0.76],
  ],
];

/** Catmull-Rom interpolation through `points`, `samples` points per segment, so the strokes curve like a pen line. */
function smooth(points: readonly PadPoint[], samples = 6): PadPoint[] {
  const at = (index: number): PadPoint => points[Math.min(Math.max(index, 0), points.length - 1)] ?? [0, 0];
  const result: PadPoint[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [p0, p1, p2, p3] = [at(index - 1), at(index), at(index + 1), at(index + 2)];
    for (let step = 0; step < samples; step += 1) {
      const t = step / samples;
      const blend = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t ** 2 + (3 * b - a - 3 * c + d) * t ** 3);
      result.push([blend(p0[0], p1[0], p2[0], p3[0]), blend(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  result.push(at(points.length - 1));
  return result;
}

async function drawSignature(page: Page): Promise<void> {
  const pad = page.getByRole('img', { name: 'Signature pad' });
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  if (!box) throw new Error('the signature pad is not visible');
  const toViewport = ([x, y]: PadPoint): [number, number] => [box.x + x * box.width, box.y + y * box.height];
  for (const stroke of SIGNATURE_CONTROL_POINTS.map((points) => smooth(points))) {
    const [first, ...rest] = stroke;
    if (!first) continue;
    await page.mouse.move(...toViewport(first));
    await page.mouse.down();
    for (const point of rest) await page.mouse.move(...toViewport(point), { steps: 2 });
    await page.mouse.up();
  }
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
    await page.screenshot({ path: join(OUT, path) });
  } finally {
    await context.close();
  }
}

test.beforeAll(async ({ browser }) => {
  await mkdir(OUT, { recursive: true });
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
      expect(deleted, 'delete the clip signature').toBe(303);
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

test('@media sign-flow clip: draw, sign, thank-you page', async ({ browser }, testInfo) => {
  const context = await browser.newContext({
    viewport: DESKTOP,
    colorScheme: 'light',
    storageState,
    recordVideo: { dir: testInfo.outputPath('raw'), size: DESKTOP },
  });
  // Assigned in `try`: when that throws, the context still closes and the test fails before `video` is read.
  let video: Video | null;
  try {
    const page = await context.newPage();
    video = page.video();
    await page.goto('/signature');
    await settle(page);
    // The pauses are for the viewer of the clip, not for the app: each one is a beat before the next step.
    await page.waitForTimeout(800);
    await drawSignature(page);
    await page.waitForTimeout(600);
    const sign = page.getByRole('button', { name: 'sign the petition' });
    await sign.hover();
    await page.waitForTimeout(300);
    await sign.click();
    await page.waitForURL('**/thank-you');
    await settle(page);
    await page.waitForTimeout(2500);
  } finally {
    await context.close(); // also on failure; closing finalises the video file
  }
  if (!video) throw new Error('the context did not record a video');
  await video.saveAs(join(testInfo.project.outputDir, CLIP));
});

test('@media mobile dark: thank-you page', async ({ browser }) => {
  await capture(browser, 'mobile-dark.png', contextOptions(MOBILE, 'dark'), '/thank-you');
});
