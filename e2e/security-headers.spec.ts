import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { Page, Response } from '@playwright/test';

import { documentAfter, expect, gotoResponse, registerUser, signTyped, test, uniqueCity } from './fixtures.ts';

/**
 * Security headers, CSP and third-party isolation on the production image (F-71, F-86; B-10, B-16, B-40, B-82;
 * ADR 0010, ADR 0011). `headers.int.test.ts` proves the header switch positions in-process; this spec proves what a
 * browser receives from the built image behind the published port, on every kind of response: pages in every state,
 * error pages, hashed assets, fonts, icons and the private signature image. `test` from fixtures.ts also fails every
 * test on a Content-Security-Policy violation the browser reports (F-71).
 */

/** The exact policy of ADR 0011 on the plain-http stack (`COOKIE_SECURE=false`: no upgrade-insecure-requests). */
const EXPECTED_CSP: Readonly<Record<string, readonly string[]>> = {
  'default-src': ["'self'"],
  'script-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'"],
  'font-src': ["'self'"],
  'connect-src': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
  'base-uri': ["'none'"],
  'object-src': ["'none'"],
  'manifest-src': ["'self'"],
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const MONTH_SECONDS = 30 * 24 * 60 * 60;
const DAY_SECONDS = 24 * 60 * 60;

function parseCsp(header: string | undefined): Record<string, string[]> {
  const directives: Record<string, string[]> = {};
  for (const part of (header ?? '').split(';')) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name !== undefined && name !== '') directives[name] = values;
  }
  return directives;
}

/** The helmet headers every response carries, pages and static files alike (F-71, B-10, ADR 0011). */
function expectSecurityHeaders(headers: Record<string, string>, label: string): void {
  expect(parseCsp(headers['content-security-policy']), `${label}: CSP`).toEqual(EXPECTED_CSP);
  expect(headers['x-content-type-options'], label).toBe('nosniff');
  expect(headers['referrer-policy'], label).toBe('strict-origin-when-cross-origin');
  expect(headers['cross-origin-opener-policy'], label).toBe('same-origin');
  expect(headers['cross-origin-resource-policy'], label).toBe('same-origin');
  expect(headers['x-frame-options'], label).toBe('DENY');
  expect(headers['x-powered-by'], `${label}: no framework banner`).toBeUndefined();
  // Plain http (COOKIE_SECURE=false): HSTS would pin 127.0.0.1 to https (ADR 0011).
  expect(headers['strict-transport-security'], label).toBeUndefined();
}

/** Dynamic HTML on top of that: never cached, never compressed (BREACH, ADR 0010), with a request id. */
async function expectHtmlResponse(response: Response, status: number): Promise<void> {
  const label = `${response.request().method()} ${new URL(response.url()).pathname}${new URL(response.url()).search}`;
  expect(response.status(), label).toBe(status);
  const headers = await response.allHeaders();
  expectSecurityHeaders(headers, label);
  expect(headers['content-type'], label).toBe('text/html; charset=utf-8');
  expect(headers['cache-control'], label).toBe('no-store');
  expect(headers['content-encoding'], `${label}: HTML is never compressed`).toBeUndefined();
  expect(headers['x-request-id'], label).toMatch(UUID);
}

