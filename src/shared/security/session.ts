import { RedisStore } from 'connect-redis';
import type { Request, RequestHandler } from 'express';
import session, { type Session, type SessionData } from 'express-session';

import { APP_SLUG } from '../../config/app.js';
import type { Env } from '../../config/env.js';
import { setFlash, type FlashMessage } from '../http/flash.js';
import type { RedisClient } from '../redis/redis.js';

/**
 * Server-side sessions (ADR 0002, F-28, F-29, B-04): express-session 1.19 with the connect-redis 10 store, an opaque
 * id in an httpOnly cookie, and only technical fields in the session (`userId`, `sessionVersion`, `issuedAt`,
 * `csrfBound`, `flash`; each declared next to the code that owns it). Names, emails and signature ids never enter it.
 */

declare module 'express-session' {
  interface SessionData {
    /** Epoch ms from `SessionPolicy.now()` when `establishSession` signed the visitor in (absolute lifetime). */
    issuedAt?: number;
  }
}

/** Idle and absolute session lifetimes plus the clock they are measured with (ADR 0002 item 4). */
export interface SessionPolicy {
  /** Cookie `maxAge` and Redis TTL, renewed by every request (`rolling`). */
  idleMs: number;
  /** Maximum age of a signed-in session since `establishSession`, however active it is. */
  absoluteMs: number;
  /** `Date.now` in the app; tests pass a fake clock. */
  now: () => number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** `SESSION_IDLE_MINUTES` and `SESSION_ABSOLUTE_HOURS` (defaults 120 and 168, OVERVIEW.md section 16). */
export function sessionPolicyFromEnv(
  env: Pick<Env, 'SESSION_IDLE_MINUTES' | 'SESSION_ABSOLUTE_HOURS'>,
  now: () => number = Date.now,
): SessionPolicy {
  return { idleMs: env.SESSION_IDLE_MINUTES * MINUTE_MS, absoluteMs: env.SESSION_ABSOLUTE_HOURS * HOUR_MS, now };
}

/**
 * App-scoped cookie name (conventions §8) of the session and CSRF cookies: cookies ignore ports, and all three rebuilt
 * apps run on 127.0.0.1. The `__Host-` prefix (secure, `path=/`, no `Domain`) is only valid over https.
 */
export function appCookieName(name: string, secure: boolean): string {
  return secure ? `__Host-${APP_SLUG}.${name}` : `${APP_SLUG}.${name}`;
}

interface SessionOptions {
  /** Connected by the composition root (or the test harness) before the first request. */
  redis: RedisClient;
  /** `SESSION_SECRET` as a list: the first entry signs, every entry verifies (rotation, B-03). */
  secrets: readonly string[];
  /** `isHttps(env)`: secure cookie and `__Host-` name. */
  secure: boolean;
  /** Redis key prefix: `APP_SLUG` in the app, a fresh `test-<uuid>` per test app; keys are `<prefix>:sess:<id>`. */
  prefix: string;
  policy: SessionPolicy;
}

function assertPositiveDuration(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer (ms)`);
}

/**
 * The session middleware (OVERVIEW.md section 5.1, step 7). `saveUninitialized: false`, so guests get no session
 * until something is stored (CSRF binding on a form page, a flash); `rolling: true` with `maxAge = idleMs` renews the
 * cookie and, through connect-redis' `touch`, the Redis TTL on every request: the idle timeout (F-29).
 */
export function createSessionMiddleware({ redis, secrets, secure, prefix, policy }: SessionOptions): RequestHandler {
  if (secrets.length === 0) throw new RangeError('at least one session secret is required');
  assertPositiveDuration('idleMs', policy.idleMs);
  assertPositiveDuration('absoluteMs', policy.absoluteMs);

  return session({
    store: new RedisStore({ client: redis, prefix: `${prefix}:sess:` }),
    name: appCookieName('sid', secure),
    secret: [...secrets],
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: policy.idleMs },
  });
}

type RequestSession = Session & Partial<SessionData>;

/**
 * `req.session`, or `undefined` when the session middleware has not run for this request: express-session types it
 * as always present, but the error handler also renders errors raised before or inside the session middleware.
 */
export function currentSession(req: Request): RequestSession | undefined {
  return (req as { session?: RequestSession }).session;
}

function callbackToPromise(run: (done: (error: unknown) => void) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    run((error) => {
      if (error === undefined || error === null) resolve();
      else reject(error instanceof Error ? error : new Error('session store failure', { cause: error }));
    });
  });
}

/**
 * Replaces the session with a fresh, empty one and deletes the old store entry, so the old id is useless (ADR 0002
 * items 4, 6 and 7). express-session stores the new anonymous session at the end of the request (new cookie, empty
 * entry with the idle TTL) because its id differs from the cookie's; it holds no user data. Never `destroy()`: express-session 1.19 then deletes `req.session`, and every later
 * step of the same request that reads it (CSRF, flash, `bindAnonymousSession`) would throw and end in a 500 (F-09).
 */
export function regenerateSession(req: Request): Promise<void> {
  return callbackToPromise((done) => req.session.regenerate(done));
}

/** Writes the session to the store now, before a redirect that the browser follows immediately. */
export function saveSession(req: Request): Promise<void> {
  return callbackToPromise((done) => {
    req.session.save(done);
  });
}

/** The fields `establishSession` needs from the user row. */
interface SessionUser {
  id: number;
  /** `users.session_version` now; a later password change elsewhere ends this session (ADR 0002 item 9). */
  sessionVersion: number;
}

/**
 * Signs a visitor in on register, login and password change, and in the test-only sign-in route (ADR 0002 item 6,
 * ADR 0017): a new session id against session fixation, then the user id, the version and the issue time for the
 * absolute lifetime. The CSRF token of the old id is invalid from now on; the next rendered page issues a new one.
 */
export async function establishSession(req: Request, user: SessionUser, policy: SessionPolicy): Promise<void> {
  await regenerateSession(req);
  req.session.userId = user.id;
  req.session.sessionVersion = user.sessionVersion;
  req.session.issuedAt = policy.now();
  await saveSession(req);
}

/**
 * Logout and account deletion (ADR 0002 item 6, F-25, F-68, B-04): the old store entry is deleted, so a copied
 * cookie is dead, and the new anonymous session carries only the confirmation for the next page.
 */
export async function endSession(req: Request, flash: FlashMessage): Promise<void> {
  await regenerateSession(req);
  setFlash(req, flash);
  await saveSession(req);
}

/**
 * True for a signed-in session older than `absoluteMs`, or one without a usable issue time (which only an outdated or
 * tampered store entry can have). Anonymous sessions (CSRF binding, flash) live by the idle timeout alone.
 */
function isPastAbsoluteLifetime(session: RequestSession, policy: SessionPolicy): boolean {
  if (session.userId === undefined) return false;
  const { issuedAt } = session;
  if (typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return true;
  return policy.now() - issuedAt >= policy.absoluteMs;
}

/**
 * Right after the session middleware (OVERVIEW.md section 5.1, step 8): a signed-in session past its absolute
 * lifetime is regenerated, so the rest of the request, error pages included, runs as a guest (F-29). A form posted
 * with it then fails the CSRF check (its token was bound to the old id) with the 403 page, never a 500.
 */
export function enforceAbsoluteLifetime(policy: SessionPolicy): RequestHandler {
  return async (req, _res, next) => {
    const session = currentSession(req);
    if (session !== undefined && isPastAbsoluteLifetime(session, policy)) await regenerateSession(req);
    next();
  };
}
