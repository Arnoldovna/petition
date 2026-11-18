import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../test/auth.js';
import { createUser } from '../../test/factories.js';
import { parse } from '../../test/html.js';
import { createTestApp, type TestApp } from '../../test/test-app.js';
import { resolvePaths } from '../config/paths.js';

/**
 * Security headers, cookies and compression of the real app under `NODE_ENV=production` (ADR 0010, ADR 0011, F-71,
 * B-10, B-16), in both positions of the one "served over https" switch:
 *
 * - `COOKIE_SECURE=true` (and unset, the production default): HSTS, `upgrade-insecure-requests`, secure `__Host-`
 *   cookies. Behind the TLS-terminating proxy the app sees `X-Forwarded-Proto: https`, so these apps trust one proxy
 *   hop; express-session only sends a secure cookie over a secure connection.
 * - `COOKIE_SECURE=false` (the local compose stack over plain http): neither HSTS nor UIR, plain cookie names.
 *
 * Dynamic HTML is never compressed (BREACH: it carries the CSRF token next to reflected input); generated assets are.
 */

/** The CSP of ADR 0011 without the https-only directive, as a directive -> sources map. */
const BASE_CSP: Readonly<Record<string, string>> = {
  'default-src': "'self'",
  'script-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self'",
  'font-src': "'self'",
  'connect-src': "'self'",
  'form-action': "'self'",
  'frame-ancestors': "'none'",
  'base-uri': "'none'",
  'object-src': "'none'",
  'manifest-src': "'self'",
};

function cspOf(response: Response): Record<string, string> {
  const header = response.headers['content-security-policy'];
  expect(typeof header).toBe('string');
  return Object.fromEntries(
    String(header)
      .split(';')
      .map((directive) => directive.trim())
      .filter((directive) => directive.length > 0)
      .map((directive) => {
        const [name = '', ...sources] = directive.split(/\s+/);
        return [name, sources.join(' ')];
      }),
  );
}

interface Cookie {
  name: string;
  attributes: Map<string, string>;
}

function cookiesOf(response: Response): Cookie[] {
  const header: unknown = response.headers['set-cookie'];
  const lines = Array.isArray(header) ? header.map(String) : [];
  return lines.map((line) => {
    const [pair = '', ...attributes] = line.split(';').map((part) => part.trim());
    return {
      name: pair.slice(0, pair.indexOf('=')),
      attributes: new Map(
        attributes.map((attribute) => {
          const [key = '', value = ''] = attribute.split('=');
          return [key.toLowerCase(), value];
        }),
      ),
    };
  });
}

/** The headers every dynamic HTML response carries in both switch positions (ADR 0011, ROUTES.md section 1). */
function expectBaseHeaders(response: Response): void {
  expect(response.headers['x-powered-by']).toBeUndefined();
  expect(response.headers['x-content-type-options']).toBe('nosniff');
  expect(response.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(response.headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
  expect(response.headers['x-frame-options']).toBe('DENY');
  expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['x-request-id']).toMatch(/^[\w-]{8,128}$/);
}

/** Session and CSRF cookie: httpOnly, SameSite=Lax, path `/`, no Domain (conventions §8, ADR 0002, ADR 0003). */
function expectAppCookies(response: Response, { secure }: { secure: boolean }): void {
  const prefix = secure ? '__Host-petition.' : 'petition.';
  const cookies = cookiesOf(response);
  expect(cookies.map(({ name }) => name).sort()).toEqual([`${prefix}sid`, `${prefix}x-csrf-token`]);
  for (const { attributes } of cookies) {
    expect(attributes.has('httponly')).toBe(true);
    expect(attributes.get('samesite')?.toLowerCase()).toBe('lax');
    expect(attributes.get('path')).toBe('/');
    expect(attributes.has('domain')).toBe(false);
    expect(attributes.has('secure')).toBe(secure);
  }
}

const HTTPS_POSITIONS = [
  { position: 'COOKIE_SECURE=true', env: { NODE_ENV: 'production', COOKIE_SECURE: 'true' } },
  { position: 'COOKIE_SECURE unset (production default)', env: { NODE_ENV: 'production' } },
] as const;

describe.each(HTTPS_POSITIONS)('NODE_ENV=production, $position: served over https', ({ env }) => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env, trustProxy: 1 });
  });

  afterAll(async () => {
    await testApp.close();
  });

  const overHttps = (path: string) => request(testApp.app).get(path).set('X-Forwarded-Proto', 'https');

  it('F-71, B-10: the strict CSP with upgrade-insecure-requests, HSTS and the other security headers', async () => {
    const response = await overHttps('/login').expect(200);

    expectBaseHeaders(response);
    expect(cspOf(response)).toEqual({ ...BASE_CSP, 'upgrade-insecure-requests': '' });
    const maxAge = Number(/max-age=(\d+)/.exec(String(response.headers['strict-transport-security']))?.[1]);
    expect(maxAge).toBeGreaterThanOrEqual(180 * 24 * 60 * 60);
  });

  it('F-28, ADR 0011: session and CSRF cookies are secure and carry the __Host- prefix', async () => {
    expectAppCookies(await overHttps('/login').expect(200), { secure: true });
  });
});

