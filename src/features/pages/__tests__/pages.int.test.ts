import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import { getForm, postForm, type Agent } from '../../../../test/forms.js';
import { parse, type Html } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';

/**
 * The public pages on the real app (ROUTES.md section 2, F-12 to F-16, F-88, F-89, B-42, B-44, B-62): their content,
 * the navigation per auth state through the shared header and footer, titles, headers, and that a guest's visit never
 * creates a session. Signed-in agents come from `signIn` (ADR 0017).
 */

/** A contact URL that is not the default, so the tests prove it comes from configuration (F-15, F-88). */
const CONTACT_URL = 'https://contact.example.org/petition';
const IMPRINT_URL = 'https://imprint.example.org/legal';

const PUBLIC_PAGES = ['/', '/about', '/privacy'] as const;

/** The home rows of ROUTES.md section 2, in order (F-12, B-42). */
const HOME_TARGETS = ['/register', '/login', '/profile', '/signature', '/supporters', '/account/delete'];

/** The rebuild stack of ROUTES.md section 2, in order (F-13, B-62). */
const STACK = [
  'Node 26',
  'Express 5',
  'TypeScript 6',
  'express-handlebars',
  'PostgreSQL 18 + Drizzle ORM',
  'Redis sessions',
  'Zod',
  'argon2id',
  'Tailwind CSS 4',
  'Schibsted Grotesk',
  'Vitest',
  'Playwright + axe',
  'Docker',
  'GitHub Actions',
];

/** Set explicitly, so the footer year below is computed in a known zone (F-15). */
const APP_TIME_ZONE = 'Europe/Berlin';

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp({ env: { CONTACT_URL, APP_TIME_ZONE } });
});

afterAll(async () => {
  await testApp.close();
});

function setCookies(response: Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  return Array.isArray(header) ? header.map(String) : [];
}

const hrefs = (page: Html, selector: string): string[] =>
  page.root.querySelectorAll(selector).map((link) => link.getAttribute('href') ?? '');

async function signedInAgent(): Promise<Agent> {
  const user = await createUser(testApp.db);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return agent;
}

async function getPage(agent: Agent | undefined, path: string): Promise<Html> {
  const response = await (agent ?? request(testApp.app)).get(path).expect(200);
  return parse(response.text);
}

/** One rendered page of the whole app, with the raw HTML for byte-level checks. */
interface RenderedPage {
  readonly path: string;
  readonly html: string;
  readonly page: Html;
}

async function renderedPage(agent: Agent | undefined, path: string, status = 200): Promise<RenderedPage> {
  const response = await (agent ?? request(testApp.app)).get(path).set('Accept', 'text/html').expect(status);
  return { path, html: response.text, page: parse(response.text) };
}

/**
 * Every page kind of the app, all rendered through the one layout and the shared partials: the public pages, the
 * guest forms, the pages of a signed-in member before and after signing, and the 404 page. The shell owns what every
 * page has in common (F-16, F-79), so it checks them all, not only its own.
 */
async function everyPageKind(): Promise<RenderedPage[]> {
  const member = await signedInAgent();
  const signerUser = await createUser(testApp.db);
  await createSignature(testApp.db, signerUser.id);
  const signer = request.agent(testApp.app);
  await signIn(signer, signerUser.id);

  return Promise.all([
    ...['/', '/about', '/privacy', '/login', '/register'].map((path) => renderedPage(undefined, path)),
    ...['/profile', '/profile/edit', '/signature', '/account/delete'].map((path) => renderedPage(member, path)),
    ...['/thank-you', '/signature/delete', '/supporters'].map((path) => renderedPage(signer, path)),
    renderedPage(undefined, '/no-such-page', 404),
  ]);
}

/** The footer year as viewLocals computes it; read before and after a request, so a midnight turn cannot flake. */
const yearNow = (): number =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: APP_TIME_ZONE, year: 'numeric' }).format(Date.now()));

