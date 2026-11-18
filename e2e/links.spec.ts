import type { Page } from '@playwright/test';

import { expectNoA11yViolations } from './a11y.ts';
import {
  cityPath,
  expect,
  findSupporterRow,
  fullName,
  logOut,
  registerUser,
  signTyped,
  supporterList,
  supporterNames,
  test,
  uniqueCity,
} from './fixtures.ts';

/**
 * Links and paths (ADR 0015 "Link crawler", B-42; F-56 and F-57 with unique cities; B-30 to B-33).
 *
 * - The crawler follows every same-origin `href` and `src` of every page it reaches, as a guest, as a signed-in user who
 *   has not signed, and as a signer, and fails on any target that does not answer 200 (after redirects). It also
 *   checks in-page fragment links (`#main`) and the files a stylesheet or the web manifest refers to.
 * - The city tests store cities with a slash, `?`, `#`, `&`, an umlaut and odd spacing (B-32), and walk from the
 *   supporters list to the city page and back.
 *
 * Mutating spec (ADR 0015): own users, unique cities (`e2e-<uuid>`), no global counts. Other workers add and delete
 * signers while this spec runs, so the crawler re-checks a failing target before it reports it, and `findSupporterRow`
 * searches the paginated list instead of assuming a page.
 */

/** A sanity bound: the site has a few dozen pages plus one page per city; far more means the crawler is looping. */
const MAX_CRAWL_TARGETS = 2000;

// ---------------------------------------------------------------------------------------------------------------
// Crawler (B-42)
// ---------------------------------------------------------------------------------------------------------------

/** What one HTML page links to, read with `DOMParser` (inert: nothing of the parsed page runs or loads). */
interface PageRefs {
  /** `a[href]`: pages to crawl. */
  links: string[];
  /** `link[href]`, `script[src]`, `img[src]`: files that must exist but are not crawled further. */
  resources: string[];
  /** Every `id` of the page, for fragment links. */
  ids: string[];
}

interface Target {
  url: string;
  /** The page whose markup (or the stylesheet or manifest) referred to `url`. */
  from: string;
  /** Pages are fetched and crawled; resources are only fetched. */
  crawl: boolean;
}

interface Failure {
  url: string;
  from: string;
  problem: string;
}

interface CrawlResult {
  /** Every fetched target as `pathname + search`. */
  fetched: Set<string>;
  failures: Failure[];
}

function pathOf(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

async function readRefs(page: Page, html: string): Promise<PageRefs> {
  return page.evaluate((markup) => {
    const doc = new DOMParser().parseFromString(markup, 'text/html');
    const values = (selector: string, attribute: string): string[] =>
      [...doc.querySelectorAll(selector)].map((element) => element.getAttribute(attribute) ?? '');
    return {
      links: values('a[href]', 'href'),
      resources: [...values('link[href]', 'href'), ...values('script[src]', 'src'), ...values('img[src]', 'src')],
      ids: [...doc.querySelectorAll('[id]')].map((element) => element.id),
    };
  }, html);
}

/** `url(...)` references of a stylesheet (fonts), without `data:` URLs. */
function stylesheetRefs(css: string): string[] {
  return [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)]
    .map((match) => match[2] ?? '')
    .filter((ref) => !ref.startsWith('data:'));
}

/** `start_url` and icon `src` values of the web manifest. */
function manifestRefs(json: string): string[] {
  const manifest: unknown = JSON.parse(json);
  if (typeof manifest !== 'object' || manifest === null) return [];
  const refs: string[] = [];
  if ('start_url' in manifest && typeof manifest.start_url === 'string') refs.push(manifest.start_url);
  if ('icons' in manifest && Array.isArray(manifest.icons)) {
    for (const icon of manifest.icons as unknown[]) {
      if (typeof icon === 'object' && icon !== null && 'src' in icon && typeof icon.src === 'string') {
        refs.push(icon.src);
      }
    }
  }
  return refs;
}

