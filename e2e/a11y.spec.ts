import { randomBytes, randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import { errorSummary, expect, flash, registerUser, signTyped, test, uniqueCity } from './fixtures.ts';

/**
 * Accessibility and responsive layout (F-78 to F-85; B-63 to B-74, B-81, B-83; OVERVIEW.md section 17). axe runs on
 * every page and state, in light and dark mode for the main screens; the rest is what axe cannot see: the page
 * skeleton and skip link, labels and input purposes, the error summary, keyboard-only use, the focus ring and its
 * contrast, hover effects and their focus equivalents, text size, reflow and zoom, the sticky header covering focus,
 * image alternatives and reduced motion.
 *
 * Every test runs in the `desktop` (1440 x 900) and `mobile` (390 x 844) projects. Tests that sign, log out or need a
 * signer register their own user; the signed-in worker user is never changed (fixtures.ts). `test` from fixtures.ts
 * also fails every test on a Content-Security-Policy violation (F-71).
 */

const GUEST_PAGES = ['/', '/about', '/privacy', '/register', '/login', '/no-such-page'] as const;
const SIGNED_IN_PAGES = [
  '/',
  '/about',
  '/privacy',
  '/profile',
  '/profile/edit',
  '/signature',
  '/supporters',
  '/supporters?page=2',
  `/supporters/city/${encodeURIComponent('Köln')}`,
  '/account/delete',
  '/supporters?page=10000',
] as const;
/** Pages only a signer reaches (requireSigned). */
const SIGNER_PAGES = ['/thank-you', '/signature/delete'] as const;

/** Viewport widths from the smallest supported phone (and 400% zoom of 1280px) to wide desktop (F-83, WCAG 1.4.10). */
const WIDTHS = [320, 390, 720, 768, 1024, 1440] as const;
const DESKTOP = { width: 1440, height: 900 } as const;

type Rgba = readonly [number, number, number, number];

// ------------------------------------------------------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------------------------------------------------------

/** axe in light mode, then in dark mode (F-78: dark mode is a token swap, so every main screen is checked in both). */
async function expectNoViolationsInBothSchemes(page: Page): Promise<void> {
  await page.emulateMedia({ colorScheme: 'light' });
  await expectNoA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'light' });
}

/** The two error pages in the page lists: an unknown path and an out-of-range supporters page. */
const NOT_FOUND = new Set<string>(['/no-such-page', '/supporters?page=10000']);

async function visit(page: Page, path: string, status = NOT_FOUND.has(path) ? 404 : 200): Promise<void> {
  const response = await page.goto(path);
  expect(response?.status(), path).toBe(status);
}

/** WCAG 2.x contrast ratio of two opaque sRGB colours. */
function contrastRatio(a: Rgba, b: Rgba): number {
  const luminance = ([r, g, b]: Rgba): number => {
    const [lr, lg, lb] = [r, g, b].map((channel) => {
      const s = channel / 255;
      return s <= 0.040_45 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** Facts about the focused element: its focus ring and the colour behind it (the ring is drawn outside the element). */
interface FocusFacts {
  label: string;
  outlineStyle: string;
  outlineWidth: number;
  outline: Rgba;
  /** The widest solid border side: form fields replace the ring by a 2px ink bottom line (form-field.css). */
  borderWidth: number;
  border: Rgba;
  backdrop: Rgba;
  clipped: boolean;
}

/**
 * Presses Tab until focus leaves the page or wraps, tags every stop with `data-e2e-stop="<n>"` and returns how many
 * there are. Fails if the page has more than `max` stops (a focus trap would loop forever otherwise).
 */
async function tagTabStops(page: Page, max = 200): Promise<number> {
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  for (let index = 0; index < max; index += 1) {
    await page.keyboard.press('Tab');
    const tagged = await page.evaluate((next) => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || active === document.body) return false;
      if (active.dataset['e2eStop'] !== undefined) return false;
      active.dataset['e2eStop'] = String(next);
      return true;
    }, index);
    if (!tagged) return index;
  }
  throw new Error(`more than ${String(max)} tab stops on ${page.url()}`);
}

function stop(page: Page, index: number): Locator {
  return page.locator(`[data-e2e-stop="${String(index)}"]`);
}

/**
 * Resolves once the page has not scrolled for three animation frames (a smooth scroll has come to rest). Without
 * smooth scrolling (reduced motion, F-85) every scroll is instant, so there is nothing to wait for.
 */
async function settleScroll(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const scroller = document.scrollingElement ?? document.documentElement;
        if (getComputedStyle(scroller).scrollBehavior !== 'smooth') {
          resolve();
          return;
        }
        let last = Number.NaN;
        let stableFrames = 0;
        const frame = () => {
          stableFrames = window.scrollY === last ? stableFrames + 1 : 0;
          last = window.scrollY;
          if (stableFrames >= 3) resolve();
          else requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
      }),
  );
}

/** Focuses stop `index` with the keyboard (Tab from the stop before it), so `:focus-visible` matches. */
async function focusWithKeyboard(page: Page, index: number): Promise<void> {
  // Every page has at least two stops (the skip link and the wordmark), so stop 0 is reached backwards from stop 1.
  await stop(page, index === 0 ? 1 : index - 1).focus();
  // A person never presses the next key within the same frame: let the (smooth, motion-safe) focus scroll finish.
  await settleScroll(page);
  await page.keyboard.press(index === 0 ? 'Shift+Tab' : 'Tab');
  await expect(stop(page, index)).toBeFocused();
  await settleScroll(page);
}

/** Moves keyboard focus from the focused stop `index - 1` to stop `index` with one Tab, as a person walks a page. */
async function tabToNextStop(page: Page, index: number): Promise<void> {
  await page.keyboard.press('Tab');
  await expect(stop(page, index)).toBeFocused();
  await settleScroll(page);
}

