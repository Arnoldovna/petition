import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';

import { DrizzleQueryError } from 'drizzle-orm/errors';
import express, { type RequestHandler } from 'express';
import { parse } from 'node-html-parser';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { resolvePaths } from '../../../config/paths.js';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TooManyRequestsError,
  UnauthorizedError,
} from '../../errors/app-error.js';
import { createLogger, createRequestLogger } from '../../logging/logger.js';
import { createCsrf } from '../../security/csrf.js';
import { createAssetResolver } from '../../view/assets.js';
import { configureViewEngine } from '../../view/engine.js';
import { errorHandler, notFoundHandler } from '../error-handler.js';

/** A fresh random secret per run: tests never commit secret-shaped literals (gitleaks, ADR 0011). */
const testSecret = (): string => randomBytes(32).toString('base64url');

/**
 * The error handler between real Express, real body-parser, the real view engine and the request logger, without
 * sessions or a database (those parts are covered by error-pages.int.test.ts in step 2b).
 */
function createErrorApp() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  const paths = resolvePaths('development');
  const app = express();
  configureViewEngine(app, {
    viewsDir: paths.viewsDir,
    assets: createAssetResolver({ mode: paths.mode }),
    timeZone: 'Europe/Berlin',
    issueCsrfToken: createCsrf({ secret: testSecret(), secure: false }).issueToken,
  });
  app.use(createRequestLogger(createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' }, destination)));
  app.use(express.urlencoded({ extended: false, limit: '1kb' }));

  const fail =
    (error: unknown): RequestHandler =>
    () => {
      throw error;
    };
  app.post('/form', (_req, res) => {
    res.sendStatus(204);
  });
  app.get(
    '/crash',
    fail(
      new DrizzleQueryError('select password_hash from users where email = $1', ['ada@example.com'], new Error('x')),
    ),
  );
  app.get('/crash-async', async () => {
    await Promise.resolve();
    throw new Error('async failure with internals');
  });
  app.get('/missing-thing', fail(new NotFoundError('Supporter page')));
  app.get('/limited', fail(new TooManyRequestsError({ retryAfterSeconds: 90 })));
  app.get('/limited-by-limiter', (_req, res, next) => {
    res.setHeader('Retry-After', '600');
    next(new TooManyRequestsError({ retryAfterSeconds: 90 }));
  });
  app.get('/queue-full', fail(new TooManyRequestsError()));
  app.get(
    '/expired',
    fail(Object.assign(new Error('invalid csrf token'), { status: 403, expose: true, code: 'EBADCSRFTOKEN' })),
  );
  // serve-static's refusal of a path that leaves its folder: an http-errors 403 that is not a CSRF rejection.
  app.get('/refused', fail(Object.assign(new Error('Forbidden'), { status: 403, expose: true })));
  app.get('/forbidden', fail(new ForbiddenError()));
  app.get('/unauthenticated', fail(new UnauthorizedError()));
  app.get('/conflict', fail(new ConflictError('Already signed', 'already-signed')));
  app.get(
    '/charset',
    fail(
      Object.assign(new Error('unsupported charset "X"'), { status: 415, expose: true, type: 'charset.unsupported' }),
    ),
  );
  app.get('/partial', (_req, res, next) => {
    res.write('partial');
    next(new Error('after headers'));
  });
  app.use(notFoundHandler);
  app.use(errorHandler);
  return { app, logs: () => lines.join('\n') };
}

const html = (agent: request.Test) => agent.set('Accept', 'text/html');
/** The decoded href of the error page's next-step link (Handlebars escapes `=` in attributes). */
const nextHref = (body: string) => parse(body).querySelector('main a')?.getAttribute('href');
/** The text of the page's one h1 (the page-heading partial adds a class, so a bare `<h1>` string never matches). */
const heading = (body: string) => parse(body).querySelector('h1')?.text.trim();
const json = (agent: request.Test) => agent.set('Accept', 'application/json');

describe('errorHandler for HTML clients', () => {
  it('F-08, B-43: an unknown path is the 404 page with a link home, never a redirect', async () => {
    const { app } = createErrorApp();

    const response = await html(request(app).get('/no/such/page'));

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['location']).toBeUndefined();
    expect(heading(response.text)).toBe('Page not found');
    expect(response.text).toContain('<title>Page not found · Nonsense Petition</title>');
    expect(nextHref(response.text)).toBe('/');
  });

  it('F-09, B-13, B-20: an unexpected error is the 500 page without message, SQL or stack, and it is logged', async () => {
    const { app, logs } = createErrorApp();

    for (const path of ['/crash', '/crash-async']) {
      const response = await html(request(app).get(path));

      expect(response.status).toBe(500);
      expect(heading(response.text)).toBe('Something went wrong');
      expect(response.text).not.toMatch(/Failed query|password_hash|internals|at .*\.ts:\d+/);
    }
    expect(logs()).toContain('async failure with internals');
    // The logger's error serializer removes bound query values (B-12).
    expect(logs()).not.toContain('ada@example.com');
  });

  it('F-08: the 413 page sends the signer back to the pad', async () => {
    const { app } = createErrorApp();

    const response = await html(
      request(app)
        .post('/form')
        .type('form')
        .send({ signature: 'x'.repeat(2048) }),
    );

    expect(response.status).toBe(413);
    expect(heading(response.text)).toBe('That was too much data');
    expect(nextHref(response.text)).toBe('/signature');
  });

  it('F-70: the CSRF 403 page links back to the form when the Referer is this app', async () => {
    const { app } = createErrorApp();

    const sameOrigin = await html(request(app).get('/expired'))
      .set('Host', 'petition.test')
      .set('Referer', 'http://petition.test/profile/edit?x=1');
    const foreign = await html(request(app).get('/expired'))
      .set('Host', 'petition.test')
      .set('Referer', 'http://evil.example/profile/edit');

    expect(sameOrigin.status).toBe(403);
    expect(heading(sameOrigin.text)).toBe('This form has expired');
    expect(nextHref(sameOrigin.text)).toBe('/profile/edit?x=1');
    expect(foreign.status).toBe(403);
    expect(foreign.text).not.toContain('evil.example');
    expect(nextHref(foreign.text)).toBe('/');
  });

  it('F-70, ADR 0008: only the CSRF rejection says the form expired; any other 403 never offers a way back to a form', async () => {
    const { app } = createErrorApp();

    for (const path of ['/refused', '/forbidden']) {
      const response = await html(request(app).get(path))
        .set('Host', 'petition.test')
        .set('Referer', 'http://petition.test/profile/edit');

      expect(response.status, path).toBe(403);
      expect(heading(response.text), path).toBe('That request could not be completed');
      expect(response.text, path).not.toContain('This form has expired');
      expect(nextHref(response.text), path).toBe('/');
    }
  });

  it('ADR 0008: a 401 or 409 page names no cause it cannot know; an unsupported charset could not be read', async () => {
    const { app } = createErrorApp();

    const unauthenticated = await html(request(app).get('/unauthenticated'));
    const conflict = await html(request(app).get('/conflict'));
    const charset = await html(request(app).get('/charset'));

    expect(unauthenticated.status).toBe(401);
    expect(heading(unauthenticated.text)).toBe('That request could not be completed');
    expect(conflict.status).toBe(409);
    expect(heading(conflict.text)).toBe('That request could not be completed');
    expect(charset.status).toBe(415);
    expect(heading(charset.text)).toBe('That request could not be read');
  });

  it('F-26: a 429 page carries Retry-After from the error, without overriding one a limiter has set', async () => {
    const { app } = createErrorApp();

    const fromError = await html(request(app).get('/limited'));
    const fromLimiter = await html(request(app).get('/limited-by-limiter'));
    const queueFull = await html(request(app).get('/queue-full'));

    expect(fromError.status).toBe(429);
    expect(heading(fromError.text)).toBe('Too many attempts');
    expect(fromError.headers['retry-after']).toBe('90');
    expect(fromLimiter.headers['retry-after']).toBe('600');
    expect(queueFull.status).toBe(429);
    expect(queueFull.headers['retry-after']).toBeUndefined();
  });

  it('B-20: an error after the headers were sent ends the response instead of hanging', async () => {
    const { app } = createErrorApp();

    await expect(html(request(app).get('/partial'))).rejects.toThrow();
  });
});

describe('errorHandler for non-HTML clients', () => {
  it('F-09: answers RFC 9457 problem+json', async () => {
    const { app } = createErrorApp();

    const response = await json(request(app).get('/missing-thing'));

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toEqual({
      type: 'tag:arnoldovna.github.io,2026:petition:problem:not-found',
      title: 'Not found',
      status: 404,
      detail: 'Supporter page was not found.',
      instance: '/missing-thing',
    });
  });

  it('F-09, B-13: a 500 problem has the generic detail only', async () => {
    const { app } = createErrorApp();

    const response = await json(request(app).get('/crash'));

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      type: 'about:blank',
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/crash',
    });
  });

  it('F-26: a 429 problem carries Retry-After too', async () => {
    const { app } = createErrorApp();

    const response = await json(request(app).get('/limited'));

    expect(response.status).toBe(429);
    expect(response.headers['retry-after']).toBe('90');
  });
});
