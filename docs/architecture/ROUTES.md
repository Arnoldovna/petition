# petition: Routes

Server-rendered HTML only. There is no JSON API and no socket event (F-10). Every route below is the complete list;
anything else is the 404 page (F-08). Middleware order and guard semantics are in OVERVIEW.md sections 5 and 12.

## 1. Conventions

**Guards** (`src/shared/auth/guards.ts`, all read `res.locals.viewer`, enforced on GET **and** POST, F-07):

| Guard | Passes when | Otherwise (GET) | Otherwise (POST) |
|---|---|---|---|
| `requireAuth` | viewer exists | 302 `/login?returnTo=<encoded originalUrl>` | 303 `/login` |
| `requireGuest` | no viewer | 302 `/thank-you` if `hasSigned`, else `/signature` (F-22) | 303, same target |
| `requireSigned` | `viewer.hasSigned` | 302 `/signature` | 303 `/signature` |
| `requireNotSigned` | `!viewer.hasSigned` | 302 `/thank-you` (F-44) | 303 `/thank-you` (F-43, idempotent) |

**Forms.** Every form is `method="post"`, `novalidate` (server validation is the authority; native constraint UI would
pre-empt the accessible error summary), `data-guard` (double-submit guard, F-75), and contains `{{> csrf-field}}`. The
body is `application/x-www-form-urlencoded`. Success is `303 See Other` (PRG). Validation failure re-renders the same
view with **422**, an error summary that receives focus, inline field messages and the submitted values (never
passwords) (F-21, ADR 0008). Every page, including every 422/401 re-render and every error page, is rendered through
`renderPage`, which adds a fresh `csrfToken`, the `viewer` and the one-time `flash` (ADR 0003), so a corrected form
can be resubmitted.

**CSRF.** Every POST requires a valid `_csrf` (ADR 0003). Missing or invalid: **403** error page "This form has
expired".

