import type { Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import {
  cityPath,
  errorSummary,
  expect,
  findSupporterRow,
  flash,
  fullName,
  registerUser,
  signTyped,
  supporterList,
  supporterRow,
  test,
  uniqueCity,
} from './fixtures.ts';

/**
 * Stored and reflected XSS (F-53, B-01). Legacy built supporter rows as HTML strings and printed them with `{{{ }}}`,
 * so markup in a name, the city or the homepage ran for every signed-in visitor of the supporters list. Here every
 * user-supplied field carries a payload through the real forms (register, onboarding, profile edit), and every page
 * that prints it must show it as text: no element, attribute or script of the payload may reach the DOM.
 *
 * Each payload would set `window.xss` if it ever ran. The strict CSP (F-71) would block inline code anyway, and the
 * fixtures' CSP guard fails the test on any violation, so a regression is caught twice: by the DOM checks below (which
 * prove escaping on their own, without relying on the CSP) and by the guard.
 *
 * Mutating spec (ADR 0015): every test registers its own users and uses a unique city, and it never asserts global
 * counts. A user's position on the paginated `/supporters` list is not known in advance, so `findSupporterRow` looks
 * for it page by page.
 */

/** One payload per field. Names and city are stored as typed (after trimming), the homepage as its parsed `href`. */
function payloads() {
  return {
    firstName: '<img src=x onerror=top.xss=1>',
    // Tries to close the row's name element and list item, then run a script.
    lastName: '</span></li><script>top.xss=2</script>',
    // Unique per test (ADR 0015); the quote and `>` try to break out of the city link's `href` attribute.
    city: `${uniqueCity()} "><svg/onload=top.xss=3>`,
    homepage: 'https://xss.example/"><script>top.xss=4</script>',
    // Fails the http/https rule (F-35, B-18): it must be rejected, never stored or rendered as a link.
    scriptUrl: 'javascript:top.xss=5',
    // Fails URL parsing (a host with spaces and quotes): the attribute-breakout attempt of B-01.
    attributeBreakout: 'x" onmouseover="top.xss=6',
    editedLastName: '<b onmouseover=top.xss=7>bold</b>',
  } as const;
}

/** The value the WHATWG URL parser (server and browser alike) stores for an accepted homepage (F-35). */
function storedHomepage(raw: string): string {
  return new URL(raw).href;
}

/**
 * Collects page errors for the whole test: a payload that ran and failed would surface here even if it set no marker.
 */
function trackPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * Proves that nothing of a payload became markup on the current page: no inline event-handler attribute anywhere, no
 * script element besides the layout's hashed module entries, no image, SVG or embedded frame inside `<main>` (none of
 * the pages checked here has one of its own), and no `window.xss` marker.
 */
async function expectNoInjectedMarkup(page: Page, where: string): Promise<void> {
  const report = await page.evaluate(() => {
    const handlers = [...document.querySelectorAll('*')].flatMap((element) =>
      [...element.attributes]
        .filter((attribute) => attribute.name.toLowerCase().startsWith('on'))
        .map((attribute) => `${element.localName}[${attribute.name}]`),
    );
    const scripts = [...document.scripts]
      .filter((script) => !(script.type === 'module' && (script.getAttribute('src') ?? '').startsWith('/assets/')))
      .map((script) => script.outerHTML);
    const embedded = [...document.querySelectorAll('main img, main svg, main iframe, main object, main embed')].map(
      (element) => element.outerHTML,
    );
    return { handlers, scripts, embedded, payloadRan: 'xss' in window };
  });
  expect(report, where).toEqual({ handlers: [], scripts: [], embedded: [], payloadRan: false });
}

test('F-53, B-01: rejected payloads are echoed back into the register form as values, never as markup', async ({
  page,
}) => {
  const xss = payloads();
  const pageErrors = trackPageErrors(page);

  await page.goto('/register');
  await page.locator('#firstName').fill(xss.firstName);
  await page.locator('#lastName').fill(xss.lastName);
  await page.locator('#email').fill(xss.attributeBreakout);
  await page.locator('#password').fill('short');
  await page.getByRole('button', { name: 'register' }).click();

  // 422 re-render (ADR 0008): the summary lists the two failing fields, the names are kept exactly as typed.
  const summary = errorSummary(page);
  await expect(summary.getByRole('link')).toHaveText([
    'Enter a valid email address, like name@example.com',
    'Password must be at least 12 characters',
  ]);
  await expect(page.locator('#firstName')).toHaveValue(xss.firstName);
  await expect(page.locator('#lastName')).toHaveValue(xss.lastName);
  await expect(page.locator('#email')).toHaveValue(xss.attributeBreakout);
  await expect(page.locator('#email')).not.toHaveAttribute('onmouseover');
  await expect(page.locator('#password')).toHaveValue(''); // never echoed (F-20)
  await expectNoInjectedMarkup(page, 'register 422');

  expect(pageErrors).toEqual([]);
  await expectNoA11yViolations(page);
});