describe('GET /', () => {
  it('F-12, F-16: the home page shows the petition intro as dynamic, uncached HTML', async () => {
    const response = await request(testApp.app).get('/').expect(200);
    const page = parse(response.text);

    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(page.text('title')).toBe('Home · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['Nonsense Petition']);
    expect(page.text('main .page-heading__lead')).toBe('A nonsense petition for absolutely nothing.');
  });

  it('F-12, B-42: the home rows link to the six petition routes, in order, and to nothing else', async () => {
    const page = await getPage(undefined, '/');

    expect(hrefs(page, 'main .row-list .list-row__link')).toEqual(HOME_TARGETS);
    // Every link in the page body is one of those routes; the legacy page linked to a route that never existed.
    expect(hrefs(page, 'main a')).toEqual(HOME_TARGETS);
    expect(page.texts('main .list-row__title')).toEqual([
      'register',
      'log in',
      'tell us about yourself',
      'sign the petition',
      'see all supporters',
      'delete your account',
    ]);
    // The list has an accessible name (a visually hidden h2), so the page outline is h1 > h2.
    expect(page.attr('main section', 'aria-labelledby')).toBe('home-steps');
    expect(page.text('#home-steps')).toBe('Take part');
  });

  it('F-12: signed-in viewers see the same rows; the guards of the targets decide where they lead', async () => {
    const agent = await signedInAgent();

    const page = await getPage(agent, '/');

    expect(hrefs(page, 'main .row-list .list-row__link')).toEqual(HOME_TARGETS);
  });

  it('B-44: / is the home page itself, and /home is a permanent redirect to it', async () => {
    const home = await request(testApp.app).get('/');
    const legacy = await request(testApp.app).get('/home');

    expect(home.status).toBe(200);
    expect(home.headers['location']).toBeUndefined();
    expect(legacy.status).toBe(301);
    expect(legacy.headers['location']).toBe('/');
  });
});

describe('GET /about', () => {
  it('F-13, B-62, F-16: the about page describes the rebuild and lists its stack as plain rows', async () => {
    const page = await getPage(undefined, '/about');

    expect(page.text('title')).toBe('About · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['About']);
    expect(page.texts('main .long-text__heading')).toEqual(['the project', 'the stack']);
    expect(page.text('main .long-text__text')).toMatch(/sign with a drawn or a typed signature/);
    expect(page.texts('main .list-row__title')).toEqual(STACK);
    // Rows of text, not links: the about page has no link in its body.
    expect(page.has('main .list-row__link')).toBe(false);
    expect(page.has('main a')).toBe(false);
    expect(page.root.querySelectorAll('main .list-row__meta')).toHaveLength(STACK.length);
  });
});

describe('GET /privacy', () => {
  it('F-88, F-16: the notice names the operator and the configured contact link and covers every topic', async () => {
    const page = await getPage(undefined, '/privacy');

    expect(page.text('title')).toBe('Privacy · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['Privacy']);
    expect(page.texts('main .long-text__heading')).toEqual([
      'who runs this site',
      'what is stored',
      'who sees what',
      'why',
      'how long it is kept',
      'deleting your data',
      'your rights',
    ]);
    expect(page.text('main')).toContain('run by Arnoldovna');
    // The contact channel for questions, access and erasure without a password is the configured URL (F-91).
    expect(hrefs(page, 'main .long-text__link').filter((href) => href === CONTACT_URL)).toHaveLength(2);
  });

  it('F-88: the notice says what is stored and who sees what, and that email and signature stay private', async () => {
    const page = await getPage(undefined, '/privacy');
    const stored = page.text('section[aria-labelledby="privacy-stored"]') ?? '';
    const visibility = page.text('section[aria-labelledby="privacy-visibility"]') ?? '';
    const purpose = page.text('section[aria-labelledby="privacy-purpose"]') ?? '';
    const retention = page.text('section[aria-labelledby="privacy-retention"]') ?? '';

    for (const item of ['first and last name', 'email address', 'hash of your password', 'age, city and homepage']) {
      expect(stored).toContain(item);
    }
    expect(stored).toContain('signature image and the time you signed');
    expect(stored).toContain('No IP addresses');
    expect(visibility).toContain('your name, the date you signed and, if you added them, your age, city and homepage');
    expect(visibility).toContain('Only registered users who are logged in can see it.');
    expect(visibility).toContain('Your signature image is shown only to you.');
    expect(visibility).toContain('Your email address is never shown to anyone else.');
    expect(purpose).toMatch(/no tracking, no analytics and no request to any third party/);
    expect(retention).toContain('until you delete them');
    expect(retention).toContain('at most one hour');
  });

  it('F-88: the notice links to deleting the signature and the account, and to correcting the profile', async () => {
    const page = await getPage(undefined, '/privacy');

    expect(hrefs(page, 'main .long-text__link')).toEqual([
      CONTACT_URL,
      '/signature/delete',
      '/account/delete',
      CONTACT_URL,
      '/profile/edit',
    ]);
    // Descriptive link texts (F-84): every link names its destination.
    expect(page.texts('main .long-text__link')).toEqual([
      'contact page of Arnoldovna',
      'delete your signature',
      'delete your account',
      'contact page',
      'edit your profile',
    ]);
  });
});

describe('sessions on public pages', () => {
  it.each(PUBLIC_PAGES)(
    'F-88, F-28, ADR 0003: a guest visit to %s creates no session and sets no cookie',
    async (path) => {
      // Other tests of this file sign agents in on the same app, so compare the store before and after the visit.
      const sessionKeys = async (): Promise<string[]> => (await testApp.redis.keys(`${testApp.prefix}:sess:*`)).sort();
      const before = await sessionKeys();

      const response = await request(testApp.app).get(path).expect(200);

      expect(setCookies(response)).toEqual([]);
      expect(parse(response.text).has('input[name="_csrf"]')).toBe(false);
      expect(await sessionKeys()).toEqual(before);
    },
  );

  it('ROUTES.md section 2: the public pages change nothing, so a POST with a valid token is the 404 page', async () => {
    const agent = await signedInAgent();
    const { csrf } = await getForm(agent, '/', 'form[action="/logout"]');

    for (const path of PUBLIC_PAGES) {
      const response = await postForm(agent, path, { _csrf: csrf }).set('Accept', 'text/html');
      expect(response.status, path).toBe(404);
      expect(parse(response.text).text('h1'), path).toBe('Page not found');
    }
  });
});

describe('navigation through the shared header and footer', () => {
  it('F-14, B-46: guests get about, log in and register; the current page is marked with aria-current', async () => {
    const home = await getPage(undefined, '/');
    const about = await getPage(undefined, '/about');

    for (const page of [home, about]) {
      expect(hrefs(page, '.site-header__nav a')).toEqual(['/about', '/login', '/register']);
      expect(page.has('form[action="/logout"]')).toBe(false);
    }
    expect(home.attr('.site-header__brand', 'aria-current')).toBe('page');
    expect(home.attr('.site-header__nav a[href="/about"]', 'aria-current')).toBeUndefined();
    expect(about.attr('.site-header__brand', 'aria-current')).toBeUndefined();
    expect(about.attr('.site-header__nav a[href="/about"]', 'aria-current')).toBe('page');
    expect(about.root.querySelectorAll('[aria-current="page"]').map((link) => link.getAttribute('href'))).toEqual([
      '/about',
      '/about',
    ]);
  });

  it('F-14, B-46: signed-in viewers get supporters, profile and a log-out form; about moves to the footer', async () => {
    const agent = await signedInAgent();

    for (const path of PUBLIC_PAGES) {
      const page = await getPage(agent, path);
      expect(hrefs(page, '.site-header__nav a'), path).toEqual(['/supporters', '/profile/edit']);
      expect(page.attr('.site-header form[action="/logout"]', 'method'), path).toBe('post');
      expect(page.attr('.site-header form[action="/logout"] input[name="_csrf"]', 'value'), path).not.toBe('');
      expect(hrefs(page, '.site-footer a'), path).toContain('/about');
    }
    const about = await getPage(agent, '/about');
    expect(about.attr('.site-footer a[href="/about"]', 'aria-current')).toBe('page');
  });

  it('F-16: home, about and privacy have unique titles in the form "<Page> · Nonsense Petition"', async () => {
    const titles = await Promise.all(PUBLIC_PAGES.map(async (path) => (await getPage(undefined, path)).text('title')));

    expect(titles).toEqual(['Home · Nonsense Petition', 'About · Nonsense Petition', 'Privacy · Nonsense Petition']);
    expect(new Set(titles).size).toBe(PUBLIC_PAGES.length);
  });

  it('F-88, F-15: every page, the 404 page too, links the privacy notice and the configured contact in the footer', async () => {
    const notFound = await request(testApp.app).get('/no-such-page').set('Accept', 'text/html').expect(404);
    const pages = [...(await Promise.all(PUBLIC_PAGES.map((path) => getPage(undefined, path)))), parse(notFound.text)];

    for (const page of pages) {
      expect(page.has('.site-footer a[href="/privacy"]')).toBe(true);
      expect(page.has(`.site-footer a[href="${CONTACT_URL}"]`)).toBe(true);
    }
  });

  it('F-14: the main navigation never has more than three entries, for guests and signed-in viewers', async () => {
    const guest = await getPage(undefined, '/');
    const member = await getPage(await signedInAgent(), '/');

    expect(guest.texts('.site-header__nav .site-header__item')).toEqual(['about', 'log in', 'register']);
    expect(member.texts('.site-header__nav .site-header__item')).toEqual(['supporters', 'profile', 'log out']);
    // The wordmark is the home link next to the navigation, not one of its entries (no hamburger, ADR 0014).
    for (const page of [guest, member]) {
      expect(page.attr('.site-header > .site-header__brand', 'href')).toBe('/');
      expect(page.text('.site-header__brand')).toBe('nonsense petition');
      expect(page.has('.site-header__nav .site-header__brand')).toBe(false);
    }
  });

  it('F-15: the footer shows the project credit with the current year, computed per request', async () => {
    const before = yearNow();
    const page = await getPage(undefined, '/');
    const after = yearNow();

    const credit = page.text('footer .site-footer__credit') ?? '';
    const year = /^© (\d{4}) Arnoldovna\. Nonsense Petition is a portfolio project\.$/.exec(credit)?.[1];
    expect(credit).toMatch(/^© \d{4} /);
    expect([before, after]).toContain(Number(year));
  });

  it('F-14, F-88, F-15: the footer links about, privacy and the configured contact, in that order', async () => {
    const page = await getPage(undefined, '/privacy');

    expect(hrefs(page, '.site-footer__nav a')).toEqual(['/about', '/privacy', CONTACT_URL]);
    expect(page.texts('.site-footer__nav a')).toEqual(['about', 'privacy', 'contact']);
    expect(page.attr('.site-footer a[href="/privacy"]', 'aria-current')).toBe('page');
  });

  it('F-15, B-15: no page puts an email address or a phone number into its markup', async () => {
    for (const path of PUBLIC_PAGES) {
      const { text } = await request(testApp.app).get(path).expect(200);
      expect(text, path).not.toMatch(/mailto:|tel:/i);
      expect(text, path).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
    }
  });
});

describe('what every page has in common (layout and shared partials)', () => {
  let pages: RenderedPage[];

  beforeAll(async () => {
    pages = await everyPageKind();
  });

  it('F-16, B-45: every page has a unique title in the form "<Page> · Nonsense Petition"', () => {
    const titles = pages.map(({ page }) => page.text('title') ?? '');

    for (const [index, title] of titles.entries()) {
      expect(title, pages[index]?.path).toMatch(/^\S.* · Nonsense Petition$/);
    }
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('F-79, B-64, B-63: lang, the charset as the first head child within 1024 bytes, and a viewport meta', () => {
    for (const { path, html, page } of pages) {
      expect(page.attr('html', 'lang'), path).toBe('en');
      const first = page.root.querySelector('head')?.firstElementChild;
      expect(first?.tagName.toLowerCase(), path).toBe('meta');
      expect(first?.getAttribute('charset'), path).toBe('utf-8');
      expect(Buffer.byteLength(html.slice(0, html.indexOf('<meta charset="utf-8">'))), path).toBeLessThan(1024);
      expect(page.attr('meta[name="viewport"]', 'content'), path).toBe('width=device-width, initial-scale=1');
    }
  });

  it('F-79, B-67: one h1 and the header, main navigation, main and footer landmarks, each once', () => {
    for (const { path, page } of pages) {
      expect(page.root.querySelectorAll('h1'), path).toHaveLength(1);
      expect(page.root.querySelectorAll('body > header.site-header'), path).toHaveLength(1);
      expect(page.root.querySelectorAll('nav[aria-label="Main"]'), path).toHaveLength(1);
      expect(page.root.querySelectorAll('main'), path).toHaveLength(1);
      expect(page.root.querySelectorAll('body > footer.site-footer'), path).toHaveLength(1);
      // The h1 is the page's own heading inside main, never the wordmark.
      expect(page.has('main h1'), path).toBe(true);
    }
  });

  it('F-79, B-67: a "Skip to content" link comes first and leads to the focusable main element', () => {
    for (const { path, page } of pages) {
      const first = page.root.querySelector('body')?.firstElementChild;
      expect(first?.getAttribute('class'), path).toBe('skip-link');
      expect(first?.getAttribute('href'), path).toBe('#main');
      expect(first?.text.trim(), path).toBe('Skip to content');
      expect(page.attr('main#main', 'tabindex'), path).toBe('-1');
    }
  });

  it('F-17: the role="status" flash region is on every page, inside main and before the heading', () => {
    for (const { path, page } of pages) {
      const first = page.root.querySelector('main')?.firstElementChild;
      expect(first?.getAttribute('class'), path).toBe('flash');
      expect(first?.getAttribute('role'), path).toBe('status');
      expect(page.root.querySelectorAll('[role="status"].flash'), path).toHaveLength(1);
    }
  });

  it('F-86, B-16: no page loads anything from another origin; only the footer contact leaves the site', () => {
    for (const { path, page } of pages) {
      const loaded = [
        ...page.root.querySelectorAll('link[href]').map((element) => element.getAttribute('href') ?? ''),
        ...page.root.querySelectorAll('[src]').map((element) => element.getAttribute('src') ?? ''),
      ];
      for (const url of loaded) expect(url, path).toMatch(/^\/(?!\/)/);

      // Supporters' own homepage links are user content with their own rules (F-52, supporters module), so they are
      // left out; every other link that leaves the site is the configured contact.
      const external = page.root
        .querySelectorAll('a[href]')
        .filter((link) => link.closest('.supporter-row') === null)
        .map((link) => link.getAttribute('href') ?? '')
        .filter((href) => !/^[/#](?!\/)/.test(href));
      expect([...new Set(external)], path).toEqual([CONTACT_URL]);
    }
  });

  it('F-84, B-69: no icon images; every link and button has a text name that says where it leads', () => {
    for (const { path, page } of pages) {
      // Images only with an alt attribute (the thank-you signature has a descriptive one); no icon images.
      for (const image of page.root.querySelectorAll('img')) {
        expect(image.getAttribute('alt'), path).toBeDefined();
        expect(image.getAttribute('src') ?? '', path).not.toMatch(/icon/i);
      }
      for (const link of page.root.querySelectorAll('a, button')) {
        expect(link.text.trim(), `${path}: ${link.toString()}`).not.toBe('');
      }
    }
  });
});

describe('robots.txt (ROUTES.md section 7)', () => {
  it('B-43: robots.txt is a real text file that keeps the public pages crawlable and the form pages out', async () => {
    const response = await request(testApp.app).get('/robots.txt').expect(200);
    const disallowed = response.text
      .split('\n')
      .filter((line) => line.startsWith('Disallow:'))
      .map((line) => line.slice('Disallow:'.length).trim());

    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toMatch(/^User-agent: \*$/m);
    // No rule matches a public page (robots rules are path prefixes, RFC 9309).
    for (const path of PUBLIC_PAGES) {
      expect(
        disallowed.filter((rule) => rule === '/' || path.startsWith(rule)),
        path,
      ).toEqual([]);
    }
    for (const path of ['/register', '/login', '/profile/edit', '/signature', '/supporters', '/account/delete']) {
      expect(
        disallowed.some((rule) => path.startsWith(rule)),
        path,
      ).toBe(true);
    }
  });
});

describe('imprint link (F-89)', () => {
  it('F-89: without IMPRINT_URL no page renders an imprint link', async () => {
    for (const path of PUBLIC_PAGES) {
      const page = await getPage(undefined, path);
      expect(page.texts('.site-footer a'), path).not.toContain('imprint');
    }
  });

  it('F-89: with IMPRINT_URL the footer of every page links to it in the same tab', async () => {
    const withImprint = await createTestApp({ env: { CONTACT_URL, IMPRINT_URL } });
    try {
      for (const path of PUBLIC_PAGES) {
        const page = parse((await request(withImprint.app).get(path).expect(200)).text);
        expect(page.attr(`.site-footer a[href="${IMPRINT_URL}"]`, 'href'), path).toBe(IMPRINT_URL);
        expect(page.text(`.site-footer a[href="${IMPRINT_URL}"]`), path).toBe('imprint');
        expect(page.attr(`.site-footer a[href="${IMPRINT_URL}"]`, 'target'), path).toBeUndefined();
      }
    } finally {
      await withImprint.close();
    }
  });
});
