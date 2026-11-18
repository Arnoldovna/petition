import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { type Browser, type BrowserContext, type Locator, type Page, test } from '@playwright/test';

// Only the form helpers: like readme-media.spec.ts, this spec drives its own browser contexts against the demo stack
// and keeps the plain Playwright `test` instead of the harness fixtures of the e2e suite.
import { expect, flash, fullName, supporterRow } from './fixtures.ts';
import { DESKTOP, deviceOptions, drawSignature, MOBILE, settle } from './media.ts';

/**
 * The demo video (Etappe 3b in PLAN.md: petition has no live server, a screen recording shows it instead), run on
 * demand against the seeded `pnpm demo` stack, never in CI:
 *
 *   pnpm media:record
 *
 * scripts/record-demo.mjs runs this spec (project `recording` of playwright.media.config.ts) and encodes the two raw
 * recordings it leaves in test-results/media/ into docs/media/demo-{desktop,mobile}.{webm,mp4} and the README GIF.
 *
 * One test per viewport (desktop 1440 x 900, mobile 390 x 844) records the whole journey of a new visitor:
 * register, add a profile, draw and sign, find the own row on the supporters list, edit the profile, delete the
 * signature. Every step waits on what the app shows (URL, flash, row), never on time; the only fixed waits are the
 * `beat`s, short pauses that let a viewer follow, and the typing runs key by key at a readable speed.
 *
 * Each run registers a fresh `@petition.test` account (the reserved demo domain, so the seed's foreign-user guard of
 * ADR 0016 stays quiet) and deletes it again afterwards, recorded or not, so the demo database ends as it was. Each
 * registration counts against the auth rate limit (RATE_LIMIT_AUTH_MAX, 10 per 15 minutes from one address), so a
 * full run uses two of those attempts; after several runs in a row, wait for the window or the page says
 * "Too many attempts".
 */

interface Visitor {
  firstName: string;
  lastName: string;
  age: string;
  city: string;
  /** The city the profile edit changes to. */
  movedTo: string;
}

interface Recording {
  name: 'desktop' | 'mobile';
  viewport: { width: number; height: number };
  visitor: Visitor;
}

const RECORDINGS: readonly Recording[] = [
  {
    name: 'desktop',
    viewport: DESKTOP,
    visitor: { firstName: 'Lena', lastName: 'Brandt', age: '34', city: 'Leipzig', movedTo: 'Halle (Saale)' },
  },
  {
    name: 'mobile',
    viewport: MOBILE,
    visitor: { firstName: 'Jonas', lastName: 'Weber', age: '27', city: 'Bremen', movedTo: 'Hamburg' },
  },
];

/** Delay between two keystrokes: fast enough to keep the video short, slow enough to read along. */
const TYPING_DELAY_MS = 45;

/** A pause for the viewer of the video, not for the app: the app state is always awaited before it. */
async function beat(page: Page, milliseconds = 700): Promise<void> {
  await page.waitForTimeout(milliseconds);
}

/**
 * Headless recordings show no mouse pointer, so a viewer could not see what is clicked. This draws a small ring at
 * the pointer position (filled with the accent while a button is down) and carries the position over navigations.
 * It is added through the CSSOM, which the app's CSP allows, and is invisible to assistive technology.
 */
function installPointerRing(): void {
  const KEY = 'recording-pointer';
  const show = (): void => {
    const ring = document.createElement('div');
    ring.setAttribute('aria-hidden', 'true');
    Object.assign(ring.style, {
      position: 'fixed',
      insetBlockStart: '0',
      insetInlineStart: '0',
      inlineSize: '20px',
      blockSize: '20px',
      margin: '-10px 0 0 -10px',
      border: '2px solid #000',
      borderRadius: '50%',
      background: 'transparent',
      pointerEvents: 'none',
      zIndex: '2147483647',
    });
    const place = (x: number, y: number): void => {
      ring.style.transform = `translate(${String(x)}px, ${String(y)}px)`;
    };
    let [x = -40, y = -40] = (sessionStorage.getItem(KEY) ?? '').split(',').map(Number);
    place(x, y);
    document.documentElement.append(ring);
    addEventListener(
      'mousemove',
      (event) => {
        [x, y] = [event.clientX, event.clientY];
        place(x, y);
      },
      { passive: true },
    );
    addEventListener('pagehide', () => {
      sessionStorage.setItem(KEY, `${String(x)},${String(y)}`);
    });
    addEventListener('mousedown', () => {
      ring.style.background = '#f85d33';
    });
    addEventListener('mouseup', () => {
      ring.style.background = 'transparent';
    });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show, { once: true });
  else show();
}

/** Waits until the page shows `url` with its fonts, then pauses for the viewer. */
async function arrive(page: Page, url: RegExp, pause = 700): Promise<void> {
  await expect(page).toHaveURL(url);
  await settle(page);
  await beat(page, pause);
}

/** Moves the pointer visibly onto `target`, `x` of the way across it (0..1). */
async function pointAt(page: Page, target: Locator, x = 0.5): Promise<void> {
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  if (!box) throw new Error('the pointer target is not visible');
  await page.mouse.move(box.x + box.width * x, box.y + box.height / 2, { steps: 15 });
}

/** Moves the pointer visibly onto `target`, pauses briefly and clicks it. */
async function pointAndClick(page: Page, target: Locator): Promise<void> {
  await pointAt(page, target);
  await beat(page, 250);
  await target.click();
}

/** Clicks into a field and types `text` key by key, so the video shows the typing. */
async function typeInto(page: Page, field: Locator, text: string): Promise<void> {
  await pointAndClick(page, field);
  await field.clear();
  await field.pressSequentially(text, { delay: TYPING_DELAY_MS });
}