async function focusFacts(page: Page): Promise<FocusFacts> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('no 2d context');
    /** Any CSS colour (rgb, hex, oklch, color-mix) as sRGB bytes, by painting one pixel. */
    const toRgba = (color: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1);
      context.fillStyle = '#000';
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };

    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) throw new Error('nothing is focused');
    const style = getComputedStyle(element);
    let backdrop: [number, number, number, number] = [255, 255, 255, 1];
    for (let node = element.parentElement; node !== null; node = node.parentElement) {
      const background = toRgba(getComputedStyle(node).backgroundColor);
      if (background[3] > 0) {
        backdrop = background;
        break;
      }
    }
    let clipped = false;
    for (let node: Element | null = element; node !== null; node = node.parentElement) {
      if (getComputedStyle(node).clipPath !== 'none') clipped = true;
    }
    const sides = (['top', 'right', 'bottom', 'left'] as const)
      .filter((side) => style.getPropertyValue(`border-${side}-style`) === 'solid')
      .map((side) => ({
        width: Number.parseFloat(style.getPropertyValue(`border-${side}-width`)),
        color: toRgba(style.getPropertyValue(`border-${side}-color`)),
      }))
      .sort((a, b) => b.width - a.width);
    const text = (
      [element.innerText, element.getAttribute('aria-label') ?? '', element.id]
        .map((candidate) => candidate.trim())
        .find((candidate) => candidate !== '') ?? ''
    ).slice(0, 40);
    return {
      label: `${element.tagName.toLowerCase()} "${text}"`,
      outlineStyle: style.outlineStyle,
      outlineWidth: Number.parseFloat(style.outlineWidth),
      outline: toRgba(style.outlineColor),
      borderWidth: sides[0]?.width ?? 0,
      border: sides[0]?.color ?? [0, 0, 0, 0],
      backdrop,
      clipped,
    };
  });
}

/** F-81, B-66: every tab stop of the current page shows a solid ring of at least 2px with at least 3:1 contrast. */
async function expectVisibleFocusOnEveryStop(page: Page): Promise<void> {
  const count = await tagTabStops(page);
  expect(count, `${page.url()} has tab stops`).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    // The walk is in tab order: stop 0 is reached with the keyboard, every later stop with one Tab from the one before.
    await (index === 0 ? focusWithKeyboard(page, 0) : tabToNextStop(page, index));
    const facts = await focusFacts(page);
    const where = `${page.url()} stop ${String(index)}: ${facts.label}`;
    expect(facts.outlineStyle, where).toBe('solid');
    expect(facts.outlineWidth, where).toBeGreaterThanOrEqual(2);
    if (facts.outline[3] === 1) {
      expect(contrastRatio(facts.outline, facts.backdrop), `${where}: ring contrast`).toBeGreaterThanOrEqual(3);
    } else {
      // A transparent outline (kept for forced-colours mode) must come with an equally strong solid line.
      expect(facts.outline[3], `${where}: ring is opaque or fully transparent`).toBe(0);
      expect(facts.borderWidth, `${where}: focus line width`).toBeGreaterThanOrEqual(2);
      expect(facts.border[3], `${where}: opaque focus line`).toBe(1);
      expect(contrastRatio(facts.border, facts.backdrop), `${where}: focus line contrast`).toBeGreaterThanOrEqual(3);
    }
    await expect(stop(page, index), `${where}: scrolled into view`).toBeInViewport();
    expect(facts.clipped, `${where}: not clipped while focused`).toBe(false);
  }
}

/** Visual properties a hover effect may change; the focus state must show the same change (F-81, B-83). */
const HOVER_PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'text-decoration-line',
  'text-decoration-thickness',
  'text-decoration-color',
  'box-shadow',
  'opacity',
] as const;

/** The element and its three closest ancestors: a row's rule reacts to its link (`:has(:focus-visible)`). */
async function visualState(target: Locator): Promise<string[]> {
  return target.evaluate((element, properties) => {
    const values: string[] = [];
    let node: Element | null = element;
    for (let depth = 0; depth < 4 && node !== null && node !== document.body; depth += 1) {
      const style = getComputedStyle(node);
      for (const property of properties)
        values.push(`${String(depth)} ${property}: ${style.getPropertyValue(property)}`);
      node = node.parentElement;
    }
    return values;
  }, HOVER_PROPERTIES);
}

/** A viewport point over no interactive element, where the mouse rests between hovers. */
async function restingPoint(page: Page): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(() => {
    const interactive = 'a, button, input, select, textarea, label, summary, canvas, [tabindex]:not([tabindex="-1"])';
    const { innerWidth: width, innerHeight: height } = window;
    const candidates = [
      [width - 2, height - 2],
      [1, height - 2],
      [width - 2, Math.round(height / 2)],
      [1, Math.round(height / 2)],
    ] as const;
    for (const [x, y] of candidates) {
      const hit = document.elementFromPoint(x, y);
      if (hit !== null && hit.closest(interactive) === null) return { x, y };
    }
    return null;
  });
  if (point === null) throw new Error(`no resting point without an interactive element on ${page.url()}`);
  return point;
}

/** F-81, B-83: whatever a pointer hover changes on a tab stop, keyboard focus changes the same way. */
async function expectHoverHasFocusEquivalent(page: Page): Promise<void> {
  const count = await tagTabStops(page);
  let withHoverEffect = 0;
  for (let index = 0; index < count; index += 1) {
    const target = stop(page, index);
    // The skip link is clipped away until it has focus; there is nothing to hover.
    const hoverable = await target.evaluate((element) => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        if (getComputedStyle(node).clipPath !== 'none') return false;
      }
      return true;
    });
    if (!hoverable) continue;

    await page.evaluate(() => {
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await target.scrollIntoViewIfNeeded();
    const rest = await restingPoint(page);
    await page.mouse.move(rest.x, rest.y);
    const atRest = await visualState(target);

    await target.hover();
    const hovered = await visualState(target);
    await page.mouse.move(rest.x, rest.y);

    await focusWithKeyboard(page, index);
    const focused = await visualState(target);

    const label = await target.evaluate(
      (element) => `${element.tagName.toLowerCase()} "${(element as HTMLElement).innerText.trim().slice(0, 40)}"`,
    );
    const changedOnHover = hovered.filter((value, i) => value !== atRest[i]);
    if (changedOnHover.length > 0) withHoverEffect += 1;
    const missingOnFocus = changedOnHover.filter((value) => !focused.includes(value));
    expect(missingOnFocus, `${page.url()} ${label}: hover changes without a focus equivalent`).toEqual([]);
  }
  // Links and buttons have a hover effect (underline, rule or inversion): proof that the comparison saw real changes.
  // (Touch projects match `(hover: none)`, so the pointer-only effects of form fields are absent there.)
  expect(withHoverEffect, `${page.url()}: stops with a hover effect`).toBeGreaterThan(0);
}

