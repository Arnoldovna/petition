import cookieParser from 'cookie-parser';
import { doubleCsrf } from 'csrf-csrf';
import type { Request, RequestHandler, Response } from 'express';

import { appCookieName, saveSession } from './session.js';

/**
 * CSRF protection for the HTML forms (ADR 0003, F-70, B-08, B-14): csrf-csrf 4.1 signed double submit, bound to the
 * session id. The token travels only in the hidden form field `_csrf` (partial `csrf-field`), never in a header: one
 * source per app, no fallthrough. Tokens are issued in exactly one place, `renderPage`.
 */

declare module 'express-session' {
  interface SessionData {
    /**
     * Set by `bindAnonymousSession` on guest pages with a form (`/login`, `/register`), so the anonymous session id
     * stays stable between the rendered token and the POST (ADR 0003).
     */
    csrfBound?: true;
  }
}

/** The CSRF cookie, app-scoped like the session cookie (conventions §8). */
export function csrfCookieName(secure: boolean): string {
  return appCookieName('x-csrf-token', secure);
}

/** Issues the token for the current session and sets its cookie; reuses a valid one (`overwrite: false`). */
export type CsrfTokenIssuer = (req: Request, res: Response) => string;

export interface Csrf {
  /**
   * Middleware after the body parsers and `cookie-parser` (OVERVIEW.md section 5.1, step 14): rejects every POST,
   * PUT, PATCH and DELETE without a valid `_csrf` with csrf-csrf's 403 error (`code: 'EBADCSRFTOKEN'`), which the
   * error handler renders as "This form has expired" (B-13).
   */
  protection: RequestHandler;
  /** For `renderPage` only: call it only when the request has a session. */
  issueToken: CsrfTokenIssuer;
}

interface CsrfOptions {
  /** `CSRF_SECRET`, at least 32 characters. */
  secret: string;
  /** `isHttps(env)`: secure cookie and `__Host-` name. */
  secure: boolean;
}

const MIN_SECRET_LENGTH = 32;

/** `req.body._csrf` from the urlencoded form; anything else (missing body, repeated field) is no token. */
function tokenFromForm(req: Request): string | undefined {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && '_csrf' in body && typeof body._csrf === 'string'
    ? body._csrf
    : undefined;
}

export function createCsrf({ secret, secure }: CsrfOptions): Csrf {
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new RangeError(`the CSRF secret must be at least ${String(MIN_SECRET_LENGTH)} characters`);
  }
  const { doubleCsrfProtection, generateCsrfToken } = doubleCsrf({
    getSecret: () => secret,
    getSessionIdentifier: (req) => req.session.id,
    cookieName: csrfCookieName(secure),
    cookieOptions: { sameSite: 'lax', path: '/', secure, httpOnly: true },
    getCsrfTokenFromRequest: tokenFromForm,
  });

  // csrf-csrf reads the existing token from `req.cookies`. Error pages for requests rejected before `cookie-parser`
  // ran (413 from a body parser, 429 from the global limiter) render a token too; without parsed cookies the
  // library would throw on `req.cookies` (a 500 instead of the error page) or replace the visitor's token, breaking
  // forms open in other tabs. cookie-parser is synchronous and a no-op once `req.cookies` exists.
  const parseCookies = cookieParser();
  const ensureCookies = (req: Request, res: Response): void => {
    if ((req as { cookies?: unknown }).cookies === undefined) {
      parseCookies(req, res, () => undefined);
    }
  };

  return {
    protection: doubleCsrfProtection,
    issueToken: (req, res) => {
      ensureCookies(req, res);
      return generateCsrfToken(req, res);
    },
  };
}

/**
 * Guest GET handlers that render a form (`/login`, `/register`) call this before `renderPage` (ADR 0003): it stores
 * the binding flag, so the anonymous session is saved and its id (and with it the token) stays stable until the POST.
 * Home, about, privacy and error pages never call it, so they never create a session for a guest.
 */
export async function bindAnonymousSession(req: Request): Promise<void> {
  req.session.csrfBound = true;
  await saveSession(req);
}
