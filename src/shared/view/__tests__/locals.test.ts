import express, { type ErrorRequestHandler, type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { viewLocalsOnError } from '../locals.js';

/**
 * Step 6a of the middleware order (OVERVIEW.md section 5.1): `viewLocalsOnError` gives an error raised before step 6
 * (a missing asset in the static routers) the layout data and `no-store`, and passes the error on unchanged. The full
 * 404 page of a missing asset is proven on the real app in `pages.int.test.ts`.
 */

const ENV = {
  CONTACT_URL: 'https://example.org/contact',
  IMPRINT_URL: 'https://example.org/imprint',
  APP_TIME_ZONE: 'Europe/Berlin',
} as const;
// 31 Dec 2026, 23:30 UTC is already 2027 in Berlin.
const NOW = (): number => Date.parse('2026-12-31T23:30:00Z');

/** `raise` fails the request; the final error handler reports what reached it and the layout data it saw. */
function createApp(raise: RequestHandler): { app: Express; seen: unknown[] } {
  const seen: unknown[] = [];
  const app = express();
  app.use(raise);
  app.use(viewLocalsOnError(ENV, NOW));
  const report: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    seen.push(error);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(404).json({ ...res.locals });
  };
  app.use(report);
  return { app, seen };
}

describe('viewLocalsOnError', () => {
  it('F-15, F-89: an error before step 6 gets the layout data and no-store, and reaches the error handler as is', async () => {
    const missing = Object.assign(new Error('ENOENT'), { status: 404 });
    const { app, seen } = createApp((_req, _res, next) => {
      next(missing);
    });

    const response = await request(app).get('/assets/missing.css/').expect(404);

    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      year: 2027,
      contactUrl: ENV.CONTACT_URL,
      imprintUrl: ENV.IMPRINT_URL,
      currentPath: '/assets/missing.css',
    });
    expect(seen).toEqual([missing]);
  });

  it('F-15: an error after the response started passes on untouched instead of a headers-already-sent error', async () => {
    const streamError = new Error('read failed mid-stream');
    const { app, seen } = createApp((_req, res, next) => {
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.write('partial body');
      next(streamError);
    });

    const response = await request(app).get('/assets/app.css');

    // The headers went out before the error; the real error, not ERR_HTTP_HEADERS_SENT, reaches the handler.
    expect(response.headers['cache-control']).toBe('public, max-age=60');
    expect(seen).toEqual([streamError]);
  });
});
