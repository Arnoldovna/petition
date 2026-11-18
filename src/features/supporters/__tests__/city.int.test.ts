import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { profiles } from '../../../db/schema/index.js';
import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import type { Agent } from '../../../../test/forms.js';
import { parse, spoken, type Html } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';

/**
 * GET /supporters/city/:city (ROUTES.md section 6, ADR 0007) against the real app on this file's own database
 * (ADR 0017): case-insensitive matching with `pg_c_utf8`, normalisation of the parameter, encoded links, the heading
 * from the request (B-33), the empty state and pagination.
 */

const PAGE_SIZE = 50;
const T0 = Date.parse('2026-02-01T10:00:00.000Z');
const at = (minutes: number): Date => new Date(T0 + minutes * 60_000);

/** City names that broke the legacy links (B-32, ADR 0007). */
const AWKWARD_CITIES = ['Frankfurt/Main', 'Halle (Saale)', 'St. Gallen?', 'A#B&C', '100% Köln'] as const;

let testApp: TestApp;
let agent: Agent;
let minute = 0;

/** A signer with a profile in `city`, signed one minute after the previous one. */
async function signerIn(city: string, firstName: string): Promise<void> {
  const user = await createUser(testApp.db, { firstName, lastName: 'Citizen' });
  await testApp.db.insert(profiles).values({ userId: user.id, city });
  await createSignature(testApp.db, user.id, { createdAt: at(minute++) });
}

beforeAll(async () => {
  testApp = await createTestApp();
  const { db } = testApp;
  const viewer = await createUser(db, { firstName: 'Vera', lastName: 'Viewer' });
  agent = request.agent(testApp.app);
  await signIn(agent, viewer.id);

  // Three spellings of one city (ADR 0007), in signing order.
  await signerIn('München', 'Berta');
  await signerIn('MÜNCHEN', 'Dora');
  await signerIn('münchen', 'Emil');
  await signerIn('Berlin', 'Bruno');
  for (const [index, city] of AWKWARD_CITIES.entries()) await signerIn(city, `Awkward${String(index)}`);

  // Not supporters of München: a profile without a signature, and a signature without a profile (F-56, B-30).
  const unsigned = await createUser(db, { firstName: 'Paul', lastName: 'Profileonly' });
  await db.insert(profiles).values({ userId: unsigned.id, city: 'München' });
  const noProfile = await createUser(db, { firstName: 'Nina', lastName: 'Noprofile' });
  await createSignature(db, noProfile.id, { createdAt: at(minute++) });

  // 51 signers in one city for the pagination (F-59).
  for (let index = 1; index <= 51; index++) await signerIn('Köln', `Koeln${String(index).padStart(2, '0')}`);
});

afterAll(async () => {
  await testApp.close();
});

async function cityPage(path: string): Promise<Html> {
  const response = await agent.get(path);
  expect(response.status, `GET ${path}`).toBe(200);
  return parse(response.text);
}

const rowNames = (html: Html): string[] => html.texts('.supporter-list .supporter-row__name');

const cityPath = (city: string): string => `/supporters/city/${encodeURIComponent(city)}`;

describe('GET /supporters/city/:city: guards', () => {
  it('F-07: a guest is redirected to the login page with the encoded returnTo', async () => {
    const response = await request(testApp.app).get('/supporters/city/M%C3%BCnchen');

    expect(response.status).toBe(302);
    expect(response.headers['location']).toBe(`/login?returnTo=${encodeURIComponent('/supporters/city/M%C3%BCnchen')}`);
  });
});

