import type { Locator, Page } from '@playwright/test';

import { SEED_SUPPORTERS } from '../src/tools/seed-data.ts';
import { expectNoA11yViolations } from './a11y.ts';
import {
  cityPath,
  expect,
  fullName,
  supporterList,
  supporterNames,
  supporterRow,
  SUPPORTERS_PAGE_SIZE,
  test,
} from './fixtures.ts';

/**
 * Supporters list and city pages on the pristine seed (F-51 to F-59; DATA-MODEL.md section 6). This is the only spec
 * of the `seed-readonly` project: it asserts the seed's exact numbers, so it runs first and alone, before any spec
 * signs or deletes (ADR 0015, ADR 0017). It must never change a signature. The signed-in worker user registers but
 * never signs, so it is not a supporter and every number below stays exact.
 *
 * The literal numbers are the oracle from DATA-MODEL.md section 6 ("64 > 50 gives a second supporters page", "Berlin
 * has 8 and Leipzig 5"); the expected names and their order come from the seed's own table in `seed-data.ts`, and each
 * test checks that both agree before it looks at the page.
 */

const SEED_TOTAL = 64;
const SEED_LAST_PAGE_ROWS = SEED_TOTAL - SUPPORTERS_PAGE_SIZE;
/** Signers without a `profiles` row at all (B-30): the legacy inner join dropped exactly these. */
const SEED_SIGNERS_WITHOUT_PROFILE = [
  'Sophie Wagner',
  'Mia Schulz',
  'Katharina Braun',
  'Laura Klein',
  'Pia Lorenz',
  'Till Hansen',
];

/** Every seed city with its number of supporters (DATA-MODEL.md section 6). */
const SEED_CITY_COUNTS: readonly (readonly [city: string, count: number])[] = [
  ['Berlin', 8],
  ['Leipzig', 5],
  ['Hamburg', 5],
  ['Köln', 5],
  ['München', 4],
  ['Frankfurt/Main', 4],
  ['Zürich', 3],
  ['Wien', 3],
  ['Graz', 3],
  ['St. Gallen', 3],
  ['Dresden', 3],
  ['Bremen', 3],
  ['Rostock', 3],
  ['Halle (Saale)', 2],
  ['Freiburg im Breisgau', 2],
  ['Brandenburg an der Havel', 1],
];

const SEED_NAMES = SEED_SUPPORTERS.map(fullName);

/** The seed supporters of `city` in signing order (exact stored value; case-insensitive matching is tested apart). */
function seedNamesFrom(city: string): string[] {
  return SEED_SUPPORTERS.filter(({ profile }) => profile?.city === city).map(fullName);
}

function pagination(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Pagination' });
}

function supportersLead(count: number): string {
  return `${String(count)} ${count === 1 ? 'supporter' : 'supporters'}`;
}