test.describe('guest', () => {
  test('F-71, B-10: every guest page, form re-render and error page carries the exact CSP and security headers', async ({
    page,
  }) => {
    for (const path of ['/', '/about', '/privacy', '/register', '/login', '/login?returnTo=%2Fsupporters']) {
      await expectHtmlResponse(await gotoResponse(page, path), 200);
    }
    await expectHtmlResponse(await gotoResponse(page, '/no-such-page'), 404);

    await page.goto('/register');
    await expectHtmlResponse(
      await documentAfter(page, () => page.getByRole('button', { name: 'register' }).click()),
      422,
    );

    await page.goto('/login');
    await page.locator('#email').fill(`e2e-unknown-${uniqueCity()}@petition.test`);
    await page.locator('#password').fill('not the password at all');
    await expectHtmlResponse(
      await documentAfter(page, () => page.getByRole('button', { name: 'log in' }).click()),
      401,
    );

    await page.locator('form[action="/login"] input[name="_csrf"]').evaluate((input) => {
      (input as HTMLInputElement).value = 'tampered';
    });
    await expectHtmlResponse(
      await documentAfter(page, () => page.getByRole('button', { name: 'log in' }).click()),
      403,
    );
  });

  test('F-71, B-10: the 404 page of a missing asset or font carries the same headers as every other page', async ({
    page,
  }) => {
    // The static routers answer a missing file themselves (`fallthrough: false`), before the layout middleware.
    await expectHtmlResponse(await gotoResponse(page, '/assets/no-such-file-0000000000.css'), 404);
    await expectHtmlResponse(await gotoResponse(page, '/fonts/no-such-font.woff2'), 404);
  });

  test('F-71, B-10: the browser refuses to frame any page (frame-ancestors none, X-Frame-Options DENY)', async ({
    page,
    baseURL,
  }) => {
    // An attacker's page on another origin (about:blank here) embeds the home page.
    const frameResponse = page.waitForResponse((response) => response.url() === `${baseURL ?? ''}/`);
    await page.setContent(`<iframe title="embedded petition" src="${baseURL ?? ''}/"></iframe>`);
    expect((await frameResponse).status()).toBe(200);

    const framed = page.frameLocator('iframe');
    await expect(page.locator('iframe')).toBeVisible();
    // The response arrived, but the browser blocked rendering it: the frame never shows the petition.
    await expect
      .poll(
        () =>
          page
            .frames()
            .find((frame) => frame !== page.mainFrame())
            ?.url() ?? '',
      )
      .not.toBe(`${baseURL ?? ''}/`);
    await expect(framed.getByRole('heading', { name: 'Nonsense Petition' })).toHaveCount(0);
  });

  test('F-88: the privacy page, like every public page, creates no session for a guest', async ({ page }) => {
    for (const path of ['/privacy', '/', '/about']) {
      const response = await gotoResponse(page, path);
      await expectHtmlResponse(response, 200);
      expect(await response.headerValue('set-cookie'), `${path}: no cookie for a guest`).toBeNull();
    }
    expect(await page.context().cookies()).toEqual([]);
  });

  test('F-73: a well-formed x-request-id is echoed, anything else is replaced by a fresh UUID', async ({ page }) => {
    const echoed = await page.request.get('/', { headers: { 'x-request-id': 'e2e-request-0001' } });
    expect(echoed.headers()['x-request-id']).toBe('e2e-request-0001');

    const replaced = await page.request.get('/', { headers: { 'x-request-id': 'bad id <script>' } });
    expect(replaced.headers()['x-request-id']).toMatch(UUID);
  });
});

test.describe('signed in', () => {
  test.use({ signedIn: true });

  test('F-71, B-10: every signed-in page, form re-render and error page carries the exact CSP and security headers', async ({
    page,
  }) => {
    for (const path of [
      '/',
      '/profile',
      '/profile/edit',
      '/signature',
      '/supporters',
      '/supporters?page=2',
      `/supporters/city/${encodeURIComponent('Berlin')}`,
      '/account/delete',
    ]) {
      await expectHtmlResponse(await gotoResponse(page, path), 200);
    }
    await expectHtmlResponse(await gotoResponse(page, '/supporters?page=10000'), 404);

    await page.goto('/signature');
    await page.locator('#typedName').fill('1');
    await expectHtmlResponse(
      await documentAfter(page, () => page.getByRole('button', { name: 'sign with my typed name' }).click()),
      422,
    );

    await page.goto('/profile/edit');
    await page.locator('#email').fill('not-an-email');
    await expectHtmlResponse(
      await documentAfter(page, () => page.getByRole('button', { name: 'save changes' }).click()),
      422,
    );
  });

  test('B-40, F-71: no console errors, script errors or CSP violations on any page, also while the mouse moves', async ({
    page,
    cspViolations,
  }) => {
    const errors: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`${page.url()}: console: ${message.text()}`);
    });
    page.on('pageerror', (error) => {
      errors.push(`${page.url()}: ${error.message}`);
    });

    // The legacy city page threw on every mouse move and a hint followed the cursor on the list (B-40).
    for (const path of [
      '/',
      '/about',
      '/privacy',
      '/profile',
      '/profile/edit',
      '/signature',
      '/supporters',
      `/supporters/city/${encodeURIComponent('Berlin')}`,
      `/supporters/city/${encodeURIComponent('Halle (Saale)')}`,
      '/account/delete',
    ]) {
      await gotoResponse(page, path);
      const viewport = page.viewportSize() ?? { width: 390, height: 844 };
      for (const [x, y] of [
        [0.1, 0.2],
        [0.5, 0.5],
        [0.9, 0.8],
        [0.3, 0.9],
      ] as const) {
        await page.mouse.move(viewport.width * x, viewport.height * y, { steps: 4 });
      }
      // Let every module script finish its first task before leaving the page.
      await page.evaluate(() => new Promise((resolveFrame) => requestAnimationFrame(resolveFrame)));
    }

    expect(errors).toEqual([]);
    expect(cspViolations).toEqual([]);
  });
});

