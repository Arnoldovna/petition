import type { BrowserContext, BrowserContextOptions } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import {
  cityPath,
  expect,
  flash,
  fullName,
  recordSubmitStates,
  registerUser,
  supporterNames,
  test,
  uniqueCity,
} from './fixtures.ts';

/**
 * The typed-name journey (F-33, F-45, F-46, F-75, F-76; B-49): by keyboard, with the double-submit guard, and with
 * JavaScript switched off, where every form must still work (F-76). Each test registers its own user and uses its own
 * city (ADR 0015). The typed name's validation rules and the rendered image are covered by signature-pad.spec.ts
 * (5b) and the unit and integration tests.
 */

/**
 * axe needs JavaScript, so a no-JS page is checked in a JS-enabled twin of the context with the same cookies, on the
 * same URL. The caller has already asserted everything that depends on scripts being off.
 */
async function expectNoA11yViolationsWithScripts(
  newGuardedContext: (options?: BrowserContextOptions) => Promise<BrowserContext>,
  context: BrowserContext,
  path: string,
): Promise<void> {
  // Explicit: inside Playwright Test, a new context inherits the describe block's `javaScriptEnabled: false`.
  const twin = await newGuardedContext({ javaScriptEnabled: true, storageState: await context.storageState() });
  const page = await twin.newPage();
  await page.goto(path);
  await expect(page).toHaveURL(path);
  await expectNoA11yViolations(page);
}

test('F-33, F-45, F-46: by keyboard alone, a new user skips onboarding and signs by typing the full name', async ({
  page,
}) => {
  await registerUser(page);
  await expect(page).toHaveURL('/profile');

  // "skip" leads on without saving anything (F-33).
  const skip = page.getByRole('link', { name: 'skip', exact: true });
  await expect(skip).toHaveAttribute('href', '/signature');
  await skip.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL('/signature');

  // The typed form is a keyboard and screen-reader alternative to the pad (F-45, B-70).
  const typedName = page.getByLabel('full name', { exact: true });
  await expect(page.getByRole('heading', { name: 'Sign by typing your full name' })).toBeVisible();
  await expect(typedName).toHaveAttribute('autocomplete', 'name');
  await typedName.focus();
  await page.keyboard.type('Ada Lovelace');
  await page.keyboard.press('Enter');

  await expect(page).toHaveURL('/thank-you');
  await expect(flash(page)).toHaveText('Thank you, your signature was saved');
  const signature = page.getByRole('img', { name: 'Your signature' });
  await expect(signature).toHaveJSProperty('naturalWidth', 720);

  // Skipping stored no profile values.
  await page.goto('/profile/edit');
  await expect(page.getByLabel('age', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('city', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('homepage', { exact: true })).toHaveValue('');

  await page.goto('/thank-you');
  await expectNoA11yViolations(page);
});

test('F-75, B-49: a double click on "sign with my typed name" sends one request and marks the button busy', async ({
  page,
}) => {
  const city = uniqueCity();
  const user = await registerUser(page, { profile: { city } });
  await page.getByLabel('full name', { exact: true }).fill('Ada Lovelace');

  let posts = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/signature', async (route) => {
    if (route.request().method() !== 'POST') {
      await route.fallback();
      return;
    }
    posts += 1;
    await held;
    await route.continue();
  });
  const button = page.getByRole('button', { name: 'sign with my typed name' });
  const states = await recordSubmitStates(page, button);

  await button.dblclick();

  await expect.poll(() => states.at(-1)).toEqual({ ariaBusy: 'true', disabled: true });
  await expect.poll(() => posts).toBe(1);
  release();
  await expect(page).toHaveURL('/thank-you');
  expect(posts).toBe(1);
  await page.unrouteAll({ behavior: 'wait' });

  await page.goto(cityPath(city));
  await expect(supporterNames(page)).toHaveText([fullName(user)]);

  await page.goto('/thank-you');
  await expectNoA11yViolations(page);
});

test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false });

  test('F-76, F-17, F-45, F-25: register, onboard, sign by typing, edit the profile, log out and back in', async ({
    page,
    context,
    newGuardedContext,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { age: '41', city, homepage: 'example.org' } });
    const signerName = fullName(user);
    await expect(page).toHaveURL('/signature');

    // F-45: drawing needs scripts, so the pad stays hidden, a note says why, and the typed form is there. The note is
    // found by structure: Playwright's text and role engines skip <noscript> content, although the browser renders it.
    const noScriptNote = page.locator('noscript p');
    await expect(noScriptNote).toBeVisible();
    await expect(noScriptNote).toHaveText(
      'Drawing a signature needs JavaScript. You can sign by typing your full name below.',
    );
    await expect(page.getByRole('img', { name: 'Signature pad' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'sign the petition' })).toBeHidden();

    await page.getByLabel('full name', { exact: true }).fill('Ada Lovelace');
    await page.getByRole('button', { name: 'sign with my typed name' }).click();
    await expect(page).toHaveURL('/thank-you');
    await expect(flash(page)).toHaveText('Thank you, your signature was saved');
    const image = await page.request.get('/signature/image.png');
    expect(image.status()).toBe(200);
    expect(image.headers()['content-type']).toBe('image/png');

    await page.goto(cityPath(city));
    await expect(supporterNames(page)).toHaveText([signerName]);

    // Profile edit (F-62) as a plain form post.
    await page.goto('/profile/edit');
    await expect(page.getByLabel('homepage', { exact: true })).toHaveValue('https://example.org/');
    await page.getByLabel('age', { exact: true }).fill('42');
    await page.getByRole('button', { name: 'save changes' }).click();
    await expect(page).toHaveURL('/profile/edit');
    await expect(flash(page)).toHaveText('Profile updated');
    await expect(page.getByLabel('age', { exact: true })).toHaveValue('42');

    // Logout is a form button, so it needs no script either (F-25).
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'log out' }).click();
    await expect(page).toHaveURL('/');
    await expect(flash(page)).toHaveText('You are logged out');

    await page.goto('/login');
    await page.getByLabel('email', { exact: true }).fill(user.email);
    await page.getByLabel('password', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'log in' }).click();
    await expect(page).toHaveURL('/thank-you');

    await expectNoA11yViolationsWithScripts(newGuardedContext, context, '/thank-you');
  });

  test('F-76, F-17: the signature and the account are deleted through their confirmation pages', async ({
    page,
    context,
    newGuardedContext,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city } });
    await page.getByLabel('full name', { exact: true }).fill('Ada Lovelace');
    await page.getByRole('button', { name: 'sign with my typed name' }).click();
    await expect(page).toHaveURL('/thank-you');

    await page.getByRole('link', { name: 'delete signature' }).click();
    await expect(page).toHaveURL('/signature/delete');
    await page.getByRole('button', { name: 'delete my signature' }).click();
    await expect(page).toHaveURL('/signature');
    await expect(flash(page)).toHaveText('Your signature was removed');

    await page.goto(cityPath(city));
    await expect(page.getByText(`No supporters from ${city} yet`)).toBeVisible();

    await page.goto('/account/delete');
    await page.getByLabel('current password', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'delete my account' }).click();
    await expect(page).toHaveURL('/');
    await expect(flash(page)).toHaveText('Your account was deleted');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'log in' })).toBeVisible();

    await expectNoA11yViolationsWithScripts(newGuardedContext, context, '/');
  });
});