/** Horizontal scrolling, content beyond the viewport and clipped text (F-82, F-83, B-74, B-81). */
async function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const problems: string[] = [];
    const root = document.documentElement;
    const viewportWidth = root.clientWidth;
    if (root.scrollWidth > viewportWidth) {
      problems.push(`horizontal scrolling: ${String(root.scrollWidth)}px content in ${String(viewportWidth)}px`);
    }
    /** Visually hidden content (clip-path) is clipped on purpose and stays readable for assistive technology. */
    const intentionallyClipped = (element: Element): boolean => {
      for (let node: Element | null = element; node !== null; node = node.parentElement) {
        if (getComputedStyle(node).clipPath !== 'none') return true;
      }
      return false;
    };
    const describe = (element: Element): string => {
      const text = element.textContent.trim().replace(/\s+/g, ' ').slice(0, 40);
      return `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> "${text}"`;
    };
    for (const element of document.body.querySelectorAll('*')) {
      if (!(element instanceof HTMLElement) || element.offsetParent === null) continue;
      if (intentionallyClipped(element)) continue;
      // A long value scrolls inside its form control; that is how controls work, not clipped content.
      const isControl = element.matches('input, textarea, select');
      const style = getComputedStyle(element);
      const clipsX = style.overflowX === 'hidden' || style.overflowX === 'clip';
      const clipsY = style.overflowY === 'hidden' || style.overflowY === 'clip';
      if (!isControl && clipsX && element.scrollWidth > element.clientWidth + 1)
        problems.push(`clipped horizontally: ${describe(element)}`);
      if (!isControl && clipsY && element.scrollHeight > element.clientHeight + 1)
        problems.push(`clipped vertically: ${describe(element)}`);
      const box = element.getBoundingClientRect();
      if (box.width > 0 && (box.right > viewportWidth + 1 || box.left < -1)) {
        problems.push(
          `outside the viewport (${String(Math.round(box.left))}..${String(Math.round(box.right))}): ${describe(element)}`,
        );
      }
    }
    return problems;
  });
}

/** Text zoom (WCAG 1.4.4): the root font size doubles, like a browser's text-only zoom; every rem scales with it. */
async function zoomText(page: Page, percent: number): Promise<void> {
  await page.evaluate((size) => {
    document.documentElement.style.setProperty('font-size', `${String(size)}%`);
  }, percent);
  await expect
    .poll(() => page.evaluate(() => getComputedStyle(document.documentElement).fontSize))
    .toBe(`${String((16 * percent) / 100)}px`);
}

/** Presses Tab until `target` has focus: proves it is reachable by keyboard alone. */
async function tabTo(page: Page, target: Locator, max = 60): Promise<void> {
  for (let presses = 0; presses < max; presses += 1) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => element === document.activeElement)) return;
  }
  throw new Error(`could not reach ${target.toString()} with ${String(max)} Tab presses on ${page.url()}`);
}

/** F-79, B-63, B-64, B-67: the page skeleton and the skip link of the page that is open. */
async function expectPageSkeleton(page: Page): Promise<void> {
  const head = await page.evaluate(() => ({
    lang: document.documentElement.lang,
    firstHeadChild: document.head.firstElementChild?.outerHTML ?? '',
    viewport: document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null,
  }));
  const where = page.url();
  expect(head.lang, where).toBe('en');
  expect(head.firstHeadChild, `${where}: charset first (B-64)`).toBe('<meta charset="utf-8">');
  expect(head.viewport, `${where}: viewport (B-63)`).toBe('width=device-width, initial-scale=1');

  await expect(page.locator('h1'), `${where}: one h1`).toHaveCount(1);
  await expect(page.getByRole('banner'), where).toHaveCount(1);
  await expect(page.getByRole('navigation', { name: 'Main' }), where).toHaveCount(1);
  await expect(page.getByRole('main'), where).toHaveCount(1);
  await expect(page.getByRole('contentinfo'), where).toHaveCount(1);
  await expect(page.getByRole('contentinfo').getByRole('link', { name: 'privacy' }), `${where}: F-88`).toHaveAttribute(
    'href',
    '/privacy',
  );

  // The skip link is the first tab stop, visible while focused, and moves focus to <main>.
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
  });
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content' });
  await expect(skip, where).toBeFocused();
  await expect(skip).toHaveAttribute('href', '#main');
  await expect(skip).toBeInViewport();
  expect(await skip.evaluate((element) => getComputedStyle(element).clipPath), `${where}: skip link shown`).toBe(
    'none',
  );
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main'), `${where}: skip link target`).toBeFocused();
}

/** F-80, B-65: every visible form control has exactly one visible, non-empty label and no placeholder. */
async function expectLabelledControls(page: Page): Promise<void> {
  const controls = await page.evaluate(() =>
    [...document.querySelectorAll('input, select, textarea')]
      .filter((control) => (control as HTMLInputElement).type !== 'hidden')
      .filter((control) => (control as HTMLElement).offsetParent !== null)
      .map((control) => {
        const input = control as HTMLInputElement;
        const labels = [...(input.labels ?? [])];
        return {
          name: input.name,
          labels: labels.length,
          labelText: labels[0]?.innerText.trim() ?? '',
          labelVisible: labels[0] !== undefined && labels[0].getBoundingClientRect().height > 0,
          labelAbove:
            labels[0] !== undefined &&
            labels[0].getBoundingClientRect().bottom <= input.getBoundingClientRect().top + 1,
          placeholder: input.getAttribute('placeholder'),
        };
      }),
  );
  expect(controls.length, `${page.url()} has form controls`).toBeGreaterThan(0);
  for (const control of controls) {
    const where = `${page.url()} ${control.name}`;
    expect(control.labels, `${where}: one <label for>`).toBe(1);
    expect(control.labelText, `${where}: label text`).not.toBe('');
    expect(control.labelVisible, `${where}: label visible`).toBe(true);
    expect(control.labelAbove, `${where}: label above the control`).toBe(true);
    expect(control.placeholder, `${where}: no placeholder as label`).toBeNull();
  }
}

