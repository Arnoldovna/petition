import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Page, Response, TestInfo } from '@playwright/test';

import { documentAfter, expect, gotoResponse, registerUser, test, uniqueCity } from './fixtures.ts';

/**
 * HTML validity (F-87, B-73, ADR 0015, ADR 0019 section 6). Every page is visited in its guest, signed-in, signer,
 * validation, flash and error states, and each **raw** response body (not the DOM after scripts ran) is written to
 * `html/` inside the run's output directory as `<project>-<page>-<state>.html`. `scripts/validate-html.mjs` runs the
 * W3C Nu validator over that folder after a green Playwright run (`run-e2e.mjs`; unit 5d:
 * `node scripts/validate-html.mjs test-results/5d/html`). Playwright empties the output directory at the start of a
 * run, so no stale page is ever validated.
 *
 * The same raw bodies are checked here for what a validator does not report: the charset declaration is the first
 * child of `<head>` and inside the first 1024 bytes (B-64, F-79), and there is no inline code that the CSP would have
 * to allow (F-71): no `<script>` without `src`, no `<style>`, no `style` or `on*` attribute, no `javascript:` URL.
 */

/** Every page body this spec saves, so a test can prove it wrote what it promised. */
interface Saved {
  file: string;
  status: number;
}

/** Raw-body checks that hold for every HTML page (B-64, F-79, F-71). */
function expectWellFormedHead(body: string, label: string): void {
  expect(body, `${label}: doctype`).toMatch(/^<!doctype html>\s*<html lang="en">/i);

  // B-64: `<meta charset>` is the first child of <head> and lies inside the first 1024 bytes.
  const head = /<head>\s*<meta charset="utf-8">/i.exec(body);
  expect(head, `${label}: <meta charset="utf-8"> must be the first child of <head>`).not.toBeNull();
  const charsetEnd = Buffer.byteLength(body.slice(0, (head?.index ?? 0) + (head?.[0].length ?? 0)), 'utf8');
  expect(charsetEnd, `${label}: charset declaration must end within the first 1024 bytes`).toBeLessThanOrEqual(1024);
  expect(body, `${label}: viewport meta (B-63)`).toContain(
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
  );

  // F-71: nothing the strict CSP would block. Tags are matched as raw markup; user input is always escaped.
  const tags = body.match(/<[a-z][^>]*>/gi) ?? [];
  const scripts = tags.filter((tag) => /^<script\b/i.test(tag));
  expect(scripts.length, `${label}: at least the form-guard module`).toBeGreaterThan(0);
  for (const script of scripts) expect(script, `${label}: external module script only`).toMatch(/ src="\/assets\//);
  expect(
    tags.filter((tag) => /^<style\b/i.test(tag)),
    `${label}: no <style> element`,
  ).toEqual([]);
  expect(
    tags.filter((tag) => /\sstyle\s*=/i.test(tag)),
    `${label}: no style attribute`,
  ).toEqual([]);
  expect(
    tags.filter((tag) => /\son[a-z]+\s*=/i.test(tag)),
    `${label}: no inline event handler`,
  ).toEqual([]);
  expect(body, `${label}: no javascript: URL`).not.toMatch(/(href|src|action)\s*=\s*"\s*javascript:/i);
}

/** Writes the raw body of `response` for the Nu validator after checking its status and head. */
async function save(testInfo: TestInfo, saved: Saved[], response: Response, name: string, expectedStatus: number) {
  const label = `${name} (${response.request().method()} ${new URL(response.url()).pathname})`;
  expect(response.status(), label).toBe(expectedStatus);
  expect(response.headers()['content-type'], label).toBe('text/html; charset=utf-8');
  const body = await response.text();
  expectWellFormedHead(body, label);

  const dir = join(testInfo.project.outputDir, 'html');
  await mkdir(dir, { recursive: true });
  const file = `${testInfo.project.name}-${name}.html`;
  await writeFile(join(dir, file), body, 'utf8');
  saved.push({ file, status: response.status() });
}

/** Every file a test saved is on disk under its project prefix (the validator gets exactly these). */
async function expectSaved(testInfo: TestInfo, saved: Saved[]): Promise<void> {
  const onDisk = new Set(await readdir(join(testInfo.project.outputDir, 'html')));
  for (const { file } of saved) expect(onDisk.has(file), file).toBe(true);
  expect(new Set(saved.map(({ file }) => file)).size, 'every page state has its own file').toBe(saved.length);
}

/** Replaces the CSRF token of the login form, as a stale or forged form would send it. */
async function tamperLoginCsrf(page: Page): Promise<void> {
  await page.locator('form[action="/login"] input[type="hidden"][name="_csrf"]').evaluate((input) => {
    (input as HTMLInputElement).value = 'tampered';
  });
}

/** The sign page's typed-name form (the drawing form posts to the same action). */
function typedForm(page: Page) {
  return page.locator('form[action="/signature"]').filter({ has: page.locator('#typedName') });
}

test.describe('guest', () => {
  test('F-87, B-73: guest pages, their validation states and error pages are saved for the W3C validator (B-64, F-71, F-79)', async ({
    page,
  }, testInfo) => {
    const saved: Saved[] = [];
    const keep = (response: Response, name: string, status = 200) => save(testInfo, saved, response, name, status);

    await keep(await gotoResponse(page, '/'), 'home-guest');
    await keep(await gotoResponse(page, '/about'), 'about-guest');
    await keep(await gotoResponse(page, '/privacy'), 'privacy-guest');
    await keep(await gotoResponse(page, '/register'), 'register-guest');
    await keep(await gotoResponse(page, '/login'), 'login-guest');
    await keep(await gotoResponse(page, '/login?returnTo=%2Fsupporters'), 'login-return-to');

    // Validation: every register field empty (422, error summary and inline messages).
    await page.goto('/register');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'register' }).click()),
      'register-invalid',
      422,
    );
    // Validation with kept values: a malformed email and a short password.
    await page.locator('#firstName').fill('Ada');
    await page.locator('#lastName').fill('Lovelace <b>&</b> "Byron"');
    await page.locator('#email').fill('not-an-email');
    await page.locator('#password').fill('short');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'register' }).click()),
      'register-invalid-values',
      422,
    );

    await page.goto('/login');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'log in' }).click()),
      'login-invalid',
      422,
    );
    // Unknown email: the 401 re-render with the single "incorrect" message (a fresh email, so no limiter counts up).
    await page.locator('#email').fill(`e2e-unknown-${testInfo.testId}-${String(Date.now())}@petition.test`);
    await page.locator('#password').fill('not the password at all');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'log in' }).click()),
      'login-failed',
      401,
    );

    // Error pages: unknown path, a missing hashed asset (the static router's 404), an invalid CSRF token.
    await keep(await gotoResponse(page, '/no-such-page'), 'error-not-found', 404);
    await keep(await gotoResponse(page, '/assets/no-such-file-0000000000.css'), 'error-missing-asset', 404);
    await page.goto('/login');
    await page.locator('#email').fill('someone@petition.test');
    await page.locator('#password').fill('any password at all');
    await tamperLoginCsrf(page);
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'log in' }).click()),
      'error-csrf',
      403,
    );

    await expectSaved(testInfo, saved);
  });
});