/**
 * Breadth-first crawl from `start` with the page's own cookies (`page.request` shares the browser context, so a
 * signed-in test crawls signed in). Only GET requests: forms are never submitted, so the crawl changes no data.
 * Redirects are followed (a guarded page answers with the login page); the final answer must be 200.
 */
async function crawl(page: Page, start: readonly string[]): Promise<CrawlResult> {
  const origin = new URL(page.url()).origin;
  const queue: Target[] = start.map((path) => ({ url: new URL(path, origin).href, from: '(start)', crawl: true }));
  const queued = new Set(queue.map(({ url }) => url));
  const fetched = new Set<string>();
  const failures: Failure[] = [];

  const enqueue = (ref: string, base: string, crawlIt: boolean, ids?: readonly string[]): void => {
    const url = new URL(ref, base);
    if (url.origin !== origin) return; // external homepages, the contact link and mailto: are not ours to check
    if (url.hash !== '' && ids !== undefined && pathOf(url.href) === pathOf(base)) {
      const id = decodeURIComponent(url.hash.slice(1));
      if (!ids.includes(id)) failures.push({ url: url.href, from: base, problem: `no element with id "${id}"` });
    }
    url.hash = '';
    if (queued.has(url.href)) return;
    if (queued.size >= MAX_CRAWL_TARGETS) throw new Error(`crawl: more than ${String(MAX_CRAWL_TARGETS)} targets`);
    queued.add(url.href);
    queue.push({ url: url.href, from: base, crawl: crawlIt });
  };

  for (let target = queue.shift(); target !== undefined; target = queue.shift()) {
    const response = await page.request.get(target.url);
    fetched.add(pathOf(target.url));
    if (response.status() !== 200) {
      failures.push({ url: target.url, from: target.from, problem: `HTTP ${String(response.status())}` });
      continue;
    }
    const type = response.headers()['content-type'] ?? '';
    const finalUrl = response.url();
    if (type.startsWith('text/html') && target.crawl) {
      const refs = await readRefs(page, await response.text());
      for (const ref of refs.links) enqueue(ref, finalUrl, true, refs.ids);
      for (const ref of refs.resources) enqueue(ref, finalUrl, false);
    } else if (type.startsWith('text/css')) {
      for (const ref of stylesheetRefs(await response.text())) enqueue(ref, finalUrl, false);
    } else if (type.startsWith('application/manifest+json') || finalUrl.endsWith('.webmanifest')) {
      for (const ref of manifestRefs(await response.text())) enqueue(ref, finalUrl, false);
    }
  }
  return { fetched, failures: await confirmFailures(page, failures) };
}

/**
 * Other workers sign and delete while the crawl runs, so a pagination link to a last page can vanish between reading
 * the page and fetching the target. An HTTP failure only counts when the referring page still links the target and
 * the target still fails; a missing fragment target is a markup fact and always counts.
 */
async function confirmFailures(page: Page, failures: readonly Failure[]): Promise<Failure[]> {
  const confirmed: Failure[] = [];
  for (const failure of failures) {
    if (!failure.problem.startsWith('HTTP ')) {
      confirmed.push(failure);
      continue;
    }
    const source = await page.request.get(failure.from);
    const refs = await readRefs(page, await source.text());
    const stillLinked = [...refs.links, ...refs.resources].some(
      (ref) => new URL(ref, source.url()).href === failure.url,
    );
    const retry = await page.request.get(failure.url);
    if (stillLinked && retry.status() !== 200)
      confirmed.push({ ...failure, problem: `HTTP ${String(retry.status())}` });
  }
  return confirmed;
}

/** The pages and files every visitor's crawl must reach, so a crawler that finds nothing can never pass. */
const SHARED_TARGETS = [
  '/',
  '/about',
  '/privacy',
  '/favicon.svg',
  '/apple-touch-icon.png',
  '/icon-512.png',
  '/site.webmanifest',
  '/fonts/schibsted-grotesk-latin-400-normal.woff2',
];

