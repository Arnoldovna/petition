import type { Locator, Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import {
  expect,
  expectCitySupporters,
  flash,
  fullName,
  registerUser,
  signDrawn,
  test,
  uniqueCity,
} from './fixtures.ts';

/**
 * The signature pad on `/signature` (F-37 to F-45; B-36 to B-39, B-70) in the real browser engines: Chromium at desktop
 * and phone size, and WebKit as an iPhone (project `webkit-iphone`), where the pointer and touch fixes matter most.
 *
 * Tests that only draw (never submit) run as the shared worker user, who must never sign (fixtures.ts). Every test
 * that submits registers its own user, and counts are read on that user's own unique city page (ADR 0015), so the
 * parallel spec groups that sign and delete at the same time never change a number asserted here.
 *
 * What a drawing looks like is read back from the canvas pixels (the pad draws black ink on a transparent backing
 * store over the accent field), so these tests prove what the visitor sees, not which functions ran.
 */

/** A position on the pad, 0..1 of its width and height (values outside lie beyond the pad's edges). */
type PadPoint = readonly [x: number, y: number];

/** What a drawn signature looks like on the canvas. */
interface InkStats {
  /** Pixels with any ink (alpha above zero). */
  pixels: number;
  /** The centre of the ink as a pad position, or null for an empty pad. */
  centroid: { x: number; y: number } | null;
}

/** Counters that an init script collects on the visible pad (B-39); see `countPadDrawing`. */
interface PadDrawCounts {
  clearRect: number;
  lineTo: number;
  /** Pointer positions delivered to the pad while a button was pressed (coalesced positions counted one by one). */
  positions: number;
}

declare global {
  interface Window {
    /** Pointer types of every `pointerdown` (installed by `recordPointerTypes`). */
    __e2ePointerTypes?: string[];
    /** Drawing calls on the visible pad (installed by `countPadDrawing`). */
    __e2ePadCalls?: PadDrawCounts;
  }
}

const SIGN_URL = /\/signature$/;
const THANK_YOU_URL = /\/thank-you$/;
const PNG_DATA_URL = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;
const BLANK_MESSAGE = 'Please sign before submitting';
const UNREADABLE_MESSAGE = 'The signature could not be read. Clear the pad and sign again.';

/** A stroke long enough for the client blank check and the server's ink minimum, well inside the pad. */
const ZIGZAG: readonly PadPoint[] = [
  [0.1, 0.6],
  [0.25, 0.25],
  [0.4, 0.75],
  [0.55, 0.3],
  [0.7, 0.7],
  [0.85, 0.4],
];

function signaturePad(page: Page): Locator {
  return page.getByRole('img', { name: 'Signature pad' });
}

/** The hidden input the drawing form submits (filled by the pad on every stroke end and on submit). */
function signatureInput(page: Page): Locator {
  return page.locator('form[data-signature-pad] input[name="signature"]');
}

/**
 * The note shown without JavaScript (F-45). Playwright's text and role engines skip `<noscript>` content, so it is
 * found by its element; with JavaScript the parser keeps it as raw text and the element does not exist.
 */
function noScriptNote(page: Page): Locator {
  return page.locator('noscript > p');
}

function padAlert(page: Page): Locator {
  return page.locator('form[data-signature-pad]').getByRole('alert');
}

/** Viewport coordinates of a pad position, from the pad's current layout box. */
async function viewportPoint(pad: Locator, [x, y]: PadPoint): Promise<[number, number]> {
  const box = await pad.boundingBox();
  if (box === null) throw new Error('the signature pad has no layout box');
  return [box.x + box.width * x, box.y + box.height * y];
}

/** Draws one stroke with the mouse through `points` (each move in small steps) and releases at the last point. */
async function drawWithMouse(page: Page, pad: Locator, points: readonly PadPoint[]): Promise<void> {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('drawWithMouse needs at least one point');
  await page.mouse.move(...(await viewportPoint(pad, first)));
  await page.mouse.down();
  for (const point of rest) await page.mouse.move(...(await viewportPoint(pad, point)), { steps: 8 });
  await page.mouse.up();
}

/** Reads the ink on the visible canvas (its backing store, in device pixels). */
async function inkStats(pad: Locator): Promise<InkStats> {
  return pad.evaluate((canvas) => {
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('the signature pad is not a canvas');
    const context = canvas.getContext('2d');
    if (context === null) throw new Error('the signature pad has no 2D context');
    const { width, height } = canvas;
    const { data } = context.getImageData(0, 0, width, height);
    let pixels = 0;
    let sumX = 0;
    let sumY = 0;
    for (let index = 3; index < data.length; index += 4) {
      if ((data[index] ?? 0) === 0) continue;
      const pixel = (index - 3) / 4;
      pixels += 1;
      sumX += (pixel % width) + 0.5;
      sumY += Math.floor(pixel / width) + 0.5;
    }
    return { pixels, centroid: pixels === 0 ? null : { x: sumX / pixels / width, y: sumY / pixels / height } };
  });
}

/**
 * How far the centre of the ink lies from a pad position, in CSS pixels on each axis. WebKit reports whole-pixel
 * pointer positions and the dot is antialiased, so a correct pad stays within one pixel; the legacy offset bug (B-38)
 * was off by the whole scroll distance.
 */
async function inkOffsetFrom(pad: Locator, [x, y]: PadPoint): Promise<number> {
  const ink = await inkStats(pad);
  if (ink.centroid === null) throw new Error('the pad has no ink');
  const box = await pad.boundingBox();
  if (box === null) throw new Error('the signature pad has no layout box');
  return Math.max(Math.abs(ink.centroid.x - x) * box.width, Math.abs(ink.centroid.y - y) * box.height);
}

/** Whether there is ink within `radius` CSS pixels of a pad position. */
async function hasInkAt(pad: Locator, [x, y]: PadPoint, radius = 3): Promise<boolean> {
  return pad.evaluate(
    (canvas, probe) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('the signature pad is not a canvas');
      const context = canvas.getContext('2d');
      if (context === null) throw new Error('the signature pad has no 2D context');
      const scale = canvas.width / canvas.getBoundingClientRect().width;
      const reach = Math.max(1, Math.round(probe.radius * scale));
      const left = Math.max(0, Math.round(probe.x * canvas.width) - reach);
      const top = Math.max(0, Math.round(probe.y * canvas.height) - reach);
      const { data } = context.getImageData(left, top, reach * 2 + 1, reach * 2 + 1);
      for (let index = 3; index < data.length; index += 4) if ((data[index] ?? 0) > 0) return true;
      return false;
    },
    { x, y, radius },
  );
}