/** F-80, B-71, B-72: the input purpose of one field, found by its visible label. */
async function expectField(
  page: Page,
  label: string,
  attributes: { type?: string; autocomplete: string; inputmode?: string },
): Promise<void> {
  const field = page.getByLabel(label, { exact: true });
  await expect(field).toHaveAttribute('type', attributes.type ?? 'text');
  await expect(field).toHaveAttribute('autocomplete', attributes.autocomplete);
  if (attributes.inputmode !== undefined) await expect(field).toHaveAttribute('inputmode', attributes.inputmode);
}

async function submit(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name, exact: true }).click();
}

/** Registers an own user and signs with a typed name, so the signer-only pages are reachable. */
async function registerSigner(page: Page): Promise<void> {
  await registerUser(page, { profile: { age: '33', city: uniqueCity(), homepage: 'example.org' } });
  await signTyped(page);
}

// ------------------------------------------------------------------------------------------------------------------
// axe on every page and state (F-78)
// ------------------------------------------------------------------------------------------------------------------

test.describe('guest', () => {
  test('F-78: every guest page has no axe violations in light and dark mode', async ({ page }) => {
    for (const path of GUEST_PAGES) {
      await visit(page, path);
      await expectNoViolationsInBothSchemes(page);
    }
  });

  test('F-78, B-68: guest validation and error states have no axe violations and announce their errors', async ({
    page,
  }) => {
    await visit(page, '/register');
    await submit(page, 'register');
    // The error summary receives focus without JavaScript (autofocus) and is announced (role="alert").
    const summary = errorSummary(page);
    await expect(summary).toBeFocused();
    await expect(summary.getByRole('link', { name: 'Enter your first name' })).toHaveAttribute('href', '#firstName');
    await expect(summary.getByRole('link', { name: 'Enter an email address' })).toHaveAttribute('href', '#email');
    // Each invalid field is marked and described by its message, so a screen reader hears it on focus.
    const firstName = page.getByLabel('first name', { exact: true });
    await expect(firstName).toHaveAttribute('aria-invalid', 'true');
    await expect(firstName).toHaveAccessibleDescription('Error: Enter your first name');
    const password = page.getByLabel('password', { exact: true });
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAccessibleDescription(/^Error: Enter a password\b.*At least 12 characters$/);
    // A field without an error is neither marked nor described by an error.
    await page.locator('#firstName').fill('Ada');
    await submit(page, 'register');
    await expect(page.getByLabel('first name', { exact: true })).not.toHaveAttribute('aria-invalid', 'true');
    await expectNoViolationsInBothSchemes(page);

    await visit(page, '/login');
    await page.getByLabel('email', { exact: true }).fill(`e2e-${randomUUID()}@petition.test`);
    await page.getByLabel('password', { exact: true }).fill('not the password at all');
    await submit(page, 'log in');
    await expect(errorSummary(page)).toContainText('Email or password is incorrect');
    await expectNoViolationsInBothSchemes(page);

    // CSRF failure page (403).
    await visit(page, '/login');
    await page.locator('form[action="/login"] input[name="_csrf"]').evaluate((input) => {
      (input as HTMLInputElement).value = 'tampered';
    });
    await submit(page, 'log in');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('This form has expired');
    await expectNoViolationsInBothSchemes(page);
  });

  test('F-79, B-63, B-64, B-67: every guest page has lang, charset first, viewport, one h1, landmarks and a working skip link', async ({
    page,
  }) => {
    for (const path of GUEST_PAGES) {
      await visit(page, path);
      await expectPageSkeleton(page);
    }
  });

  test('F-80, B-65, B-71, B-72: register and login controls have visible labels, input types and autocomplete tokens', async ({
    page,
  }) => {
    await visit(page, '/register');
    await expectLabelledControls(page);
    await expectField(page, 'first name', { autocomplete: 'given-name' });
    await expectField(page, 'last name', { autocomplete: 'family-name' });
    await expectField(page, 'email', { type: 'email', autocomplete: 'email' });
    await expectField(page, 'password', { type: 'password', autocomplete: 'new-password' });
    await expect(page.locator('form[autocomplete="off"], input[autocomplete="off"]'), 'B-71').toHaveCount(0);

    await visit(page, '/login');
    await expectLabelledControls(page);
    await expectField(page, 'email', { type: 'email', autocomplete: 'email' });
    await expectField(page, 'password', { type: 'password', autocomplete: 'current-password' });
    await expect(page.locator('form[autocomplete="off"], input[autocomplete="off"]'), 'B-71').toHaveCount(0);
  });
});