test('B-42, F-12: the home page links every step of the petition to an existing route, never to ./signup', async ({
  page,
}) => {
  await page.goto('/');
  const rows = page.getByRole('main').getByRole('list').getByRole('link');

  await expect(rows).toHaveCount(6);
  const hrefs = await rows.evaluateAll((links) => links.map((link) => link.getAttribute('href')));
  expect(hrefs).toEqual(['/register', '/login', '/profile', '/signature', '/supporters', '/account/delete']);
  await expect(page.locator('a[href*="signup"]')).toHaveCount(0);

  // A guest reaches each target or its login redirect (guards, ROUTES.md section 1), never the 404 page.
  for (const href of hrefs) {
    const response = await page.goto(href ?? '');
    expect(response?.status(), href ?? '').toBe(200);
    await expect(page, href ?? '').not.toHaveTitle('Page not found · Nonsense Petition');
  }
  await expectNoA11yViolations(page);
});

test('B-42: as a guest, every same-origin link and file on every reachable page answers 200', async ({ page }) => {
  await page.goto('/');

  const { fetched, failures } = await crawl(page, ['/']);

  expect(failures).toEqual([]);
  expect([...fetched]).toEqual(expect.arrayContaining([...SHARED_TARGETS, '/login', '/register', '/profile']));
  expect([...fetched].some((path) => /^\/assets\/app-[a-f0-9]+\.css$/.test(path))).toBe(true);
});

test.describe('signed in, not signed', () => {
  test.use({ signedIn: true });

  test('B-42: every same-origin link and file of the signed-in pages answers 200, the supporters and city pages included', async ({
    page,
  }) => {
    await page.goto('/');

    const { fetched, failures } = await crawl(page, ['/']);

    expect(failures).toEqual([]);
    expect([...fetched]).toEqual(
      expect.arrayContaining([
        ...SHARED_TARGETS,
        '/supporters',
        '/supporters?page=2',
        '/profile/edit',
        '/account/delete',
        '/signature',
        cityPath('Frankfurt/Main'),
      ]),
    );
  });
});

test('B-42: a signer reaches the thank-you page, the own signature image and the delete confirmation without a 404', async ({
  page,
}) => {
  await registerUser(page, { profile: { city: uniqueCity() } });
  await signTyped(page);

  const { fetched, failures } = await crawl(page, ['/', '/thank-you']);

  expect(failures).toEqual([]);
  expect([...fetched]).toEqual(
    expect.arrayContaining([...SHARED_TARGETS, '/thank-you', '/signature/image.png', '/signature/delete']),
  );
});

// ---------------------------------------------------------------------------------------------------------------
// City paths with unique cities (F-56, F-57, B-30 to B-33)
// ---------------------------------------------------------------------------------------------------------------

