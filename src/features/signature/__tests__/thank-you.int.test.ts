import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import type { Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { drawnSignature } from './fakes.js';

/**
 * `GET /thank-you` and the private image route `GET /signature/image.png` (F-46 to F-48, ADR 0004 item 6). The count
 * comes from a fake `countSupporters` (createTestApp); that it equals the supporters list total (F-47) is asserted
 * with the real modules in phase 2b.
 */

let testApp: TestApp;
/** What the fake `countSupporters` returns; a test may change it, and every test starts again from 1. */
let supporters = 1;

beforeAll(async () => {
  testApp = await createTestApp({ countSupporters: () => Promise.resolve(supporters) });
});

// Reset before each test, not after a change: a failing assertion would otherwise leave its count for the next test.
beforeEach(() => {
  supporters = 1;
});

afterAll(async () => {
  await testApp.close();
});

/** Each signer gets its own image (a different number of ink pixels), so a leak between users would show. */
async function signer(inkPixels?: number): Promise<{ agent: Agent; image: Buffer }> {
  const user = await createUser(testApp.db);
  const image = await drawnSignature(inkPixels === undefined ? {} : { inkPixels });
  await createSignature(testApp.db, user.id, { image });
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { agent, image };
}

async function unsignedAgent(): Promise<Agent> {
  const user = await createUser(testApp.db);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return agent;
}

describe('GET /thank-you', () => {
  it('F-46: thanks the signer, shows the own signature and links to the list and the delete step', async () => {
    const { agent } = await signer();

    const response = await agent.get('/thank-you').expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    const page = parse(response.text);
    expect(page.text('title')).toBe('Thank you · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['Thank you for your signature']);
    expect(page.text('.page-heading__lead')).toBe('Your name is now on the supporters list.');
    const image = page.root.querySelector('.signature-frame img');
    expect(image?.getAttribute('src')).toBe('/signature/image.png');
    expect(image?.getAttribute('alt')).toBe('Your signature');
    expect([image?.getAttribute('width'), image?.getAttribute('height')]).toEqual(['720', '240']);
    const links = page.root
      .querySelectorAll('.row-list a')
      .map((link) => [link.text.trim(), link.getAttribute('href')]);
    expect(links).toEqual([
      ['see all supporters', '/supporters'],
      ['delete signature', '/signature/delete'],
    ]);
    // Each row has its title only: no meta of the page leaks into a row (list-row partial).
    expect(page.has('.row-list .list-row__meta')).toBe(false);
  });

  it('F-46, F-84, B-67: the thanks, the signature, the count and the next steps come in reading order', async () => {
    const { agent } = await signer();
    supporters = 64;

    const page = parse((await agent.get('/thank-you').expect(200)).text);

    // querySelectorAll('*') lists the elements of main in document order.
    const inOrder = page.root.querySelectorAll('main *');
    const positions = ['h1', '.signature-frame', '.supporter-count', '.row-list'].map((selector) => {
      const element = page.root.querySelector(`main ${selector}`);
      return element === null ? -1 : inOrder.indexOf(element);
    });
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);

    // The image is content with its own text alternative, never decoration, and the only image on the page (F-84).
    expect(page.root.querySelectorAll('main img').map((img) => img.getAttribute('alt'))).toEqual(['Your signature']);
    // Number and word are separate elements, so the number can be the display-size figure (OVERVIEW.md 15.4).
    expect(page.text('.supporter-count__number')).toBe('64');
    expect(page.text('.supporter-count__label')).toBe('supporters');
    // The next steps are text links that name their destination; none is an icon (F-84, B-69).
    expect(page.texts('main .row-list a')).toEqual(['see all supporters', 'delete signature']);
    expect(page.has('main .row-list svg, main .row-list img')).toBe(false);
  });

  it('F-46, B-75: shows the supporter count with correct pluralisation and grouping', async () => {
    const { agent } = await signer();

    for (const [count, text] of [
      [1, '1 supporter'],
      [2, '2 supporters'],
      [1284, '1,284 supporters'],
    ] as const) {
      supporters = count;
      const page = parse((await agent.get('/thank-you').expect(200)).text);

      expect(page.text('.supporter-count')).toBe(text);
    }
  });

  it('F-71, ADR 0004 item 7: the page needs no data: URL; the CSP allows images from self only', async () => {
    const { agent } = await signer();

    const response = await agent.get('/thank-you').expect(200);

    expect(response.headers['content-security-policy']).toMatch(/(^|;)\s*img-src 'self'(;|$)/);
    expect(response.text).not.toContain('data:image');
  });

  it('F-48, B-07: a viewer without a signature is sent to the sign page; a guest to the login page', async () => {
    await (await unsignedAgent()).get('/thank-you').expect(302).expect('location', '/signature');
    await request(testApp.app).get('/thank-you').expect(302).expect('location', '/login?returnTo=%2Fthank-you');
  });
});

describe('GET /signature/image.png', () => {
  it("ADR 0004 item 6, F-71: serves exactly the viewer's own stored bytes as a private PNG", async () => {
    const first = await signer();
    const second = await signer(400);

    for (const { agent, image } of [first, second]) {
      const response = await agent.get('/signature/image.png').buffer(true).expect(200);

      expect(Buffer.from(response.body as Buffer).equals(image)).toBe(true);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['content-length']).toBe(String(image.length));
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['etag']).toBeUndefined();
    }
    expect(first.image.equals(second.image)).toBe(false);
  });

  it('ADR 0004 item 6: a HEAD request gets the headers without the image', async () => {
    const { agent, image } = await signer();

    const response = await agent.head('/signature/image.png').expect(200);

    expect(response.headers['content-length']).toBe(String(image.length));
    expect(response.headers['content-type']).toBe('image/png');
  });

  it('F-48, B-07: a viewer without a signature gets the 404 page, never a redirect or a broken image', async () => {
    const response = await (await unsignedAgent()).get('/signature/image.png');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(parse(response.text).text('h1')).toBe('Page not found');
  });

  it('F-07, F-30: a guest is sent to the login page', async () => {
    await request(testApp.app)
      .get('/signature/image.png')
      .expect(302)
      .expect('location', '/login?returnTo=%2Fsignature%2Fimage.png');
  });
});