test('F-71: the signature image is private: PNG, never cached, nosniff, and only for its signer', async ({
  page,
  newGuardedContext,
}) => {
  await registerUser(page, { profile: { city: uniqueCity() } });

  // Signed in but not signed: an image URL never answers with an HTML redirect (ROUTES.md section 5).
  const before = await page.request.get('/signature/image.png', { maxRedirects: 0 });
  expect(before.status()).toBe(404);

  await signTyped(page);
  const image = page.getByRole('img', { name: 'Your signature' });
  await expect(image).toHaveAttribute('src', '/signature/image.png');
  await expect.poll(() => image.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(720);

  const response = await page.request.get('/signature/image.png', { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const headers = response.headers();
  expectSecurityHeaders(headers, 'GET /signature/image.png');
  expect(headers['content-type']).toBe('image/png');
  expect(headers['cache-control']).toBe('private, no-store');
  expect(Number(headers['content-length'])).toBe((await response.body()).length);
  expect((await response.body()).subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  // A guest gets no image either: the guard sends them to the login page.
  const guest = await newGuardedContext();
  const anonymous = await guest.request.get('/signature/image.png', { maxRedirects: 0 });
  expect(anonymous.status()).toBe(302);
  expect(anonymous.headers()['location']).toBe('/login?returnTo=%2Fsignature%2Fimage.png');
});

test('B-82, F-86: one hashed stylesheet, module scripts, fonts and icons come from self with their cache headers and no cookie', async ({
  page,
}) => {
  await page.goto('/');
  const stylesheets = await page
    .locator('link[rel="stylesheet"]')
    .evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
  expect(stylesheets, 'B-82: exactly one built stylesheet').toHaveLength(1);
  expect(stylesheets[0]).toMatch(/^\/assets\/app-[a-f0-9]{10}\.css$/);
  const scripts = await page
    .locator('script')
    .evaluateAll((elements) =>
      elements.map((element) => ({ src: element.getAttribute('src') ?? '', type: element.getAttribute('type') ?? '' })),
    );
  expect(scripts.length).toBeGreaterThan(0);
  for (const script of scripts) {
    expect(script.type, script.src).toBe('module');
    expect(script.src).toMatch(/^\/assets\/[\w-]+\.js$/);
  }

  const assets: { path: string; type: RegExp; cache: string; compressed: boolean }[] = [
    {
      path: stylesheets[0] ?? '',
      type: /^text\/css; charset=utf-8$/,
      cache: `public, max-age=${String(YEAR_SECONDS)}, immutable`,
      compressed: true,
    },
    ...scripts.map(({ src }) => ({
      path: src,
      type: /^(text|application)\/javascript; charset=utf-8$/,
      cache: `public, max-age=${String(YEAR_SECONDS)}, immutable`,
      compressed: false,
    })),
    {
      path: '/fonts/schibsted-grotesk-latin-400-normal.woff2',
      type: /^font\/woff2$/,
      cache: `public, max-age=${String(MONTH_SECONDS)}`,
      compressed: false,
    },
    {
      path: '/fonts/schibsted-grotesk-latin-500-normal.woff2',
      type: /^font\/woff2$/,
      cache: `public, max-age=${String(MONTH_SECONDS)}`,
      compressed: false,
    },
    {
      path: '/favicon.svg',
      type: /^image\/svg\+xml$/,
      cache: `public, max-age=${String(DAY_SECONDS)}`,
      compressed: false,
    },
    {
      path: '/site.webmanifest',
      type: /^application\/manifest\+json/,
      cache: `public, max-age=${String(DAY_SECONDS)}`,
      compressed: false,
    },
  ];
  for (const asset of assets) {
    const response = await page.request.get(asset.path, { headers: { 'accept-encoding': 'gzip, br' } });
    const headers = response.headers();
    expect(response.status(), asset.path).toBe(200);
    expectSecurityHeaders(headers, asset.path);
    expect(headers['content-type'], asset.path).toMatch(asset.type);
    expect(headers['cache-control'], asset.path).toBe(asset.cache);
    // Static files are served before the session middleware: they never create a session (ADR 0010).
    expect(headers['set-cookie'], `${asset.path}: no cookie`).toBeUndefined();
    // B-82: the stylesheet is minified and compressed on the wire.
    if (asset.compressed) expect(headers['content-encoding'], asset.path).toMatch(/^(br|gzip)$/);
  }
});

/** Every request a page makes while it loads and settles, as absolute URLs. */
function recordRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on('request', (request) => urls.push(request.url()));
  return urls;
}

/** F-86: the page renders in the self-hosted Schibsted Grotesk, loaded from `/fonts`. */
async function expectSelfHostedFont(page: Page): Promise<void> {
  const font = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      family: getComputedStyle(document.body).fontFamily,
      loaded: document.fonts.check('16px "Schibsted Grotesk"'),
      faces: [...document.fonts].filter((face) => face.status === 'loaded').map((face) => face.family),
    };
  });
  expect(font.family).toMatch(/^"?Schibsted Grotesk"?,/);
  expect(font.loaded).toBe(true);
  expect(font.faces.some((family) => family.replaceAll('"', '') === 'Schibsted Grotesk')).toBe(true);
}

