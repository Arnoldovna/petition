# ADR 0002: Server-side Redis sessions and a per-request viewer loaded from the database

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-03, B-04, B-05, B-35, B-48, B-57, F-28, F-29, F-31, F-32

## Context

Legacy used `cookie-session` with a hard-coded secret (B-03), stored names and the signature id in a readable cookie
(B-04), never checked the session against the database (B-05) and cached "has signed" in the session (B-35).

The first draft destroyed expired and ghost sessions with `req.session.destroy()`. In express-session 1.19,
`destroy()` runs `delete this.req.session`, so every later step of the same request that reads `req.session`
(csrf-csrf's `getSessionIdentifier`, `bindAnonymousSession`, the flash helpers) throws a `TypeError` and the request
ends in a 500, exactly what F-09 forbids. It also loaded the viewer after the CSRF check, so error pages raised earlier
showed the guest navigation to signed-in users.

## Decision

1. **Store.** `express-session` 1.19 with `connect-redis` 10 (`RedisStore`, prefix `petition:sess:`), node-redis 6
   client from the container. `resave: false`, `saveUninitialized: false`.
2. **Cookie.** Name `__Host-petition.sid` when the app is served over https, `petition.sid` on plain-http local stacks.
   The app slug in the name keeps petition's cookie apart from imageboard and social-network, which use the same
   template on `127.0.0.1` (cookies ignore ports). `httpOnly`, `sameSite: 'lax'`, `path: '/'`, `secure` from
   `isHttps(env)` (= `COOKIE_SECURE`, production default true; the same switch drives HSTS and
   `upgrade-insecure-requests`, ADR 0011). `app.set('trust proxy', TRUST_PROXY)`.
3. **Secrets.** `SESSION_SECRET` is a comma-separated list, each entry at least 32 characters. The first signs, all
   verify (rotation, B-03). Never in code.
4. **Lifetimes and clock.** `SessionPolicy = { idleMs, absoluteMs, now: () => number }` is part of `AppDeps`.
   `container.ts` builds it from `SESSION_IDLE_MINUTES` (default 120) and `SESSION_ABSOLUTE_HOURS` (default 168) with
   `now = Date.now`; `test/test-app.ts` accepts millisecond values and a fake clock.
   - Idle timeout: `rolling: true` and `cookie.maxAge = idleMs`; connect-redis sets the Redis TTL from it.
   - Absolute lifetime: `session.issuedAt` (epoch ms from `policy.now()`, set by `establishSession`) and the middleware
     `enforceAbsoluteLifetime(policy)`. An expired session is **regenerated**, not destroyed:
     `await regenerateSession(req)` (promisified `req.session.regenerate`) deletes the old store entry and leaves a
     fresh, empty session object on `req.session`, so the rest of the request runs as a guest (F-29). Because its id
     differs from the cookie's, express-session stores that anonymous session at the end of the request (a new cookie
     and an empty entry with the idle TTL); it holds no user data. `viewer.ts` uses the same `regenerateSession`
     from `shared/security/session.ts`.
5. **Session content.** `SessionData = { userId?: number; sessionVersion?: number; issuedAt?: number;
csrfBound?: true; flash?: Flash }`. No names, emails or signature ids (F-28). `flash` is a fixed, server-written
   message and is deleted when a page renders it (ADR 0008). FEATURES F-28 is amended accordingly (OVERVIEW.md
   section 2.2).
6. **Session id rotation.** `establishSession(req, user, policy)` calls `regenerate`, then sets `userId`,
   `sessionVersion` and `issuedAt = policy.now()`, then `save`. Used on register, login and password change and by the
   test-only sign-in route (ADR 0017). `endSession(req, flash)` calls `regenerate` too: the old store entry is deleted
   (the old id becomes useless), and the new anonymous session only carries the flash ("You are logged out", "Your
   account was deleted"). A fresh CSRF token is rendered on the next GET.
7. **Viewer loader.** `loadViewer(findViewer)` in `src/shared/auth/viewer.ts` runs **directly after the session
   middleware and `enforceAbsoluteLifetime`**, before the global limiter, the body parsers and CSRF (OVERVIEW.md
   section 5.1), so every response, including 413, 429 and CSRF 403 pages, knows the viewer. It only runs when the
   session has a `userId`. `findViewer` is injected; it is the auth module's viewer repository
   (`createViewerRepository(db)` exported from `features/auth/index.ts`), so `shared` contains no SQL:
   `SELECT u.id, u.first_name, u.session_version, (s.user_id IS NOT NULL) AS has_signed FROM users u LEFT JOIN
signatures s ON s.user_id = u.id WHERE u.id = $1`.
   - No row (account deleted elsewhere) or `session_version` differs (password changed elsewhere): **regenerate** the
     session (as in item 4) and continue as a guest (F-31, B-05). Never `destroy()`.
   - Otherwise `res.locals.viewer = { userId, firstName, hasSigned }`. "Has signed" is never cached (F-32, B-35).
8. **Guards** read `res.locals.viewer` only: `requireAuth`, `requireGuest`, `requireSigned`, `requireNotSigned`
   (B-48 naming). They redirect; they never throw 401 on HTML routes (F-07, F-30).
9. **Revocation on password change.** `users.session_version` is incremented in the same transaction that stores a
   new password hash (auth's `credentials.apply`, ADR 0009). All other sessions of that user fail the viewer check on
   their next request.

## Alternatives considered

- **Signed or encrypted cookie sessions.** Rejected: no server-side revocation (B-04).
- **Trust `req.session.userId` without a DB lookup.** Rejected: ghost sessions (B-05) and stale signature state (B-35).
  The cost is one primary-key lookup with a left join per request.
- **Index of sessions per user in Redis for revocation.** Rejected as more moving parts than a version column.
- **Flash via query string (`/?notice=logged-out`).** Rejected: shown again on reload (F-17 says once).
- **Clear `userId`, `sessionVersion` and `issuedAt` instead of regenerating.** Works too, but keeps the old session id,
  which the user's browser may also hold in another tab. Regenerating makes the old id useless.

## Consequences

- Each authenticated request costs one indexed query. Acceptable at this scale. Because the viewer is loaded before the
  global limiter, a flood of requests with a valid signed-in cookie reaches Redis and Postgres before it is limited;
  only holders of a valid session can trigger the database lookup, and the global limiter still stops them after
  `globalPerMinute` requests. Accepted in exchange for correct navigation on every error page.
- Rolling sessions write to Redis on every response with a session. Acceptable.
- Integration tests (`session.int.test.ts`, `viewer.int.test.ts`) cover: session id changes on login and register,
  logout invalidates the old cookie, a deleted user's cookie becomes a guest, password change logs out a second agent,
  cookie name and flags, Redis content has no PII.
- Expiry tests need no sleeping for minutes: the idle test runs with `idleMs: 1000` and asserts the key's TTL with
  `redis.pTTL()` right after a request (between 0 and 1000) and that it is renewed by the next request; the absolute
  test advances the fake clock past `absoluteMs`.
- **No-500 regressions:** a stale cookie (user deleted, or `session_version` bumped) on `GET /login`, `GET /register`
  and `GET /` returns 200 with the guest page; a `POST /profile/edit` after absolute expiry returns 403 (CSRF bound to
  the old id) or 303, never 500; a ghost cookie on a POST with a valid old token returns 403, never 500.