test('F-88, F-78: the privacy page explains operator, data, visibility, purpose, retention, deletion and rights, and every footer links to it', async ({
  page,
}) => {
  await visit(page, '/privacy');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy');
  const sections = page.getByRole('main').getByRole('heading', { level: 2 });
  await expect(sections).toHaveText([
    'who runs this site',
    'what is stored',
    'who sees what',
    'why',
    'how long it is kept',
    'deleting your data',
    'your rights',
  ]);
  // The contact channel comes from configuration (CONTACT_URL) and is the same as the footer's contact link.
  const contact = await page.getByRole('contentinfo').getByRole('link', { name: 'contact' }).getAttribute('href');
  expect(contact).toMatch(/^https:\/\//);
  await expect(
    page
      .getByRole('main')
      .getByRole('link', { name: /^contact page/ })
      .first(),
  ).toHaveAttribute('href', contact ?? '');
  await expect(page.getByRole('main').getByRole('link', { name: 'delete your account' })).toHaveAttribute(
    'href',
    '/account/delete',
  );
  await expect(page.getByRole('main').getByRole('link', { name: 'delete your signature' })).toHaveAttribute(
    'href',
    '/signature/delete',
  );
  await expectNoViolationsInBothSchemes(page);

  for (const path of GUEST_PAGES) {
    await visit(page, path);
    await expect(page.getByRole('contentinfo').getByRole('link', { name: 'privacy' }), path).toHaveAttribute(
      'href',
      '/privacy',
    );
  }
});

test.describe('signed in', () => {
  test.use({ signedIn: true });

  test('F-78: every signed-in page has no axe violations, the main screens also in dark mode', async ({ page }) => {
    const mainScreens = new Set<string>(['/', '/profile/edit', '/signature', '/supporters']);
    for (const path of SIGNED_IN_PAGES) {
      await visit(page, path);
      if (mainScreens.has(path)) await expectNoViolationsInBothSchemes(page);
      else await expectNoA11yViolations(page);
    }
  });

  test('F-78, B-68: signed-in validation and error states have no axe violations and announce their errors', async ({
    page,
  }) => {
    await visit(page, '/profile');
    await page.getByLabel('age', { exact: true }).fill('old');
    await page.getByLabel('homepage', { exact: true }).fill('ftp://example.com');
    await submit(page, 'continue');
    await expect(errorSummary(page)).toBeFocused();
    await expect(page.getByLabel('age', { exact: true })).toHaveAccessibleDescription(
      'Error: Age must be a whole number between 1 and 120',
    );
    await expectNoViolationsInBothSchemes(page);

    await visit(page, '/profile/edit');
    await page.getByLabel('email', { exact: true }).fill('not-an-email');
    await page.getByLabel('new password', { exact: true }).fill('short');
    await submit(page, 'save changes');
    await expect(errorSummary(page)).toBeFocused();
    await expect(page.getByLabel('email', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expectNoViolationsInBothSchemes(page);

    await visit(page, '/signature');
    await page.getByLabel('full name', { exact: true }).fill('1');
    await submit(page, 'sign with my typed name');
    await expect(errorSummary(page)).toBeFocused();
    await expect(page.getByLabel('full name', { exact: true })).toHaveAttribute('aria-invalid', 'true');
    await expectNoViolationsInBothSchemes(page);

    await visit(page, '/account/delete');
    await submit(page, 'delete my account');
    await expect(errorSummary(page)).toBeFocused();
    await expect(page.getByLabel('current password', { exact: true })).toHaveAccessibleDescription(
      'Error: Enter your current password',
    );
    await expectNoA11yViolations(page);
  });

  test('F-79, B-63, B-64, B-67: every signed-in page has lang, charset first, viewport, one h1, landmarks and a working skip link', async ({
    page,
  }) => {
    for (const path of SIGNED_IN_PAGES) {
      await visit(page, path);
      await expectPageSkeleton(page);
    }
    // B-67: supporters are an ordered list, the navigation a list of links.
    await visit(page, '/supporters');
    await expect(page.getByRole('main').getByRole('list').first()).toBeVisible();
    await expect(page.locator('main ol li').first()).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('listitem')).toHaveCount(3);
  });

  test('F-80, B-65, B-72: profile, account and typed-signature controls have visible labels, types and autocomplete tokens', async ({
    page,
  }) => {
    await visit(page, '/profile');
    await expectLabelledControls(page);
    await expectField(page, 'age', { autocomplete: 'off', inputmode: 'numeric' });
    await expectField(page, 'city', { autocomplete: 'address-level2' });
    await expectField(page, 'homepage', { type: 'url', autocomplete: 'url' });

    await visit(page, '/profile/edit');
    await expectLabelledControls(page);
    await expectField(page, 'first name', { autocomplete: 'given-name' });
    await expectField(page, 'last name', { autocomplete: 'family-name' });
    await expectField(page, 'email', { type: 'email', autocomplete: 'email' });
    await expectField(page, 'age', { autocomplete: 'off', inputmode: 'numeric' });
    await expectField(page, 'city', { autocomplete: 'address-level2' });
    await expectField(page, 'homepage', { type: 'url', autocomplete: 'url' });
    await expectField(page, 'new password', { type: 'password', autocomplete: 'new-password' });
    await expectField(page, 'current password', { type: 'password', autocomplete: 'current-password' });

    await visit(page, '/account/delete');
    await expectLabelledControls(page);
    await expectField(page, 'current password', { type: 'password', autocomplete: 'current-password' });

    await visit(page, '/signature');
    await expectLabelledControls(page);
    await expectField(page, 'full name', { autocomplete: 'name' });
  });

  test('B-70: the signature pad has a name and instructions, and typing the name is the keyboard alternative', async ({
    page,
  }) => {
    await visit(page, '/signature');
    const pad = page.getByRole('img', { name: 'Signature pad' });
    await expect(pad).toBeVisible();
    await expect(pad).toHaveAccessibleDescription(/^Sign in the field below with a mouse, a finger or a pen\./);
    // The keyboard path: the typed-name field and its button are tab stops.
    await tabTo(page, page.getByLabel('full name', { exact: true }));
    await tabTo(page, page.getByRole('button', { name: 'sign with my typed name' }));
    await expectNoA11yViolations(page);
  });
});

test('F-78, F-84: signer pages have no axe violations in light and dark mode and the signature image has alt text', async ({
  page,
}) => {
  await registerSigner(page);
  // Right after signing: the thank-you page with its flash message.
  await expect(flash(page)).toContainText('Thank you, your signature was saved');
  await expectNoViolationsInBothSchemes(page);
  await expect(page.getByRole('img', { name: 'Your signature' })).toHaveAttribute('src', '/signature/image.png');

  for (const path of SIGNER_PAGES) {
    await visit(page, path);
    await expectNoViolationsInBothSchemes(page);
    await expectPageSkeleton(page);
  }
});

// ------------------------------------------------------------------------------------------------------------------
// Keyboard and focus (F-79, F-81, B-66, B-83)
// ------------------------------------------------------------------------------------------------------------------

test('F-79, F-81, B-66: a keyboard-only visitor registers, skips onboarding and signs with a typed name', async ({
  page,
}) => {
  const email = `e2e-${randomUUID()}@petition.test`;
  await visit(page, '/');

  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('main')).toBeFocused();

  // From the main content, Tab continues inside it: the home row "register".
  await tabTo(page, page.getByRole('main').getByRole('link', { name: /^register\b/ }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/register$/);

  await tabTo(page, page.getByLabel('first name', { exact: true }));
  await page.keyboard.type('Grace');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('last name', { exact: true })).toBeFocused();
  await page.keyboard.type('Keyboard');
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('email', { exact: true })).toBeFocused();
  await page.keyboard.type(email);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('password', { exact: true })).toBeFocused();
  await page.keyboard.type(randomBytes(18).toString('base64url'));
  await tabTo(page, page.getByRole('button', { name: 'register', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/profile$/);

  await tabTo(page, page.getByRole('link', { name: 'skip', exact: true }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/signature$/);

  await tabTo(page, page.getByLabel('full name', { exact: true }));
  await page.keyboard.type('Grace Keyboard');
  await tabTo(page, page.getByRole('button', { name: 'sign with my typed name' }));
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/thank-you$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you for your signature');

  await expectNoViolationsInBothSchemes(page);
});

test.describe('focus ring', () => {
  for (const scheme of ['light', 'dark'] as const) {
    // One test per page: each page walks every tab stop with the keyboard, which takes a few seconds on its own.
    for (const path of ['/', '/register', '/login', '/privacy', '/no-such-page']) {
      test(`F-81, B-66: every tab stop of the guest page ${path} shows a 2px focus ring with 3:1 contrast (${scheme})`, async ({
        page,
      }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await visit(page, path);
        await expectVisibleFocusOnEveryStop(page);
      });
    }
  }

  test.describe('signed in', () => {
    test.use({ signedIn: true });

    for (const scheme of ['light', 'dark'] as const) {
      for (const path of ['/profile', '/profile/edit', '/signature', '/supporters', '/account/delete']) {
        test(`F-81, B-66: every tab stop of the signed-in page ${path} shows a 2px focus ring with 3:1 contrast (${scheme})`, async ({
          page,
        }) => {
          await page.emulateMedia({ colorScheme: scheme });
          await visit(page, path);
          await expectVisibleFocusOnEveryStop(page);
        });
      }
    }
  });

  test('F-81, B-66: every tab stop of the signer pages shows a 2px focus ring with 3:1 contrast (light and dark)', async ({
    page,
  }) => {
    await registerSigner(page);
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of SIGNER_PAGES) {
        await visit(page, path);
        await expectVisibleFocusOnEveryStop(page);
      }
    }
  });
});