test.describe('signed in', () => {
  test.use({ signedIn: true });

  test('F-87, B-73: signed-in pages, their validation states and error pages are saved for the W3C validator (B-64, F-71, F-79)', async ({
    page,
  }, testInfo) => {
    const saved: Saved[] = [];
    const keep = (response: Response, name: string, status = 200) => save(testInfo, saved, response, name, status);

    await keep(await gotoResponse(page, '/'), 'home-signed-in');
    await keep(await gotoResponse(page, '/about'), 'about-signed-in');
    await keep(await gotoResponse(page, '/privacy'), 'privacy-signed-in');
    await keep(await gotoResponse(page, '/profile'), 'onboarding');
    await keep(await gotoResponse(page, '/profile/edit'), 'profile-edit');
    await keep(await gotoResponse(page, '/signature'), 'signature');
    await keep(await gotoResponse(page, '/supporters'), 'supporters');
    await keep(await gotoResponse(page, '/supporters?page=2'), 'supporters-page-2');
    await keep(await gotoResponse(page, `/supporters/city/${encodeURIComponent('Köln')}`), 'supporters-city');
    await keep(
      await gotoResponse(page, `/supporters/city/${encodeURIComponent(uniqueCity())}`),
      'supporters-city-empty',
    );
    await keep(await gotoResponse(page, '/account/delete'), 'account-delete');
    await keep(await gotoResponse(page, '/supporters?page=10000'), 'error-not-found-signed-in', 404);

    // Validation states. Nothing is stored, so the shared worker user stays as it was.
    await page.goto('/profile');
    await page.locator('#age').fill('old');
    await page.locator('#city').fill('12345');
    await page.locator('#homepage').fill('ftp://example.com');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'continue' }).click()),
      'onboarding-invalid',
      422,
    );

    await page.goto('/profile/edit');
    await page.locator('#firstName').fill('');
    await page.locator('#email').fill('not-an-email');
    await page.locator('#newPassword').fill('short');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'save changes' }).click()),
      'profile-edit-invalid',
      422,
    );

    await page.goto('/signature');
    await page.locator('#typedName').fill('1');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'sign with my typed name' }).click()),
      'signature-invalid-typed',
      422,
    );

    await page.goto('/account/delete');
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'delete my account' }).click()),
      'account-delete-invalid',
      422,
    );

    // Error pages with the signed-in navigation: an unknown sign method (400) and a body above 128 kb (413).
    await page.goto('/signature');
    await page.locator('#typedName').fill('Ada Lovelace');
    await typedForm(page)
      .locator('input[type="hidden"][name="method"]')
      .evaluate((input) => {
        (input as HTMLInputElement).value = 'scribbled';
      });
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'sign with my typed name' }).click()),
      'error-bad-request',
      400,
    );

    await page.goto('/signature');
    await page.locator('#typedName').fill('Ada Lovelace');
    await typedForm(page).evaluate((form) => {
      const padding = document.createElement('input');
      padding.type = 'hidden';
      padding.name = 'padding';
      padding.value = 'x'.repeat(200_000);
      form.append(padding);
    });
    await keep(
      await documentAfter(page, () => page.getByRole('button', { name: 'sign with my typed name' }).click()),
      'error-too-large',
      413,
    );

    await expectSaved(testInfo, saved);
  });
});

