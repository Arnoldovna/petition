import type { Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import {
  errorSummary,
  expect,
  expectCitySupporters,
  flash,
  fullName,
  logIn,
  registerUser,
  signDrawn,
  signTyped,
  test,
  tryLogIn,
  uniqueCity,
} from './fixtures.ts';

/**
 * Deleting a signature (F-49, F-50) and deleting the account (F-67 to F-69; B-34, B-47) through the confirmation pages
 * of ADR 0013, with and without JavaScript.
 *
 * Every test registers its own users (deletion ends or changes them) and gives them a unique city, so "the supporter
 * count goes down" is read on that city's page, which no parallel spec touches (ADR 0015). The global total is never
 * asserted here: other spec groups sign and delete at the same time.
 */

const HOME_URL = /\/$/;
const SIGN_URL = /\/signature$/;
const THANK_YOU_URL = /\/thank-you$/;
const SIGNATURE_DELETE_URL = /\/signature\/delete$/;
const ACCOUNT_DELETE_URL = /\/account\/delete$/;
const PROFILE_EDIT_URL = /\/profile\/edit$/;

/** The CSRF token of the current page (every page of a signed-in visitor has one in the log-out form). */
async function csrfToken(page: Page): Promise<string> {
  return page.locator('input[name="_csrf"]').first().inputValue();
}

test.describe('delete signature', () => {
  test('F-50, B-47: a visitor who has not signed is offered no signature deletion', async ({ page }) => {
    await registerUser(page);

    await page.goto('/profile/edit');
    await expect(page.getByRole('link', { name: /^delete account/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^delete signature/ })).toHaveCount(0);

    // The confirmation page and the action are for signers only: both lead to the sign page (idempotent POST).
    await page.goto('/signature/delete');
    await expect(page).toHaveURL(SIGN_URL);
    const token = await csrfToken(page);
    const response = await page.request.post('/signature/delete', { form: { _csrf: token }, maxRedirects: 0 });
    expect(response.status()).toBe(303);
    expect(response.headers()['location']).toBe('/signature');
  });

  test('F-49, F-50: a signer confirms on a separate page, the signature is removed and the city count drops by one', async ({
    page,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city } });
    await signDrawn(page);
    await expectCitySupporters(page, city, [fullName(user)]);

    // F-50: the control is offered to signers, on the thank-you and the edit page, and asks for confirmation first.
    await page.goto('/profile/edit');
    await expect(page.getByRole('link', { name: /^delete signature/ })).toHaveAttribute('href', '/signature/delete');
    await page.goto('/thank-you');
    await page.getByRole('link', { name: 'delete signature' }).click();
    await expect(page).toHaveURL(SIGNATURE_DELETE_URL);
    await expect(page).toHaveTitle('Delete signature · Nonsense Petition');
    await expect(page.getByRole('heading', { level: 2, name: 'Delete your signature?' })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'The supporter count goes down by one.' })).toBeVisible();
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });

    // "keep my signature" changes nothing.
    await page.getByRole('link', { name: 'keep my signature' }).click();
    await expect(page).toHaveURL(THANK_YOU_URL);
    await expectCitySupporters(page, city, [fullName(user)]);

    await page.goto('/signature/delete');
    await page.getByRole('button', { name: 'delete my signature' }).click();

    await expect(page).toHaveURL(SIGN_URL);
    await expect(flash(page)).toHaveText('Your signature was removed');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hey ${user.firstName}`);
    await expectNoA11yViolations(page);
    // The image and the thank-you page are gone with it (F-48), and the city page no longer lists the user.
    expect((await page.request.get('/signature/image.png')).status()).toBe(404);
    await page.goto('/thank-you');
    await expect(page).toHaveURL(SIGN_URL);
    await expectCitySupporters(page, city, []);

    // The user can sign again.
    await signTyped(page);
    await expectCitySupporters(page, city, [fullName(user)]);
  });

  test("F-49: deleting removes only the signer's own signature", async ({ page, newGuardedContext }) => {
    const city = uniqueCity();
    const deleter = await registerUser(page, { profile: { city } });
    const otherContext = await newGuardedContext();
    const otherPage = await otherContext.newPage();
    const other = await registerUser(otherPage, { profile: { city } });
    await signTyped(otherPage, 'Other Signer');
    await signTyped(page);
    await expectCitySupporters(page, city, [fullName(other), fullName(deleter)]);

    await page.goto('/signature/delete');
    await page.getByRole('button', { name: 'delete my signature' }).click();
    await expect(flash(page)).toHaveText('Your signature was removed');

    await expectCitySupporters(page, city, [fullName(other)]);
    // The other signer is still a signer.
    await otherPage.goto('/signature');
    await expect(otherPage).toHaveURL(THANK_YOU_URL);
    await otherContext.close();
  });

  test('F-49: without a CSRF token the deletion is refused (403) and the signature stays', async ({ page }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city } });
    await signTyped(page);

    const response = await page.request.post('/signature/delete', { form: {}, maxRedirects: 0 });

    expect(response.status()).toBe(403);
    await expectCitySupporters(page, city, [fullName(user)]);
  });
});

test.describe('delete account', () => {
  test('F-67: the edit page leads to a confirmation page that explains what is deleted and asks for the password', async ({
    page,
  }) => {
    await registerUser(page);
    await page.goto('/profile/edit');

    await page.getByRole('link', { name: /^delete account/ }).click();

    await expect(page).toHaveURL(ACCOUNT_DELETE_URL);
    await expect(page).toHaveTitle('Delete account · Nonsense Petition');
    await expect(page.getByRole('heading', { level: 2, name: 'Delete your account?' })).toBeVisible();
    const consequences = page.locator('.confirm-panel').getByRole('listitem');
    await expect(consequences).toHaveText([/^Your account/, /^Your profile/, /^Your signature/]);
    const password = page.getByLabel('current password');
    await expect(password).toHaveAttribute('type', 'password');
    await expect(password).toHaveAttribute('autocomplete', 'current-password');
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });

    await page.getByRole('link', { name: 'keep my account' }).click();
    await expect(page).toHaveURL(PROFILE_EDIT_URL);
  });

  test('F-67, B-34: a missing or wrong password deletes nothing (422 with the field error)', async ({ page }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city } });
    await signTyped(page);

    await page.goto('/account/delete');
    await page.getByRole('button', { name: 'delete my account' }).click();
    await expect(errorSummary(page)).toContainText('Enter your current password');
    await expect(page.getByLabel('current password')).toHaveAttribute('aria-invalid', 'true');

    await page.getByLabel('current password').fill(`${user.password}-wrong`);
    await page.getByRole('button', { name: 'delete my account' }).click();
    await expect(errorSummary(page)).toContainText('The password is incorrect');
    await expect(page.getByLabel('current password')).toHaveValue('');
    await expectNoA11yViolations(page);

    // Still signed in, still a supporter.
    await expectCitySupporters(page, city, [fullName(user)]);
  });

  test('F-68, F-69, B-34: the account, profile and signature go together, the session ends, the email is free again', async ({
    page,
    newGuardedContext,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city, age: '42' } });
    await signDrawn(page);
    await expectCitySupporters(page, city, [fullName(user)]);
    // A second session of the same user, on another device.
    const otherDevice = await newGuardedContext();
    const otherPage = await otherDevice.newPage();
    await logIn(otherPage, user.email, user.password);
    await expect(otherPage).toHaveURL(THANK_YOU_URL);

    await page.goto('/account/delete');
    await page.getByLabel('current password').fill(user.password);
    await page.getByRole('button', { name: 'delete my account' }).click();

    // F-68: back home as a guest with the flash.
    await expect(page).toHaveURL(HOME_URL);
    await expect(flash(page)).toHaveText('Your account was deleted');
    const nav = page.getByRole('navigation', { name: 'Main' });
    await expect(nav.getByRole('link', { name: 'log in' })).toBeVisible();
    await expect(nav.getByRole('button', { name: 'log out' })).toHaveCount(0);
    await expectNoA11yViolations(page);
    await page.goto('/profile/edit');
    await expect(page).toHaveURL(/\/login(\?|$)/);
    // The other device's session belongs to a deleted user: it is a guest on its next request.
    await otherPage.goto('/thank-you');
    await expect(otherPage).toHaveURL(/\/login(\?|$)/);
    await otherDevice.close();

    // The old credentials no longer work.
    expect(await tryLogIn(page, user.email, user.password)).toBe(401);
    await expect(errorSummary(page)).toContainText('Email or password is incorrect');

    // F-69: the same email registers again, as a new account without the old profile or signature.
    await registerUser(page, { firstName: user.firstName, lastName: user.lastName, email: user.email });
    await expect(page.locator('#city')).toHaveValue('');
    await expect(page.locator('#age')).toHaveValue('');
    await page.goto('/thank-you');
    await expect(page).toHaveURL(SIGN_URL);
    // B-34: the signature went with the account (the count of the city went down by one), nothing is left behind.
    await expectCitySupporters(page, city, []);
    await expectNoA11yViolations(page);
  });

  test('F-68: without a CSRF token the account deletion is refused (403) and the account stays', async ({
    page,
    newGuardedContext,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city } });
    await signTyped(page);

    const response = await page.request.post('/account/delete', {
      form: { currentPassword: user.password },
      maxRedirects: 0,
    });

    expect(response.status()).toBe(403);
    await expectCitySupporters(page, city, [fullName(user)]);
    // The credentials still work in a fresh session.
    const freshContext = await newGuardedContext();
    const freshPage = await freshContext.newPage();
    await logIn(freshPage, user.email, user.password);
    await expect(freshPage).toHaveURL(THANK_YOU_URL);
    await freshContext.close();
  });
});

test.describe('without JavaScript', () => {
  // axe runs as a script in the page, so these pages are checked for accessibility with JavaScript elsewhere.
  test.use({ javaScriptEnabled: false });

  test('F-49, F-50, F-67, F-68: both confirmation flows work without JavaScript', async ({ page }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { city } });
    await signTyped(page);

    await page.getByRole('link', { name: 'delete signature' }).click();
    await page.getByRole('button', { name: 'delete my signature' }).click();
    await expect(page).toHaveURL(SIGN_URL);
    await expect(flash(page)).toHaveText('Your signature was removed');
    await expectCitySupporters(page, city, []);

    await signTyped(page);
    await page.goto('/profile/edit');
    await page.getByRole('link', { name: /^delete account/ }).click();
    await page.getByLabel('current password').fill(user.password);
    await page.getByRole('button', { name: 'delete my account' }).click();
    await expect(page).toHaveURL(HOME_URL);
    await expect(flash(page)).toHaveText('Your account was deleted');
  });
});
