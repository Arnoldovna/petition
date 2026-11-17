import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import cookieParser from 'cookie-parser';
import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import session from 'express-session';
import { parse } from 'node-html-parser';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { resolvePaths } from '../../../config/paths.js';
import { setFlash } from '../../http/flash.js';
import { createLogger, createRequestLogger } from '../../logging/logger.js';
import { bindAnonymousSession, createCsrf, csrfCookieName } from '../../security/csrf.js';
import { endSession, establishSession, type SessionPolicy } from '../../security/session.js';
import { createAssetResolver } from '../assets.js';
import { configureViewEngine } from '../engine.js';
import { viewLocals } from '../locals.js';
import { renderPage } from '../render.js';

/** A fresh random secret per run: tests never commit secret-shaped literals (gitleaks, ADR 0011). */
const testSecret = (): string => randomBytes(32).toString('base64url');

/**
 * renderPage between real Express, express-session (memory store; the Redis store is covered by session.int.test.ts),
 * the real csrf-csrf setup and the real view engine. A minimal layout prints exactly what renderPage adds, so every
 * assertion reads one element. The last block renders the real layout with viewLocals.
 */

let viewsDir: string;

beforeAll(() => {
  viewsDir = mkdtempSync(join(tmpdir(), 'petition-views-'));
  for (const folder of ['layouts', 'partials', 'pages']) mkdirSync(join(viewsDir, folder));
  writeFileSync(
    join(viewsDir, 'layouts', 'main.hbs'),
    [
      '<title>{{title}}</title>',
      '<p id="viewer">{{viewer.firstName}}</p>',
      '<p id="flash">{{flash.message}}</p>',
      '<form method="post"><input type="hidden" name="_csrf" value="{{csrfToken}}"></form>',
      '{{{body}}}',
    ].join('\n'),
  );
  writeFileSync(join(viewsDir, 'pages', 'probe.hbs'), '<p id="note">{{note}}</p>');
  writeFileSync(join(viewsDir, 'pages', 'broken.hbs'), '{{noSuchHelper note}}');
});

afterAll(() => {
  rmSync(viewsDir, { recursive: true, force: true });
});

const policy: SessionPolicy = { idleMs: 60_000, absoluteMs: 3_600_000, now: () => Date.now() };
const csrf = createCsrf({ secret: testSecret(), secure: false });
const CSRF_COOKIE = csrfCookieName(false);

/** Status and csrf-csrf's code, so a test can tell a CSRF rejection from anything else. */
const errorHandler: ErrorRequestHandler = (error: { status?: number; code?: string }, _req, res, _next) => {
  res.status(error.status ?? 500).send(error.code ?? 'error');
};

/** Stand-in for loadViewer: a session with a user id is "Ada". */
const fakeViewer: RequestHandler = (req, res, next) => {
  if (req.session.userId !== undefined)
    res.locals.viewer = { userId: req.session.userId, firstName: 'Ada', hasSigned: false };
  next();
};

function createRenderApp(): Express {
  const app = express();
  configureViewEngine(app, {
    viewsDir,
    assets: createAssetResolver({ mode: 'development' }),
    timeZone: 'Europe/Berlin',
    issueCsrfToken: csrf.issueToken,
  });
  app.use(createRequestLogger(createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' })));
  app.use(
    session({
      name: 'petition.sid',
      secret: testSecret(),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false, path: '/' },
    }),
  );
  app.use(fakeViewer);

  // Rendered before body parsing and cookie-parser, like the 413 and 429 pages of the real middleware order.
  app.get('/early', (req, res) => {
    renderPage(req, res, 'pages/probe', { title: 'Early', note: 'early' });
  });

  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());
  app.use(csrf.protection);

  app.get('/page', (req, res) => {
    renderPage(req, res, 'pages/probe', { title: 'Probe', note: 'from the model' });
  });
  app.get('/form', async (req, res) => {
    await bindAnonymousSession(req);
    renderPage(req, res, 'pages/probe', { title: 'Form' });
  });
  app.get('/broken', (req, res) => {
    renderPage(req, res, 'pages/broken', { title: 'Broken', note: 'x' });
  });
  app.post('/sign-in', async (req, res) => {
    await establishSession(req, { id: 7, sessionVersion: 0 }, policy);
    res.redirect(303, '/page');
  });
  app.post('/logout', async (req, res) => {
    await endSession(req, 'You are logged out');
    res.redirect(303, '/page');
  });
  app.post('/profile', (req, res) => {
    setFlash(req, 'Profile updated');
    res.redirect(303, '/redirect-only');
  });
  app.post('/submit', (_req, res) => {
    res.sendStatus(204);
  });
  app.get('/redirect-only', (_req, res) => {
    res.redirect(302, '/page');
  });
  app.use(errorHandler);
  return app;
}

