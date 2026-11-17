import { expectNoA11yViolations } from './a11y.ts';
import { expect, test } from './fixtures.ts';

// Phase-1 smoke spec: the production image renders a page with its hashed assets and fonts, headers and the 404
// page. `test` from fixtures.ts fails every test on a Content-Security-Policy violation (F-71), so each page below is
// also proven to render under the strict CSP.

test('F-16, F-78: the home page renders with its title, landmarks and assets and has no axe violations', async ({
  page,
}) => {
  const response = await page.goto('/');

  expect(response?.status()).toBe(200);
  await expect(page).toHaveTitle('Home · Nonsense Petition');
  await expect(page.getByRole('main')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Nonsense Petition');

  // Hashed stylesheet and module entry from the manifest (ADR 0010).
  const stylesheet = await page.locator('link[rel="stylesheet"]').getAttribute('href');
  const script = await page.locator('script[type="module"]').first().getAttribute('src');
  expect(stylesheet).toMatch(/^\/assets\/app-[a-f0-9]{10}\.css$/);
  expect(script).toMatch(/^\/assets\/form-guard-[\w-]+\.js$/);
  for (const path of [stylesheet, script, '/fonts/schibsted-grotesk-latin-400-normal.woff2']) {
    const asset = await page.request.get(path ?? '');
    expect(asset.status(), path ?? '').toBe(200);
  }

  await expectNoA11yViolations(page);
});

test('F-78: the home page has no axe violations in dark mode', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');

  await expectNoA11yViolations(page);
});

test('F-71, F-86: pages carry the strict CSP and no upgrade-insecure-requests on the http stack', async ({ page }) => {
  const response = await page.goto('/');
  const headers = response?.headers() ?? {};

  expect(headers['content-security-policy']).toContain("script-src 'self'");
  expect(headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(headers['content-security-policy']).not.toContain('upgrade-insecure-requests');
  expect(headers['strict-transport-security']).toBeUndefined();
  expect(headers['x-powered-by']).toBeUndefined();
});

test('F-08, B-43: an unknown path is a 404 page that links home and has no axe violations', async ({ page }) => {
  const response = await page.goto('/no-such-page');

  expect(response?.status()).toBe(404);
  await expect(page).toHaveTitle('Page not found · Nonsense Petition');
  await expect(page.getByRole('link', { name: 'go to the home page' })).toHaveAttribute('href', '/');
  await expectNoA11yViolations(page);
});

test('F-71: the browser enforces the CSP: an injected inline script does not run and is reported', async ({
  page,
  cspViolations,
}) => {
  await page.goto('/');

  // The script element is created by page code, so the page's CSP decides; Playwright's own evaluation is exempt.
  const ran = await page.evaluate(async () => {
    const script = document.createElement('script');
    script.textContent = 'document.documentElement.dataset.inlineScriptRan = "yes";';
    document.head.append(script);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return document.documentElement.dataset['inlineScriptRan'] ?? 'no';
  });

  expect(ran).toBe('no');
  await expect.poll(() => cspViolations.length).toBeGreaterThan(0);
  // Taken out of the guard's list: this violation is the expected result, every other one still fails the test.
  const [violation, ...others] = cspViolations.splice(0);
  expect(others).toEqual([]);
  expect(violation).toMatchObject({ blockedURI: 'inline', directive: expect.stringMatching(/^script-src/) });
});
