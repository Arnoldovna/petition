import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { signIn } from '../../test/auth.js';
import { createSignature, createUser, type TestUser } from '../../test/factories.js';
import { createFakeHasher } from '../../test/fakes.js';
import { getForm, postForm, type Agent } from '../../test/forms.js';
import { parse, type Html } from '../../test/html.js';
import { createTestApp, type TestApp } from '../../test/test-app.js';
import type { PasswordHasher } from '../shared/auth/password.js';

/**
 * Error pages and flash messages across modules (ROUTES.md section 8, ADR 0008; F-08, F-09, F-17, B-13, B-20, B-43):
 * the styled 404 instead of a redirect, real files for the icons the layout links, the generic 500 page for an
 * exploding dependency and for a real database error (no stack, no SQL, no hang), the signed-in navigation with a
 * working token on the 413, 429 and CSRF 403 pages, and a flash that survives requests which only redirect.
 */

let testApp: TestApp;

beforeAll(async () => {
  // One re-authentication per 15 minutes, so the second attempt is the 429 page (ADR 0012 limits are asserted in
  // rate-limits.int.test.ts; here only the page matters).
  testApp = await createTestApp({ rateLimits: { reauthPer15Min: 1 } });
});

afterAll(async () => {
  await testApp.close();
});

/** The fields of public/site.webmanifest the icon checks read (W3C Web App Manifest). */
const WebManifest = z.object({
  name: z.string(),
  start_url: z.string(),
  lang: z.string(),
  icons: z.array(z.object({ src: z.string(), sizes: z.string(), type: z.string() })),
});

/** `<width>x<height>` from a PNG's IHDR chunk (bytes 16 to 23, big endian), or `not a PNG`. */
function pngSize(bytes: Buffer): string {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return 'not a PNG';
  return `${String(bytes.readUInt32BE(16))}x${String(bytes.readUInt32BE(20))}`;
}

/** Every request must be answered quickly; a hanging request (B-20) fails here instead of at the test timeout. */
const ANSWER_WITHIN_MS = 5_000;

interface Member {
  user: TestUser;
  agent: Agent;
  csrf: string;
}

async function member({ signed = false }: { signed?: boolean } = {}): Promise<Member> {
  const user = await createUser(testApp.db);
  if (signed) await createSignature(testApp.db, user.id);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { user, agent, csrf: (await getForm(agent, '/', 'form[action="/logout"]')).csrf };
}