/** Waits two animation frames, so input that was dispatched has been handled and painted. */
async function nextFrames(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      }),
  );
}

/**
 * Moves one finger through `points` (viewport coordinates) through the Chrome DevTools Protocol, the only way
 * Playwright can move a touch point (Chromium only), and waits until the input has been handled.
 */
async function dragWithFinger(page: Page, points: readonly (readonly [number, number])[]): Promise<void> {
  const [first, ...rest] = points;
  if (first === undefined) throw new Error('dragWithFinger needs at least one point');
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first[0], y: first[1] }] });
    for (const [x, y] of rest) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  } finally {
    await cdp.detach();
  }
  await nextFrames(page);
}

/** Viewport points of a vertical zigzag across the pad, ending at the pad position (0.9, 0.5). */
async function zigzagAcross(pad: Locator): Promise<[number, number][]> {
  const points: [number, number][] = [];
  for (let step = 0; step <= 32; step += 1) {
    points.push(await viewportPoint(pad, [0.1 + step * 0.025, 0.5 + 0.4 * Math.sin((step / 32) * Math.PI * 6)]));
  }
  return points;
}

/** Scrolls the page instantly (not with the page's smooth scrolling) so the pad's top is 40 px below the viewport top. */
async function scrollPadNearTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    const top = document.querySelector('canvas')?.getBoundingClientRect().top ?? 0;
    window.scrollTo({ top: window.scrollY + top - 40, behavior: 'instant' });
    return window.scrollY;
  });
}

/** Records the `pointerType` of every pointerdown on the next documents of this page. Call before `goto`. */
async function recordPointerTypes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = [];
    window.__e2ePointerTypes = seen;
    document.addEventListener(
      'pointerdown',
      (event) => {
        seen.push(event.pointerType);
      },
      true,
    );
  });
}

async function pointerTypes(page: Page): Promise<string[]> {
  return page.evaluate(() => window.__e2ePointerTypes ?? []);
}