test.describe('hover and focus', () => {
  // Without transitions the computed styles are final at once (reduced motion turns them off, F-85).
  test.beforeEach(async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
  });

  for (const path of ['/', '/register', '/login']) {
    test(`F-81, B-83: on the guest page ${path} every hover effect has the same keyboard focus effect`, async ({
      page,
    }) => {
      await visit(page, path);
      await expectHoverHasFocusEquivalent(page);
    });
  }

  test.describe('signed in', () => {
    test.use({ signedIn: true });

    for (const path of ['/profile/edit', '/signature', '/supporters?page=2']) {
      test(`F-81, B-83: on the signed-in page ${path} every hover effect has the same keyboard focus effect`, async ({
        page,
      }) => {
        await visit(page, path);
        await expectHoverHasFocusEquivalent(page);
      });
    }
  });

  test('F-81, B-83: on the thank-you page every hover effect has the same keyboard focus effect', async ({ page }) => {
    await registerSigner(page);
    await visit(page, '/thank-you');
    await expectHoverHasFocusEquivalent(page);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Text size, reflow, zoom and the sticky header (F-82, F-83, B-63, B-74, B-81)
// ------------------------------------------------------------------------------------------------------------------

/**
 * F-82, B-74: the root and body text are 16px, running text in `<main>` (paragraphs and list items) is at least 16px,
 * and nothing is smaller than the 14px meta size of labels, hints, row meta and the footer. Meta-size paragraphs in
 * `<main>` are only the hints, errors and instructions tied to a control (`aria-describedby`) and the pagination
 * status inside its navigation.
 */
async function expectReadableTextSizes(page: Page): Promise<void> {
  const facts = await page.evaluate(() => {
    const px = (element: Element) => Number.parseFloat(getComputedStyle(element).fontSize);
    const describedIds = new Set(
      [...document.querySelectorAll('[aria-describedby]')].flatMap((element) =>
        (element.getAttribute('aria-describedby') ?? '').split(/\s+/),
      ),
    );
    const hasOwnText = (element: Element) =>
      [...element.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '',
      );
    const describe = (element: Element) =>
      `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> ${String(px(element))}px`;
    const texts = [...document.body.querySelectorAll('*')].filter(hasOwnText);
    return {
      root: px(document.documentElement),
      body: px(document.body),
      belowMeta: texts.filter((element) => px(element) < 14).map(describe),
      smallRunningText: [...document.querySelectorAll('main p, main li')]
        .filter((element) => hasOwnText(element) || element.querySelector(':scope > a, :scope > span') !== null)
        .filter((element) => !describedIds.has(element.id) && element.closest('nav') === null)
        .filter((element) => px(element) < 16)
        .map(describe),
      smallControls: [...document.querySelectorAll('input:not([type="hidden"]), textarea, select, button')]
        .filter((element) => px(element) < 16)
        .map(describe),
    };
  });
  const where = page.url();
  expect(facts.root, where).toBe(16);
  expect(facts.body, where).toBe(16);
  expect(facts.belowMeta, `${where}: text below 14px`).toEqual([]);
  expect(facts.smallRunningText, `${where}: running text below 16px`).toEqual([]);
  expect(facts.smallControls, `${where}: controls below 16px`).toEqual([]);
}

test('F-82, B-74: guest pages use 16px body text and no text below the 14px meta size', async ({ page }) => {
  for (const path of GUEST_PAGES) {
    await visit(page, path);
    await expectReadableTextSizes(page);
  }
});

test.describe('signed in text', () => {
  test.use({ signedIn: true });

  test('F-82, B-74: signed-in pages use 16px body text and no text below the 14px meta size', async ({ page }) => {
    for (const path of SIGNED_IN_PAGES) {
      await visit(page, path);
      await expectReadableTextSizes(page);
    }
  });
});

test('F-83, F-82, B-63, B-81: guest pages reflow from 320px to 1440px without horizontal scrolling or clipping', async ({
  page,
}) => {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of GUEST_PAGES) {
      await visit(page, path);
      expect(await layoutProblems(page), `${path} at ${String(width)}px`).toEqual([]);
    }
  }
});

test.describe('signed in reflow', () => {
  test.use({ signedIn: true });

  test('F-83, F-82, B-63, B-81: signed-in pages reflow from 320px to 1440px without horizontal scrolling or clipping', async ({
    page,
  }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of SIGNED_IN_PAGES) {
        await visit(page, path);
        expect(await layoutProblems(page), `${path} at ${String(width)}px`).toEqual([]);
      }
    }
  });

  test('F-82, B-74, B-81: signed-in pages survive 200% text zoom at 1440px and 390px without clipping', async ({
    page,
  }) => {
    for (const width of [DESKTOP.width, 390]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of SIGNED_IN_PAGES) {
        await visit(page, path);
        await zoomText(page, 200);
        expect(await layoutProblems(page), `${path} at ${String(width)}px, text 200%`).toEqual([]);
      }
    }
  });
});

