import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createUser } from '../../../../test/factories.js';
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

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp({ env: { CONTACT_URL } });
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
      'Register',
      'Log in',
      'Tell us about yourself',
      'Sign the petition',
      'See all supporters',
      'Delete your account',
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
  it('F-14: guests get about, log in and register; the current page is marked with aria-current', async () => {
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

  it('F-14: signed-in viewers get supporters, profile and a log-out form; about moves to the footer', async () => {
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

  it('F-15, B-15: no page puts an email address or a phone number into its markup', async () => {
    for (const path of PUBLIC_PAGES) {
      const { text } = await request(testApp.app).get(path).expect(200);
      expect(text, path).not.toMatch(/mailto:|tel:/i);
      expect(text, path).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
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
