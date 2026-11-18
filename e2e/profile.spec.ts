import { randomBytes, randomUUID } from 'node:crypto';

import type { Locator, Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import {
  cityPath,
  errorSummary,
  expect,
  expectFieldError,
  flash,
  fullName,
  logOut,
  postStatus,
  registerUser,
  signInOnSecondDevice,
  signTyped,
  test,
  tryLogIn,
  uniqueCity,
} from './fixtures.ts';

/**
 * Onboarding (`/profile`) and profile editing (`/profile/edit`) in a real browser (F-17, F-21, F-33 to F-36,
 * F-60 to F-66, F-90; B-18, B-25 to B-29, B-47). Every test registers its own user (ADR 0015), because it changes
 * names, email, password or profile; cities are unique per test. Atomicity of the edit transaction (F-62) is proven by
 * the integration tests; here a refused edit is shown to change nothing that the user can see.
 */

function field(page: Page, label: string): Locator {
  return page.getByLabel(label, { exact: true });
}

/** The summary receives focus and lists exactly these messages, each linking to its field (F-21). */
async function expectErrorSummary(page: Page, errors: readonly (readonly [name: string, message: string])[]) {
  const summary = errorSummary(page);
  await expect(summary).toBeFocused();
  const links = summary.getByRole('link');
  await expect(links).toHaveText(errors.map(([, message]) => message));
  for (const [index, [name]] of errors.entries()) {
    await expect(links.nth(index)).toHaveAttribute('href', `#${name}`);
  }
}

async function saveEdit(page: Page): Promise<number> {
  return postStatus(page, '/profile/edit', () => page.getByRole('button', { name: 'save changes' }).click());
}

async function saveOnboarding(page: Page): Promise<number> {
  return postStatus(page, '/profile', () => page.getByRole('button', { name: 'continue' }).click());
}

function newPassword(): string {
  return randomBytes(18).toString('base64url');
}

test.describe('onboarding', () => {
  test('F-33, F-34, F-36, F-90, B-26, B-28: only a city saves, and the form comes back prefilled and saves again', async ({
    page,
  }) => {
    const city = uniqueCity();
    await registerUser(page);
    await expect(page).toHaveTitle('About you · Nonsense Petition');

    // F-90: the optional fields and where they appear are stated before submitting, with the privacy link.
    const disclosure = page.getByText('Age, city and homepage are optional.');
    await expect(disclosure).toContainText('they appear next to your name on the supporters list');
    await expect(disclosure.getByRole('link', { name: 'privacy' })).toHaveAttribute('href', '/privacy');
    await expect(page.getByRole('link', { name: 'skip', exact: true })).toHaveAttribute('href', '/signature');
    await expect(field(page, 'age')).toHaveAttribute('inputmode', 'numeric');
    await expect(field(page, 'homepage')).toHaveAttribute('type', 'url');

    // Only the city: the legacy app crashed on the empty age (B-26).
    await field(page, 'city').fill(city);
    expect(await saveOnboarding(page)).toBe(303);
    await expect(page).toHaveURL('/signature');

    // Back to the form and submit again (the legacy second insert hung, B-28).
    await page.goBack();
    await expect(page).toHaveURL('/profile');
    await expect(field(page, 'city')).toHaveValue(city);
    await field(page, 'age').fill('29');
    expect(await saveOnboarding(page)).toBe(303);
    await expect(page).toHaveURL('/signature');

    // A later visit shows the stored values (F-36); the empty homepage stayed empty (F-34).
    await page.goto('/profile');
    await expect(field(page, 'age')).toHaveValue('29');
    await expect(field(page, 'city')).toHaveValue(city);
    await expect(field(page, 'homepage')).toHaveValue('');

    await expectNoA11yViolations(page);
  });

  test('F-35, F-21, B-18, B-27: invalid values are refused with linked messages; valid ones are normalised', async ({
    page,
  }) => {
    const city = uniqueCity();
    await registerUser(page);

    await field(page, 'age').fill('1.5');
    await field(page, 'city').fill('..');
    await field(page, 'homepage').fill('javascript:alert(1)');
    expect(await saveOnboarding(page)).toBe(422);

    await expectErrorSummary(page, [
      ['age', 'Age must be a whole number between 1 and 120'],
      ['city', 'City must contain at least one letter'],
      ['homepage', 'Enter a web address like https://example.com'],
    ]);
    await expectFieldError(field(page, 'age'), 'Age must be a whole number between 1 and 120');
    await expectFieldError(field(page, 'city'), 'City must contain at least one letter');
    await expectFieldError(field(page, 'homepage'), 'Enter a web address like https://example.com');
    // The entered values are kept for correction.
    await expect(field(page, 'age')).toHaveValue('1.5');
    await expect(field(page, 'city')).toHaveValue('..');
    await expect(field(page, 'homepage')).toHaveValue('javascript:alert(1)');

    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'light' });

    // Valid input is normalised: trimmed age, collapsed city whitespace, https:// added once (B-18).
    await field(page, 'age').fill(' 7 ');
    await field(page, 'city').fill(`  ${city}    north  `);
    await field(page, 'homepage').fill('example.com/me');
    expect(await saveOnboarding(page)).toBe(303);

    await page.goto('/profile');
    await expect(field(page, 'age')).toHaveValue('7');
    await expect(field(page, 'city')).toHaveValue(`${city} north`);
    await expect(field(page, 'homepage')).toHaveValue('https://example.com/me');

    // A value that already has a scheme is never prefixed twice.
    await field(page, 'homepage').fill('http://example.org/');
    expect(await saveOnboarding(page)).toBe(303);
    await page.goto('/profile');
    await expect(field(page, 'homepage')).toHaveValue('http://example.org/');

    await expectNoA11yViolations(page);
  });
});