type Agent = ReturnType<typeof request.agent>;

function text(html: string, selector: string): string {
  return parse(html).querySelector(selector)?.text ?? '';
}

function tokenIn(html: string): string {
  return parse(html).querySelector('input[name="_csrf"]')?.getAttribute('value') ?? '';
}

function setCookieHeaders(response: request.Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  return Array.isArray(header) ? header.map(String) : [];
}

describe('renderPage: CSRF token', () => {
  let agent: Agent;

  beforeEach(() => {
    agent = request.agent(createRenderApp());
  });

  /** Signs in through the stand-in route; any rendered page for the agent then carries a token. */
  async function signIn(): Promise<void> {
    // The token first: a Supertest agent attaches its cookies when the request is created.
    const token = await formToken();
    await agent.post('/sign-in').type('form').send({ _csrf: token }).expect(303);
  }

  async function formToken(): Promise<string> {
    return tokenIn((await agent.get('/form').expect(200)).text);
  }

  it('F-70, ADR 0003: a guest page without a bound session has no token and creates no session', async () => {
    const response = await agent.get('/page').expect(200);

    expect(tokenIn(response.text)).toBe('');
    expect(setCookieHeaders(response)).toEqual([]);
    expect(text(response.text, '#note')).toBe('from the model');
  });

  it('F-70, ADR 0003: a guest form page binds the session and renders a token that the POST accepts', async () => {
    const response = await agent.get('/form').expect(200);
    const token = tokenIn(response.text);

    expect(token).not.toBe('');
    expect(setCookieHeaders(response).some((cookie) => cookie.startsWith(`${CSRF_COOKIE}=`))).toBe(true);
    expect(setCookieHeaders(response).some((cookie) => cookie.startsWith('petition.sid='))).toBe(true);
    await agent.post('/submit').type('form').send({ _csrf: token }).expect(204);
  });

  it('F-70, B-14: a POST without the token, or with a forged one, is rejected with 403 EBADCSRFTOKEN', async () => {
    const token = await formToken();

    expect((await agent.post('/submit').type('form').send({}).expect(403)).text).toBe('EBADCSRFTOKEN');
    expect(
      (
        await agent
          .post('/submit')
          .type('form')
          .send({ _csrf: `${token}x` })
          .expect(403)
      ).text,
    ).toBe('EBADCSRFTOKEN');
    // A header is never a token source (one source per app, ADR 0003).
    await agent.post('/submit').set('x-csrf-token', token).expect(403);
  });

  it('F-70, ADR 0003: a signed-in viewer gets a token on every page, the same one while the session lasts', async () => {
    await signIn();

    const first = await agent.get('/page').expect(200);
    const second = await agent.get('/page').expect(200);

    expect(text(first.text, '#viewer')).toBe('Ada');
    expect(tokenIn(first.text)).not.toBe('');
    expect(tokenIn(second.text)).toBe(tokenIn(first.text));
    await agent
      .post('/submit')
      .type('form')
      .send({ _csrf: tokenIn(second.text) })
      .expect(204);
  });

  it('F-70, B-04: signing in changes the session id, so the token of the anonymous session is dead', async () => {
    const anonymousToken = await formToken();
    await agent.post('/sign-in').type('form').send({ _csrf: anonymousToken }).expect(303);

    await agent.post('/submit').type('form').send({ _csrf: anonymousToken }).expect(403);
    const fresh = tokenIn((await agent.get('/page').expect(200)).text);
    expect(fresh).not.toBe(anonymousToken);
    await agent.post('/submit').type('form').send({ _csrf: fresh }).expect(204);
  });

  it('F-08, F-09: a page rendered before cookie-parser (the 413 and 429 pages) reuses the token instead of failing', async () => {
    await signIn();
    const token = tokenIn((await agent.get('/page').expect(200)).text);

    const early = await agent.get('/early').expect(200);

    expect(text(early.text, '#viewer')).toBe('Ada');
    expect(tokenIn(early.text)).toBe(token);
    await agent.post('/submit').type('form').send({ _csrf: token }).expect(204);
  });

  it('F-25, B-04: endSession leaves a guest session with the flash, and the signed-in token no longer works', async () => {
    await signIn();
    const token = tokenIn((await agent.get('/page').expect(200)).text);

    await agent.post('/logout').type('form').send({ _csrf: token }).expect(303);
    const after = await agent.get('/page').expect(200);

    expect(text(after.text, '#viewer')).toBe('');
    expect(text(after.text, '#flash')).toBe('You are logged out');
    await agent.post('/submit').type('form').send({ _csrf: token }).expect(403);
  });
});