test('F-82, B-74, B-81: guest pages survive 200% text zoom at 1440px and 390px without clipping', async ({ page }) => {
  for (const width of [DESKTOP.width, 390]) {
    await page.setViewportSize({ width, height: 800 });
    for (const path of GUEST_PAGES) {
      await visit(page, path);
      await zoomText(page, 200);
      expect(await layoutProblems(page), `${path} at ${String(width)}px, text 200%`).toEqual([]);
    }
  }
});

test('F-82, F-83, B-81: the signer pages reflow at 320px and survive 200% text zoom', async ({ page }) => {
  await registerSigner(page);
  for (const path of SIGNER_PAGES) {
    await page.setViewportSize({ width: 320, height: 800 });
    await visit(page, path);
    expect(await layoutProblems(page), `${path} at 320px`).toEqual([]);
    await page.setViewportSize(DESKTOP);
    await visit(page, path);
    await zoomText(page, 200);
    expect(await layoutProblems(page), `${path} at 1440px, text 200%`).toEqual([]);
  }
});

test.describe('signature pad layout', () => {
  test.use({ signedIn: true });

  test('F-83, B-63: the signature pad fills its container and keeps its 3:1 aspect ratio from 320px to 1440px', async ({
    page,
  }) => {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      await visit(page, '/signature');
      const pad = page.getByRole('img', { name: 'Signature pad' });
      await expect(pad).toBeVisible();
      const geometry = await pad.evaluate((canvas) => {
        const box = canvas.getBoundingClientRect();
        const container = canvas.parentElement?.getBoundingClientRect();
        return { width: box.width, height: box.height, containerWidth: container?.width ?? 0 };
      });
      const where = `${String(width)}px`;
      expect(geometry.width, `${where}: fits its container`).toBeLessThanOrEqual(geometry.containerWidth + 0.5);
      expect(geometry.width, `${where}: uses the container width`).toBeGreaterThanOrEqual(
        geometry.containerWidth - 0.5,
      );
      expect(geometry.width / geometry.height, `${where}: export ratio 720 x 240`).toBeCloseTo(3, 1);
      expect(await layoutProblems(page), where).toEqual([]);
    }
  });
});

/** The sticky header's bottom edge, or 0 when the header scrolls away with the page (narrow screens). */
async function stickyHeaderBottom(page: Page): Promise<number> {
  return page
    .getByRole('banner')
    .evaluate((header) => (getComputedStyle(header).position === 'sticky' ? header.getBoundingClientRect().bottom : 0));
}

test('B-81: at 1440px the sticky header never covers the focused element of a long page', async ({ page }) => {
  await page.setViewportSize({ width: DESKTOP.width, height: 600 });
  await visit(page, '/privacy');
  expect(await stickyHeaderBottom(page), 'the header is sticky at 1440px').toBeGreaterThan(0);

  const count = await tagTabStops(page);
  for (let index = 0; index < count; index += 1) {
    await focusWithKeyboard(page, index);
    // The first line box of the element (a wrapped link has several) must be what is painted at its centre, also
    // after a smooth scroll (motion-safe) has come to rest, hence the poll.
    await expect
      .poll(
        () =>
          stop(page, index).evaluate((element) => {
            const box = element.getClientRects()[0] ?? element.getBoundingClientRect();
            const x = Math.min(Math.max(box.left + box.width / 2, 0), window.innerWidth - 1);
            const y = Math.min(Math.max(box.top + box.height / 2, 0), window.innerHeight - 1);
            const hit = document.elementFromPoint(x, y);
            if (hit !== null && (hit === element || element.contains(hit))) return null;
            const text = (element as HTMLElement).innerText.trim().slice(0, 40);
            return `${element.tagName.toLowerCase()} "${text}" is covered by <${hit?.tagName.toLowerCase() ?? 'nothing'} class="${hit?.getAttribute('class') ?? ''}">`;
          }),
        { message: `stop ${String(index)}` },
      )
      .toBeNull();
  }
});