test('F-53, B-01: payloads in every field are stored and shown as text on the sign page, the lists and the edit form', async ({
  page,
}) => {
  const xss = payloads();
  const pageErrors = trackPageErrors(page);
  const signerName = fullName(xss);
  const homepage = storedHomepage(xss.homepage);

  await test.step('register with markup in both names (POST /register)', async () => {
    await registerUser(page, { firstName: xss.firstName, lastName: xss.lastName });
    await expectNoInjectedMarkup(page, 'onboarding');
  });

  await test.step('onboarding rejects script and broken URLs and keeps every value as text (POST /profile)', async () => {
    for (const rejected of [xss.scriptUrl, xss.attributeBreakout]) {
      await page.locator('#city').fill(xss.city);
      await page.locator('#homepage').fill(rejected);
      await page.getByRole('button', { name: 'continue' }).click();

      await expect(errorSummary(page).getByRole('link')).toHaveText(['Enter a web address like https://example.com']);
      await expect(page.locator('#homepage')).toHaveAttribute('aria-invalid', 'true');
      await expect(page.locator('#homepage')).toHaveValue(rejected);
      await expect(page.locator('#city')).toHaveValue(xss.city);
      await expectNoInjectedMarkup(page, `onboarding 422 for ${rejected}`);
    }

    await page.locator('#homepage').fill(xss.homepage);
    await page.getByRole('button', { name: 'continue' }).click();
    await expect(page).toHaveURL('/signature');
  });

  await test.step('the sign page greets with the first name as text', async () => {
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText(`Hey ${xss.firstName}`);
    await expectNoInjectedMarkup(page, 'sign page');
    await signTyped(page);
  });

  await test.step('the city page prints the requested city, the name and the homepage as text', async () => {
    const response = await page.goto(cityPath(xss.city));
    expect(response?.status()).toBe(200);

    await expect(page).toHaveTitle(`Supporters from ${xss.city} · Nonsense Petition`);
    await expect(page.getByRole('main').getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${xss.city}`);
    const row = supporterRow(page, signerName);
    await expect(supporterList(page).getByRole('listitem')).toHaveCount(1);
    await expect(row.locator('.supporter-row__city')).toHaveText(xss.city);
    const link = row.getByRole('link', { name: `${signerName} (homepage)`, exact: true });
    await expect(link).toHaveAttribute('href', homepage);
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    await expectNoInjectedMarkup(page, 'city page');
    await expectNoA11yViolations(page);
  });

  await test.step('the supporters list row links the homepage and the encoded city page', async () => {
    const row = await findSupporterRow(page, signerName);

    const homepageLink = row.getByRole('link', { name: `${signerName} (homepage)`, exact: true });
    await expect(homepageLink).toHaveAttribute('href', homepage);
    await expect(homepageLink).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    const cityLink = row.getByRole('link', { name: `supporters from ${xss.city}`, exact: true });
    await expect(cityLink).toHaveAttribute('href', cityPath(xss.city));
    // Exactly the two links of the row: no element of a payload became a link or anything else.
    await expect(row.getByRole('link')).toHaveCount(2);
    await expectNoInjectedMarkup(page, 'supporters list');

    await cityLink.click();
    await expect(page).toHaveURL(cityPath(xss.city));
    await expect(supporterRow(page, signerName)).toHaveCount(1);
  });

  await test.step('the edit form is prefilled with the values as text and stores a new payload (POST /profile/edit)', async () => {
    await page.goto('/profile/edit');
    await expect(page.locator('#firstName')).toHaveValue(xss.firstName);
    await expect(page.locator('#lastName')).toHaveValue(xss.lastName);
    await expect(page.locator('#city')).toHaveValue(xss.city);
    await expect(page.locator('#homepage')).toHaveValue(homepage);
    await expectNoInjectedMarkup(page, 'profile edit');

    await page.locator('#lastName').fill(xss.editedLastName);
    await page.getByRole('button', { name: 'save changes' }).click();
    await expect(page).toHaveURL('/profile/edit');
    await expect(flash(page)).toContainText('Profile updated');
    await expect(page.locator('#lastName')).toHaveValue(xss.editedLastName);

    await page.goto(cityPath(xss.city));
    const editedName = `${xss.firstName} ${xss.editedLastName}`;
    await expect(supporterList(page).locator('.supporter-row__name')).toHaveText([editedName]);
    await expect(supporterList(page).locator('b')).toHaveCount(0);
    await expectNoInjectedMarkup(page, 'city page after the edit');
  });

  expect(pageErrors).toEqual([]);
});

test('F-53, B-01: a script in the requested city is printed as text in the title, heading and empty state', async ({
  page,
}) => {
  const pageErrors = trackPageErrors(page);
  const city = `${uniqueCity()} <script>top.xss=8</script>`;
  await registerUser(page);

  const response = await page.goto(cityPath(city));

  expect(response?.status()).toBe(200);
  const main = page.getByRole('main');
  await expect(page).toHaveTitle(`Supporters from ${city} · Nonsense Petition`);
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${city}`);
  await expect(main.getByRole('heading', { level: 2 })).toHaveText(`No supporters from ${city} yet`);
  await expectNoInjectedMarkup(page, 'empty city page');
  expect(pageErrors).toEqual([]);
  await expectNoA11yViolations(page);
});