test('F-86, B-16: no page makes a third-party request, and the font is the self-hosted Schibsted Grotesk', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? page.url()).origin;
  const requests = recordRequests(page);

  for (const path of ['/', '/about', '/privacy', '/register', '/login', '/no-such-page']) {
    await page.goto(path);
    await expectSelfHostedFont(page);
  }
  // Signed in and signed: the sign page loads the signature pad module, the thank-you page the private image.
  await registerUser(page, { profile: { city: uniqueCity(), homepage: 'example.com' } });
  await page.goto('/signature');
  await expectSelfHostedFont(page);
  await signTyped(page);
  await expect(page.getByRole('img', { name: 'Your signature' })).toBeVisible();
  for (const path of [
    '/thank-you',
    '/supporters',
    `/supporters/city/${encodeURIComponent('Berlin')}`,
    '/profile/edit',
  ]) {
    await page.goto(path);
    await expectSelfHostedFont(page);
  }

  expect(requests.length).toBeGreaterThan(0);
  expect(
    requests.filter((url) => new URL(url).origin !== origin),
    'F-86: requests to another origin',
  ).toEqual([]);
  expect(requests.some((url) => /\/fonts\/schibsted-grotesk-latin-\d00-normal\.woff2$/.test(url))).toBe(true);
  expect(requests.some((url) => url.endsWith('/signature/image.png'))).toBe(true);
  // B-16: no CDN library is loaded at all (legacy jQuery came from code.jquery.com twice).
  expect(requests.filter((url) => /jquery|cdn|googleapis|gstatic/i.test(url))).toEqual([]);
});

test('F-86: the self-hosted font ships with its SIL Open Font License', async () => {
  const licence = await readFile(resolve(import.meta.dirname, '..', 'LICENSES', 'OFL-SchibstedGrotesk.txt'), 'utf8');
  expect(licence).toMatch(/SIL OPEN FONT LICENSE/i);
  expect(licence).toMatch(/Schibsted-Grotesk Project Authors/);
});