test('F-87, B-73: signer pages, flash messages and the signed-out states are saved for the W3C validator (B-64, F-71, F-79)', async ({
  page,
}, testInfo) => {
  const saved: Saved[] = [];
  const keep = (response: Response, name: string, status = 200) => save(testInfo, saved, response, name, status);

  // An own user: this test signs, deletes the signature, logs out and deletes the account (fixtures.ts).
  const user = await registerUser(page, { profile: { age: '41', city: uniqueCity(), homepage: 'example.com' } });

  // The thank-you page right after signing carries the one-time flash, so its body is captured from that navigation.
  await page.goto('/signature');
  await page.locator('#typedName').fill("Ada O'Brien-Lovelace");
  await keep(
    await documentAfter(page, () => page.getByRole('button', { name: 'sign with my typed name' }).click()),
    'thank-you-flash',
  );
  await expect(page).toHaveURL(/\/thank-you$/);
  await keep(await gotoResponse(page, '/thank-you'), 'thank-you');
  await keep(await gotoResponse(page, '/supporters'), 'supporters-signer');
  await keep(await gotoResponse(page, '/signature/delete'), 'signature-delete');
  await keep(
    await documentAfter(page, () => page.getByRole('button', { name: 'delete my signature' }).click()),
    'signature-removed-flash',
  );

  await page.goto('/profile/edit');
  await page.locator('#city').fill(uniqueCity());
  await keep(
    await documentAfter(page, () => page.getByRole('button', { name: 'save changes' }).click()),
    'profile-updated-flash',
  );

  await keep(
    await documentAfter(page, () =>
      page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'log out' }).click(),
    ),
    'logged-out-flash',
  );

  // The same email again: 422 "email taken" with the "log in instead" link.
  await page.goto('/register');
  await page.locator('#firstName').fill(user.firstName);
  await page.locator('#lastName').fill(user.lastName);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await keep(
    await documentAfter(page, () => page.getByRole('button', { name: 'register' }).click()),
    'register-email-taken',
    422,
  );

  await page.goto('/login');
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  await documentAfter(page, () => page.getByRole('button', { name: 'log in' }).click());
  await expect(page).toHaveURL(/\/signature$/);

  await page.goto('/account/delete');
  await page.locator('#currentPassword').fill('not the current password');
  await keep(
    await documentAfter(page, () => page.getByRole('button', { name: 'delete my account' }).click()),
    'account-delete-wrong-password',
    422,
  );
  await page.locator('#currentPassword').fill(user.password);
  await keep(
    await documentAfter(page, () => page.getByRole('button', { name: 'delete my account' }).click()),
    'account-deleted-flash',
  );

  await expectSaved(testInfo, saved);
});
