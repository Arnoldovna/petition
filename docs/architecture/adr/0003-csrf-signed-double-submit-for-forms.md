# ADR 0003: CSRF with csrf-csrf (signed double submit, form field) and POST-only state changes

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-08, B-13, B-14, B-59, F-21, F-25, F-61, F-70

## Context

Legacy used `csurf` (deprecated, archived, B-14), logged out with a GET (B-08), mounted CSRF before static files
(B-59) and leaked stack traces on token errors (B-13).

The first draft issued tokens only on successful GETs (`exposeCsrfToken` middleware for signed-in HTML GETs, guest
GET handlers for `/login` and `/register`). Every 422 or 401 re-render after a POST then rendered an empty `_csrf`
field and an empty logout form: the user fixed the error, resubmitted and got the 403 "This form has expired" page.

## Decision

- `csrf-csrf` 4.1 `doubleCsrf`, bound to the session id (`getSessionIdentifier: req => req.session.id`), secret
  `CSRF_SECRET` (at least 32 characters), cookie `__Host-petition.x-csrf-token` (https) or `petition.x-csrf-token`
  (local http), `httpOnly`, `sameSite: 'lax'`, `path: '/'`.
- **Token source: form field only** (`req.body._csrf`), never a header fallthrough. Every form includes the partial
  `{{> csrf-field}}` (`<input type="hidden" name="_csrf" value="{{csrfToken}}">`).
- Middleware order (OVERVIEW.md section 5.1): static files, session, absolute lifetime, viewer, global limiter, body
  parsers, `cookie-parser`, then CSRF protection. Static requests never touch the session or CSRF.
- **Token issuing happens at render time, in one place.** `renderPage(req, res, view, model, status = 200)` in
  `src/shared/view/render.ts` is the only way any HTML page is rendered, by controllers and by the error handler
  alike. It adds `viewer`, `flash` (read and deleted, ADR 0008) and `csrfToken` to the model, then calls
  `res.status(status).render(...)`. `csrfToken` is generated (`generateCsrfToken(req, res)`) when:
  - a viewer exists (the nav contains the logout form), or
  - the session is bound (`req.session.csrfBound`), which guest form pages ensure.
    Guest GET handlers that render a form (`/login`, `/register`) call `await bindAnonymousSession(req)` (sets
    `csrfBound`, saves) before `renderPage`. Their POST re-renders already have a bound session, because the CSRF check
    passed. Home, about, privacy and error pages never create sessions for guests.
    So every 422 and 401 re-render, and every error page shown to a signed-in user, carries a valid token.
- After `establishSession` or `endSession` the next GET renders a fresh token (PRG). The old token is invalid
  because the session id changed (tested).
- Every state change is a POST: logout, signature delete, account delete, profile updates, sign. GET handlers never
  write (except the session binding above).
- A missing or invalid token produces csrf-csrf's `ForbiddenError` (`code: 'EBADCSRFTOKEN'`). The error handler maps it
  to a 403 HTML page "This form has expired" with a link back, never a stack trace.
- `csrf-csrf` reuses one token per session (`overwrite: false`). Dynamic HTML is not compressed by the app
  (ADR 0010), so the token is not exposed to BREACH-style length oracles next to reflected input.

## Alternatives considered

- **csrf-sync (synchronizer token in the session).** Recommended by the csrf-csrf README for session apps. PLAN.md and
  the `express-feature-module` skill chose csrf-csrf; binding it to the session id gives equivalent protection and keeps
  one CSRF implementation across the three projects.
- **SameSite=Lax only.** Rejected: defence in depth, and Lax still allows top-level POST navigations from some
  contexts in older browsers.
- **A lazy `res.locals.csrfToken` getter.** Works with Handlebars, but hides a side effect (cookie write) in a
  property read. One explicit `renderPage` helper is easier to test and to grep for; ESLint bans `res.render` outside
  `render.ts` (`no-restricted-syntax`).
- **A new token per HTML render** (against BREACH). Not needed once dynamic HTML is not compressed.

## Consequences

- A form left open past the idle timeout fails with the 403 page. The page tells the user what to do.
- Integration tests for every POST route include "missing token" and "token from another session" cases.
- `csrf.int.test.ts` and each form's integration test include the **resubmit round trip**: post an invalid form, read
  `_csrf` from the 422 (or 401) body, post a valid form with it, expect 303. The same for the logout form on a 422 page
  of a signed-in user.
