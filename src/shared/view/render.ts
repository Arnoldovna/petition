import type { Application, Request, Response } from 'express';

import type { Viewer } from '../auth/viewer.js';
import { takeFlash, type Flash } from '../http/flash.js';
import type { CsrfTokenIssuer } from '../security/csrf.js';
import { currentSession } from '../security/session.js';

/** Every page model has a title: `<title>{{title}} · Nonsense Petition</title>` (F-16). */
export interface PageModel {
  title: string;
  /** Extra module entries for this page, e.g. `['signature-pad.js']` (form-guard.js is always loaded). */
  scripts?: readonly string[];
  /** Added by renderPage only (ADR 0003, 0008); a controller can never pass or override them. */
  viewer?: never;
  csrfToken?: never;
  flash?: never;
  [key: string]: unknown;
}

/** What renderPage adds to every page model; the layout and its partials read it (OVERVIEW.md section 15.1). */
interface RenderAdditions {
  viewer: Viewer | undefined;
  csrfToken: string | undefined;
  flash: Flash | undefined;
}

/**
 * The CSRF token issuer of each app, registered once by `configureViewEngine`. Keyed by the app instance (weakly, so
 * test apps are collected), because `renderPage` has the fixed signature of ADR 0003 and is also called by the error
 * handler; nothing else needs the issuer. It holds no connection or configuration of its own; a request whose
 * `req.app` has no issuer (a mounted sub-app) fails loudly in `csrfTokenFor`.
 */
const csrfIssuers = new WeakMap<Application, CsrfTokenIssuer>();

export function registerCsrfIssuer(app: Application, issuer: CsrfTokenIssuer): void {
  csrfIssuers.set(app, issuer);
}

/**
 * A token only for a signed-in viewer (the navigation holds the logout form) or a session that a guest form page has
 * bound (ADR 0003). Home, about, privacy and error pages therefore never create a session for a guest, and without a
 * session (an error inside the session middleware itself) there is no token at all.
 */
function csrfTokenFor(req: Request, res: Response, viewer: Viewer | undefined): string | undefined {
  const session = currentSession(req);
  if (session === undefined || (viewer === undefined && session.csrfBound !== true)) return undefined;
  const issueToken = csrfIssuers.get(req.app);
  // A page that needs a token but cannot get one would render forms that every POST rejects with the 403 page, and
  // nothing would be logged. Failing here logs the cause and answers the plain 500 instead.
  if (issueToken === undefined) {
    throw new Error('renderPage: no CSRF token issuer for this app; configureViewEngine registers it');
  }
  return issueToken(req, res);
}

/**
 * Reads and deletes the flash, except for HEAD: that response has the page's headers but no body, so it would use up
 * the one-time message without showing it (F-17; HEAD is a safe method, RFC 9110 section 9.3.2).
 */
function flashFor(req: Request): Flash | undefined {
  return req.method === 'HEAD' ? undefined : takeFlash(req);
}

/** Last resort when even a page cannot be rendered: plain text, no internals (F-09). */
function sendRenderFailure(res: Response): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).type('text/plain').send('Something went wrong. Please try again in a moment.');
}

/** A flash taken for a page that then failed to render is put back, so the visitor still sees it once (F-17). */
function restoreFlash(req: Request, flash: Flash | undefined): void {
  const session = currentSession(req);
  if (flash !== undefined && session !== undefined) session.flash = flash;
}

/**
 * The only place that calls `res.render` (ESLint `no-restricted-syntax`, ADR 0003, 0008, 0014). Every HTML response,
 * success or error, goes through it and gets the same layout data:
 *
 * - `viewer` from `loadViewer` (or none for a guest),
 * - `csrfToken` when there is a viewer or a bound session, so every 422/401 re-render and every error page of a
 *   signed-in visitor carries a valid token (ADR 0003),
 * - `flash`, read and deleted here and nowhere else: a request that only redirects, or a HEAD request, leaves it for
 *   the next page that renders (F-17, ADR 0008).
 *
 * A failure while issuing the token or rendering the template is logged with the request id and answered with a
 * plain 500 instead of being passed to `next()`, so a broken error page can never recurse into the error handler or
 * reach Express's default handler.
 */
export function renderPage(req: Request, res: Response, view: string, model: PageModel, status = 200): void {
  const { viewer } = res.locals;
  let additions: RenderAdditions;
  try {
    additions = { viewer, csrfToken: csrfTokenFor(req, res, viewer), flash: flashFor(req) };
  } catch (error) {
    req.log.error({ err: error, view }, 'page render failed');
    sendRenderFailure(res);
    return;
  }

  res.status(status).render(view, { ...model, ...additions }, (error: Error | null, html?: string) => {
    if (error !== null || html === undefined) {
      req.log.error({ err: error, view }, 'page render failed');
      restoreFlash(req, additions.flash);
      sendRenderFailure(res);
      return;
    }
    res.send(html);
  });
}