describe('GET /supporters/city/:city: matching (ADR 0007)', () => {
  it('F-56: lists the supporters of the city in signing order, with heading, count and the link back', async () => {
    const html = await cityPage(cityPath('München'));

    expect(html.text('title')).toBe('Supporters from München · Nonsense Petition');
    expect(html.texts('h1')).toEqual(['Supporters from München']);
    expect(html.text('.page-heading__lead')).toBe('3 supporters');
    expect(rowNames(html)).toEqual(['Berta Citizen', 'Dora Citizen', 'Emil Citizen']);
    expect(html.attr('main a.page__next-link', 'href')).toBe('/supporters');
    expect(html.text('main a.page__next-link')).toBe('all supporters');
    // Exactly one link back, and it comes after the list (F-56); the empty state is not rendered.
    expect(html.root.querySelectorAll('main a[href="/supporters"]')).toHaveLength(1);
    expect(html.has('.empty-state')).toBe(false);
  });

  it.each([['MÜNCHEN'], ['münchen'], ['mÜnChEn'], ['München']])(
    'F-56, B-61: %j matches every spelling of München (pg_c_utf8, NFC)',
    async (requested) => {
      const html = await cityPage(cityPath(requested));

      expect(rowNames(html)).toEqual(['Berta Citizen', 'Dora Citizen', 'Emil Citizen']);
      // The heading is the requested value after normalisation, never a row's spelling (B-33).
      expect(html.text('h1')).toBe(`Supporters from ${requested.normalize('NFC')}`);
    },
  );

  it('F-56: rows show their own city as plain text, without a link to this page', async () => {
    const html = await cityPage(cityPath('münchen'));

    expect(html.texts('.supporter-row__city')).toEqual(['München', 'MÜNCHEN', 'münchen']);
    expect(html.has('a.supporter-row__city')).toBe(false);
  });

  it('F-56, B-30: users who have not signed, and signers without a city, are not on a city page', async () => {
    const html = await cityPage(cityPath('München'));

    expect(rowNames(html)).not.toContain('Paul Profileonly');
    expect(rowNames(html)).not.toContain('Nina Noprofile');
  });

  it.each([
    ['%20Berlin%20%20', 'leading and trailing spaces'],
    ['Berl%E2%80%8Bin', 'a zero-width space'],
    ['%E2%80%AEBerlin', 'a bidi override'],
  ])('B-32: %s (%s) is normalised like the stored city and matches Berlin', async (segment) => {
    const html = await cityPage(`/supporters/city/${segment}`);

    expect(html.text('h1')).toBe('Supporters from Berlin');
    expect(rowNames(html)).toEqual(['Bruno Citizen']);
  });
});

describe('F-57, B-32: GET /supporters/city/:city: awkward names', () => {
  it.each(AWKWARD_CITIES.map((city, index) => [city, index] as const))(
    'F-57, B-32: the list links %j with encodeURIComponent, and the link finds its supporter',
    async (city, index) => {
      const list = await cityPage('/supporters');
      // The link's text is the city after the visually hidden "supporters from " (F-84).
      const link = list.root
        .querySelectorAll('a.supporter-row__city')
        .find((anchor) => spoken(anchor) === `supporters from ${city}`);
      expect(link?.getAttribute('href')).toBe(cityPath(city));

      const html = await cityPage(link?.getAttribute('href') ?? '');
      expect(html.text('h1')).toBe(`Supporters from ${city}`);
      expect(rowNames(html)).toEqual([`Awkward${String(index)} Citizen`]);
    },
  );
});