/**
 * Counts what the page draws on the visible pad (B-39): `clearRect` and `lineTo` calls on canvases in the document
 * (the export canvas is never attached, so its replay is not counted), and the pointer positions the pad receives
 * while a button is pressed. Call before `goto`.
 */
async function countPadDrawing(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counts: PadDrawCounts = { clearRect: 0, lineTo: 0, positions: 0 };
    window.__e2ePadCalls = counts;
    const prototype = CanvasRenderingContext2D.prototype;
    const clearRect = Object.getOwnPropertyDescriptor(prototype, 'clearRect')?.value as unknown;
    const lineTo = Object.getOwnPropertyDescriptor(prototype, 'lineTo')?.value as unknown;
    if (typeof clearRect !== 'function' || typeof lineTo !== 'function') return;
    prototype.clearRect = function (this: CanvasRenderingContext2D, ...args: [number, number, number, number]) {
      if (this.canvas.isConnected) counts.clearRect += 1;
      Reflect.apply(clearRect, this, args);
    };
    prototype.lineTo = function (this: CanvasRenderingContext2D, ...args: [number, number]) {
      if (this.canvas.isConnected) counts.lineTo += 1;
      Reflect.apply(lineTo, this, args);
    };
    document.addEventListener(
      'pointermove',
      (event) => {
        if (event.buttons === 0 || !(event.target instanceof HTMLCanvasElement)) return;
        const coalesced = 'getCoalescedEvents' in event ? event.getCoalescedEvents().length : 0;
        counts.positions += Math.max(1, coalesced);
      },
      true,
    );
  });
}

async function padDrawCounts(page: Page): Promise<PadDrawCounts> {
  return page.evaluate(() => {
    const counts = window.__e2ePadCalls;
    if (counts === undefined) throw new Error('countPadDrawing was not installed');
    return { ...counts };
  });
}

async function resetPadDrawCounts(page: Page): Promise<void> {
  await page.evaluate(() => {
    const counts = window.__e2ePadCalls;
    if (counts === undefined) throw new Error('countPadDrawing was not installed');
    counts.clearRect = 0;
    counts.lineTo = 0;
    counts.positions = 0;
  });
}

/** The sign page with the pad enhanced (the drawing form is hidden until signature-pad.js runs). */
async function openPad(page: Page): Promise<Locator> {
  await page.goto('/signature');
  const pad = signaturePad(page);
  await expect(pad).toBeVisible();
  return pad;
}

/** The `_csrf` value of the drawing form on the current sign page (the token is bound to the session). */
async function signFormToken(page: Page): Promise<string> {
  return page.locator('form[data-signature-pad] input[name="_csrf"]').inputValue();
}

