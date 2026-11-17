import { join } from 'node:path';

import compression from 'compression';
import express, { Router, type Response } from 'express';

import type { AssetMode } from '../../config/paths.js';

interface StaticOptions {
  mode: AssetMode;
  /** dist/public (production) or .dev/public (development): generated assets/ and fonts/. */
  builtPublicDir: string;
  /** Committed static files: icons, site.webmanifest, robots.txt. */
  publicDir: string;
}

type CacheOptions = Pick<NonNullable<Parameters<typeof express.static>[1]>, 'immutable' | 'maxAge'>;

const DAY_MS = 24 * 60 * 60 * 1000;

function isHtml(res: Response): boolean {
  const type = res.getHeader('Content-Type');
  return typeof type === 'string' && /^text\/html\b/i.test(type);
}

/**
 * compression() wraps the response before express.static runs, so it also sees the HTML error page that a missing
 * asset (404) produces further down. The filter keeps that page, like all dynamic HTML, uncompressed.
 */
const compressStaticFiles = () => compression({ filter: (req, res) => !isHtml(res) && compression.filter(req, res) });

/**
 * Static files (ADR 0010, ROUTES.md section 7), mounted before sessions, CSRF and rate limits (B-59), so they never
 * create a session.
 *
 * - `/assets`: hashed build output, `immutable` for a year in production; unhashed watcher output in development
 *   is revalidated on every request.
 * - `/fonts`: 30 days in production.
 * - root: committed icons and manifest, one day.
 *
 * Only files under `/assets` and `/fonts` are compressed. Dynamic HTML never is, not even the 404 page of a missing
 * asset, because it carries the CSRF token next to reflected input (BREACH). A missing asset or font is a 404 right
 * here (`fallthrough: false`) instead of reaching the page routers.
 */
export function createStaticRouter({ mode, builtPublicDir, publicDir }: StaticOptions): Router {
  const production = mode === 'production';
  /** One generated folder below builtPublicDir: compressed, and a 404 right here when a file is missing. */
  const serveBuilt = (folder: string, cache: CacheOptions) => [
    compressStaticFiles(),
    express.static(join(builtPublicDir, folder), { index: false, fallthrough: false, ...cache }),
  ];

  const router = Router();
  router.use('/assets', serveBuilt('assets', production ? { immutable: true, maxAge: 365 * DAY_MS } : { maxAge: 0 }));
  router.use('/fonts', serveBuilt('fonts', { maxAge: production ? 30 * DAY_MS : 0 }));
  router.use(express.static(publicDir, { index: false, maxAge: DAY_MS }));
  return router;
}
