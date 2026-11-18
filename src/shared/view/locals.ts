import type { ErrorRequestHandler, Request, RequestHandler, Response } from 'express';

import type { Env } from '../../config/env.js';

declare global {
  // Express declares `res.locals` through this global namespace; augmenting it is the documented way to type it.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging with @types/express, no runtime code
  namespace Express {
    interface Locals {
      /** Footer year in `APP_TIME_ZONE`, computed per request, never hard-coded (F-15). */
      year?: number;
      /** `CONTACT_URL` (F-15, B-15). */
      contactUrl?: string;
      /** `IMPRINT_URL`; absent when not configured, so the footer has no imprint link (F-89). */
      imprintUrl?: string;
      /** The request path for `currentAttr` and `aria-current="page"` (F-14), without a trailing slash. */
      currentPath?: string;
    }
  }
}

type ViewLocalsEnv = Pick<Env, 'CONTACT_URL' | 'IMPRINT_URL' | 'APP_TIME_ZONE'>;

/** `/supporters/` and `/supporters` are the same route (Express' non-strict routing), so they are the same page. */
function canonicalPath(path: string): string {
  // A loop, not /\/+$/: that pattern backtracks quadratically on a long run of slashes inside a hostile path.
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') end--;
  return path.slice(0, end);
}

/** Sets the layout data and `Cache-Control: no-store` on `res`; synchronous, so both middlewares below call it. */
function layoutLocals(env: ViewLocalsEnv, now: () => number): (req: Request, res: Response) => void {
  const yearFormat = new Intl.DateTimeFormat('en-GB', { timeZone: env.APP_TIME_ZONE, year: 'numeric' });
  return (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.locals.year = Number(yearFormat.format(now()));
    res.locals.contactUrl = env.CONTACT_URL;
    if (env.IMPRINT_URL !== undefined) res.locals.imprintUrl = env.IMPRINT_URL;
    res.locals.currentPath = canonicalPath(req.path);
  };
}

/**
 * Layout data for every dynamic response (OVERVIEW.md section 5.1, step 6: after the static routers, before the
 * session), so the error handler's pages have it too: `year`, `contactUrl`, `imprintUrl` and `currentPath` in
 * `res.locals`, which Express merges into every rendered view.
 *
 * Also `Cache-Control: no-store` (ROUTES.md section 1): pages carry the viewer's navigation and a session-bound CSRF
 * token and must never be reused from a shared or back-forward cache. A handler with other needs sets its own value
 * (the signature image keeps `private, no-store`).
 */
export function viewLocals(env: ViewLocalsEnv, now: () => number = Date.now): RequestHandler {
  const apply = layoutLocals(env, now);
  return (req, res, next) => {
    apply(req, res);
    next();
  };
}

/**
 * The same layout data for an error raised before step 6 (OVERVIEW.md section 5.1, step 6a). The static routers answer
 * a missing `/assets` or `/fonts` file with a 404 themselves (`fallthrough: false`, so the request never reaches the
 * session), and Express skips ordinary middleware once an error is pending. Without this the error page would have
 * no `Cache-Control: no-store`, an empty footer contact link and no year (F-15, ROUTES.md section 1).
 *
 * An error raised after the response started (a read error while a static file streams) passes on untouched: setting
 * a header then would throw `ERR_HTTP_HEADERS_SENT` and replace the real error before it reaches the error handler.
 */
export function viewLocalsOnError(env: ViewLocalsEnv, now: () => number = Date.now): ErrorRequestHandler {
  const apply = layoutLocals(env, now);
  return (error: unknown, req, res, next) => {
    if (!res.headersSent) apply(req, res);
    next(error);
  };
}