**Headers on dynamic HTML:** `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, CSP and security
headers (ADR 0011), `x-request-id`.

**Field rules** (`src/shared/validation/fields.ts`, Zod 4). Messages are the exact user-facing strings.

| Field | Rule | Message(s) |
|---|---|---|
| `firstName`, `lastName` | NFC, trim, collapse whitespace, 1..100, no control characters | "Enter your first name" / "Enter your last name"; "First name must be 100 characters or fewer" (same for last) |
| `email` | `z.string().trim().toLowerCase()`, 1..254, then `.pipe(z.email())` (normalise before the format check, ADR 0007) | "Enter an email address"; "Enter a valid email address, like name@example.com" |
| `password` (new) | string, not trimmed, 12..128 (ADR 0009) | "Enter a password"; "Password must be at least 12 characters"; "Password must be 128 characters or fewer" |
| `currentPassword` | string, at least 1 | "Enter your current password" |
| `age` | `''` -> `null`; else `^\d{1,3}$` -> integer 1..120 | "Age must be a whole number between 1 and 120" |
| `city` | `''` -> `null`; NFC, trim, collapse whitespace, 1..100 | "City must be 100 characters or fewer" |
| `homepage` | `''` -> `null`; trim; prepend `https://` only when no `scheme:` prefix is present; `new URL()`; protocol `http:` or `https:`; host contains a dot; no username or password; `href` at most 300 | "Enter a web address like https://example.com" |
| `returnTo` | optional; starts with `/`, not `//` or `/\`; resolves to the same origin; at most 512 | invalid values are silently dropped (no open redirect) |
| `typedName` | NFC; `’` and `ʼ` become `'`; trim; collapse whitespace; 2..60; starts with a letter; only spaces, `.`, `'`, `-` and letters or marks contained in the shipped signature fonts' glyph set (`glyphs.generated.ts`, ADR 0005) | "Type your full name"; "Use letters, spaces, hyphens, apostrophes and full stops only"; "We cannot draw some letters of this name yet. Type it in Latin, Greek or Cyrillic letters, or draw your signature." |
| `signature` | see ADR 0004 pipeline | "Please sign before submitting"; "The signature could not be read. Clear the pad and sign again." |
| `page` (query) | absent -> 1; `^\d{1,5}$` -> integer 1..10000 | invalid -> 404 page |
| `city` (param) | decoded by Express, normalised like `city` | empty or longer than 100 -> 404 page |

## 2. Public pages (`features/pages`)

### GET `/`
- Guard: none. Session: not created for guests.
- View: `pages/home`. Title "Home". Content: intro "A nonsense petition for absolutely nothing." and a list of rows
  linking to `/register`, `/login`, `/profile`, `/signature`, `/supporters`, `/account/delete` (F-12, B-42). Signed-in
  viewers see the same rows; guarded targets redirect as defined above.
- 200.

### GET `/home`
- 301 `Location: /` (B-44).

### GET `/privacy`
- Guard: none. Session: not created for guests. View `pages/privacy`, title "Privacy". Content per ADR 0016 (F-88):
  operator and contact, data stored, who sees what, purpose, retention, deletion and erasure on request, rights.
  Linked from the footer on every page and from the register and onboarding forms.
- 200.

### GET `/about`
- Guard: none. View `pages/about`, title "About". Describes the rebuild and lists the stack as rows (F-13): Node 26,
  Express 5, TypeScript 6, express-handlebars, PostgreSQL 18 + Drizzle ORM, Redis sessions, Zod, argon2id,
  Tailwind CSS 4, Schibsted Grotesk, Vitest, Playwright + axe, Docker, GitHub Actions.
- 200.

## 3. Authentication and account (`features/auth`)

### GET `/register`
- Guards: `requireGuest`. Calls `bindAnonymousSession`, renders a CSRF token.
- View `pages/auth/register`, title "Register". Fields: `firstName` (`autocomplete="given-name"`), `lastName`
  (`family-name`), `email` (`type="email"`, `autocomplete="email"`), `password` (`type="password"`,
  `autocomplete="new-password"`, hint "At least 12 characters"). Disclosure next to the submit button: "Your name
  appears on the supporters list, which registered users can see. Details: privacy." (F-90). Link "Already
  registered? log in".
- 200.

### POST `/register`
- Guards and middleware: `requireGuest`, limiters `auth-ip` and `register-email` (ADR 0012), CSRF.
- Body: `{ _csrf, firstName, lastName, email, password }`.
- Success (new account): `establishSession`, 303 `/profile` (F-18).
- An existing email always gives the "email taken" error below, whatever the password (no register-as-login branch,
  ADR 0009).
- Errors:
  - 422 validation: field messages, values kept except password (F-19, F-21, B-24).
  - 422 email taken: field error on `email` "An account with this email already exists." plus link "log in instead"
    to `/login`; names and email kept (F-20).
  - 429 rate-limited page (F-26). 403 CSRF.

### GET `/login`
- Guards: `requireGuest`. Query: `returnTo` (optional, validated). Binds anonymous session, CSRF token.
- View `pages/auth/login`, title "Log in". Fields `email` (`autocomplete="email"`), `password`
  (`autocomplete="current-password"`), hidden `returnTo` when valid. Link "No account yet? register".
- 200.

### POST `/login`
- Guards and middleware: `requireGuest`, limiters `auth-ip`, `login-email-subnet` and `login-email` (the last two count
  failed attempts only, ADR 0012), CSRF.
- Body: `{ _csrf, email, password, returnTo? }`.
- Success: `establishSession` (new id, F-23), rehash if needed, 303 to `returnTo` if valid, else `/thank-you` when the
  user has signed, else `/signature` (F-23, B-22).
- Errors:
  - 422 when a field is empty or the email is malformed (field messages).
  - **401** for unknown email or wrong password: same view, single message "Email or password is incorrect" in the
    error summary, email kept, constant code path with dummy hash (F-24, B-09, B-23).
  - 429, 403 CSRF.

### POST `/logout`
- Guards: `requireAuth`. CSRF. Body `{ _csrf }`. Rendered as a button in the nav (F-14, F-25, B-08).
- Success: `endSession(req, "You are logged out")` (old session deleted from Redis, new anonymous session carries the
  flash), 303 `/`.

### GET `/account/delete`
- Guards: `requireAuth`. View `pages/auth/account-delete`, title "Delete account". Explains that the account, profile
  and signature are deleted and the supporter count goes down; field `currentPassword`
  (`autocomplete="current-password"`); buttons "delete my account" (POST) and link "keep my account" to
  `/profile/edit` (F-67).
- 200.

### POST `/account/delete`
- Guards and middleware: `requireAuth`, limiter `reauth`, CSRF. Body `{ _csrf, currentPassword }`.
- Success: one transaction `DELETE FROM users` (cascade), `endSession(req, "Your account was deleted")`, 303 `/`
  (F-68, F-69).
- Errors: 422 "Enter your current password" / "The password is incorrect"; 429; 403 CSRF.

## 4. Profile (`features/profile`)

### GET `/profile`
- Guards: `requireAuth`. View `pages/profile/onboarding`, title "About you". Optional fields `age`
  (`type="text"`, `inputmode="numeric"`, `autocomplete="off"`), `city` (`autocomplete="address-level2"`), `homepage`
  (`type="url"`, `autocomplete="url"`), prefilled when a profile exists (F-33, F-36). Text: "Age, city and homepage
  are optional. If you add them, they appear next to your name on the supporters list." with a link to `/privacy`
  (F-90). Primary button "continue", secondary link "skip" to `/signature`.
- 200.

### POST `/profile`
- Guards: `requireAuth`, CSRF. Body `{ _csrf, age, city, homepage }`.
- Success: upsert (`ON CONFLICT (user_id) DO UPDATE`), empty fields stored as `NULL` (F-34), 303 `/signature`.
  Repeated submits never fail (F-36, B-28, B-49).
- Errors: 422 with field messages and kept values (F-35, B-26, B-27, B-18). 403 CSRF.

### GET `/profile/edit`
- Guards: `requireAuth`. View `pages/profile/edit`, title "Edit profile". Fields prefilled: `firstName`, `lastName`,
  `email`, `age`, `city`, `homepage`; empty `newPassword` (`type="password"`, `autocomplete="new-password"`, hint
  "Leave empty to keep your password"); `currentPassword` (`autocomplete="current-password"`, hint "Needed only when
  you change your email or password"). Links: "delete signature" to `/signature/delete` only when
  `viewer.hasSigned` (F-66, B-47), "delete account" to `/account/delete`.
- 200.

### POST `/profile/edit`
- Guards and middleware: `requireAuth`, limiter `reauth` (skipped when `currentPassword` is empty), CSRF.
- Body: `{ _csrf, firstName, lastName, email, age, city, homepage, newPassword, currentPassword }`.
- Rules: empty `newPassword` keeps the password; email change or new password requires a correct `currentPassword`,
  checked with auth's injected `credentials.verifyCurrentPassword` (F-63, ADR 0009); the new hash is computed before
  the transaction; names, email and password (`credentials.apply`) and the profile upsert run in one transaction
  (F-62, B-29); clearing optional fields stores `NULL` (F-65). A new password increments `session_version` and
  re-establishes the current session (ADR 0002).
- Success: 303 `/profile/edit`, flash "Profile updated" (F-62).
- Errors: 422 validation (F-61); 422 email taken "An account with this email already exists." and nothing is saved
  (F-64); 422 "Enter your current password to change your email or password"; 422 "The password is incorrect"; 429;
  403 CSRF.

## 5. Signature (`features/signature`)

### GET `/signature`
- Guards: `requireAuth`, `requireNotSigned` (F-44). Renders CSRF token.
- View `pages/signature/sign`, title "Sign the petition". Heading "Hey {{firstName}}" (F-37). Contains:
  - Drawing form (`hidden` until `signature-pad.js` enhances it): canvas with `role="img"`, accessible name
    "Signature pad", `aria-describedby` instructions, hidden input `signature`, hidden `method=drawn`, buttons
    "clear" (`button--text`) and "sign the petition" (`button--primary`, the only accent button on the page), alert
    region for client-side errors (F-38 to F-41, F-45).
  - `<noscript>` note: "Drawing a signature needs JavaScript. You can sign by typing your full name below." (F-45)
  - Typed form (always visible): heading "Sign by typing your full name", field `typedName`
    (`autocomplete="name"`), hidden `method=typed`, button "sign with my typed name" (`button--outlined`, with and
    without JavaScript, ADR 0014) (F-45).
  - Canvas data attributes: `data-export-width="720" data-export-height="240"`.
- 200.

### POST `/signature`
- Body parser: route-scoped `express.urlencoded({ limit: '128kb' })` (ADR 0004).
- Guards and middleware: `requireAuth`, `requireNotSigned` (already signed: 303 `/thank-you`, F-43), limiter `sign`,
  CSRF.
- Body: discriminated union on `method`:
  - `{ _csrf, method: 'drawn', signature: 'data:image/png;base64,...' }`
  - `{ _csrf, method: 'typed', typedName }`
- Success: `insertIfAbsent` (`ON CONFLICT (user_id) DO NOTHING`), flash "Thank you, your signature was saved", 303
  `/thank-you`. A concurrent duplicate also gets 303 `/thank-you` (F-43, B-49).
- Errors: 422 on the sign view with the message in the error summary (blank, wrong format, wrong size, too large,
  corrupt; typed name rules) (F-41, F-42, B-19). 413 page when the body exceeds 128 kb. 429. 403 CSRF.

### GET `/signature/image.png`
- Guards: `requireAuth`; if `!viewer.hasSigned` 404 (an image URL must never return an HTML redirect).
- 200 `image/png`, body = stored bytes of the **current user only**, `Cache-Control: private, no-store`,
  `Content-Length`, `nosniff` (ADR 0004).

### GET `/thank-you`
- Guards: `requireAuth`, `requireSigned` (F-48, B-07).
- View `pages/signature/thank-you`, title "Thank you". Heading "Thank you for your signature", the image
  `<img src="/signature/image.png" alt="Your signature" width="720" height="240">` on an accent field, the count
  "1 supporter" / "1,284 supporters" (`plural`, `formatCount`) from `countSupporters()` (F-46, F-47), link
  "see all supporters" to `/supporters`, link "delete signature" to `/signature/delete` (F-50).
- 200.

### GET `/signature/delete`
- Guards: `requireAuth`, `requireSigned`. View `pages/signature/delete`, title "Delete signature": confirmation text,
  POST form with button "delete my signature", link "keep my signature" to `/thank-you` (F-50, ADR 0013).
- 200.

### POST `/signature/delete`
- Guards: `requireAuth`, `requireSigned` (not signed: 303 `/signature`, idempotent), CSRF. Body `{ _csrf }`.
- Success: delete own row only, flash "Your signature was removed", 303 `/signature` (F-49).

## 6. Supporters (`features/supporters`)

### GET `/supporters`
- Guards: `requireAuth` (F-51). Query `page`.
- View `pages/supporters/list`, title "Supporters" (page 1) or "Supporters, page 2". Heading "Supporters", total
  "64 supporters". `<ol class="supporter-list" start="{{firstNumber}}">` of `supporter-row` partials (F-52, F-54):
  full name (link to `homepageUrl`, same tab, `rel="noopener noreferrer nofollow ugc"`, when set), age when set, city
  link to `/supporters/city/<encoded>` when set (same tab), signing date. Pagination
  `<nav class="pagination" aria-label="Pagination">` with `aria-current="page"` (F-54). Empty state "No supporters
  yet. Be the first!" with a link to `/signature` when the total is 0 (F-55).
- 200; 404 for invalid or out-of-range `page`.

### GET `/supporters/city/:city`
- Guards: `requireAuth`. Params `city` (decoded, normalised). Query `page`.
- View `pages/supporters/city`, title "Supporters from {{city}}". Heading "Supporters from {{city}}" (escaped, never
  blank, B-33), count, list of rows without the city link (F-56), link "all supporters" to `/supporters`, pagination
  like the list (F-59). Empty state "No supporters from {{city}} yet" with the link back (F-58).
- 200; 404 for invalid `city` or out-of-range `page`.

## 7. Operations and static files

| Method | Path | Behaviour |
|---|---|---|
| GET | `/health/live` | 200 `{"status":"ok"}`; not logged |
| GET | `/health/ready` | 200 `{"status":"ok"}` when DB `select 1` and Redis `isReady` pass, else 503 `{"status":"unavailable"}`; 503 `{"status":"shutting-down"}` during shutdown (F-74, amended from `/healthz`) |
| GET | `/assets/<name>-<hash>.(css\|js\|js.map)` | hashed build output (`dist/public/assets`), `immutable`, 1 year, gzip/brotli |
| GET | `/fonts/schibsted-grotesk-*.woff2` | 30 days, compressed responses where useful |
| GET | `/favicon.svg`, `/apple-touch-icon.png`, `/icon-512.png`, `/site.webmanifest`, `/robots.txt` | 1 day (B-43) |

Static files are served before sessions, CSRF and rate limits (B-59) and never create a session. Only these static
routes are compressed; dynamic HTML is not (BREACH, ADR 0010).

Test-only: `POST /__test/sign-in` exists only in apps built by `test/test-app.ts` (ADR 0017); in every other build it
is the 404 page.

## 8. Error responses

Rendered by `src/shared/http/error-handler.ts` with `pages/error` through `renderPage` when the client accepts HTML,
otherwise `application/problem+json` (ADR 0008). Because the viewer is loaded right after the session, error pages
show the correct navigation for signed-in users, including 413, 429 and CSRF 403. Every page has the layout, landmarks, one `h1` and a next step.

| Status | Trigger | Title (h1) | Text | Next step |
|---|---|---|---|---|
| 400 | malformed body (body-parser) | "That request could not be read" | "Please go back and try again." | link home |
| 403 | CSRF token missing or invalid | "This form has expired" | "For your security, forms expire. Go back, reload the page and send it again." | link back (same-origin Referer) or home |
| 404 | unknown path, invalid page or city, image of a non-signer | "Page not found" | "Check the address, or go to the home page." | link home |
| 413 | body above the parser limit | "That was too much data" | "If you were signing, clear the pad and draw a smaller signature." | link to `/signature` |
| 429 | any limiter, or the password hasher queue is full (ADR 0009) | "Too many attempts" | "Please wait a few minutes, then try again." (`Retry-After` header) | link home |
| 500 | anything unexpected | "Something went wrong" | "Please try again in a moment." | link home |

401 is never rendered as a page for HTML routes: guards redirect instead; the 401 status is used only by the failed
login re-render (F-24).