describe('NODE_ENV=production, COOKIE_SECURE=false: the local stack over plain http', () => {
  let testApp: TestApp;

  beforeAll(async () => {
    testApp = await createTestApp({ env: { NODE_ENV: 'production', COOKIE_SECURE: 'false' } });
  });

  afterAll(async () => {
    await testApp.close();
  });

  it('F-71, B-10: the same strict CSP without upgrade-insecure-requests, and no HSTS', async () => {
    const response = await request(testApp.app).get('/login').expect(200);

    expectBaseHeaders(response);
    // WebKit applies UIR to 127.0.0.1 too and would load the assets over https (ADR 0011).
    expect(cspOf(response)).toEqual(BASE_CSP);
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('F-28, ADR 0011: cookies have the plain app-scoped names and no Secure flag', async () => {
    expectAppCookies(await request(testApp.app).get('/login').expect(200), { secure: false });
  });

  it('F-71, B-10: error pages carry the same headers (404)', async () => {
    const response = await request(testApp.app).get('/no-such-page').expect(404);

    expectBaseHeaders(response);
    expect(cspOf(response)).toEqual(BASE_CSP);
  });
});

describe('compression and third-party resources (NODE_ENV=production)', () => {
  let testApp: TestApp;
  /** A generated stylesheet for this file only, well above compression's 1 kB threshold. */
  const assetName = `headers-int-${randomUUID()}.css`;
  /** This file's own generated-asset folder (`builtPublicDir`), so it never touches `.dev/public`. */
  let builtPublicDir: string;

  beforeAll(async () => {
    builtPublicDir = mkdtempSync(join(tmpdir(), 'petition-headers-'));
    mkdirSync(join(builtPublicDir, 'assets'));
    writeFileSync(join(builtPublicDir, 'assets', assetName), `.headers-test { content: "${'x'.repeat(8192)}"; }\n`);
    testApp = await createTestApp({
      env: { NODE_ENV: 'production', COOKIE_SECURE: 'false' },
      paths: { ...resolvePaths('development'), builtPublicDir },
    });
  });

  afterAll(async () => {
    await testApp.close();
    rmSync(builtPublicDir, { recursive: true, force: true });
  });

  const withEncoding = (path: string) => request(testApp.app).get(path).set('Accept-Encoding', 'gzip, deflate, br');

  async function signedInAgent() {
    const user = await createUser(testApp.db);
    const agent = request.agent(testApp.app);
    await signIn(agent, user.id);
    return agent;
  }

  it('B-10, ADR 0010: dynamic HTML is never compressed, with or without a CSRF token in it', async () => {
    const agent = await signedInAgent();
    const pages = [
      await withEncoding('/'),
      await withEncoding('/login'),
      await withEncoding('/no-such-page'),
      await agent.get('/supporters').set('Accept-Encoding', 'gzip, deflate, br'),
    ];

    for (const page of pages) {
      expect(page.headers['content-type']).toMatch(/^text\/html/);
      expect(page.text.length).toBeGreaterThan(1024); // large enough that compression would apply
      expect(page.headers['content-encoding']).toBeUndefined();
    }
    // The pages that carry a token really do (the signed-in header and the login form).
    expect(parse(pages[1]?.text ?? '').has('input[name="_csrf"]')).toBe(true);
    expect(parse(pages[3]?.text ?? '').has('form[action="/logout"] input[name="_csrf"]')).toBe(true);
  });

  it('B-59, ADR 0010: generated assets are compressed, carry the security headers and never set a cookie', async () => {
    const response = await withEncoding(`/assets/${assetName}`).expect(200);

    expect(response.headers['content-type']).toMatch(/^text\/css/);
    expect(['gzip', 'br', 'deflate']).toContain(response.headers['content-encoding']);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('ADR 0010: the HTML 404 page of a missing asset stays uncompressed', async () => {
    const response = await withEncoding(`/assets/missing-${randomUUID()}.css`).expect(404);

    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('B-16, F-71, F-86: every page loads its scripts, styles, fonts and icons from the app itself', async () => {
    const agent = await signedInAgent();
    for (const response of [await withEncoding('/'), await withEncoding('/login'), await agent.get('/supporters')]) {
      const page = parse(response.text);
      const urls = [
        ...page.root.querySelectorAll('script').map((element) => element.getAttribute('src') ?? ''),
        ...page.root.querySelectorAll('link').map((element) => element.getAttribute('href') ?? ''),
        ...page.root.querySelectorAll('img').map((element) => element.getAttribute('src') ?? ''),
      ];

      expect(urls.length).toBeGreaterThan(0);
      for (const url of urls) expect(url).toMatch(/^\/(?!\/)/); // same-origin paths, never //host or https://
      expect(page.root.querySelectorAll('script:not([src])')).toHaveLength(0); // no inline script (CSP)
      expect(response.text).not.toMatch(/fonts\.googleapis|fonts\.gstatic|code\.jquery/);
    }
  });
});