describe('GET /supporters/city/:city: empty and invalid cities', () => {
  it('F-58, B-33: a city without supporters keeps its heading and shows the empty state with the link back', async () => {
    const html = await cityPage(cityPath('Atlantis'));

    expect(html.text('title')).toBe('Supporters from Atlantis · Nonsense Petition');
    expect(html.texts('h1')).toEqual(['Supporters from Atlantis']);
    expect(html.text('main h2.empty-state__title')).toBe('No supporters from Atlantis yet');
    expect(html.text('main .empty-state__text')).toBe(
      'Check the spelling of the city, or see everyone who has signed so far.',
    );
    expect(html.attr('main .empty-state__link', 'href')).toBe('/supporters');
    expect(html.text('main .empty-state__link')).toBe('all supporters');
    expect(html.has('.supporter-list')).toBe(false);
    expect(html.has('.page-heading__lead')).toBe(false);
    expect(html.has('nav.pagination')).toBe(false);
    // The empty state carries the one link back; the list's link is not repeated (F-58).
    expect(html.root.querySelectorAll('main a[href="/supporters"]')).toHaveLength(1);
    expect(html.has('main .page__next')).toBe(false);
  });

  it('F-53, B-33: markup in the requested city is shown as text in the heading and the empty state', async () => {
    const city = '<b onmouseover=alert(1)>Bold</b>';
    const response = await agent.get(cityPath(city));

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('<b onmouseover');
    const html = parse(response.text);
    expect(html.text('h1')).toBe(`Supporters from ${city}`);
    expect(html.text('main .empty-state__title')).toBe(`No supporters from ${city} yet`);
    expect(html.root.querySelectorAll('main b')).toHaveLength(0);
  });

  it.each([
    ['%20', 'blank'],
    ['%E2%80%8B', 'only invisible characters'],
    [encodeURIComponent('x'.repeat(101)), 'longer than 100 characters'],
  ])('ROUTES.md section 6: a %s city (%s) is the 404 page', async (segment) => {
    const response = await agent.get(`/supporters/city/${segment}`);

    expect(response.status).toBe(404);
    expect(parse(response.text).text('h1')).toBe('Page not found');
  });

  it('B-32: a city of exactly 100 characters is valid', async () => {
    const html = await cityPage(cityPath('y'.repeat(100)));

    expect(html.text('main .empty-state__title')).toBe(`No supporters from ${'y'.repeat(100)} yet`);
  });

  it('F-09: a malformed percent-encoding is a client error page, never a 500', async () => {
    const response = await agent.get('/supporters/city/%E0%A4%A');

    expect(response.status).toBe(400);
    expect(parse(response.text).text('h1')).toBe('That request could not be read');
  });
});

describe('F-59: GET /supporters/city/:city: pagination', () => {
  it('F-59, F-54: 51 supporters of one city make two pages with encoded links', async () => {
    const first = await cityPage(cityPath('köln'));

    expect(first.text('.page-heading__lead')).toBe('51 supporters');
    expect(rowNames(first)).toHaveLength(PAGE_SIZE);
    expect(first.attr('ol.supporter-list', 'start')).toBe('1');
    expect(first.text('nav.pagination .pagination__status')).toBe('page 1 of 2');
    expect(first.text('nav.pagination [aria-current="page"]')).toBe('page 1');
    expect(first.attr('nav.pagination a[aria-current="page"]', 'href')).toBe(cityPath('köln'));
    expect(first.attr('nav.pagination a[rel="next"]', 'href')).toBe(`${cityPath('köln')}?page=2`);

    const second = await cityPage(`${cityPath('köln')}?page=2`);
    expect(second.text('title')).toBe('Supporters from köln, page 2 · Nonsense Petition');
    expect(second.attr('ol.supporter-list', 'start')).toBe('51');
    expect(rowNames(second)).toEqual(['Koeln51 Citizen']);
    expect(second.attr('nav.pagination a[rel="prev"]', 'href')).toBe(cityPath('köln'));
    // The link back to all supporters follows the pagination on every page (F-56).
    expect(second.attr('main a.page__next-link', 'href')).toBe('/supporters');
  });

  it.each([['3'], ['0'], ['x']])('F-59, ADR 0006: ?page=%j on a city page is the 404 page', async (value) => {
    const response = await agent.get(`${cityPath('Köln')}?page=${value}`);

    expect(response.status).toBe(404);
  });

  it('F-59: page 2 of a city without supporters is the 404 page', async () => {
    const response = await agent.get(`${cityPath('Atlantis')}?page=2`);

    expect(response.status).toBe(404);
  });
});
