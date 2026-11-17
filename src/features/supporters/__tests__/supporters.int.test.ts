import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { profiles } from '../../../db/schema/index.js';
import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser, type TestUser } from '../../../../test/factories.js';
import type { Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { createSupportersModule } from '../index.js';

/**
 * GET /supporters (ROUTES.md section 6) against the real app on this file's own database (ADR 0017). The file runs
 * its describe blocks in order: first on the empty database (F-55), then on a fixed set of 51 signers, so every
 * total below is exact.
 */

/** The app's page size (app.ts, ADR 0006). */
const PAGE_SIZE = 50;
const T0 = Date.parse('2026-01-01T10:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

const XSS = {
  firstName: '<img src=x onerror=alert(1)>',
  lastName: '"><script>alert(2)</script>',
  city: '<b onmouseover=alert(3)>Town</b>',
  homepageUrl: 'https://xss.example.com/"onmouseover="alert(4)',
} as const;

let testApp: TestApp;
let viewer: TestUser;
let agent: Agent;

beforeAll(async () => {
  testApp = await createTestApp();
  // The viewer has not signed: requireAuth is the only guard (F-51), and the viewer is never in the list.
  viewer = await createUser(testApp.db, { firstName: 'Vera', lastName: 'Viewer' });
  agent = request.agent(testApp.app);
  await signIn(agent, viewer.id);
});

afterAll(async () => {
  await testApp.close();
});

/** The main landmark of a 200 page. */
async function page(path: string) {
  const response = await agent.get(path);
  expect(response.status, `GET ${path}`).toBe(200);
  return { response, html: parse(response.text) };
}

/** Text of each row's name, in list order. */
const rowNames = (html: ReturnType<typeof parse>): string[] => html.texts('.supporter-list .supporter-row__name');

describe('GET /supporters: guards', () => {
  it('F-51, F-07: a guest is redirected to the login page with returnTo', async () => {
    const response = await request(testApp.app).get('/supporters?page=2');

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe('/login?returnTo=%2Fsupporters%3Fpage%3D2');
  });
});

describe('GET /supporters: nobody has signed yet', () => {
  it('F-55: shows the empty state with a link to sign, and no list or pagination', async () => {
    const { response, html } = await page('/supporters');

    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(html.text('title')).toBe('Supporters · Nonsense Petition');
    expect(html.texts('h1')).toEqual(['Supporters']);
    expect(html.text('main .empty-state__title')).toBe('No supporters yet. Be the first!');
    expect(html.attr('main .empty-state__link', 'href')).toBe('/signature');
    expect(html.has('.supporter-list')).toBe(false);
    expect(html.has('nav.pagination')).toBe(false);
  });

  it('F-54, ADR 0006: page 2 of an empty list is the 404 page', async () => {
    const response = await agent.get('/supporters?page=2');

    expect(response.status).toBe(404);
    expect(parse(response.text).text('h1')).toBe('Page not found');
  });
});

describe('GET /supporters: 51 signers', () => {
  let ada: TestUser;
  let tieFirstUser: TestUser;
  let tieSecondUser: TestUser;

  beforeAll(async () => {
    const { db } = testApp;
    const nina = await createUser(db, { firstName: 'Nina', lastName: 'Noprofile' });
    await createSignature(db, nina.id, { createdAt: at(0) });

    ada = await createUser(db, { firstName: 'Ada', lastName: 'Lovelace' });
    await db
      .insert(profiles)
      .values({ userId: ada.id, age: 36, city: 'Frankfurt/Main', homepageUrl: 'https://ada.example.com/' });
    await createSignature(db, ada.id, { createdAt: at(1) });

    const xss = await createUser(db, { firstName: XSS.firstName, lastName: XSS.lastName });
    await db.insert(profiles).values({ userId: xss.id, city: XSS.city, homepageUrl: XSS.homepageUrl });
    await createSignature(db, xss.id, { createdAt: at(2) });

    // Equal timestamps: the signature id decides (ADR 0006). The user created first signs second, so ordering by user
    // id would give the opposite order.
    tieSecondUser = await createUser(db, { firstName: 'Tie', lastName: 'Second' });
    tieFirstUser = await createUser(db, { firstName: 'Tie', lastName: 'First' });
    await createSignature(db, tieFirstUser.id, { createdAt: at(3) });
    await createSignature(db, tieSecondUser.id, { createdAt: at(3) });

    // A profile without a signature is no supporter (F-51).
    const paul = await createUser(db, { firstName: 'Paul', lastName: 'Profileonly' });
    await db.insert(profiles).values({ userId: paul.id, age: 50, city: 'Frankfurt/Main' });

    for (let index = 1; index <= 46; index++) {
      const filler = await createUser(db, { firstName: 'Filler', lastName: String(index).padStart(2, '0') });
      await createSignature(db, filler.id, { createdAt: at(10 + index) });
    }
  });

  it('F-51, B-30: signers without a profile are listed; users who have not signed are not', async () => {
    const { html } = await page('/supporters');

    const names = rowNames(html);
    expect(names).toContain('Nina Noprofile');
    expect(names).not.toContain('Paul Profileonly');
    expect(names).not.toContain('Vera Viewer');
  });

  it('F-54, F-47: the heading shows the total of every page, and the rows of all pages add up to it', async () => {
    const first = await page('/supporters');
    const second = await page('/supporters?page=2');

    expect(first.html.text('.page-heading__lead')).toBe('51 supporters');
    expect(second.html.text('.page-heading__lead')).toBe('51 supporters');
    expect(rowNames(first.html)).toHaveLength(PAGE_SIZE);
    expect(rowNames(second.html)).toEqual(['Filler 46']);
  });

  it('F-47: countSupporters, the count injected into the thank-you page, is the list total', async () => {
    const { countSupporters } = createSupportersModule({ db: testApp.db, pageSize: PAGE_SIZE });

    expect(await countSupporters()).toBe(51);
  });

  it('F-54, B-31: oldest signature first, equal timestamps by signature id', async () => {
    const { html } = await page('/supporters');

    expect(rowNames(html).slice(0, 5)).toEqual([
      'Nina Noprofile',
      'Ada Lovelace',
      `${XSS.firstName} ${XSS.lastName}`,
      'Tie First',
      'Tie Second',
    ]);
    expect(rowNames(html).at(-1)).toBe('Filler 45');
  });

  it('F-54: the list is an <ol> numbered from the first row of the page', async () => {
    const first = await page('/supporters');
    const second = await page('/supporters?page=2');

    expect(first.html.root.querySelectorAll('ol.supporter-list > li.supporter-row')).toHaveLength(PAGE_SIZE);
    expect(first.html.attr('ol.supporter-list', 'start')).toBe('1');
    expect(second.html.attr('ol.supporter-list', 'start')).toBe('51');
  });

  it('F-54, F-16: page 1 is the bare path; later pages have their own title', async () => {
    const bare = await page('/supporters');
    const explicit = await page('/supporters?page=1');
    const second = await page('/supporters?page=2');

    expect(rowNames(explicit.html)).toEqual(rowNames(bare.html));
    expect(second.html.text('title')).toBe('Supporters, page 2 · Nonsense Petition');
    expect(second.html.texts('h1')).toEqual(['Supporters']);
  });

  it('F-54, B-67: accessible pagination with aria-current on the current page', async () => {
    const first = await page('/supporters');
    const nav = 'nav.pagination[aria-label="Pagination"]';

    expect(first.html.has(nav)).toBe(true);
    expect(first.html.text(`${nav} [aria-current="page"]`)).toBe('page 1');
    expect(first.html.attr(`${nav} a[rel="next"]`, 'href')).toBe('/supporters?page=2');
    expect(first.html.has(`${nav} a[rel="prev"]`)).toBe(false);

    const second = await page('/supporters?page=2');
    expect(second.html.text(`${nav} [aria-current="page"]`)).toBe('page 2');
    expect(second.html.attr(`${nav} a[rel="prev"]`, 'href')).toBe('/supporters');
    expect(second.html.has(`${nav} a[rel="next"]`)).toBe(false);
  });

  it.each([['3'], ['0'], ['-1'], ['abc'], ['1.5'], [''], ['10001'], ['123456'], ['1e1']])(
    'F-54, ADR 0006: ?page=%j is the 404 page',
    async (value) => {
      const response = await agent.get(`/supporters?page=${encodeURIComponent(value)}`);

      expect(response.status).toBe(404);
      expect(parse(response.text).text('h1')).toBe('Page not found');
    },
  );

  it('ADR 0006: a repeated page parameter is the 404 page', async () => {
    const response = await agent.get('/supporters?page=1&page=2');

    expect(response.status).toBe(404);
  });

  it('F-52, B-17: the name links to the homepage in the same tab with rel, then age, city link and date', async () => {
    const { html } = await page('/supporters');
    const row = html.root.querySelectorAll('.supporter-row').find((li) => li.text.includes('Ada Lovelace'));
    expect(row).toBeDefined();

    const name = row?.querySelector('a.supporter-row__name');
    expect(name?.getAttribute('href')).toBe('https://ada.example.com/');
    expect(name?.getAttribute('rel')).toBe('noopener noreferrer nofollow ugc');
    expect(name?.hasAttribute('target')).toBe(false);
    expect(row?.querySelector('.supporter-row__age')?.text.trim()).toBe('age 36');

    const city = row?.querySelector('a.supporter-row__city');
    expect(city?.text.trim()).toBe('Frankfurt/Main');
    expect(city?.getAttribute('href')).toBe('/supporters/city/Frankfurt%2FMain');
    expect(city?.hasAttribute('target')).toBe(false);

    const time = row?.querySelector('.supporter-row__date time');
    expect(time?.getAttribute('datetime')).toBe('2026-01-01T10:01:00.000Z');
    expect(time?.text.trim()).toBe('1 Jan 2026');
  });

  it('F-52, B-17: a supporter without a profile shows the plain name and the date, no empty slots', async () => {
    const { html } = await page('/supporters');
    const row = html.root.querySelectorAll('.supporter-row').find((li) => li.text.includes('Nina Noprofile'));

    expect(row?.querySelector('a')).toBeNull();
    expect(row?.querySelector('.supporter-row__age')).toBeNull();
    expect(row?.querySelector('.supporter-row__city')).toBeNull();
    expect(row?.querySelector('.supporter-row__meta')?.text.replace(/\s+/g, ' ').trim()).toBe('signed 1 Jan 2026');
  });

  it('F-53, B-01: markup in every field is shown as text and never becomes an element or attribute', async () => {
    const { response, html } = await page('/supporters');

    for (const raw of ['<img src=x', '<script>alert(2)', '<b onmouseover', '"onmouseover="']) {
      expect(response.text).not.toContain(raw);
    }
    const main = html.root.querySelector('main');
    expect(main?.querySelectorAll('img, script, b')).toHaveLength(0);
    for (const element of main?.querySelectorAll('*') ?? []) {
      expect(Object.keys(element.attributes).filter((name) => name.startsWith('on'))).toEqual([]);
    }

    const row = html.root.querySelectorAll('.supporter-row').find((li) => li.text.includes(XSS.firstName));
    expect(row?.querySelector('.supporter-row__name')?.text).toBe(`${XSS.firstName} ${XSS.lastName}`);
    expect(row?.querySelector('.supporter-row__name')?.getAttribute('href')).toBe(XSS.homepageUrl);
    expect(row?.querySelector('.supporter-row__city')?.text).toBe(XSS.city);
    expect(row?.querySelector('.supporter-row__city')?.getAttribute('href')).toBe(
      `/supporters/city/${encodeURIComponent(XSS.city)}`,
    );
  });

  it('F-07: a signed-in supporter sees the list too (requireAuth is the only guard)', async () => {
    const signedAgent = request.agent(testApp.app);
    await signIn(signedAgent, ada.id);

    const response = await signedAgent.get('/supporters');

    expect(response.status).toBe(200);
    expect(rowNames(parse(response.text))).toContain('Ada Lovelace');
  });
});
