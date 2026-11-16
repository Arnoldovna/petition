# ADR 0012: Configurable rate limits per IP subnet, per keyed email hash and per user, stored in Redis

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-10, F-26

## Context

Legacy had no rate limiting (B-10). F-26 asks for limits on login and registration per IP and per email, with a
readable 429 page.

The first draft hard-coded every limit and copied the skill template's `ipv6Subnet: 56` next to custom key
generators. The critique showed three problems:

- With hard-coded limits, the integration suite (many POSTs from `::ffff:127.0.0.1`) and the E2E suite (every request
  from the Docker gateway IP, `TRUST_PROXY=0`) hit 429 after the 10th auth request. A red suite pushes builders
  towards weakening tests.
- express-rate-limit 8.7.4 ignores `ipv6Subnet` when a custom `keyGenerator` is set (it logs "Incompatible options")
  and raises `ERR_ERL_KEY_GEN_IPV6` when a key generator returns a raw `req.ip`. Every IPv6 /128 address would get its
  own bucket, so an attacker rotating addresses inside their own /64 bypasses the IP limits.
- An unsalted SHA-256 of a low-entropy email is reversible with a dictionary, and counting successful logins lets
  anyone keep a known user locked out with 10 junk attempts per 15 minutes from any IPs.

## Decision

### Configuration

`RateLimitConfig` is part of `AppDeps` (built in `container.ts` from env, built in `test/test-app.ts` from overrides):

```ts
interface RateLimitConfig {
  globalPerMinute: number;        // RATE_LIMIT_GLOBAL_MAX, default 300
  authPer15Min: number;           // RATE_LIMIT_AUTH_MAX, default 10 (auth-ip, register-email, login-email-subnet)
  loginEmailPerHour: number;      // 10 x authPer15Min (derived, default 100)
  reauthPer15Min: number;         // fixed 5 in production
  signPerHour: number;            // fixed 20 in production
}
```

- Env keys `RATE_LIMIT_GLOBAL_MAX` (int 1..100000, default 300) and `RATE_LIMIT_AUTH_MAX` (int 1..100000, default
  10). Production defaults need no configuration. When either value is above its default the app logs one
  `rate_limit.relaxed` warning at startup, so a relaxed production deployment is visible.
- Windows are fixed in code (1 minute, 15 minutes, 1 hour). Only the maxima are configurable.
- `createTestApp(overrides?)` defaults every limit to 10,000 and uses a **fresh store prefix per call**
  (`test-${randomUUID()}`), so no file and no app instance shares counters. Only
  `src/shared/security/__tests__/rate-limit.int.test.ts` passes the production defaults (`productionRateLimits` exported
  from `security.ts`) and asserts the 11th attempt, the 429 page, `Retry-After` and the per-email behaviour across IPs
  (Supertest sets `X-Forwarded-For` with `TRUST_PROXY=1` in that file only).
- The E2E stack (`docker-compose.e2e.yml`, ADR 0017) sets `RATE_LIMIT_GLOBAL_MAX=100000` and
  `RATE_LIMIT_AUTH_MAX=100000`. The 429 page is asserted in integration tests only, never in E2E.

### Keys

All key generators live in `src/shared/security/rate-limit-keys.ts` (pure, unit-tested):

```ts
import { ipKeyGenerator } from 'express-rate-limit';

export const keyByIp = (req: Request) => ipKeyGenerator(req.ip ?? '', 56);   // IPv4 as is, IPv6 as its /56
export const keyByUser = (req: Request, res: Response) => `u:${res.locals.viewer!.userId}`;
export const keyByEmail = (secret: Buffer) => (req: Request) =>
  emailKey(secret, req.body?.email) ?? keyByIp(req);                         // HMAC, falls back to the subnet key
export const keyByEmailAndSubnet = (secret: Buffer) => (req: Request) =>
  `${emailKey(secret, req.body?.email) ?? 'none'}:${keyByIp(req)}`;
```

- `emailKey` normalises the email exactly like the form schema (trim, lower-case) and returns
  `HMAC-SHA256(secret, email)` as base64url. The secret is derived once at startup with HKDF-SHA256 from the first
  `SESSION_SECRET` entry (`info: 'petition:rate-limit-email'`), so no new env key is needed. Rotating the session
  secret resets the email counters, which is acceptable. Redis therefore holds no reversible email.