describe('renderPage: flash', () => {
  let agent: Agent;

  beforeEach(async () => {
    agent = request.agent(createRenderApp());
    const token = tokenIn((await agent.get('/form').expect(200)).text);
    await agent.post('/profile').type('form').send({ _csrf: token }).expect(303);
  });

  it('F-17: a flash is consumed only by a rendered page, never by a request that only redirects', async () => {
    await agent.get('/redirect-only').expect(302);

    const shown = await agent.get('/page').expect(200);
    const next = await agent.get('/page').expect(200);

    expect(text(shown.text, '#flash')).toBe('Profile updated');
    expect(text(next.text, '#flash')).toBe('');
  });

  it('F-17: a HEAD request for a page never uses up the flash it cannot show', async () => {
    await agent.head('/page').expect(200);

    expect(text((await agent.get('/page').expect(200)).text, '#flash')).toBe('Profile updated');
  });

  it('F-09, F-17: a page that fails to render is a plain 500 without internals, and the flash waits for the next page', async () => {
    const broken = await agent.get('/broken').expect(500);

    expect(broken.headers['content-type']).toMatch(/^text\/plain/);
    expect(broken.text).toBe('Something went wrong. Please try again in a moment.');
    expect(broken.text).not.toMatch(/noSuchHelper|Missing helper|at /);
    expect(text((await agent.get('/page').expect(200)).text, '#flash')).toBe('Profile updated');
  });
});