test.describe('error summary targets', () => {
  test.use({ signedIn: true });

  test('B-81, B-68: at 1440px an error summary link scrolls its field into view below the sticky header', async ({
    page,
  }) => {
    await page.setViewportSize({ width: DESKTOP.width, height: 600 });
    await visit(page, '/profile/edit');
    await page.getByLabel('homepage', { exact: true }).fill('ftp://example.com');
    await page.getByLabel('new password', { exact: true }).fill('short');
    await submit(page, 'save changes');

    const links = errorSummary(page).getByRole('link');
    await expect(links.first()).toBeVisible();
    const hrefs = await links.evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute('href') ?? ''));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const [index, href] of hrefs.entries()) {
      expect(href, 'links to a field').toMatch(/^#[A-Za-z]+$/);
      await links.nth(index).focus();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      const field = page.locator(href);
      await expect(field).toBeInViewport();
      const top = await field.evaluate((element) => element.getBoundingClientRect().top);
      expect(top, `${href} below the header`).toBeGreaterThanOrEqual(await stickyHeaderBottom(page));
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------
// Images and motion (F-84, F-85, B-40, B-69, B-83)
// ------------------------------------------------------------------------------------------------------------------

/** F-84, B-69: images carry alt, SVG icons are hidden, and every link and button has visible text naming it. */
async function expectTextAlternatives(page: Page): Promise<void> {
  const facts = await page.evaluate(() => ({
    imagesWithoutAlt: [...document.images].filter((image) => !image.hasAttribute('alt')).map((image) => image.src),
    exposedSvgs: [...document.querySelectorAll('svg')]
      .filter((svg) => svg.closest('[aria-hidden="true"]') === null && svg.querySelector('title') === null)
      .map((svg) => svg.outerHTML.slice(0, 60)),
    imageOnlyControls: [...document.querySelectorAll('a[href], button')]
      .filter((control) => control.textContent.trim() === '')
      .map((control) => control.outerHTML.slice(0, 80)),
  }));
  const where = page.url();
  expect(facts.imagesWithoutAlt, `${where}: img without alt`).toEqual([]);
  expect(facts.exposedSvgs, `${where}: svg icons must be aria-hidden`).toEqual([]);
  expect(facts.imageOnlyControls, `${where}: links and buttons need text`).toEqual([]);
}

test('F-84, B-69: guest pages have text alternatives and links named after their destination', async ({ page }) => {
  for (const path of GUEST_PAGES) {
    await visit(page, path);
    await expectTextAlternatives(page);
  }
  // The legacy icon links ("eye", "trash", "profile") are text rows that name their destination.
  await visit(page, '/');
  const rows = page.getByRole('main').getByRole('link');
  await expect(rows.filter({ hasText: 'see all supporters' })).toHaveAttribute('href', '/supporters');
  await expect(rows.filter({ hasText: 'delete your account' })).toHaveAttribute('href', '/account/delete');
  await expect(rows.filter({ hasText: 'tell us about yourself' })).toHaveAttribute('href', '/profile');
  await expect(page.getByRole('link', { name: /^(eye|trash|click|login|signature)$/ })).toHaveCount(0);
});

test('F-84, B-69: signer pages have text alternatives; the signature is a content image named "Your signature"', async ({
  page,
}) => {
  await registerSigner(page);
  for (const path of [...SIGNER_PAGES, '/supporters', '/profile/edit']) {
    await visit(page, path);
    await expectTextAlternatives(page);
  }
  await visit(page, '/thank-you');
  await expect(page.getByRole('img', { name: 'Your signature' })).toBeVisible();
  await expect(page.getByRole('main').getByRole('link', { name: 'see all supporters' })).toHaveAttribute(
    'href',
    '/supporters',
  );
});

/** Every running animation and every non-zero transition on the page (F-85). */
async function motion(page: Page): Promise<{ animations: string[]; transitions: string[]; scrollBehavior: string }> {
  return page.evaluate(() => ({
    animations: document
      .getAnimations()
      .map((animation) => (animation instanceof CSSAnimation ? animation.animationName : animation.constructor.name)),
    transitions: [...document.querySelectorAll('*')]
      .filter((element) =>
        getComputedStyle(element)
          .transitionDuration.split(',')
          .some((duration) => Number.parseFloat(duration) > 0),
      )
      .map((element) => `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}">`),
    scrollBehavior: getComputedStyle(document.documentElement).scrollBehavior,
  }));
}

test('F-85, B-83: with prefers-reduced-motion nothing animates or transitions, on hover or after signing', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await registerSigner(page);
  // The thank-you page right after signing: the flash and the signature frame would fade in.
  await expect(flash(page)).toContainText('Thank you, your signature was saved');
  expect(await motion(page)).toEqual({ animations: [], transitions: [], scrollBehavior: 'auto' });

  for (const path of ['/', '/supporters']) {
    await visit(page, path);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'supporters' }).hover();
    expect(await motion(page), `${path}: nav hover`).toEqual({
      animations: [],
      transitions: [],
      scrollBehavior: 'auto',
    });
    await page.getByRole('main').getByRole('link').first().hover();
    expect(await motion(page), `${path}: row hover`).toEqual({
      animations: [],
      transitions: [],
      scrollBehavior: 'auto',
    });
  }
});

test('F-85, B-83: without a motion preference the hover shake runs only on pointer devices that can hover', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await visit(page, '/');
  const canHover = await page.evaluate(() => matchMedia('(hover: hover)').matches);
  const link = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'about' });
  await link.hover();
  const animations = await link.evaluate((element) =>
    element.getAnimations().map((animation) => (animation as CSSAnimation).animationName),
  );
  // The preference is what turns the motion off in the test above, not a missing animation.
  expect(animations).toEqual(canHover ? ['shake'] : []);
  expect((await motion(page)).scrollBehavior).toBe('smooth');
});

test('F-85, B-40: no element follows the mouse cursor', async ({ page }) => {
  await visit(page, '/');
  const heading = await page.getByRole('heading', { level: 1 }).boundingBox();
  if (heading === null) throw new Error('the page heading has no layout box');
  const layout = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('body *')].map((element) => {
        const box = element.getBoundingClientRect();
        return [box.x, box.y, box.width, box.height].map(Math.round).join(',');
      }),
    );

  await page.mouse.move(heading.x + 2, heading.y + 2);
  const before = await layout();
  for (const [x, y] of [
    [heading.x + heading.width - 2, heading.y + heading.height - 2],
    [heading.x + heading.width / 2, heading.y + 2],
    [heading.x + 2, heading.y + heading.height - 2],
  ] as const) {
    await page.mouse.move(x, y, { steps: 5 });
    expect(await layout(), `mouse at ${String(Math.round(x))},${String(Math.round(y))}`).toEqual(before);
  }
});
