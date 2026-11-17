import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import type { Agent } from '../../../../test/forms.js';
import { parse, spoken, type Html } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';

/**
 * The pagination markup of GET /supporters with gaps (F-54, B-67, ADR 0006), on this file's own database (ADR 0017).
 * 251 signers make six pages of 50, the smallest list whose first and last pages hide page numbers behind an
 * ellipsis ("1 2 3 … 6"). The window rules themselves are unit-tested in `shared/http/__tests__/pagination.test.ts`;
 * this file checks what the partial renders for them.
 */

const SIGNERS = 251;
const LAST_PAGE = 6;
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

let testApp: TestApp;
let agent: Agent;

beforeAll(async () => {
  testApp = await createTestApp();
  const { db } = testApp;
  const viewer = await createUser(db, { firstName: 'Vera', lastName: 'Viewer' });
  agent = request.agent(testApp.app);
  await signIn(agent, viewer.id);

  for (let index = 1; index <= SIGNERS; index++) {
    const signer = await createUser(db, { firstName: 'Signer', lastName: String(index).padStart(3, '0') });
    await createSignature(db, signer.id, { createdAt: new Date(T0 + index * 60_000) });
  }
});

afterAll(async () => {
  await testApp.close();
});

async function listPage(path: string): Promise<Html> {
  const response = await agent.get(path);
  expect(response.status, `GET ${path}`).toBe(200);
  return parse(response.text);
}

/** The announced text of every item of the pagination list, in order. */
const items = (html: Html): string[] =>
  html.root.querySelectorAll('nav.pagination .pagination__item').map((item) => spoken(item));

describe('GET /supporters: pagination with gaps (F-54)', () => {
  it('F-54, B-67: the first page shows 1 2 3, a gap announced as "more pages", the last page and next', async () => {
    const html = await listPage('/supporters');

    expect(html.text('nav.pagination .pagination__status')).toBe(`page 1 of ${String(LAST_PAGE)}`);
    expect(items(html)).toEqual(['page 1', 'page 2', 'page 3', 'more pages', 'page 6', 'next page']);
    // The gap is no link, and its ellipsis character is hidden from assistive technology.
    const gap = html.root.querySelector('.pagination__item--gap');
    expect(gap?.querySelector('a')).toBeNull();
    expect(gap?.querySelector('[aria-hidden="true"]')?.text).toBe('…');
    expect(html.attr('nav.pagination a[aria-current="page"]', 'href')).toBe('/supporters');
  });

  it('F-54: the last page shows previous, the first page, a gap and its neighbours, and no next link', async () => {
    const html = await listPage(`/supporters?page=${String(LAST_PAGE)}`);

    expect(html.text('nav.pagination .pagination__status')).toBe(`page ${String(LAST_PAGE)} of ${String(LAST_PAGE)}`);
    expect(items(html)).toEqual(['previous page', 'page 1', 'more pages', 'page 4', 'page 5', 'page 6']);
    expect(html.has('nav.pagination a[rel="next"]')).toBe(false);
    expect(html.attr('nav.pagination a[rel="prev"]', 'href')).toBe('/supporters?page=5');
    // Numbering continues across pages: the one row of page 6 is item 251 (F-54).
    expect(html.attr('ol.supporter-list', 'start')).toBe('251');
    expect(html.texts('.supporter-list .supporter-row__name')).toEqual(['Signer 251']);
  });

  it('F-54: a page in the middle shows every number when no gap would hide one', async () => {
    const html = await listPage('/supporters?page=3');

    expect(items(html)).toEqual([
      'previous page',
      'page 1',
      'page 2',
      'page 3',
      'page 4',
      'page 5',
      'page 6',
      'next page',
    ]);
    expect(html.has('.pagination__item--gap')).toBe(false);
  });

  it('F-54, F-84: every link has a text name and a canonical href; aria-current marks exactly one', async () => {
    for (let page = 1; page <= LAST_PAGE; page++) {
      const html = await listPage(page === 1 ? '/supporters' : `/supporters?page=${String(page)}`);
      const links = html.root.querySelectorAll('nav.pagination a');

      for (const link of links) {
        expect(spoken(link)).toMatch(/^(previous page|next page|page [1-6])$/);
        // Page 1 is the bare path, never a `?page=1` duplicate (ADR 0006).
        expect(link.getAttribute('href')).toMatch(/^\/supporters(\?page=[2-6])?$/);
      }
      expect(html.root.querySelectorAll('nav.pagination [aria-current]')).toHaveLength(1);
      expect(html.text('nav.pagination [aria-current="page"]')).toBe(`page ${String(page)}`);
      // Only the arrows and the ellipsis are hidden, and each of them has spoken words next to it.
      for (const hidden of html.root.querySelectorAll('nav.pagination [aria-hidden="true"]')) {
        expect(['←', '→', '…']).toContain(hidden.text);
      }
    }
  });
});
