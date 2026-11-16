# ADR 0008: SSR form handling (Result types, PRG, 422 re-render, flash) and the error model

- Status: Accepted (reviewed in the architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-13, B-20, B-21, B-24, B-26, B-29, B-43, B-48, B-54, B-56, B-68, F-08, F-09, F-17, F-19, F-20, F-21, F-61, F-62

## Context

Legacy swallowed every database error and left requests hanging (B-20, B-21), validated by provoking database errors
(B-56), reported every failure as "email already taken" (B-24), redirected even when a save failed (B-29), redirected
unknown paths to `/home` (B-43) and printed Express's default stack-trace page (B-13).

The skill's rule: no try/catch for flow control in handlers; Express 5 forwards rejected promises.

## Decision

**Expected outcomes are values, unexpected ones are exceptions.**

- `parseForm(schema, body)` in `src/shared/http/form.ts` returns
  `{ ok: true, data } | { ok: false, errors: FieldErrors, values }`. `FieldErrors` maps field name to one message.
  `values` holds the submitted strings for re-rendering, with every password field removed.
- Services return discriminated unions for expected business outcomes, for example
  `{ ok: false, reason: 'email-taken' }` or `{ ok: false, reason: 'wrong-password' }`. Unique violations (`23505`,
  found through the Drizzle error `cause` chain by `isUniqueViolation`) are translated inside the service into such a
  result, never leaked.
- Controllers branch on the result: success means `303 See Other` to the next page (PRG) plus an optional flash;
  failure re-renders the same view with **422** (validation and business rule) or **401** (login, F-24), the field
  messages, an error summary and the kept values.
- Repository delete methods return `boolean` (row count above 0), never `rows[0]` (B-54).

**Error summary (F-21).** Partial `error-summary.hbs`: `<div class="error-summary" role="alert" tabindex="-1"
autofocus>` with heading "There is a problem" and a list of links `#<field-id>`. Each field gets
`aria-invalid="true"` and `aria-describedby="<id>-error"`. `autofocus` moves focus without JavaScript.

**Rendering.** Every HTML page goes through `renderPage(req, res, view, model, status)` (`src/shared/view/render.ts`,
ADR 0003). It adds `viewer`, `csrfToken` and `flash` to the model at render time, so re-renders and error pages get the
same layout data as successful GETs. `res.render` is banned outside `render.ts` by ESLint.

**Flash (F-17).** `setFlash(req, message)` writes `{ message }` into the session. `renderPage` reads it, deletes it and
passes it to the layout's `role="status"` region, so it is consumed **only by a request that renders a page**: a
request that only redirects (303, guard 302) leaves it for the next page. Messages are fixed strings from code, never
user input. There is no `exposeFlash` middleware.

**Unexpected errors.** `AppError` hierarchy from the skill (`ValidationError` 400, `UnauthorizedError` 401,
`ForbiddenError` 403, `NotFoundError` 404, `ConflictError` 409, `PayloadTooLargeError` 413, `TooManyRequestsError`
429). `toProblem()` maps them, plus body-parser (`entity.too.large` 413, `entity.parse.failed` 400) and csrf-csrf
(`EBADCSRFTOKEN` 403) errors, and everything else to 500 "An unexpected error occurred."
`errorHandler` content-negotiates: `req.accepts(['html', 'json']) === 'html'` renders `pages/error` through
`renderPage` with the status, a title and a next step (the viewer is already known, because `loadViewer` runs before
the limiter, the body parsers and CSRF; when `req.session` is absent, for example on an error inside the session
middleware itself, it renders the guest layout without a token); otherwise `application/problem+json` (RFC 9457, `type`
`tag:arnoldovna.github.io,2026:petition:problem:<code>`). Stacks only go to the log. If headers were sent, delegate
to Express's default (connection close).

**404.** `notFoundHandler` after all routers: status 404 and the "Page not found" page (F-08). `/home` gets an explicit
301 to `/` (B-44). Real favicon and manifest files exist, so browsers no longer cause 404 noise (B-43).

## Alternatives considered

- **Throw `ValidationError` and catch in a form-aware error handler.** Rejected: the error handler would need to know
  which view and values to re-render.
- **422 vs 400 for form errors.** 422 is the established choice for semantically invalid form submissions and is what
  F-41/F-42 specify.

## Consequences

- Every controller test asserts status, `Location` and the presence of the error summary and field messages, and that
  a 422/401 body contains a non-empty `_csrf` that is accepted on resubmit (ADR 0003).
- `error-pages.int.test.ts` asserts that 413, 429 and CSRF 403 pages show the signed-in navigation for a signed-in
  agent, and that a flash set before a redirect-only request is still shown on the following page.
- `@typescript-eslint/no-floating-promises` (strictTypeChecked) prevents the unreturned-promise class of bugs (B-21).