describe('renderPage without a session', () => {
  it('F-09: an error raised before the session middleware still renders, as a guest and without a token', async () => {
    const app = express();
    configureViewEngine(app, {
      viewsDir,
      assets: createAssetResolver({ mode: 'development' }),
      timeZone: 'Europe/Berlin',
      issueCsrfToken: csrf.issueToken,
    });
    app.use(createRequestLogger(createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' })));
    app.get('/page', (req, res) => {
      renderPage(req, res, 'pages/probe', { title: 'No session' }, 503);
    });

    const response = await request(app).get('/page').expect(503);

    expect(text(response.text, 'title')).toBe('No session');
    expect(tokenIn(response.text)).toBe('');
    expect(text(response.text, '#flash')).toBe('');
  });
});

describe('renderPage without a registered CSRF issuer', () => {
  /**
   * A mounted sub-app renders with the parent's view engine, but its `req.app` is the child, for which
   * configureViewEngine registered no issuer. `signedIn` decides whether the page needs a token.
   */
  function createMountedApp({ signedIn }: { signedIn: boolean }): Express {
    const parent = express();
    configureViewEngine(parent, {
      viewsDir,
      assets: createAssetResolver({ mode: 'development' }),
      timeZone: 'Europe/Berlin',
      issueCsrfToken: csrf.issueToken,
    });
    parent.use(createRequestLogger(createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' })));
    parent.use(session({ secret: testSecret(), resave: false, saveUninitialized: false }));
    parent.use((_req, res, next) => {
      if (signedIn) res.locals.viewer = { userId: 7, firstName: 'Ada', hasSigned: false };
      next();
    });
    const child = express();
    child.set('views', viewsDir);
    child.get('/page', (req, res) => {
      renderPage(req, res, 'pages/probe', { title: 'Child', note: 'from the child' });
    });
    parent.use('/child', child);
    return parent;
  }

  it('F-70: a guest page of the sub-app needs no token and renders', async () => {
    const response = await request(createMountedApp({ signedIn: false }))
      .get('/child/page')
      .expect(200);

    expect(text(response.text, '#note')).toBe('from the child');
  });

  it('F-70, F-09: a page that needs a token but has no issuer is the plain 500, never forms with an empty token', async () => {
    const response = await request(createMountedApp({ signedIn: true }))
      .get('/child/page')
      .expect(500);

    expect(response.headers['content-type']).toMatch(/^text\/plain/);
    expect(response.text).toBe('Something went wrong. Please try again in a moment.');
  });
});

describe('renderPage with the real layout and viewLocals', () => {
  function createLayoutApp(): Express {
    const app = express();
    const { viewsDir: realViews } = resolvePaths('development');
    configureViewEngine(app, {
      viewsDir: realViews,
      assets: createAssetResolver({ mode: 'development' }),
      timeZone: 'Europe/Berlin',
      issueCsrfToken: csrf.issueToken,
    });
    app.use(createRequestLogger(createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' })));
    app.use(
      viewLocals(
        { CONTACT_URL: 'https://example.org/contact', IMPRINT_URL: undefined, APP_TIME_ZONE: 'Europe/Berlin' },
        // 31 Dec 2026, 23:30 UTC is already 2027 in Berlin.
        () => Date.parse('2026-12-31T23:30:00Z'),
      ),
    );
    app.get('/about/', (req, res) => {
      const copy = { heading: 'About', text: 'A nonsense petition.', nextHref: '/', nextLabel: 'home' };
      renderPage(req, res, 'pages/error', { title: 'About', ...copy });
    });
    return app;
  }

  it('F-15, F-16, F-14, B-45: the layout gets the title, footer data and the current page from viewLocals', async () => {
    const response = await request(createLayoutApp()).get('/about/').expect(200);
    const html = parse(response.text);

    expect(html.querySelector('title')?.text).toBe('About · Nonsense Petition');
    expect(html.querySelector('.site-footer__credit')?.text).toContain('2027');
    expect(html.querySelector('a.site-footer__link[href="https://example.org/contact"]')?.text).toBe('contact');
    expect(html.querySelectorAll('a.site-footer__link').map((link) => link.text)).not.toContain('imprint');
    // `/about/` and `/about` are one page: both nav and footer mark it.
    expect(html.querySelectorAll('a[aria-current="page"]').map((link) => link.getAttribute('href'))).toEqual([
      '/about',
      '/about',
    ]);
    expect(html.querySelector('link[rel="stylesheet"]')?.getAttribute('href')).toBe('/assets/app.css');
  });

  it('ROUTES section 1: dynamic HTML is never cached', async () => {
    const response = await request(createLayoutApp()).get('/about/').expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
  });
});