test.describe('edit', () => {
  test('F-60, F-62, F-17: the form is prefilled, a save is confirmed once and every value is kept', async ({
    page,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, {
      firstName: 'Grace',
      profile: { age: '52', city, homepage: 'grace.example' },
    });

    await page.goto('/profile/edit');
    await expect(page).toHaveTitle('Edit profile · Nonsense Petition');
    await expect(field(page, 'first name')).toHaveValue('Grace');
    await expect(field(page, 'last name')).toHaveValue(user.lastName);
    await expect(field(page, 'email')).toHaveValue(user.email);
    await expect(field(page, 'age')).toHaveValue('52');
    await expect(field(page, 'city')).toHaveValue(city);
    await expect(field(page, 'homepage')).toHaveValue('https://grace.example/');

    // F-60: the password fields are masked, empty and carry the right autocomplete tokens (B-11).
    const newPasswordField = field(page, 'new password');
    await expect(newPasswordField).toHaveAttribute('type', 'password');
    await expect(newPasswordField).toHaveAttribute('autocomplete', 'new-password');
    await expect(newPasswordField).toHaveValue('');
    await expect(field(page, 'current password')).toHaveAttribute('type', 'password');
    await expect(field(page, 'current password')).toHaveAttribute('autocomplete', 'current-password');
    await expect(field(page, 'current password')).toHaveValue('');

    await field(page, 'first name').fill('Gracie');
    await field(page, 'last name').fill(`${user.lastName} Jr`);
    await field(page, 'age').fill('53');
    expect(await saveEdit(page)).toBe(303);

    // F-62: back on the edit page with the confirmation (F-17); the values are stored.
    await expect(page).toHaveURL('/profile/edit');
    await expect(flash(page)).toHaveText('Profile updated');
    await expect(field(page, 'first name')).toHaveValue('Gracie');
    await expect(field(page, 'last name')).toHaveValue(`${user.lastName} Jr`);
    await expect(field(page, 'age')).toHaveValue('53');
    await expect(field(page, 'city')).toHaveValue(city);

    // Shown once; the new name is what the app greets with.
    await page.reload();
    await expect(flash(page)).toHaveText('');
    await page.goto('/signature');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hey Gracie');

    await page.goto('/profile/edit');
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'profile' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expectNoA11yViolations(page);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expectNoA11yViolations(page);
  });

  test('F-61, F-21, B-29: invalid edits are shown inline with the entered values, and nothing is saved', async ({
    page,
  }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { age: '30', city, homepage: '' } });
    await page.goto('/profile/edit');

    await field(page, 'first name').fill('   ');
    await field(page, 'last name').fill('Changed');
    await field(page, 'email').fill('not-an-email');
    await field(page, 'age').fill('abc');
    await field(page, 'homepage').fill('ftp://files.example');
    await field(page, 'new password').fill('too-short');
    expect(await saveEdit(page)).toBe(422);

    await expectErrorSummary(page, [
      ['firstName', 'Enter your first name'],
      ['email', 'Enter a valid email address, like name@example.com'],
      ['age', 'Age must be a whole number between 1 and 120'],
      ['homepage', 'Enter a web address like https://example.com'],
      ['newPassword', 'Password must be at least 12 characters'],
    ]);
    await expectFieldError(field(page, 'first name'), 'Enter your first name');
    await expectFieldError(field(page, 'age'), 'Age must be a whole number between 1 and 120');
    await expectFieldError(
      field(page, 'new password'),
      'Password must be at least 12 characters',
      'Leave empty to keep your password',
    );
    await expect(field(page, 'last name')).toHaveValue('Changed');
    await expect(field(page, 'age')).toHaveValue('abc');
    await expect(field(page, 'new password')).toHaveValue('');
    await expectNoA11yViolations(page);

    // The legacy app reported success and kept a partial update (B-29): here nothing changed.
    await page.goto('/profile/edit');
    await expect(field(page, 'last name')).toHaveValue(user.lastName);
    await expect(field(page, 'email')).toHaveValue(user.email);
    await expect(field(page, 'age')).toHaveValue('30');
  });

  test('F-65: clearing age, city and homepage removes them, also from the city page', async ({ page }) => {
    const city = uniqueCity();
    const user = await registerUser(page, { profile: { age: '61', city, homepage: 'example.net' } });
    await signTyped(page);
    await page.goto(cityPath(city));
    await expect(page.getByText('1 supporter', { exact: true })).toBeVisible();
    await expect(page.getByRole('main').getByRole('listitem')).toContainText([fullName(user)]);

    await page.goto('/profile/edit');
    await field(page, 'age').clear();
    await field(page, 'city').clear();
    await field(page, 'homepage').clear();
    expect(await saveEdit(page)).toBe(303);
    await expect(flash(page)).toHaveText('Profile updated');

    await page.reload();
    await expect(field(page, 'age')).toHaveValue('');
    await expect(field(page, 'city')).toHaveValue('');
    await expect(field(page, 'homepage')).toHaveValue('');

    await page.goto(cityPath(city));
    await expect(page.getByText(`No supporters from ${city} yet`)).toBeVisible();
    await expectNoA11yViolations(page);
  });

  test('F-63: an email change needs the correct current password, then the new email logs in', async ({ page }) => {
    const user = await registerUser(page);
    const changedEmail = `e2e-${randomUUID()}@petition.test`;
    await page.goto('/profile/edit');

    // Without the current password: refused, nothing changes.
    await field(page, 'email').fill(changedEmail);
    expect(await saveEdit(page)).toBe(422);
    await expectErrorSummary(page, [
      ['currentPassword', 'Enter your current password to change your email or password'],
    ]);
    await expectFieldError(
      field(page, 'current password'),
      'Enter your current password to change your email or password',
      'Needed only when you change your email or password',
    );
    await expect(field(page, 'email')).toHaveValue(changedEmail);

    // With a wrong one: refused.
    await field(page, 'current password').fill(`${user.password}-wrong`);
    expect(await saveEdit(page)).toBe(422);
    await expectErrorSummary(page, [['currentPassword', 'The password is incorrect']]);
    await expect(field(page, 'current password')).toHaveValue('');

    await page.goto('/profile/edit');
    await expect(field(page, 'email')).toHaveValue(user.email);

    // With the right one: saved, stored in lower case (B-25), and the new address is the login.
    await field(page, 'email').fill(changedEmail.toUpperCase());
    await field(page, 'current password').fill(user.password);
    expect(await saveEdit(page)).toBe(303);
    await expect(flash(page)).toHaveText('Profile updated');
    await expect(field(page, 'email')).toHaveValue(changedEmail);

    await logOut(page);
    expect(await tryLogIn(page, user.email, user.password)).toBe(401);
    expect(await tryLogIn(page, changedEmail, user.password)).toBe(303);
    await expect(page).toHaveURL('/signature');
    await expectNoA11yViolations(page);
  });

  test('F-63, ADR 0002: an empty new password keeps the old one; a new one keeps this session and ends the others', async ({
    page,
    newGuardedContext,
  }) => {
    const user = await registerUser(page);

    // A name edit with an empty password field leaves the password as it is.
    await page.goto('/profile/edit');
    await field(page, 'first name').fill('Edith');
    expect(await saveEdit(page)).toBe(303);
    await logOut(page);
    expect(await tryLogIn(page, user.email, user.password)).toBe(303);

    const other = await signInOnSecondDevice(newGuardedContext, user);
    try {
      const changedPassword = newPassword();
      await page.goto('/profile/edit');
      await field(page, 'new password').fill(changedPassword);
      await field(page, 'current password').fill(user.password);
      expect(await saveEdit(page)).toBe(303);

      // This device stays signed in with the re-established session.
      await expect(page).toHaveURL('/profile/edit');
      await expect(flash(page)).toHaveText('Profile updated');
      await page.reload();
      await expect(page).toHaveURL('/profile/edit');

      // The other device's session was revoked by the new password (session version, ADR 0002 item 9).
      await other.page.goto('/profile/edit');
      await expect(other.page).toHaveURL('/login?returnTo=%2Fprofile%2Fedit');

      await logOut(page);
      expect(await tryLogIn(page, user.email, user.password)).toBe(401);
      expect(await tryLogIn(page, user.email, changedPassword)).toBe(303);
      await expect(page).toHaveURL('/signature');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hey Edith');
    } finally {
      await other.context.close();
    }
    await expectNoA11yViolations(page);
  });

  test('F-64, B-25, B-29: an email that belongs to someone else, in any case, is refused and nothing is saved', async ({
    page,
  }) => {
    const taken = await registerUser(page);
    await logOut(page);
    const user = await registerUser(page);

    await page.goto('/profile/edit');
    await field(page, 'first name').fill('Changed');
    await field(page, 'email').fill(taken.email.toUpperCase());
    await field(page, 'current password').fill(user.password);
    expect(await saveEdit(page)).toBe(422);

    await expectErrorSummary(page, [['email', 'An account with this email already exists.']]);
    await expectFieldError(field(page, 'email'), 'An account with this email already exists.');
    await expect(field(page, 'first name')).toHaveValue('Changed');
    await expectNoA11yViolations(page);

    // Nothing was saved, not even the name in the same submit (one transaction, F-62).
    await page.goto('/profile/edit');
    await expect(field(page, 'first name')).toHaveValue(user.firstName);
    await expect(field(page, 'email')).toHaveValue(user.email);
  });

  test('F-66, B-47: "delete signature" is offered only after signing, "delete account" always', async ({ page }) => {
    await registerUser(page);
    const main = page.getByRole('main');

    await page.goto('/profile/edit');
    await expect(main.getByRole('link', { name: /^delete signature/ })).toHaveCount(0);
    await expect(main.getByRole('link', { name: /^delete account/ })).toHaveAttribute('href', '/account/delete');

    await signTyped(page);
    await page.goto('/profile/edit');
    await expect(main.getByRole('link', { name: /^delete signature/ })).toHaveAttribute('href', '/signature/delete');
    await expect(main.getByRole('link', { name: /^delete account/ })).toHaveAttribute('href', '/account/delete');
    await expectNoA11yViolations(page);
  });
});