test.describe('drawing without submitting (worker user)', () => {
  test.use({ signedIn: true });

  test('F-37, F-38, F-45, B-70: the pad is labelled, described, touch-safe and offered next to the typed name', async ({
    page,
    workerUser,
  }) => {
    const pad = await openPad(page);

    await expect(page).toHaveTitle('Sign the petition · Nonsense Petition');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hey ${workerUser.firstName}`);
    await expect(pad).toHaveAccessibleName('Signature pad');
    await expect(pad).toHaveAccessibleDescription(/with a mouse, a finger or a pen.*typing your full name/);
    // F-38, B-37: touch and pen strokes go to the pad, never to page scroll or zoom.
    await expect(pad).toHaveCSS('touch-action', 'none');
    await expect(page.getByRole('button', { name: 'clear' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'sign the petition' })).toBeVisible();
    // F-45: the keyboard and screen-reader alternative is always there; the no-JS note is not shown with JavaScript.
    await expect(page.getByRole('heading', { level: 2, name: 'Sign by typing your full name' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'full name' })).toHaveAttribute('autocomplete', 'name');
    await expect(noScriptNote(page)).toBeHidden();
    await expectNoA11yViolations(page);

    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
  });

  test('F-38, B-36: a stroke keeps drawing outside the pad and is saved when released outside', async ({ page }) => {
    const pad = await openPad(page);
    await expect(signatureInput(page)).toHaveValue('');

    // Down inside, out over the top edge onto the instructions, back in on the far side, out again and release there.
    await drawWithMouse(page, pad, [
      [0.1, 0.5],
      [0.3, 0.6],
      [0.45, -0.6],
      [0.75, 0.5],
      [0.9, 0.4],
      [0.95, -0.5],
    ]);

    // The part drawn after re-entering is on the pad: pointer capture kept the stroke alive outside it (F-38).
    expect(await hasInkAt(pad, [0.75, 0.5])).toBe(true);
    expect(await hasInkAt(pad, [0.9, 0.4])).toBe(true);
    // Released outside, the drawing is still serialised (B-36: legacy saved only on mouseup over the canvas).
    await expect(signatureInput(page)).toHaveValue(PNG_DATA_URL);
    await expect(padAlert(page)).toHaveText('');
  });

  test.describe('touch', () => {
    test.use({ hasTouch: true });

    test('F-38, B-37: touch input reaches the pad as a touch pointer, draws and never scrolls the page', async ({
      page,
      browserName,
    }) => {
      const viewport = page.viewportSize();
      if (viewport === null) throw new Error('the page has no viewport');
      // A short viewport, so the page can scroll: a finger move on the pad must not.
      await page.setViewportSize({ width: viewport.width, height: 480 });
      await recordPointerTypes(page);
      const pad = await openPad(page);
      await pad.scrollIntoViewIfNeeded();

      await page.touchscreen.tap(...(await viewportPoint(pad, [0.5, 0.5])));

      await expect.poll(() => pointerTypes(page)).toContain('touch');
      expect(await hasInkAt(pad, [0.5, 0.5])).toBe(true);
      await expect(signatureInput(page)).toHaveValue(PNG_DATA_URL);

      // Playwright can move a finger only through the Chrome DevTools Protocol, so the finger stroke runs in Chromium;
      // WebKit gets the tap above and every mouse-driven Pointer Events test of this file (capture, release outside).
      if (browserName === 'chromium') {
        const scrollY = (): Promise<number> => page.evaluate(() => window.scrollY);
        await page.getByRole('button', { name: 'clear' }).click();
        const before = await scrollPadNearTop(page);
        await dragWithFinger(page, await zigzagAcross(pad));
        await nextFrames(page);

        expect(await scrollY()).toBe(before);
        expect(await hasInkAt(pad, [0.5, 0.5])).toBe(true);
        expect(await hasInkAt(pad, [0.9, 0.5])).toBe(true);
        await expect(signatureInput(page)).toHaveValue(PNG_DATA_URL);

        // Control: the same finger drag just below the pad (plain form space) scrolls the page within the same wait,
        // so the still page above is the pad's doing (touch-action: none), not input that never scrolls.
        const [x, below] = await viewportPoint(pad, [0.05, 1]);
        await dragWithFinger(page, [
          [x, below + 10],
          [x, below - 30],
          [x, below - 70],
          [x, below - 110],
        ]);
        await nextFrames(page);
        expect(await scrollY()).toBeGreaterThan(before);
      }
    });
  });

  test('F-39, B-38: the backing store is the CSS size times the pixel ratio and ink lands under the pointer', async ({
    page,
  }) => {
    const viewport = page.viewportSize();
    if (viewport === null) throw new Error('the page has no viewport');
    // A short viewport, so the pad can be scrolled to: coordinates must not depend on the scroll position (B-38).
    await page.setViewportSize({ width: viewport.width, height: 480 });
    const pad = await openPad(page);

    const geometry = await pad.evaluate((canvas) => {
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error('the signature pad is not a canvas');
      const rect = canvas.getBoundingClientRect();
      return { cssWidth: rect.width, cssHeight: rect.height, ratio: window.devicePixelRatio };
    });
    const ratio = Math.min(Math.max(geometry.ratio, 1), 3);
    await expect
      .poll(() => pad.evaluate((canvas) => (canvas instanceof HTMLCanvasElement ? [canvas.width, canvas.height] : [])))
      .toEqual([Math.round(geometry.cssWidth * ratio), Math.round(geometry.cssHeight * ratio)]);
    // F-83: the pad keeps the 3:1 export ratio at every width and never overflows the viewport.
    expect(geometry.cssWidth / geometry.cssHeight).toBeCloseTo(3, 1);
    expect(geometry.cssWidth).toBeLessThanOrEqual(viewport.width);

    // Scroll so the pad sits near the top of the viewport, then tap a point that is not on any axis of symmetry.
    expect(await scrollPadNearTop(page)).toBeGreaterThan(0);
    const target: PadPoint = [0.3, 0.7];
    await page.mouse.click(...(await viewportPoint(pad, target)));

    // Legacy used pageX - offsetLeft and was off by the whole scroll distance and the layout offsets.
    expect(await inkOffsetFrom(pad, target)).toBeLessThanOrEqual(1);

    // A new layout (narrower viewport) resizes the backing store and replays the drawing at the same place.
    const before = await pad.evaluate((canvas) => (canvas instanceof HTMLCanvasElement ? canvas.width : 0));
    // At most 640 px wide, below the pad's maximum width on desktop, so the pad really shrinks.
    await page.setViewportSize({ width: Math.min(Math.round(viewport.width * 0.8), 640), height: 480 });
    await expect
      .poll(() => pad.evaluate((canvas) => (canvas instanceof HTMLCanvasElement ? canvas.width : 0)))
      .not.toBe(before);
    expect(await inkOffsetFrom(pad, target)).toBeLessThanOrEqual(1);
  });

  test('F-40, B-39: "clear" empties the pad and the value, and drawing never clears and replays the pad', async ({
    page,
  }) => {
    await countPadDrawing(page);
    const pad = await openPad(page);
    await resetPadDrawCounts(page);

    // A long stroke: about a hundred pointer positions.
    const longStroke: PadPoint[] = [...ZIGZAG, [0.9, 0.8], [0.6, 0.2], [0.3, 0.8], [0.1, 0.3], [0.5, 0.5]];
    await drawWithMouse(page, pad, longStroke);

    const counts = await padDrawCounts(page);
    expect(counts.positions).toBeGreaterThanOrEqual(40);
    // B-39: legacy cleared the canvas and replayed every point on each move (quadratic). The pad draws only the newest
    // segment: no clear while drawing, and at most one line per pointer position.
    expect(counts.clearRect).toBe(0);
    expect(counts.lineTo).toBeLessThanOrEqual(counts.positions);
    expect((await inkStats(pad)).pixels).toBeGreaterThan(0);
    await expect(signatureInput(page)).toHaveValue(PNG_DATA_URL);

    await page.getByRole('button', { name: 'clear' }).click();

    expect((await inkStats(pad)).pixels).toBe(0);
    await expect(signatureInput(page)).toHaveValue('');
    // After clearing, the empty pad is blank again for the submit check (F-41).
    await page.getByRole('button', { name: 'sign the petition' }).click();
    await expect(padAlert(page)).toHaveText(`Error: ${BLANK_MESSAGE}`);
    await expect(page).toHaveURL(SIGN_URL);
  });

  test('F-41: an empty pad or a stray tap is blocked in the browser with the message, focused, without a request', async ({
    page,
  }) => {
    const pad = await openPad(page);
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST') posts.push(request.url());
    });

    await page.getByRole('button', { name: 'sign the petition' }).click();

    await expect(padAlert(page)).toHaveText(`Error: ${BLANK_MESSAGE}`);
    await expect(padAlert(page)).toBeFocused();
    await expect(page).toHaveURL(SIGN_URL);

    // A tap leaves a dot, but too little ink to be a signature.
    await page.mouse.click(...(await viewportPoint(pad, [0.5, 0.5])));
    await expect(padAlert(page)).toHaveText('');
    await page.getByRole('button', { name: 'sign the petition' }).click();
    await expect(padAlert(page)).toHaveText(`Error: ${BLANK_MESSAGE}`);

    expect(posts).toEqual([]);
    await expectNoA11yViolations(page);
  });
});

test.describe('signing (own users)', () => {
  test('F-38, F-42, B-36: a drawing released outside the pad is stored as the 720 x 240 signature image', async ({
    page,
  }) => {
    await registerUser(page);
    const pad = await openPad(page);

    await drawWithMouse(page, pad, [...ZIGZAG, [0.95, 1.6]]);
    await page.getByRole('button', { name: 'sign the petition' }).click();

    await expect(page).toHaveURL(THANK_YOU_URL);
    await expect(flash(page)).toHaveText('Thank you, your signature was saved');
    const image = page.getByRole('img', { name: 'Your signature' });
    await expect(image).toBeVisible();
    await expect
      .poll(() =>
        image.evaluate((img) => (img instanceof HTMLImageElement ? [img.naturalWidth, img.naturalHeight] : [])),
      )
      .toEqual([720, 240]);
    const stored = await page.request.get('/signature/image.png');
    expect(stored.status()).toBe(200);
    expect(stored.headers()['content-type']).toBe('image/png');
    await expectNoA11yViolations(page);
  });

  test('F-41, F-42: the server rejects a blank, a non-PNG and a wrongly sized drawing with 422 and stores nothing', async ({
    page,
  }) => {
    await registerUser(page);
    await openPad(page);
    const token = await signFormToken(page);
    const wrongSize = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = 100;
      canvas.height = 100;
      const context = canvas.getContext('2d');
      context?.fillRect(10, 10, 80, 80);
      return canvas.toDataURL('image/png');
    });
    const htmlAsPng = `data:image/png;base64,${Buffer.from('<html><script>alert(1)</script></html>').toString('base64')}`;
    const svg = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`;

    const cases: readonly (readonly [signature: string, message: string])[] = [
      ['', BLANK_MESSAGE],
      [svg, UNREADABLE_MESSAGE],
      [htmlAsPng, UNREADABLE_MESSAGE],
      [wrongSize, UNREADABLE_MESSAGE],
    ];
    for (const [signature, message] of cases) {
      const response = await page.request.post('/signature', {
        form: { _csrf: token, method: 'drawn', signature },
        maxRedirects: 0,
      });
      expect(response.status(), signature.slice(0, 30)).toBe(422);
      expect(await response.text(), signature.slice(0, 30)).toContain(message);
    }

    // Nothing was stored: the visitor still has to sign, and there is no image.
    await page.goto('/signature');
    await expect(page).toHaveURL(SIGN_URL);
    expect((await page.request.get('/signature/image.png')).status()).toBe(404);
  });

  test('F-43, F-44: a second tab that signs after the first ends on the thank-you page with one signature', async ({
    page,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city } });
    const secondTab = await page.context().newPage();
    await secondTab.goto('/signature');
    await expect(secondTab.getByRole('textbox', { name: 'full name' })).toBeVisible();

    await signDrawn(page);

    // The stale tab still shows the sign page; a double click on its typed form submits once more, without an error.
    await secondTab.getByRole('textbox', { name: 'full name' }).fill('Ada Lovelace');
    await secondTab.getByRole('button', { name: 'sign with my typed name' }).dblclick();
    await expect(secondTab).toHaveURL(THANK_YOU_URL);
    await expect(secondTab.getByRole('heading', { level: 1 })).toHaveText('Thank you for your signature');

    // F-44: a signer who opens the sign page goes to the thank-you page.
    await page.goto('/signature');
    await expect(page).toHaveURL(THANK_YOU_URL);

    await expectCitySupporters(page, city, [fullName(user)]);
    await secondTab.close();
  });

  test('F-45, B-70: the typed name is a keyboard-only way to sign and is stored as an image', async ({ page }) => {
    await registerUser(page);
    await openPad(page);

    // Keyboard only once the field has focus: the name is typed and Enter submits the typed form (no pointer).
    await page.getByRole('textbox', { name: 'full name' }).focus();
    await page.keyboard.type('Grace Hopper');
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(THANK_YOU_URL);
    const image = page.getByRole('img', { name: 'Your signature' });
    await expect
      .poll(() =>
        image.evaluate((img) => (img instanceof HTMLImageElement ? [img.naturalWidth, img.naturalHeight] : [])),
      )
      .toEqual([720, 240]);
    await expectNoA11yViolations(page);
  });
});

test.describe('without JavaScript', () => {
  // axe runs as a script in the page, so these pages are checked for accessibility with JavaScript elsewhere.
  test.use({ javaScriptEnabled: false });

  test('F-45, B-70: the page explains that drawing needs JavaScript and the typed name signs', async ({ page }) => {
    await registerUser(page);
    await page.goto('/signature');

    await expect(noScriptNote(page)).toBeVisible();
    await expect(noScriptNote(page)).toHaveText(
      'Drawing a signature needs JavaScript. You can sign by typing your full name below.',
    );
    // The drawing form stays hidden: no pad and no "sign the petition" button that could not work.
    await expect(signaturePad(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'sign the petition' })).toBeHidden();

    await page.getByRole('textbox', { name: 'full name' }).fill('Grace Hopper');
    await page.getByRole('button', { name: 'sign with my typed name' }).click();

    await expect(page).toHaveURL(THANK_YOU_URL);
    await expect(page.getByRole('img', { name: 'Your signature' })).toBeVisible();
  });
});