/** Scrolls `target` smoothly into the middle of the viewport and waits until it is there. */
async function scrollToCentre(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
  await expect(target).toBeInViewport({ ratio: 1 });
}

function mainNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

/** The recorded journey. `password` is typed into the register form; the page ends signed in, without a signature. */
async function journey(page: Page, visitor: Visitor, email: string, password: string): Promise<void> {
  await page.goto('/');
  await settle(page);
  await beat(page, 1200);

  // 1. Register.
  await pointAndClick(page, mainNav(page).getByRole('link', { name: 'register' }));
  await arrive(page, /\/register$/);
  await typeInto(page, page.locator('#firstName'), visitor.firstName);
  await typeInto(page, page.locator('#lastName'), visitor.lastName);
  await typeInto(page, page.locator('#email'), email);
  await typeInto(page, page.locator('#password'), password);
  await beat(page, 400);
  await pointAndClick(page, page.getByRole('button', { name: 'register' }));

  // 2. Profile (onboarding).
  await arrive(page, /\/profile$/);
  await typeInto(page, page.locator('#age'), visitor.age);
  await typeInto(page, page.locator('#city'), visitor.city);
  await beat(page, 400);
  await pointAndClick(page, page.getByRole('button', { name: 'continue' }));

  // 3. Sign with a drawn signature.
  await arrive(page, /\/signature$/);
  await drawSignature(page);
  await beat(page, 600);
  await pointAndClick(page, page.getByRole('button', { name: 'sign the petition' }));
  await arrive(page, /\/thank-you$/, 2000);

  // 4. The supporters list: new signers are appended, so the own row is on the last page.
  await pointAndClick(page, page.getByRole('link', { name: 'see all supporters' }));
  await arrive(page, /\/supporters$/, 1200);
  // Page by page to the end, however many pages the demo database has by now (none when everything fits on one).
  const next = page.getByRole('navigation', { name: 'Pagination' }).getByRole('link', { name: 'next page' });
  while ((await next.count()) > 0) {
    const from = page.url();
    await scrollToCentre(next);
    await beat(page, 400);
    await pointAndClick(page, next);
    await expect(page).not.toHaveURL(from);
    await settle(page);
  }
  const ownRow = supporterRow(page, fullName(visitor));
  await scrollToCentre(ownRow);
  await pointAt(page, ownRow, 1 / 3);
  await beat(page, 1800);

  // 5. Edit the profile: a new city.
  await pointAndClick(page, mainNav(page).getByRole('link', { name: 'profile' }));
  await arrive(page, /\/profile\/edit$/);
  await typeInto(page, page.locator('#city'), visitor.movedTo);
  await beat(page, 400);
  await pointAndClick(page, page.getByRole('button', { name: 'save changes' }));
  await expect(flash(page)).toHaveText('Profile updated');
  await page.evaluate(() => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  await beat(page, 1500);

  // 6. Delete the signature through its confirmation page.
  await pointAndClick(page, page.getByRole('link', { name: /^delete signature/ }));
  await arrive(page, /\/signature\/delete$/, 1200);
  await pointAndClick(page, page.getByRole('button', { name: 'delete my signature' }));
  await expect(page).toHaveURL(/\/signature$/);
  await expect(flash(page)).toHaveText('Your signature was removed');
  await beat(page, 2200);
}

/**
 * Closes the recording context (which finalises the video), then deletes the recording's account (and with it any
 * signature) through the real form, in an unrecorded context with the recording's cookies, so the clean-up needs no
 * second login (registration and login share the auth rate limit,
 * RATE_LIMIT_AUTH_MAX per 15 minutes). Runs after a failed journey too; when the registration never went through,
 * the guard redirects to the login page and there is nothing to delete.
 */
async function closeAndDeleteAccount(
  browser: Browser,
  recordingContext: BrowserContext,
  password: string,
): Promise<void> {
  const storageState = await recordingContext.storageState().finally(() => recordingContext.close());
  const context = await browser.newContext({ viewport: DESKTOP, storageState });
  try {
    const page = await context.newPage();
    await page.goto('/account/delete');
    if (new URL(page.url()).pathname !== '/account/delete') return;
    await page.locator('#currentPassword').fill(password);
    await page.getByRole('button', { name: 'delete my account' }).click();
    await expect(page).toHaveURL(/\/$/);
  } finally {
    await context.close();
  }
}

test.describe.configure({ mode: 'serial' });

for (const { name, viewport, visitor } of RECORDINGS) {
  test(`@media demo recording, ${name}`, async ({ browser }, testInfo) => {
    // Two minutes of paced typing and pauses per viewport; the default 30 s would cut the journey off.
    test.setTimeout(180_000);
    // Short and readable on screen; the random suffix keeps a re-run free of collisions with a leftover account.
    const email =
      `${visitor.firstName}.${visitor.lastName}-${randomBytes(2).toString('hex')}@petition.test`.toLowerCase();
    const password = randomBytes(18).toString('base64url');
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      colorScheme: 'light',
      ...deviceOptions(viewport),
      recordVideo: { dir: testInfo.outputPath('raw'), size: viewport },
    });
    await context.addInitScript(installPointerRing);
    const page = await context.newPage();
    const video = page.video();
    try {
      await journey(page, visitor, email, password);
    } catch (error) {
      // Clean up as well as possible, but report the journey's error, not a follow-up error of the clean-up.
      await closeAndDeleteAccount(browser, context, password).catch((cleanupError: unknown) => {
        testInfo.annotations.push({ type: 'clean-up failed', description: String(cleanupError) });
      });
      throw error;
    }
    await closeAndDeleteAccount(browser, context, password);
    if (!video) throw new Error('the context did not record a video');
    await video.saveAs(join(testInfo.project.outputDir, `demo-${name}.raw.webm`));
  });
}