/** Heading, lead and the exact rows of a city page (F-56). */
async function expectCityPage(page: Page, heading: string, names: readonly string[]): Promise<void> {
  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${heading}`);
  await expect(page).toHaveTitle(`Supporters from ${heading} · Nonsense Petition`);
  await expect(main.getByText(supportersLead(names.length), { exact: true })).toBeVisible();
  await expect(supporterNames(page)).toHaveText([...names]);
}

test('F-51, F-07: a guest who opens the supporters list or a city page is sent to log in with returnTo', async ({
  page,
}) => {
  await page.goto('/supporters');
  await expect(page).toHaveURL('/login?returnTo=%2Fsupporters');
  await expect(supporterList(page)).toHaveCount(0);

  await page.goto(cityPath('Frankfurt/Main'));
  await expect(page).toHaveURL(`/login?returnTo=${encodeURIComponent('/supporters/city/Frankfurt%2FMain')}`);
  await expect(supporterList(page)).toHaveCount(0);
});

test.describe('signed in, on the pristine seed', () => {
  test.use({ signedIn: true });

  test('F-51, F-54, F-47, B-30, B-31: all 64 seed signers are listed oldest first over two pages, with the total', async ({
    page,
  }) => {
    expect(SEED_NAMES).toHaveLength(SEED_TOTAL);
    const main = page.getByRole('main');

    const response = await page.goto('/supporters');
    expect(response?.status()).toBe(200);
    await expect(page).toHaveTitle('Supporters · Nonsense Petition');
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Supporters');
    await expect(main.getByText('64 supporters', { exact: true })).toBeVisible();
    await expect(supporterList(page)).toHaveAttribute('start', '1');
    await expect(supporterNames(page)).toHaveText(SEED_NAMES.slice(0, SUPPORTERS_PAGE_SIZE));

    await pagination(page).getByRole('link', { name: 'next page', exact: true }).click();

    await expect(page).toHaveURL('/supporters?page=2');
    await expect(page).toHaveTitle('Supporters, page 2 · Nonsense Petition');
    // The total of every page, not of this page's rows (F-54).
    await expect(main.getByText('64 supporters', { exact: true })).toBeVisible();
    // Numbering continues across pages: row 51 is item 51 (F-54, B-67).
    await expect(supporterList(page)).toHaveAttribute('start', String(SUPPORTERS_PAGE_SIZE + 1));
    await expect(supporterNames(page)).toHaveText(SEED_NAMES.slice(SUPPORTERS_PAGE_SIZE));
    await expect(supporterNames(page)).toHaveCount(SEED_LAST_PAGE_ROWS);

    await expectNoA11yViolations(page);
  });

  test('F-51, B-30: every seed signer without a profile is on the list, so the list adds up to the count', async ({
    page,
  }) => {
    await page.goto('/supporters');
    const firstPageNames = await supporterNames(page).allTextContents();
    await page.goto('/supporters?page=2');
    await expect(supporterNames(page)).toHaveCount(SEED_LAST_PAGE_ROWS);
    const listed = [...firstPageNames, ...(await supporterNames(page).allTextContents())];

    expect(listed).toHaveLength(SEED_TOTAL);
    expect(new Set(listed).size).toBe(SEED_TOTAL);
    expect(listed).toEqual(expect.arrayContaining(SEED_SIGNERS_WITHOUT_PROFILE));
    expect(
      SEED_SUPPORTERS.filter(({ profile }) => profile === null).map(
        ({ firstName, lastName }) => `${firstName} ${lastName}`,
      ),
    ).toEqual(SEED_SIGNERS_WITHOUT_PROFILE);
  });

  test('F-54, B-67: the pagination is a labelled landmark that marks the current page and steps between pages', async ({
    page,
  }) => {
    await page.goto('/supporters');
    const nav = pagination(page);

    await expect(nav.getByText('page 1 of 2', { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'page 1', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'page 2', exact: true })).not.toHaveAttribute('aria-current');
    await expect(nav.getByRole('link', { name: 'previous page', exact: true })).toHaveCount(0);
    await expect(nav.getByRole('link', { name: 'next page', exact: true })).toHaveAttribute(
      'href',
      '/supporters?page=2',
    );

    await nav.getByRole('link', { name: 'page 2', exact: true }).click();

    await expect(page).toHaveURL('/supporters?page=2');
    await expect(nav.getByText('page 2 of 2', { exact: true })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'page 2', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(nav.getByRole('link', { name: 'page 1', exact: true })).not.toHaveAttribute('aria-current');
    await expect(nav.getByRole('link', { name: 'next page', exact: true })).toHaveCount(0);

    // Page 1 is the bare path, never a `?page=1` duplicate (ADR 0006).
    await nav.getByRole('link', { name: 'previous page', exact: true }).click();
    await expect(page).toHaveURL('/supporters');
    await expect(supporterNames(page)).toHaveCount(SUPPORTERS_PAGE_SIZE);
  });

  test('F-54, ADR 0006: a page beyond the last one, or an invalid page number, is the 404 page', async ({ page }) => {
    for (const query of ['?page=3', '?page=0', '?page=two', '?page=-1']) {
      const response = await page.goto(`/supporters${query}`);
      expect(response?.status(), query).toBe(404);
      await expect(page).toHaveTitle('Page not found · Nonsense Petition');
      await expect(supporterList(page)).toHaveCount(0);
    }
  });

  test('F-52, B-17: a name with a homepage links to it in the same tab, with rel and an announced destination', async ({
    page,
  }) => {
    await page.goto('/supporters');
    const homepage = supporterRow(page, 'Lena Hartmann').getByRole('link', {
      name: 'Lena Hartmann (homepage)',
      exact: true,
    });

    await expect(homepage).toHaveAttribute('href', 'https://lena-hartmann.example/');
    await expect(homepage).toHaveAttribute('rel', 'noopener noreferrer nofollow ugc');
    // Same tab, so there is no "opens in new tab" to announce (F-52).
    await expect(homepage).not.toHaveAttribute('target');
    // A supporter without a homepage has a plain name, no link.
    await expect(supporterRow(page, 'Jonas Becker').getByRole('link', { name: /Jonas Becker/ })).toHaveCount(0);
  });

  test('F-52, B-17, B-73: rows show age, city and signing date only when set, with no stray separators', async ({
    page,
  }) => {
    await page.goto('/supporters');

    // Every value present (the city is a link named after its destination, F-84).
    await expect(supporterRow(page, 'Lena Hartmann')).toHaveText(
      'Lena Hartmann (homepage) age 34 supporters from Leipzig signed 2 Sep 2026',
    );
    // No age.
    await expect(supporterRow(page, 'Mateusz Nowak')).toHaveText(
      'Mateusz Nowak supporters from Frankfurt/Main signed 5 Sep 2026',
    );
    // No city. Signed at 23:15 UTC on 15 Sep, which is 16 Sep in APP_TIME_ZONE (Europe/Berlin).
    await expect(supporterRow(page, 'Yusuf Arslan')).toHaveText('Yusuf Arslan age 48 signed 16 Sep 2026');
    await expect(supporterRow(page, 'Yusuf Arslan').locator('time')).toHaveAttribute(
      'datetime',
      '2026-09-15T23:15:00.000Z',
    );
    // No profile at all: the name and the date only (B-30).
    await expect(supporterRow(page, 'Sophie Wagner')).toHaveText('Sophie Wagner signed 8 Sep 2026');
    await expect(supporterRow(page, 'Sophie Wagner').getByRole('link')).toHaveCount(0);
  });

  test('F-56, F-57, B-32: a city link with a slash opens that city page in the same tab, and "all supporters" leads back', async ({
    page,
  }) => {
    await page.goto('/supporters');
    const cityLink = supporterRow(page, 'Mateusz Nowak').getByRole('link', {
      name: 'supporters from Frankfurt/Main',
      exact: true,
    });
    await expect(cityLink).toHaveAttribute('href', '/supporters/city/Frankfurt%2FMain');
    await expect(cityLink).not.toHaveAttribute('target');

    await cityLink.click();

    await expect(page).toHaveURL('/supporters/city/Frankfurt%2FMain');
    await expectCityPage(page, 'Frankfurt/Main', seedNamesFrom('Frankfurt/Main'));
    // Rows print their city as plain text, never a link to this same page (F-56).
    await expect(supporterRow(page, 'Mateusz Nowak')).toHaveText('Mateusz Nowak Frankfurt/Main signed 5 Sep 2026');
    await expect(supporterList(page).getByRole('link', { name: /supporters from/ })).toHaveCount(0);
    // One page only, so no pagination landmark (F-59).
    await expect(pagination(page)).toHaveCount(0);
    await expectNoA11yViolations(page);

    const back = page.getByRole('main').getByRole('link', { name: 'all supporters', exact: true });
    await expect(back).toHaveCount(1);
    await back.click();
    await expect(page).toHaveURL('/supporters');
    await expect(supporterNames(page)).toHaveCount(SUPPORTERS_PAGE_SIZE);
  });

  for (const [city, count] of SEED_CITY_COUNTS) {
    test(`F-56, F-57, B-32: ${city} lists its ${String(count)} seed ${count === 1 ? 'supporter' : 'supporters'} oldest first`, async ({
      page,
    }) => {
      const names = seedNamesFrom(city);
      expect(names, 'seed-data.ts agrees with DATA-MODEL.md section 6').toHaveLength(count);

      const response = await page.goto(cityPath(city));

      expect(response?.status()).toBe(200);
      await expectCityPage(page, city, names);
      await expect(supporterList(page)).toHaveAttribute('start', '1');
    });
  }

  test('F-57, B-32: the list pages link every seed city, each with an encodeURIComponent path', async ({ page }) => {
    const linked = new Set<string>();
    for (const path of ['/supporters', '/supporters?page=2']) {
      await page.goto(path);
      await expect(supporterNames(page).first()).toBeVisible();
      const cityLinks = supporterList(page).getByRole('link', { name: /^supporters from / });
      const hrefs = await cityLinks.evaluateAll((links) => links.map((link) => link.getAttribute('href') ?? ''));
      for (const href of hrefs) linked.add(href);
    }

    expect([...linked].sort()).toEqual(SEED_CITY_COUNTS.map(([city]) => cityPath(city)).sort());
    // The table above covers every seed supporter with a city, so the per-city tests miss nobody.
    const withCity = SEED_SUPPORTERS.filter(({ profile }) => typeof profile?.city === 'string');
    expect(SEED_CITY_COUNTS.reduce((sum, [, count]) => sum + count, 0)).toBe(withCity.length);
  });

  test('F-56, B-32: a city matches case-insensitively, trimmed and NFC-normalised; the heading shows the request', async ({
    page,
  }) => {
    const berlin = seedNamesFrom('Berlin');

    await page.goto(cityPath('BERLIN'));
    await expectCityPage(page, 'BERLIN', berlin);

    // Leading and trailing whitespace is trimmed before matching and in the heading (B-32).
    await page.goto(cityPath('  berlin  '));
    await expectCityPage(page, 'berlin', berlin);

    // Unicode case folding (pg_c_utf8, ADR 0007).
    await page.goto(cityPath('ZÜRICH'));
    await expectCityPage(page, 'ZÜRICH', seedNamesFrom('Zürich'));

    // A decomposed "u + combining diaeresis" is the same city as the stored precomposed "ü".
    await page.goto(cityPath('München'));
    await expectCityPage(page, 'München', seedNamesFrom('München'));
  });

  test('F-58, B-33: a city without supporters keeps its heading and shows the empty state with one link back', async ({
    page,
  }) => {
    const main = page.getByRole('main');

    const response = await page.goto(cityPath('Atlantis'));

    expect(response?.status()).toBe(200);
    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Supporters from Atlantis');
    await expect(main.getByRole('heading', { level: 2 })).toHaveText('No supporters from Atlantis yet');
    await expect(supporterList(page)).toHaveCount(0);
    await expect(pagination(page)).toHaveCount(0);
    const back = main.getByRole('link', { name: 'all supporters', exact: true });
    await expect(back).toHaveCount(1);
    await expect(back).toHaveAttribute('href', '/supporters');
    await expectNoA11yViolations(page);
  });

  test('F-53, F-58, B-33: markup in the requested city is shown as text in the heading and the empty state', async ({
    page,
  }) => {
    const main = page.getByRole('main');

    await page.goto(cityPath('<em>Atlantis</em>'));

    await expect(main.getByRole('heading', { level: 1 })).toHaveText('Supporters from <em>Atlantis</em>');
    await expect(main.getByRole('heading', { level: 2 })).toHaveText('No supporters from <em>Atlantis</em> yet');
    await expect(main.locator('em')).toHaveCount(0);
  });

  test('F-59, ADR 0006: a city page with fewer than 51 supporters has no pagination, and its page 2 is the 404 page', async ({
    page,
  }) => {
    await page.goto(cityPath('Berlin'));
    await expect(supporterNames(page)).toHaveCount(8);
    await expect(pagination(page)).toHaveCount(0);

    const response = await page.goto(`${cityPath('Berlin')}?page=2`);
    expect(response?.status()).toBe(404);
    await expect(page).toHaveTitle('Page not found · Nonsense Petition');
  });

  test('F-78: the supporters list, its page 2 and a city page have no axe violations in dark mode', async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: 'dark' });

    await page.goto('/supporters');
    await expect(supporterNames(page)).toHaveCount(SUPPORTERS_PAGE_SIZE);
    await expectNoA11yViolations(page);

    await page.goto('/supporters?page=2');
    await expect(supporterNames(page)).toHaveCount(SEED_LAST_PAGE_ROWS);
    await expectNoA11yViolations(page);

    await page.goto(cityPath('Köln'));
    await expect(supporterNames(page)).toHaveCount(seedNamesFrom('Köln').length);
    await expectNoA11yViolations(page);
  });
});
