import { randomBytes, randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import {
  cookieOf,
  errorSummary,
  expect,
  expectFieldError,
  flash,
  logIn,
  logOut,
  postStatus,
  recordSubmitStates,
  registerUser,
  signInOnSecondDevice,
  signTyped,
  submitLogin,
  test,
} from './fixtures.ts';

/**
 * Registration, login, logout and the session in a real browser (F-17 to F-32, F-75, F-90; B-22, B-49).
 *
 * Every test registers its own user (ADR 0015): these tests log out, log in elsewhere or sign, which would change
 * the shared worker user. No test asserts a 429 (the E2E stack raises the limits; integration tests prove them,
 * ADR 0012). Argon2 timing (F-24), password hashing (F-27), the idle and absolute session lifetime (F-29) and the
 * rate limits (F-26) are proven by unit and integration tests, not here.
 */

function mainNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

test.describe('register', () => {
  test('F-18, F-28, F-90: a guest registers, gets a new session id and CSRF token, and lands on onboarding', async ({
    page,
    context,
  }) => {
    await page.goto('/register');
    await expect(page).toHaveTitle('Register · Nonsense Petition');

    // F-90: before anything is sent, the form says where the name appears and links to the privacy page.
    const disclosure = page.getByText('Your name appears on the supporters list, which registered users can see.');
    await expect(disclosure).toBeVisible();
    await expect(disclosure.getByRole('link', { name: 'privacy' })).toHaveAttribute('href', '/privacy');

    // GET /register binds an anonymous session for the CSRF token (ADR 0003).
    const anonymousSession = await cookieOf(context, 'sid');
    const anonymousCsrf = await cookieOf(context, 'x-csrf-token');

    await page.getByLabel('first name', { exact: true }).fill('Ada');
    await page.getByLabel('last name', { exact: true }).fill(`Register ${randomUUID().slice(0, 8)}`);
    await page.getByLabel('email', { exact: true }).fill(`e2e-${randomUUID()}@petition.test`);
    await page.getByLabel('password', { exact: true }).fill(randomBytes(18).toString('base64url'));
    expect(await postStatus(page, '/register', () => page.getByRole('button', { name: 'register' }).click())).toBe(303);

    await expect(page).toHaveURL('/profile');
    await expect(page).toHaveTitle('About you · Nonsense Petition');
    await expect(mainNav(page).getByRole('button', { name: 'log out' })).toBeVisible();

    // F-18: a new session id on sign-in, and a new CSRF token bound to it.
    const session = await cookieOf(context, 'sid');
    expect(session.value).not.toBe(anonymousSession.value);
    expect((await cookieOf(context, 'x-csrf-token')).value).not.toBe(anonymousCsrf.value);

    // F-28: an opaque, HttpOnly, SameSite=Lax cookie for the whole site; scripts cannot read it.
    expect(session).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    expect(await page.evaluate(() => document.cookie)).not.toContain('sid');

    await expectNoA11yViolations(page);
  });

  test('F-19, F-21: invalid input gets a focused error summary, linked field messages and kept values', async ({
    page,
  }) => {
    await page.goto('/register');
    const firstName = page.getByLabel('first name', { exact: true });
    const lastName = page.getByLabel('last name', { exact: true });
    const email = page.getByLabel('email', { exact: true });
    const password = page.getByLabel('password', { exact: true });

    await firstName.fill('   ');
    await lastName.fill('Lovelace');
    await email.fill('not-an-email');
    await password.fill('too-short');
    expect(await postStatus(page, '/register', () => page.getByRole('button', { name: 'register' }).click())).toBe(422);

    // The summary lists every error as a link to its field and receives focus (F-21).
    const summary = errorSummary(page);
    await expect(summary).toBeFocused();
    const links = summary.getByRole('link');
    await expect(links).toHaveText([
      'Enter your first name',
      'Enter a valid email address, like name@example.com',
      'Password must be at least 12 characters',
    ]);
    await expect(links.nth(0)).toHaveAttribute('href', '#firstName');
    await expect(links.nth(1)).toHaveAttribute('href', '#email');
    await expect(links.nth(2)).toHaveAttribute('href', '#password');
    await expect(page.locator('#firstName')).toHaveAccessibleName('first name');

    await expectFieldError(firstName, 'Enter your first name');
    await expectFieldError(email, 'Enter a valid email address, like name@example.com');
    await expectFieldError(password, 'Password must be at least 12 characters', 'At least 12 characters');
    await expect(lastName).not.toHaveAttribute('aria-invalid', 'true');

    // Values are kept, the password never comes back (F-20, B-24).
    await expect(lastName).toHaveValue('Lovelace');
    await expect(email).toHaveValue('not-an-email');
    await expect(password).toHaveValue('');

    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });

    // The re-rendered form carries a fresh token, so the corrected form goes through (ADR 0003).
    await firstName.fill('Ada');
    await email.fill(`e2e-${randomUUID()}@petition.test`);
    await password.fill(randomBytes(18).toString('base64url'));
    await page.getByRole('button', { name: 'register' }).click();
    await expect(page).toHaveURL('/profile');
  });

  test('F-20, B-25: an email that exists in any letter case is refused on the field, with a way to log in', async ({
    page,
  }) => {
    const existing = await registerUser(page);
    await logOut(page);

    await page.goto('/register');
    await page.getByLabel('first name', { exact: true }).fill('Grace');
    await page.getByLabel('last name', { exact: true }).fill('Hopper');
    const email = page.getByLabel('email', { exact: true });
    await email.fill(`  ${existing.email.toUpperCase()} `);
    await page.getByLabel('password', { exact: true }).fill(randomBytes(18).toString('base64url'));
    expect(await postStatus(page, '/register', () => page.getByRole('button', { name: 'register' }).click())).toBe(422);

    await expect(errorSummary(page).getByRole('link')).toHaveText(['An account with this email already exists.']);
    await expectFieldError(email, 'An account with this email already exists.');
    await expect(page.getByRole('main').getByRole('link', { name: 'log in instead' })).toHaveAttribute(
      'href',
      '/login',
    );

    // Names and email are kept, the password is not echoed (F-20).
    await expect(page.getByLabel('first name', { exact: true })).toHaveValue('Grace');
    await expect(page.getByLabel('last name', { exact: true })).toHaveValue('Hopper');
    expect((await email.inputValue()).trim().toLowerCase()).toBe(existing.email);
    await expect(page.getByLabel('password', { exact: true })).toHaveValue('');

    await expectNoA11yViolations(page);
  });

  test('F-75, B-49: a double click on "register" sends one request and marks the button busy', async ({ page }) => {
    await page.goto('/register');
    await page.getByLabel('first name', { exact: true }).fill('Ada');
    await page.getByLabel('last name', { exact: true }).fill(`Double ${randomUUID().slice(0, 8)}`);
    await page.getByLabel('email', { exact: true }).fill(`e2e-${randomUUID()}@petition.test`);
    await page.getByLabel('password', { exact: true }).fill(randomBytes(18).toString('base64url'));

    // Hold the request until the busy state is asserted, so the check never races the navigation.
    // Locators wait while that navigation is pending, so the page reports the button's state itself.
    let posts = 0;
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/register', async (route) => {
      if (route.request().method() !== 'POST') {
        await route.fallback();
        return;
      }
      posts += 1;
      await held;
      await route.continue();
    });

    const button = page.getByRole('button', { name: 'register' });
    const states = await recordSubmitStates(page, button);
    await button.dblclick();

    await expect.poll(() => states.at(-1)).toEqual({ ariaBusy: 'true', disabled: true });
    await expect.poll(() => posts).toBe(1);

    release();
    await expect(page).toHaveURL('/profile');
    // The legacy second request rendered "email already taken" (B-49); here it is never sent.
    expect(posts).toBe(1);
    await page.unrouteAll({ behavior: 'wait' });

    await expectNoA11yViolations(page);
  });
});

