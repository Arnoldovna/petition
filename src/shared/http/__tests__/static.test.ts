import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createStaticRouter } from '../static.js';

/** Well above compression's 1 kB threshold, so size never decides whether a response is compressed. */
const LARGE = 'x'.repeat(4096);

describe('createStaticRouter compression', () => {
  let root: string;
  let app: express.Express;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'static-router-'));
    mkdirSync(join(root, 'built', 'assets'), { recursive: true });
    mkdirSync(join(root, 'built', 'fonts'), { recursive: true });
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'built', 'assets', 'app.css'), `.page { content: "${LARGE}"; }`);

    // Stands in for the real error handler: an HTML error page as large as a real one with a CSRF token.
    const htmlErrorPage: ErrorRequestHandler = (error: { status?: number }, _req, res, _next) => {
      res
        .status(error.status ?? 500)
        .type('html')
        .send(`<!doctype html><title>Page not found</title><p>${LARGE}</p>`);
    };
    app = express()
      .use(
        createStaticRouter({
          mode: 'production',
          builtPublicDir: join(root, 'built'),
          publicDir: join(root, 'public'),
        }),
      )
      .use(htmlErrorPage);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ADR 0010: compresses a static asset', async () => {
    const response = await request(app).get('/assets/app.css').set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('ADR 0010, B-59: the HTML 404 page of a missing asset is never compressed (BREACH)', async () => {
    const response = await request(app).get('/assets/missing.css').set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('ADR 0010: the same holds below /fonts', async () => {
    const response = await request(app).get('/fonts/missing.woff2').set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(404);
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});