/** No stack frame, no error class, no SQL and no library message ever reaches the client (F-09, B-13). */
function expectNoInternals(response: Response): void {
  expect(response.text).not.toMatch(/\bat \S+ \(|\.ts:\d+|node_modules|Error:|stack/i);
  expect(response.text).not.toMatch(
    /\b(select|insert|update|delete from|relation|column)\b.*\b(from|does not exist)\b/i,
  );
}

/** The error page of ROUTES.md section 8: status, one h1 with its text, and the next-step link. */
function expectErrorPage(response: Response, status: number, heading: string, next: string): Html {
  expect(response.status).toBe(status);
  expect(response.headers['content-type']).toMatch(/^text\/html/);
  expect(response.headers['location']).toBeUndefined();
  const page = parse(response.text);
  expect(page.texts('h1')).toEqual([heading]);
  expect(page.attr('main .page__next-link', 'href')).toBe(next);
  expect(page.has('header.site-header')).toBe(true);
  expect(page.has('footer')).toBe(true);
  expectNoInternals(response);
  return page;
}

/** The signed-in navigation (F-14) with a token the visitor can really use: it logs them out. */
async function expectSignedInNavigation(page: Html, agent: Agent): Promise<void> {
  expect(page.has('.site-header a[href="/supporters"]')).toBe(true);
  expect(page.has('.site-header a[href="/login"]')).toBe(false);
  const token = page.attr('form[action="/logout"] input[name="_csrf"]', 'value') ?? '';
  expect(token).not.toBe('');
  await postForm(agent, '/logout', { _csrf: token }).expect(303).expect('Location', '/');
}

describe('404', () => {
  it('F-08, B-43: an unknown path is the styled 404 page with a link home, never a redirect', async () => {
    const guest = await request(testApp.app).get(`/no-such-page-${randomUUID()}`).timeout(ANSWER_WITHIN_MS);
    const page = expectErrorPage(guest, 404, 'Page not found', '/');

    expect(page.has('.site-header a[href="/login"]')).toBe(true);
    // A guest's 404 page creates no session (ADR 0003).
    expect(guest.headers['set-cookie']).toBeUndefined();
  });

  it('F-08, F-14: a signed-in visitor keeps the signed-in navigation on the 404 page', async () => {
    const { agent } = await member();

    const page = expectErrorPage(await agent.get('/no-such-page'), 404, 'Page not found', '/');

    await expectSignedInNavigation(page, agent);
  });

  it('B-43: the icons and manifest the layout links are real files; legacy icon names are 404, not HTML redirects', async () => {
    const layout = parse((await request(testApp.app).get('/').expect(200)).text);
    const linked = layout.root
      .querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')
      .map((link) => link.getAttribute('href') ?? '');
    expect(linked.sort()).toEqual(['/apple-touch-icon.png', '/favicon.svg', '/site.webmanifest']);

    for (const path of [...linked, '/robots.txt']) {
      const response = await request(testApp.app).get(path).expect(200);
      expect(response.headers['content-type']).not.toMatch(/^text\/html/);
    }
    for (const path of ['/apple-icon-57x57.png', '/favicon-32x32.png', '/ms-icon-144x144.png', '/manifest.json']) {
      const response = await request(testApp.app).get(path).expect(404);
      expect(response.headers['location']).toBeUndefined();
    }
  });

  it('B-43: the manifest names the site and lists only real icons, each of the declared type and pixel size', async () => {
    const manifest = WebManifest.parse((await request(testApp.app).get('/site.webmanifest').expect(200)).body);

    expect(manifest).toMatchObject({ name: 'Nonsense Petition', start_url: '/', lang: 'en' });
    expect(manifest.icons.map(({ src }) => src)).toEqual(['/favicon.svg', '/apple-touch-icon.png', '/icon-512.png']);
    for (const icon of manifest.icons) {
      // Supertest buffers every image/* body (SVG included) as raw bytes.
      const response = await request(testApp.app).get(icon.src).expect(200);
      expect(response.headers['content-type']?.split(';')[0], icon.src).toBe(icon.type);
      const body: unknown = response.body;
      if (!Buffer.isBuffer(body)) throw new TypeError(`${icon.src}: expected a binary body`);
      if (icon.type === 'image/png') {
        expect(pngSize(body), icon.src).toBe(icon.sizes);
      } else {
        // The vector source of the PNGs (scripts/generate-icons.mjs): a square drawing that needs no font, no
        // embedded image and nothing from another origin (comments left out, they may mention such things).
        const drawing = body.toString('utf8').replaceAll(/<!--[\s\S]*?-->/g, '');
        expect(drawing, icon.src).toMatch(/<svg[^>]+viewBox="0 0 32 32"/);
        expect(drawing, icon.src).not.toMatch(/<text\b|<image\b|https?:\/\/(?!www\.w3\.org\/2000\/svg")/);
      }
    }
  });
});

describe('500', () => {
  const SECRET_DETAIL = 'hasher exploded at /srv/app/secret-path';

  /** The fake hasher, except that `verify` fails like a broken native module would. */
  function explodingHasher(): PasswordHasher {
    const fake = createFakeHasher();
    return {
      hash: (plain) => fake.hash(plain),
      verify: () => Promise.reject(new Error(SECRET_DETAIL)),
      needsRehash: (hash) => fake.needsRehash(hash),
    };
  }

  let broken: TestApp;

  beforeAll(async () => {
    broken = await createTestApp({ hasher: explodingHasher() });
  });

  afterAll(async () => {
    await broken.close();
  });

  async function failedLogin(accept?: string): Promise<Response> {
    const user = await createUser(broken.db);
    const agent = request.agent(broken.app);
    const { csrf } = await getForm(agent, '/login');
    const call = postForm(agent, '/login', { _csrf: csrf, email: user.email, password: user.password });
    return (accept === undefined ? call : call.set('Accept', accept)).timeout(ANSWER_WITHIN_MS);
  }

  it('F-09, B-13: an unexpected error is the generic 500 page without the message or a stack', async () => {
    const response = await failedLogin();

    expectErrorPage(response, 500, 'Something went wrong', '/');
    expect(response.text).not.toContain(SECRET_DETAIL);
    expect(response.text).not.toContain('secret-path');
  });

  it('F-09, B-13: a client that does not accept HTML gets a generic problem+json 500', async () => {
    const response = await failedLogin('application/json');

    expect(response.status).toBe(500);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ status: 500 });
    expect(JSON.stringify(response.body)).not.toMatch(/secret-path|exploded|stack|\bat \S+ \(/);
  });
});

describe('B-20: a failing database query is answered, never left hanging', () => {
  /** Renames a table for the duration of `run` in this file's own database, so every query on it fails for real. */
  async function withoutTable(table: 'signatures' | 'profiles', run: () => Promise<void>): Promise<void> {
    const hidden = `${table}_hidden_${randomUUID().replaceAll('-', '')}`;
    await testApp.db.execute(sql`ALTER TABLE ${sql.identifier(table)} RENAME TO ${sql.identifier(hidden)}`);
    try {
      await run();
    } finally {
      await testApp.db.execute(sql`ALTER TABLE ${sql.identifier(hidden)} RENAME TO ${sql.identifier(table)}`);
    }
  }

  it('B-20, F-09: a page whose query fails is the 500 page without SQL', async () => {
    const { agent } = await member();

    await withoutTable('signatures', async () => {
      const response = await agent.get('/supporters').timeout(ANSWER_WITHIN_MS);

      expectErrorPage(response, 500, 'Something went wrong', '/');
      expect(response.text).not.toMatch(/signatures_hidden|does not exist/);
    });
  });

  it('B-20, F-09: a form whose write fails is the 500 page, and the app answers normally again afterwards', async () => {
    const { agent, csrf } = await member();

    await withoutTable('profiles', async () => {
      const response = await postForm(agent, '/profile', {
        _csrf: csrf,
        age: '36',
        city: 'Bonn',
        homepage: '',
      }).timeout(ANSWER_WITHIN_MS);

      expectErrorPage(response, 500, 'Something went wrong', '/');
      expect(response.text).not.toMatch(/profiles_hidden|does not exist/);
    });
    await postForm(agent, '/profile', { _csrf: csrf, age: '36', city: 'Bonn', homepage: '' })
      .expect(303)
      .expect('Location', '/signature');
  });
});

describe('signed-in navigation on 413, 429 and 403', () => {
  it('F-09, B-13: a signature body above 128 kb is the 413 page with the signed-in navigation', async () => {
    const { agent, csrf } = await member();

    const response = await postForm(agent, '/signature', {
      _csrf: csrf,
      method: 'drawn',
      signature: `data:image/png;base64,${'A'.repeat(200 * 1024)}`,
    }).timeout(ANSWER_WITHIN_MS);

    const page = expectErrorPage(response, 413, 'That was too much data', '/signature');
    await expectSignedInNavigation(page, agent);
  });

  it('F-09, B-13: any other form above 16 kb is the 413 page too', async () => {
    const { agent, csrf } = await member();

    const response = await postForm(agent, '/profile', {
      _csrf: csrf,
      age: '',
      city: 'x'.repeat(20 * 1024),
      homepage: '',
    });

    const page = expectErrorPage(response, 413, 'That was too much data', '/signature');
    await expectSignedInNavigation(page, agent);
  });

  it('F-09, F-26: the 429 page keeps the signed-in navigation and names the wait in Retry-After', async () => {
    const { agent, csrf } = await member();
    await postForm(agent, '/account/delete', { _csrf: csrf, currentPassword: 'wrong guess' }).expect(422);

    const response = await postForm(agent, '/account/delete', { _csrf: csrf, currentPassword: 'wrong guess' });

    const page = expectErrorPage(response, 429, 'Too many attempts', '/');
    expect(Number(response.headers['retry-after'])).toBeGreaterThan(0);
    await expectSignedInNavigation(page, agent);
  });

  it('F-09, F-70, B-13: the CSRF 403 page keeps the signed-in navigation with a fresh, working token', async () => {
    const { agent } = await member();

    const response = await postForm(agent, '/profile', { age: '36', city: 'Bonn', homepage: '' });

    const page = expectErrorPage(response, 403, 'This form has expired', '/');
    await expectSignedInNavigation(page, agent);
  });

  it('B-13: a body in an unsupported charset is the "could not be read" page, not a library message', async () => {
    const { agent, csrf } = await member();

    const response = await agent
      .post('/profile')
      .set('Content-Type', 'application/x-www-form-urlencoded; charset=koi8-r')
      .send(`_csrf=${encodeURIComponent(csrf)}&age=36`)
      .timeout(ANSWER_WITHIN_MS);

    const page = expectErrorPage(response, 415, 'That request could not be read', '/');
    expect(response.text).not.toMatch(/unsupported charset|koi8/i);
    await expectSignedInNavigation(page, agent);
  });
});

describe('flash messages survive requests that only redirect', () => {
  const flashOf = (response: Response): string | undefined =>
    parse(response.text).text('[role="status"] .flash__message');

  it('F-17, F-49: the confirmation of a deleted signature waits through redirects and HEAD, then shows once', async () => {
    const signer = await member({ signed: true });
    const confirm = await getForm(signer.agent, '/signature/delete');
    await postForm(signer.agent, '/signature/delete', { _csrf: confirm.csrf })
      .expect(303)
      .expect('Location', '/signature');

    // Only redirects and a body-less HEAD: none of them renders a page, so none takes the flash (ADR 0008).
    await signer.agent.get('/thank-you').expect(302).expect('Location', '/signature');
    await signer.agent.get('/login').expect(302).expect('Location', '/signature');
    await signer.agent.get('/home').expect(301);
    await signer.agent.head('/signature').expect(200);

    expect(flashOf(await signer.agent.get('/signature').expect(200))).toBe('Your signature was removed');
    expect(flashOf(await signer.agent.get('/signature').expect(200))).toBeUndefined();
  });

  it('F-17, F-25: "You are logged out" survives the guard redirect of a guarded page and shows on the next page', async () => {
    const { agent, csrf } = await member();
    await postForm(agent, '/logout', { _csrf: csrf }).expect(303).expect('Location', '/');

    await agent.get('/supporters').expect(302).expect('Location', '/login?returnTo=%2Fsupporters');

    expect(flashOf(await agent.get('/').expect(200))).toBe('You are logged out');
    expect(flashOf(await agent.get('/').expect(200))).toBeUndefined();
  });
});