- **No limiter sets `ipv6Subnet`.** Every limiter passes an explicit `keyGenerator`, and every IP-based key goes
  through `ipKeyGenerator(..., 56)`. The skill template's `ipv6Subnet: 56` is not copied (see "Skill follow-up").
- Unit tests (`rate-limit-keys.test.ts`): two IPv6 addresses in the same /56 give one key, addresses in different /56
  give different keys, IPv4 and IPv4-mapped IPv6 (`::ffff:127.0.0.1`) are stable, an email with surrounding spaces and
  upper case gives the same HMAC as its normalised form, the HMAC never contains the email, a missing email falls
  back to the subnet key. An integration test asserts that the app logs no express-rate-limit validation warning
  (`ERR_ERL_*`) at startup.

### Limiters

`express-rate-limit` 8.7 with `rate-limit-redis` 6 stores (one store and prefix per limiter:
`petition:rl:<name>:`), `standardHeaders: 'draft-8'`, `legacyHeaders: false`, rejection routed to
`next(new TooManyRequestsError())`, which renders the 429 page ("Too many attempts. Please wait a few minutes, then
try again.") with `Retry-After` (windows differ per limiter, so the text names no fixed duration).

| Limiter | Applies to | Key | Counts | Limit (production) |
|---|---|---|---|---|
| `global` | every non-static request | `keyByIp` | all | `globalPerMinute` (300) per minute |
| `auth-ip` | `POST /login`, `POST /register` | `keyByIp` | all | `authPer15Min` (10) per 15 minutes |
| `register-email` | `POST /register` | `keyByEmail` | all | `authPer15Min` (10) per 15 minutes |
| `login-email-subnet` | `POST /login` | `keyByEmailAndSubnet` | failed only (`skipSuccessfulRequests: true`) | `authPer15Min` (10) per 15 minutes |
| `login-email` | `POST /login` | `keyByEmail` | failed only | `loginEmailPerHour` (100) per hour |
| `reauth` | `POST /profile/edit` with a current password, `POST /account/delete` | `keyByUser` | all | `reauthPer15Min` (5) per 15 minutes |
| `sign` | `POST /signature` | `keyByUser` | all | `signPerHour` (20) per hour |

- "Failed" for the login limiters means a response status of 400 or above (401 wrong credentials, 422 validation).
  A successful login (303) does not count, so the owner of an account never consumes their own budget.
- Lockout analysis: an attacker who knows a user's email can block that email only from their own /56 subnet
  (`login-email-subnet`). Blocking the user everywhere needs more than 100 failed attempts per hour, which with
  `auth-ip` at 10 per 15 minutes needs at least three distinct /56 subnets per hour, while distributed password
  guessing against one account stays capped at 100 attempts per hour. Accepted for this app.
- `register-email` counts every attempt: repeatedly registering a victim's address only blocks registering that
  address, which already exists.
- `trust proxy` must be configured correctly (`TRUST_PROXY`); otherwise every user shares the proxy's IP. The E2E stack
  runs with `TRUST_PROXY=0`, which is why it raises the limits instead.

## Alternatives considered

- **Keep hard-coded limits and space out tests.** Rejected: slow, flaky and it still fails on a second `pnpm verify`.
- **`ipv6Subnet: 56` with the default key generator for IP limiters.** Equivalent for the IP limiters, but the email
  fallback and the email-plus-subnet key need the same subnet logic, so one explicit `keyByIp` everywhere is simpler
  to reason about and to test.
- **Separate `RATE_LIMIT_SECRET`.** Rejected: one more secret to generate and rotate for a key that only needs to be
  non-reversible; HKDF from the session secret gives domain separation.
- **Count successful logins too.** Rejected: it enables the lockout described in the context.

## Consequences

- `AppDeps` gains `rateLimits: RateLimitConfig`; every limiter in `app.ts` and in the feature routers reads its
  maximum from there.
- `.env.example` documents the two keys with their production defaults; `scripts/setup-env.mjs` does not change them.
- **Skill follow-up (outside this repository):** the `express-feature-module` template `security.ts` sets
  `ipv6Subnet: 56` and the reference keys on raw `req.ip`. The template should export `keyByIp` as above. petition does
  not copy that part of the template.
