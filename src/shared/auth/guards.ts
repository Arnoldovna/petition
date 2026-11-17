import type { Request, RequestHandler, Response } from 'express';

import { loginPath } from '../http/redirect.js';
import type { Viewer } from './viewer.js';

/**
 * Route guards (ROUTES.md section 1, ADR 0002 item 8, B-48 naming). They read only `res.locals.viewer` (set by
 * `loadViewer`), apply to GET **and** POST (F-07, B-06) and always redirect; they never throw 401 on HTML routes
 * (F-30). A page request (GET, HEAD) gets 302; a form submission gets 303, so the browser follows with a GET (PRG).
 */

const SIGNATURE = '/signature';
const THANK_YOU = '/thank-you';

function isPageRequest(req: Request): boolean {
  return req.method === 'GET' || req.method === 'HEAD';
}

function redirect(req: Request, res: Response, target: string): void {
  res.redirect(isPageRequest(req) ? 302 : 303, target);
}

/**
 * Guests go to the login page. A page request carries its own URL as `returnTo` (F-30; `loginPath` drops anything
 * that is not a safe same-origin path); a POST goes to plain `/login`, because its URL cannot be revisited by a GET.
 */
function redirectToLogin(req: Request, res: Response): void {
  redirect(req, res, isPageRequest(req) ? loginPath(req.originalUrl) : '/login');
}

/** Where a signed-in visitor belongs: the thank-you page after signing, else the signature page (F-22, F-23). */
export function homeOf(viewer: Viewer): string {
  return viewer.hasSigned ? THANK_YOU : SIGNATURE;
}

/** Signed-in visitors only. */
export const requireAuth: RequestHandler = (req, res, next) => {
  if (res.locals.viewer === undefined) {
    redirectToLogin(req, res);
    return;
  }
  next();
};

/** Guests only (`/register`, `/login`); signed-in visitors go to their home (F-22). */
export const requireGuest: RequestHandler = (req, res, next) => {
  const { viewer } = res.locals;
  if (viewer !== undefined) {
    redirect(req, res, homeOf(viewer));
    return;
  }
  next();
};

/**
 * Signed-in visitors whose `hasSigned` equals `signed`; the others go to `otherwise`. A guest is sent to the login
 * page, as by `requireAuth`, so the guard is safe even where a route forgets `requireAuth`.
 */
function requireSignedState(signed: boolean, otherwise: string): RequestHandler {
  return (req, res, next) => {
    const { viewer } = res.locals;
    if (viewer === undefined) {
      redirectToLogin(req, res);
      return;
    }
    if (viewer.hasSigned !== signed) {
      redirect(req, res, otherwise);
      return;
    }
    next();
  };
}

/** Visitors who have signed (`/thank-you`, `/signature/delete`, F-48, B-07). Others go to `/signature`. */
export const requireSigned: RequestHandler = requireSignedState(true, SIGNATURE);

/**
 * Visitors who have not signed yet (`/signature`, F-44). Signers go to `/thank-you`, also on POST, which makes a
 * repeated signature submission idempotent (F-43).
 */
export const requireNotSigned: RequestHandler = requireSignedState(false, THANK_YOU);

/**
 * The viewer inside a handler behind `requireAuth`. Throws a plain error (a 500) when called without a viewer: that
 * is a missing guard in the route, a programming error, never something to show the visitor as 401.
 */
export function viewerOf(res: Response): Viewer {
  const { viewer } = res.locals;
  if (viewer === undefined) throw new Error('viewerOf() needs requireAuth before the handler');
  return viewer;
}