test('F-56, F-57, B-31, B-32: a city with /, ?, #, & and an umlaut links to its page, matches case-, space- and NFC-insensitively and lists signers oldest first', async ({
  page,
}) => {
  // B-32: every character that broke legacy city links, after a unique prefix (ADR 0015).
  const city = `${uniqueCity()} Frankfurt/Main? St. Gallen #1 & Köln`;
  // The same city as typed by someone else: upper case, decomposed umlaut, padded and with a run of spaces.
  const typedVariant = `  ${city.toUpperCase().normalize('NFD').replace(' ', '    ')}  `;
  // Stored after normalisation on write (B-32: NFC, whitespace collapsed, trimmed); the case is kept.
  const storedVariant = city.toUpperCase();

  const first = await test.step('the first signer stores the city as typed', async () => {
    const user = await registerUser(page, { profile: { city } });
    await signTyped(page);
    await logOut(page);
    return fullName(user);
  });
  const second = await test.step('the second signer stores the variant, normalised', async () => {
    const user = await registerUser(page, { profile: { city: typedVariant } });
    await signTyped(page);
    return fullName(user);
  });

  await test.step('the list links the city with encodeURIComponent in the same tab', async () => {
    const row = await findSupporterRow(page, first);
    const cityLink = row.getByRole('link', { name: `supporters from ${city}`, exact: true });
    await expect(cityLink).toHaveAttribute('href', cityPath(city));
    await expect(cityLink).not.toHaveAttribute('target');

    await cityLink.click();
    await expect(page).toHaveURL(cityPath(city));
  });

  const main = page.getByRole('main');
  await test.step('F-56, B-31: the city page lists both signers oldest first, each city as plain text', async () => {
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${city}`);
    await expect(page).toHaveTitle(`Supporters from ${city} · Nonsense Petition`);
    await expect(main.getByText('2 supporters', { exact: true })).toBeVisible();
    await expect(supporterNames(page)).toHaveText([first, second]);
    await expect(supporterList(page).locator('.supporter-row__city')).toHaveText([city, storedVariant]);
    await expect(supporterList(page).getByRole('link', { name: /^supporters from / })).toHaveCount(0);
    await expectNoA11yViolations(page);
  });

  await test.step('the variant spelling finds the same signers; the heading shows the trimmed request', async () => {
    const response = await page.goto(cityPath(typedVariant));
    expect(response?.status()).toBe(200);
    await expect(main.getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${storedVariant}`);
    await expect(supporterNames(page)).toHaveText([first, second]);
  });

  await test.step('F-56: "all supporters" leads back to the list', async () => {
    await main.getByRole('link', { name: 'all supporters', exact: true }).click();
    await expect(page).toHaveURL('/supporters');
    await expect(supporterNames(page).first()).toBeVisible();
    await expectNoA11yViolations(page);
  });
});

test('B-30: a signer who skipped the profile is on the supporters list with the name and signing date only', async ({
  page,
}) => {
  const user = await registerUser(page);
  // The explicit skip of the onboarding form (F-33): no profile row is written.
  await page.getByRole('main').getByRole('link', { name: 'skip', exact: true }).click();
  await expect(page).toHaveURL('/signature');
  await signTyped(page);
  const signerName = fullName(user);

  const row = await findSupporterRow(page, signerName);

  // A regular expression is matched against the raw text, so the markup's whitespace is allowed between the parts.
  await expect(row).toHaveText(
    new RegExp(`^\\s*${RegExp.escape(signerName)}\\s+signed \\d{1,2} [A-Z][a-z]{2} \\d{4}\\s*$`),
  );
  await expect(row.getByRole('link')).toHaveCount(0);
  await expect(row.locator('.supporter-row__age, .supporter-row__city')).toHaveCount(0);
  await expectNoA11yViolations(page);
});

test('F-58, B-33: a city nobody signed from keeps the requested city as its heading, with an empty state and a link back', async ({
  page,
}) => {
  await registerUser(page);
  const city = `${uniqueCity()} Halle (Saale)`;
  const main = page.getByRole('main');

  const response = await page.goto(cityPath(city));

  expect(response?.status()).toBe(200);
  await expect(main.getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${city}`);
  await expect(main.getByRole('heading', { level: 2 })).toHaveText(`No supporters from ${city} yet`);
  await expect(supporterList(page)).toHaveCount(0);
  const back = main.getByRole('link', { name: 'all supporters', exact: true });
  await expect(back).toHaveCount(1);
  await expect(back).toHaveAttribute('href', '/supporters');
  await expectNoA11yViolations(page);

  // A city that is blank after normalisation (spaces, a zero-width space) or has no letter never renders a blank or
  // meaningless heading: it is the 404 page (ROUTES.md section 1, cityParam).
  for (const blank of ['   ', '​', '...']) {
    const blankResponse = await page.goto(cityPath(blank));
    expect(blankResponse?.status(), JSON.stringify(blank)).toBe(404);
    await expect(page).toHaveTitle('Page not found · Nonsense Petition');
  }
});
