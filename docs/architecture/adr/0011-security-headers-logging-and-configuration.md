# ADR 0011: Security headers, structured logging and validated configuration

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-02, B-03, B-10, B-12, B-15, B-16, B-57, B-58, F-15, F-71, F-72, F-73, F-74

## Context

Legacy had committed credentials and a hard-coded session secret (B-02, B-03), no security headers (B-10), logged
password hashes and personal data with about 40 `console.log` calls (B-12, B-58), mixed hard-coded configuration
(B-57) and hard-coded private contact data in the footer (B-15).

## Decision

**Headers (helmet 8.3)** with an explicit CSP instead of helmet's default directives:

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none';
manifest-src 'self'; upgrade-insecure-requests (only when served over https)
```

plus helmet's HSTS (only when served over https), `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin`, frameguard deny.
`app.disable('x-powered-by')`. No CORS middleware: the app is same-origin only.

**One "served over https" switch.** `isHttps(env)` (= `COOKIE_SECURE`, default `NODE_ENV === 'production'`) decides
secure cookies and `__Host-` prefixes (ADR 0002, 0003), HSTS and `upgrade-insecure-requests`. NODE_ENV alone never
does. The local compose stack runs the production image over plain http with `COOKIE_SECURE=false`, so it sends
neither HSTS nor `upgrade-insecure-requests`; otherwise browsers that apply UIR to `127.0.0.1` (WebKit/Safari) would
rewrite `/assets` and `/fonts` to `https://127.0.0.1:3000` and a reviewer would see an unstyled page.
`headers.int.test.ts` covers both switch positions in `NODE_ENV=production`.

**Logging (pino 10, pino-http 11)**

- Request id: a well-formed incoming `x-request-id` (`/^[\w-]{8,128}$/`) or a UUID, echoed in the response.
- Redaction paths: `req.headers.cookie`, `req.headers.authorization`, `req.headers["x-csrf-token"]`,
  `res.headers["set-cookie"]`, `*.password`, `*.currentPassword`, `*.newPassword`, `*.passwordHash`, `*.email`,
  `*._csrf`, `*.signature`, `*.image`, `*.typedName`. Request bodies are never logged. The app reads the CSRF token
  only from the `_csrf` form field (ADR 0003), but a client may still send it as a header, so that header is redacted
  too (Etappe 3 security review).
- Domain events log ids only: `user.registered {userId}`, `user.logged_in {userId}`, `user.logged_out {userId}`,
  `signature.created {userId, method}`, `signature.rejected {userId, reason}`, `signature.deleted {userId}`,
  `profile.updated {userId, emailChanged, passwordChanged}` (onboarding and edit; the flags make an email or password
  change, the key step of an account takeover, visible without logging the address), `account.deleted {userId}`,
  `auth.login_failed` (no email), `rate_limit.hit {limiter}`, `rate_limit.relaxed {limiter, max}` (startup, ADR 0012),
  `account.erased {userId}` (manual erasure, ADR 0016). Phase 5e aligned the code to these names (security review
  L1); `user.logged_out` and `signature.rejected` were added to this list from the code.
- 5xx at `error` with the error object; 4xx at `warn` without stack; health checks not logged.
- `no-console` is an ESLint error (B-58). Development uses `pino-pretty` as a transport.

**Configuration**

- `src/config/env.ts` is the only reader of `process.env` (plus tooling entry points: `db/migrate.ts`,
  `tools/seed.ts`, `tools/erase-user.ts`, `tools/smoke-canvas.ts`, `drizzle.config.ts`, `playwright.config.ts` and
  `scripts/*.mjs`). Zod schema, fail-fast at startup, error message lists keys only.
- `.env.example` with empty secret values; `.env*` gitignored; gitleaks in lefthook pre-commit and in CI over the
  full history (B-02).
- Footer contact link from `CONTACT_URL` (default `https://github.com/Arnoldovna`); no phone number, no private email
  anywhere in markup (B-15). Footer credit text: "a nonsense petition by Arnoldovna". Footer also links to `/privacy`
  and, when `IMPRINT_URL` is set, to the imprint (ADR 0016).

**Health (F-74, amended).** The skill template's two routes only: `GET /health/live` (process up) and
`GET /health/ready` (database `select 1` and Redis `isReady`; 200 or 503; 503 while shutting down). Mounted before
helmet, sessions and limits; no dependency details in the body. The first draft also added a `/healthz` alias for the
literal F-74 wording; after critique, F-74 is amended to `/health/ready` instead (OVERVIEW.md section 2.2), so there is
one readiness path in the app, the compose healthcheck and Playwright.

## Consequences

- Any new inline `<script>` or `style=""` breaks under CSP; the E2E suite fails on CSP console errors.
- The Playwright suite asserts the headers on one HTML response and on `/assets/*`.