test.describe('log in', () => {
  test('F-23, B-22: a user who never signed logs in with any email case, gets a new session and lands on /signature', async ({
    page,
    context,
  }) => {
    const user = await registerUser(page);
    await logOut(page);

    await page.goto('/login');
    await expect(page).toHaveTitle('Log in · Nonsense Petition');
    const guestSession = (await cookieOf(context, 'sid')).value;
    const guestCsrf = (await cookieOf(context, 'x-csrf-token')).value;

    // The legacy login hung for exactly this user (no signature row, B-22).
    expect(await submitLogin(page, ` ${user.email.toUpperCase()} `, user.password)).toBe(303);

    await expect(page).toHaveURL('/signature');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hey ${user.firstName}`);
    expect((await cookieOf(context, 'sid')).value).not.toBe(guestSession);
    expect((await cookieOf(context, 'x-csrf-token')).value).not.toBe(guestCsrf);

    await expectNoA11yViolations(page);
  });

  test('F-23: a user who has signed logs in and lands on /thank-you', async ({ page }) => {
    const user = await registerUser(page);
    await signTyped(page);
    await logOut(page);

    await logIn(page, user.email, user.password);

    await expect(page).toHaveURL('/thank-you');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you for your signature');
    await expectNoA11yViolations(page);
  });

  test('F-24, B-09, B-23: a wrong password and an unknown email get the same 401 message and keep the email', async ({
    page,
  }) => {
    const user = await registerUser(page);
    await logOut(page);
    const email = page.getByLabel('email', { exact: true });
    const password = page.getByLabel('password', { exact: true });

    for (const attempt of [
      { email: user.email, password: `${user.password}-wrong` },
      { email: `e2e-nobody-${randomUUID()}@petition.test`, password: user.password },
    ]) {
      await page.goto('/login');
      expect(await submitLogin(page, attempt.email, attempt.password)).toBe(401);

      await expect(page).toHaveTitle('Log in · Nonsense Petition');
      const summary = errorSummary(page);
      await expect(summary).toBeFocused();
      await expect(summary.getByRole('link')).toHaveText(['Email or password is incorrect']);
      await expect(email).toHaveValue(attempt.email);
      await expect(password).toHaveValue('');
      // Not the legacy registration page with "email already taken" (B-23).
      await expect(page.getByText('An account with this email already exists.')).toHaveCount(0);
    }

    await expectNoA11yViolations(page);
  });

  test('F-22: a signed-in user who opens /register or /login is sent on, by signing state', async ({ page }) => {
    await registerUser(page);

    for (const path of ['/register', '/login']) {
      await page.goto(path);
      await expect(page).toHaveURL('/signature');
    }

    await signTyped(page);
    for (const path of ['/register', '/login']) {
      await page.goto(path);
      await expect(page).toHaveURL('/thank-you');
    }

    await expectNoA11yViolations(page);
  });

  test('F-30: a guest is sent to log in with returnTo and comes back there; a foreign returnTo is dropped', async ({
    page,
  }) => {
    const user = await registerUser(page);
    await logOut(page);

    await page.goto('/profile/edit');
    await expect(page).toHaveURL('/login?returnTo=%2Fprofile%2Fedit');
    expect(await submitLogin(page, user.email, user.password)).toBe(303);
    await expect(page).toHaveURL('/profile/edit');
    await expect(page).toHaveTitle('Edit profile · Nonsense Petition');

    // Only same-origin relative paths: an absolute or protocol-relative URL is never followed.
    for (const foreign of ['//evil.example/', 'https://evil.example/']) {
      await logOut(page);
      await page.goto(`/login?returnTo=${encodeURIComponent(foreign)}`);
      expect(await submitLogin(page, user.email, user.password)).toBe(303);
      await expect(page).toHaveURL('/signature');
    }

    await expectNoA11yViolations(page);
  });
});

test.describe('log out and the session', () => {
  test('F-25, F-17, B-08: logout is a POST that ends the server session and says so once', async ({
    page,
    context,
    newGuardedContext,
  }) => {
    await registerUser(page);
    const signedInSession = (await cookieOf(context, 'sid')).value;
    const signedInState = await context.storageState();

    // A GET never logs out (B-08): there is no such route.
    expect((await page.request.get('/logout')).status()).toBe(404);
    expect((await page.goto('/profile/edit'))?.status()).toBe(200);

    await logOut(page);
    await expect(flash(page)).toHaveText('You are logged out');
    await expect(mainNav(page).getByRole('link', { name: 'log in' })).toBeVisible();
    await expect(mainNav(page).getByRole('button', { name: 'log out' })).toHaveCount(0);
    expect((await cookieOf(context, 'sid')).value).not.toBe(signedInSession);

    // The server-side session is gone: the old cookie, replayed in another browser, is a guest's (F-25, F-28).
    const replay = await newGuardedContext({ storageState: signedInState });
    try {
      const replayPage = await replay.newPage();
      await replayPage.goto('/profile/edit');
      await expect(replayPage).toHaveURL('/login?returnTo=%2Fprofile%2Fedit');
    } finally {
      await replay.close();
    }

    // The flash is shown once (F-17).
    await page.reload();
    await expect(flash(page)).toHaveText('');
    await expectNoA11yViolations(page);
  });

  test('F-31, B-05: when the account is deleted on another device, this device becomes a guest', async ({
    page,
    newGuardedContext,
  }) => {
    const user = await registerUser(page);
    const other = await signInOnSecondDevice(newGuardedContext, user);
    try {
      await other.page.goto('/account/delete');
      await other.page.getByLabel('current password', { exact: true }).fill(user.password);
      await other.page.getByRole('button', { name: 'delete my account' }).click();
      await expect(other.page).toHaveURL('/');
    } finally {
      await other.context.close();
    }

    // The ghost session is not trusted: no 500, no stale name, just the guest flow.
    const response = await page.goto('/profile/edit');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL('/login?returnTo=%2Fprofile%2Fedit');
    await expect(mainNav(page).getByRole('link', { name: 'log in' })).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('F-32, B-35: "has signed" comes from the database, so a signature from another device counts at once', async ({
    page,
    newGuardedContext,
  }) => {
    const user = await registerUser(page);
    await page.goto('/signature');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hey ${user.firstName}`);

    const other = await signInOnSecondDevice(newGuardedContext, user);
    try {
      await signTyped(other.page);
    } finally {
      await other.context.close();
    }

    // This session never cached the signing state: the same session now goes to the thank-you page.
    await page.goto('/signature');
    await expect(page).toHaveURL('/thank-you');
    await page.goto('/login');
    await expect(page).toHaveURL('/thank-you');
    await expectNoA11yViolations(page);
  });
});
