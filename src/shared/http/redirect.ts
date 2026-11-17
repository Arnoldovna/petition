import type { Request } from 'express';

/** ROUTES.md section 1: a `returnTo` longer than this is dropped. */
const MAX_RETURN_TO_LENGTH = 512;

/** Only used to resolve relative paths; never sent anywhere. `.invalid` is reserved (RFC 2606). */
const PLACEHOLDER_ORIGIN = 'https://petition.invalid';

/** Control characters and backslashes: browsers strip tabs and newlines and read `\` as `/` in URLs. */
const UNSAFE_CHARACTERS = /[\p{Cc}\\]/u;

/**
 * F-30, ROUTES.md section 1: a same-origin relative path, or `undefined`. Invalid values are dropped silently, never
 * reported, so `returnTo` can never become an open redirect.
 *
 * Accepted: starts with a single `/` (not `//` or `/\`), no control characters or backslashes, at most 512
 * characters, and it resolves to the app's own origin. The result is the normalised path, query and fragment of the
 * parsed URL, and it is checked again after normalisation, because dot segments can turn a harmless path into a
 * protocol-relative one (`/.//evil.example` normalises to `//evil.example`).
 */
export function safeReturnTo(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return undefined;
  if (!value.startsWith('/') || value.startsWith('//') || UNSAFE_CHARACTERS.test(value)) return undefined;

  let url: URL;
  try {
    url = new URL(value, PLACEHOLDER_ORIGIN);
  } catch {
    return undefined;
  }
  if (url.origin !== PLACEHOLDER_ORIGIN) return undefined;

  const normalised = `${url.pathname}${url.search}${url.hash}`;
  if (normalised.startsWith('//') || normalised.length > MAX_RETURN_TO_LENGTH) return undefined;
  return normalised;
}

/**
 * The login page, carrying `returnTo` only when it is safe (ROUTES.md section 1, `requireAuth` on GET). Unsafe
 * targets are dropped, so the guard never builds a link it would later reject.
 */
export function loginPath(returnTo?: string): string {
  const target = safeReturnTo(returnTo);
  return target === undefined ? '/login' : `/login?returnTo=${encodeURIComponent(target)}`;
}

/**
 * The path of a same-origin `Referer`, for the "back to the form" link of the CSRF 403 page (ROUTES.md section 8),
 * or `undefined` when the header is missing, foreign or unsafe. The origin is compared with the request's own
 * protocol and host (`trust proxy` decides both behind a proxy).
 */
export function sameOriginReferer(req: Request): string | undefined {
  const referer = req.get('referer');
  const host = req.get('host');
  if (referer === undefined || host === undefined) return undefined;

  try {
    const url = new URL(referer);
    if (url.origin !== new URL(`${req.protocol}://${host}`).origin) return undefined;
    return safeReturnTo(`${url.pathname}${url.search}`);
  } catch {
    // A malformed Referer or Host header: no back link.
    return undefined;
  }
}
