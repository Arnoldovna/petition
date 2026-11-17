# ADR 0009: Password policy, argon2id with bounded concurrency, constant-path login and re-authentication

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-09, B-11, B-12, B-22, B-23, B-34, B-49, B-52, F-19, F-20, F-23, F-24, F-27, F-60, F-63, F-67

## Context

Legacy accepted 1-character passwords, used bcrypt (72-byte truncation), showed the new password in clear text on the
edit page, allowed email and password changes without the current password and deleted accounts with one click
(B-11, B-34). Login leaked whether an email exists, by page and by timing (B-09, B-23), and hung for users without a
signature (B-22).

F-19 says 10 to 128 characters. The `express-feature-module` skill's non-negotiable says at least 12.

The critique raised three points: argon2id with 64 MiB per hash and no concurrency limit lets 10 to 20 parallel auth
requests from different IPs push a small container out of memory; auth and profile both wrote password hashes and
checked current passwords on their own; and the "register double submit as login" branch was practically unreachable
(without JS the second POST fails CSRF after the first regenerated the session; with JS `form-guard.ts` prevents it)
while adding a second password-checking endpoint.

## Decision

- **Length 12 to 128 characters**, no composition rules, never trimmed. 12 follows the skill and current OWASP
  guidance for accounts without MFA; 128 caps hashing input. **FEATURES F-19 is amended from 10 to 12** (OVERVIEW.md
  section 2.2); the E2E and integration tests use the amended value.
- argon2id with the skill's pinned parameters `memoryCost 65536, timeCost 3, parallelism 4` (above the OWASP minimum
  m=19456, t=2, p=1, and identical in all three projects). `needsRehash` on login stores a fresh hash.
- **Bounded hashing.** `createHasher({ maxConcurrent: 2, maxQueue: 64 })` in `src/shared/auth/password.ts` wraps
  `hash` and `verify` (including the dummy-hash verify for unknown emails) in a small semaphore. At most two hashes
  run at once, so peak hashing memory is 128 MiB. A request that finds 64 others already waiting gets
  `TooManyRequestsError` with `Retry-After: 5` (the 429 page). The runtime container needs at least **384 MiB** of memory; this is noted in
  the compose file and in the deploy job. Unit test: with a fake slow hash, a third concurrent call waits, the 65th
  queued call is rejected.
- **Login uses one code path:** `findForLogin(email)` returns `{ id, passwordHash, hasSigned } | undefined` in one
  query (`users LEFT JOIN signatures`, B-52). Always `verify(user?.passwordHash ?? timingDummyHash, password)`.
  Unknown email and wrong password give the same view, status 401 and message "Email or password is incorrect"
  (F-24). The redirect target is computed from `hasSigned` (B-22) or a safe `returnTo`.
- **Registration with an existing email** always shows the F-20 message (422, "An account with this email already
  exists." plus "log in instead"), whatever the password. There is no register-as-login branch (B-49 is handled by
  `form-guard.ts` and the CSRF behaviour described in OVERVIEW.md section 22).
- **Credentials belong to auth** (ADR 0001). `src/features/auth/credentials.ts` (created in phase 1, owned by auth
  afterwards) exports:
  - `verifyCurrentPassword(userId, password): Promise<boolean>` (uses the bounded hasher; `needsRehash` handled),
  - `hashNewPassword(password): Promise<string>` (call **before** opening a transaction),
  - `apply(tx: DatabaseTransaction, userId, { email?, passwordHash? })`: one `UPDATE users` inside a savepoint of the
    caller's transaction; a new hash increments `session_version`. Result
    `{ ok: true, sessionVersion } | { ok: false, reason: 'email-taken' | 'not-found' }`: 23505 on
    `users_email_lower_idx` gives `email-taken` and rolls back only the savepoint, so the caller's transaction stays
    usable; `sessionVersion` is the value to re-establish the current session with after a password change.
    Account deletion (auth) and profile edit (profile, injected through `app.ts`) both use it, so the
    current-password rule and the session-version bump exist once.
- **Re-authentication** with the current password for: changing email, changing password (F-63) and deleting the
  account (F-67). These POSTs share the per-user `reauth` limiter (ADR 0012) to stop password guessing through a
  hijacked session.
- Password change re-establishes the current session (`establishSession`, ADR 0002) after the transaction commits.
- `autocomplete`: `current-password` on login and re-auth fields, `new-password` on register and the new-password
  field (F-60, B-71). The edit page's new-password field is `type="password"` and always empty.
- Passwords, hashes and emails are redacted in logs (ADR 0011).

## Alternatives considered

- **Keep F-19's 10.** Rejected: contradicts the project-wide skill rule and weakens all three projects' consistency.
- **Breached-password check (HIBP k-anonymity API).** Deferred: third-party request at registration; possible later.
- **OWASP minimum parameters (m=19 MiB, t=2, p=1) instead of a semaphore.** Would also fix the memory risk, but the
  three projects share one hasher template; the semaphore keeps the stronger parameters and bounds memory regardless
  of parameters.
- **Keep register-double-submit-as-login.** Rejected after critique (see context).

## Consequences

- Seeds read `SEED_DEMO_PASSWORD`, which must be at least 12 characters (validated).
- Unit tests: dummy-hash path is taken for unknown emails (fake hasher records calls), rehash on outdated parameters,
  re-auth required exactly when email or password changes, the semaphore bounds and rejects as above,
  `credentials.apply` bumps `session_version` only when the hash changes.
