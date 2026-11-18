import type { Page } from '@playwright/test';

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
 * The main journey with a drawn signature (F-17, F-33, F-37, F-43, F-44, F-46, F-75; B-49): register, add profile
 * details, draw, get thanked, find yourself on the city page. Each test registers its own user and uses its own city
 * (ADR 0015), so the counts it asserts are relative to its own empty city page and stay exact while other workers
 * sign and delete. The pad's input details (touch, pointer capture, HiDPI) are signature-pad.spec.ts (5b).
 */

/** One long stroke across the pad with the mouse, at relative points so it fits every viewport (F-83). */
async function drawStroke(page: Page): Promise<void> {
  const pad = page.getByRole('img', { name: 'Signature pad' });
  await expect(pad).toBeVisible();
  const box = await pad.boundingBox();
  if (box === null) throw new Error('drawStroke: the signature pad has no layout box');
  const at = (x: number, y: number): [number, number] => [box.x + box.width * x, box.y + box.height * y];

  await page.mouse.move(...at(0.1, 0.5));
  await page.mouse.down();
  for (const [x, y] of [
    [0.3, 0.2],
    [0.45, 0.8],
    [0.6, 0.25],
    [0.85, 0.6],
  ] as const) {
    await page.mouse.move(...at(x, y), { steps: 8 });
  }
  await page.mouse.up();
}

test('F-17, F-33, F-37, F-46, F-75, B-49: register, add a city, draw, double-click once, get thanked and listed', async ({
  page,
}) => {
  const city = uniqueCity();
  const user = await registerUser(page, { profile: { age: '34', city, homepage: '' } });
  const signerName = fullName(user);

  // Before signing, the new city has no supporters: the count below starts from zero.
  await page.goto(cityPath(city));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${city}`);
  await expect(page.getByText(`No supporters from ${city} yet`)).toBeVisible();

  await page.goto('/signature');
  await expect(page).toHaveTitle('Sign the petition · Nonsense Petition');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Hey ${user.firstName}`);
  await drawStroke(page);

  // Hold the POST until the busy state is recorded; a double click must send exactly one request (B-49).
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
  const signButton = page.getByRole('button', { name: 'sign the petition' });
  const states = await recordSubmitStates(page, signButton);

  await signButton.dblclick();

  await expect.poll(() => states.at(-1)).toEqual({ ariaBusy: 'true', disabled: true });
  await expect.poll(() => posts).toBe(1);
  release();

  await expect(page).toHaveURL('/thank-you');
  expect(posts).toBe(1);
  await page.unrouteAll({ behavior: 'wait' });

  // F-46, F-17: the thanks, the own signature as a real PNG, the count, and the confirmation in the status region.
  await expect(page).toHaveTitle('Thank you · Nonsense Petition');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Thank you for your signature');
  await expect(flash(page)).toHaveText('Thank you, your signature was saved');
  const signature = page.getByRole('img', { name: 'Your signature' });
  await expect(signature).toHaveAttribute('src', '/signature/image.png');
  await expect(signature).toHaveJSProperty('naturalWidth', 720);
  // The total moves with other workers' signers, so only its form is asserted ("1 supporter", "1,284 supporters").
  const count = page
    .getByRole('main')
    .getByRole('paragraph')
    .filter({ hasText: /^\s*\d{1,3}(,\d{3})*\s+supporters?\s*$/ });
  await expect(count).toBeVisible();

  // Shown once: a reload has no flash, and the way back to the pad leads to the thanks again (F-44).
  await page.reload();
  await expect(flash(page)).toHaveText('');
  await page.goto('/signature');
  await expect(page).toHaveURL('/thank-you');

  // Exactly one new supporter in this city: this user, with the age (F-47 relative to the empty start).
  await page.getByRole('link', { name: 'see all supporters' }).click();
  await expect(page).toHaveURL('/supporters');
  await page.goto(cityPath(city));
  await expect(page.getByText('1 supporter', { exact: true })).toBeVisible();
  await expect(supporterNames(page)).toHaveText([signerName]);
  await expect(page.getByRole('main').getByRole('listitem').filter({ hasText: signerName })).toContainText('age 34');

  await page.goto('/thank-you');
  await expectNoA11yViolations(page);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expectNoA11yViolations(page);
});

test('F-43, B-49: signing again from a second, stale tab is idempotent and lists the user once', async ({
  page,
  context,
}) => {
  const city = uniqueCity();
  const user = await registerUser(page, { profile: { city } });
  const signerName = fullName(user);

  // Both tabs load the pad before either signs (the legacy second submit hung, B-49).
  const secondTab = await context.newPage();
  await page.goto('/signature');
  await secondTab.goto('/signature');

  await drawStroke(page);
  await page.getByRole('button', { name: 'sign the petition' }).click();
  await expect(page).toHaveURL('/thank-you');

  await drawStroke(secondTab);
  await secondTab.getByRole('button', { name: 'sign the petition' }).click();
  await expect(secondTab).toHaveURL('/thank-you');
  await expect(secondTab.getByRole('heading', { level: 1 })).toHaveText('Thank you for your signature');
  await expect(secondTab.getByRole('alert', { name: 'There is a problem' })).toHaveCount(0);

  // One signature per user (F-43): the city lists this user exactly once.
  await secondTab.goto(cityPath(city));
  await expect(secondTab.getByText('1 supporter', { exact: true })).toBeVisible();
  await expect(supporterNames(secondTab)).toHaveText([signerName]);

  await secondTab.goto('/thank-you');
  await expectNoA11yViolations(secondTab);
});
