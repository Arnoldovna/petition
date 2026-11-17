# petition: Features and Acceptance Criteria

This document lists every user-facing feature of the legacy app (`_legacy/src/petition`, 2018) as testable acceptance criteria for the rebuild. The legacy code is reference only. Its defects are listed in [BUGS.md](./BUGS.md); where a criterion exists to fix a bug, the bug ID is given in brackets.

**Legend**

- No marker: behaviour the legacy app had (or tried to have). It must work correctly in the rebuild.
- **(new)**: an expectation the legacy app did not meet. It is required in the rebuild.
- **(changed)**: deliberate change of legacy behaviour; the reason is given.
- **(amended)**: criterion changed in the architecture review; the reason is in OVERVIEW.md section 2.2 and the ADR named.

**Product summary.** "Nonsense Petition" is a tongue-in-cheek petition "for absolutely nothing". A visitor registers, optionally adds profile details (age, city, homepage), signs with a hand-drawn signature on a canvas, sees a thank-you page with their signature and the supporter count, can browse all supporters (filterable by city), edit their profile, delete their signature, and delete their account.

---

## 1. Data model

### 1.1 Legacy schema (for reference)

| Table               | Columns                                                                                                                                     | Constraints                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `registered_users`  | `id SERIAL`, `first VARCHAR(255)`, `last VARCHAR(255)`, `email VARCHAR(255)`, `password VARCHAR(255)` (bcrypt hash), `created_at TIMESTAMP` | PK `id`; `email` UNIQUE (case-sensitive); all NOT NULL except `created_at`   |
| `save` (signatures) | `id SERIAL`, `signature TEXT` (PNG data URL), `user_id INT`, `created_at TIMESTAMP`                                                         | PK `id`; `user_id` UNIQUE, FK → `registered_users(id)` (no cascade)          |
| `user_profiles`     | `id SERIAL`, `age INT`, `city VARCHAR(100)`, `url VARCHAR(300)`, `user_id INT`                                                              | PK `id`; `user_id` UNIQUE NOT NULL, FK → `registered_users(id)` (no cascade) |

### 1.2 Rebuild schema (Drizzle migrations)

- **F-01** The schema is created only through versioned Drizzle migrations. No script drops tables. A seed script creates demo supporters for local development and E2E tests. **(new)** [B-60]
- **F-02** `users`: `id` (identity PK), `first_name`, `last_name` (text, NOT NULL, CHECK trimmed length 1–100), `email` (`citext` or unique index on `lower(email)`, NOT NULL, unique case-insensitively), `password_hash` (text, NOT NULL, argon2id), `created_at`, `updated_at` (`timestamptz`, default `now()`). [B-25, B-53, B-61]
- **F-03** `signatures`: `id`, `user_id` (UNIQUE, FK → `users.id` **ON DELETE CASCADE**), `image` (PNG bytes as `bytea`, or a validated data URL with a CHECK on length), `created_at timestamptz`. Exactly one signature per user is enforced by the database. [B-34, B-61]
- **F-04** `profiles`: `user_id` (PK and FK → `users.id` ON DELETE CASCADE), `age` (smallint, nullable, CHECK 1–120), `city` (text, nullable, CHECK trimmed length 1–100), `homepage_url` (text, nullable, CHECK length ≤ 300 and scheme `http`/`https`), `created_at`, `updated_at`. [B-27, B-61]
- **F-05** An index supports the case-insensitive city lookup (e.g. on `lower(city)`), and an index supports listing signatures ordered by `created_at, id`. [B-61, B-31]
- **F-06** Deleting a user removes their profile and signature in the same statement or transaction. No orphan rows can exist. [B-34]

## 2. Routes

### 2.1 Legacy routes (for reference)

| Method | Path                | Guard                 | Behaviour                                            |
| ------ | ------------------- | --------------------- | ---------------------------------------------------- |
| GET    | `/home`             | none                  | Intro page                                           |
| GET    | `/about`            | none                  | Tech-stack page                                      |
| GET    | `/register`         | guest only            | Registration form                                    |
| POST   | `/register`         | none                  | Create user, set session, redirect `/profile`        |
| GET    | `/login`            | guest only            | Login form                                           |
| POST   | `/login`            | none                  | Check password, redirect `/thankyou` or `/signature` |
| GET    | `/logout`           | none                  | Clear session, redirect `/register`                  |
| GET    | `/profile`          | logged in             | Optional profile form (onboarding)                   |
| POST   | `/profile`          | **none**              | Insert profile, redirect `/signature`                |
| GET    | `/profile/edit`     | logged in             | Edit form                                            |
| POST   | `/profile/edit`     | **none**              | Update user + profile, redirect `/supporter`         |
| GET    | `/signature`        | logged in, not signed | Canvas signature page                                |
| POST   | `/signature`        | **none**              | Insert signature, redirect `/thankyou`               |
| POST   | `/signature/delete` | logged in             | Delete own signature, redirect `/signature`          |
| GET    | `/thankyou`         | logged in             | Thank-you page, own signature, count                 |
| GET    | `/supporter`        | logged in             | List of all supporters                               |
| GET    | `/supporter/:city`  | logged in             | Supporters from one city                             |
| POST   | `/delete`           | logged in             | Delete account, redirect `/home`                     |
| GET    | `*`                 | none                  | Redirect everything else to `/home`                  |

### 2.2 Rebuild routes

| Method   | Path                     | Guard                 | Notes                                             |
| -------- | ------------------------ | --------------------- | ------------------------------------------------- |
| GET      | `/`                      | none                  | Home (`/home` → 301 `/`)                          |
| GET      | `/about`                 | none                  |                                                   |
| GET      | `/privacy`               | none                  | privacy notice, no session for guests **(new)**   |
| GET/POST | `/register`              | guest only            |                                                   |
| GET/POST | `/login`                 | guest only            |                                                   |
| POST     | `/logout`                | signed in             | (changed) was GET                                 |
| GET/POST | `/profile`               | signed in             | onboarding, upsert                                |
| GET/POST | `/profile/edit`          | signed in             |                                                   |
| GET/POST | `/signature`             | signed in, not signed |                                                   |
| GET      | `/signature/image.png`   | signed in, has signed | own signature image only, 404 otherwise **(new)** |
| GET/POST | `/signature/delete`      | signed in, has signed | confirmation page + POST **(new)**                |
| GET      | `/thank-you`             | signed in, has signed |                                                   |
| GET      | `/supporters`            | signed in             | paginated                                         |
| GET      | `/supporters/city/:city` | signed in             | `:city` URL-encoded                               |
| GET/POST | `/account/delete`        | signed in             | confirmation page + POST **(new)**                |
| GET      | `/health/live`           | none                  | liveness: the process only **(new)**              |
| GET      | `/health/ready`          | none                  | readiness: database and Redis **(new)**           |
| any      | unknown                  | none                  | 404 page **(changed)**                            |

- **F-07** Every route in table 2.2 exists, and every guard in the "Guard" column is enforced on **both** GET and POST. A request that fails a guard gets a redirect for page requests, not a database error. [B-06, B-07]
- **F-08** Unknown paths return HTTP 404 with a styled "Page not found" page that links home. They do not redirect. **(changed)** [B-43]
- **F-09** Unexpected errors return HTTP 500 with a generic styled page. No stack trace, SQL or internal message ever reaches the client. Every request gets a response; none hang. **(new)** [B-13, B-20, B-21]

## 3. Real-time events and uploads

- **F-10** The app has no real-time events (no WebSocket/SSE). Pages are server-rendered. Counts are correct at render time.
- **F-11** The only user "upload" is the signature drawing. It is submitted as a form field holding a PNG data URL. Rules are in section 7 (F-41 to F-44). No other file uploads exist.

## 4. Public pages, layout, navigation

- **F-12** `GET /` shows the petition intro ("nonsense petition for absolutely nothing") with links to register, log in, the profile, the signature page, the supporters page and account deletion. Every link points to an existing route. [B-42]
- **F-13** `GET /about` describes the project and lists the technologies of the **rebuild** stack.
- **F-14** A single navigation component adapts to the auth state. **(changed)** **(amended, ADR 0014)** [B-46]
  - Guest: brand/home, About, Log in, Register.
  - Signed in: brand/home, Supporters, Profile, Log out (a POST form button). For signed-in users, About moves to the footer.
  - The current page's link has `aria-current="page"`.
- **F-15** The footer shows the project credit, the current year (computed, not hard-coded) and a contact link taken from configuration. No phone number and no private email address appear in markup. **(changed)** [B-15]
- **F-16** Every page has a unique `<title>` in the form "<Page> · Nonsense Petition". **(new)** [B-45]
- **F-17** Flash messages confirm completed actions (signed, signature deleted, profile updated, logged out, account deleted). They are rendered in a `role="status"` region and shown once. **(new)** [B-48]

## 5. Registration and authentication

- **F-18** A guest can register with first name, last name, email and password. On success the account is created, the user is signed in (new session ID), and the user is redirected to `/profile`.
- **F-19** Server-side validation (Zod) with field-level messages. **(new)** [B-24]
  - First and last name: required, trimmed, 1–100 characters.
  - Email: required, valid format, ≤ 254 characters, trimmed and lower-cased before storage.
  - Password: required, 12–128 characters, never trimmed. **(amended, ADR 0009)**
- **F-20** If the email is already registered (case-insensitively), the email field shows "An account with this email already exists", with a link to log in. First name, last name and email are kept in the form. The password is never echoed back. [B-24, B-25]
- **F-21** On validation failure, an error summary at the top lists all errors as links to the fields and receives focus. Each invalid field has `aria-invalid="true"` and `aria-describedby` pointing to its message. **(new)** [B-68]
- **F-22** A signed-in user who opens `/register` or `/login` is redirected to `/thank-you` if they have signed, otherwise to `/signature`.
- **F-23** A user can log in with email (case-insensitive) and password. On success the session ID is regenerated and the user is redirected to `/thank-you` if they have signed, otherwise to `/signature`. This works for users with and without a signature. [B-22]
- **F-24** On failure (unknown email **or** wrong password), the login page is re-rendered with HTTP 401 and the single message "Email or password is incorrect". The email is kept. Response time does not reveal whether the email exists (dummy hash verification). [B-09, B-23]
- **F-25** Logout is a POST with a CSRF token. It deletes the server-side session; the browser gets a new anonymous session id that only carries the flash message. It redirects to `/` with a "You are logged out" message. **(changed)** **(amended, ADR 0002)** [B-08]
- **F-26** Login and registration are rate-limited, e.g. 10 attempts per 15 minutes per IP and per email. Exceeding the limit returns HTTP 429 with a readable page. **(new)** [B-10]
- **F-27** Passwords are hashed with argon2id (OWASP-recommended parameters). Plaintext passwords and hashes are never logged. [B-11, B-12]

## 6. Session

- **F-28** Sessions are stored server-side in Redis. The cookie holds only an opaque session ID and has `HttpOnly`, `Secure` (in production), `SameSite=Lax` and a path of `/`. The session holds only the user ID plus non-personal technical fields (session version, issue time, CSRF binding flag, one-time flash). Names, email and signature IDs are not stored in it. **(changed)** **(amended, ADR 0002)** [B-04]
- **F-29** Sessions expire after an idle timeout (e.g. 2 hours, rolling) and an absolute lifetime (e.g. 7 days). Values come from configuration. **(new)** [B-04, B-57]
- **F-30** Guests who request a protected page are redirected to `/login?returnTo=<path>`. After login they return to that path (same-origin relative paths only). **(changed)**: legacy redirected to `/register`.
- **F-31** If the user in the session no longer exists (for example, the account was deleted on another device), the session is destroyed and the request is treated as a guest request. [B-05]
- **F-32** "Has signed" is always derived from the database, never cached in the session. [B-35]

## 7. Profile onboarding (`/profile`)

- **F-33** After registration, `/profile` shows a form with three optional fields: age, city, homepage. "Continue" saves and redirects to `/signature`. A "Skip" link goes to `/signature` without saving. **(new: explicit skip)**
- **F-34** Each field is optional on its own. Any combination (for example, only city) saves correctly. Empty fields are stored as `NULL`. [B-26]
- **F-35** Validation **(new)** [B-27, B-18]:
  - Age: integer 1–120 (`inputmode="numeric"`). Decimals and text are rejected with a message.
  - City: trimmed, internal whitespace collapsed, 1–100 characters.
  - Homepage: valid absolute URL with `http` or `https` scheme, ≤ 300 characters. If no scheme is entered, `https://` is prepended **before** validation. A value that already has a scheme is never prefixed twice.
- **F-36** Submitting the form again, or revisiting `/profile` when a profile exists, never fails. The form is prefilled and the save is an upsert. [B-28]

## 8. Signature

- **F-37** `/signature` (signed-in users who have not signed) greets the user by first name ("Hey <first name>") and shows a signature pad with instructions.
- **F-38** The pad accepts mouse, touch and pen input through Pointer Events (`touch-action: none` on the canvas). A stroke continues when the pointer leaves the canvas while pressed (pointer capture). Strokes are never lost when the pointer is released outside the canvas. [B-36, B-37]
- **F-39** The drawing is crisp on HiDPI screens (backing store scaled by `devicePixelRatio`). Pointer coordinates are computed with `getBoundingClientRect()`, so they match the cursor at any scroll position or layout. [B-38]
- **F-40** A "Clear" button empties the pad. **(new)** [B-39]
- **F-41** Submitting an empty pad is blocked on the client with the message "Please sign before submitting". The server rejects it too (HTTP 422, same message). [B-19]
- **F-42** Server-side signature rules [B-19]:
  - The value must be a `data:image/png;base64,` URL.
  - Decoded size ≤ 64 KB; the request body limit is configured explicitly.
  - The decoded bytes start with the PNG magic number, and the image dimensions match the pad's export size.
  - Any violation → HTTP 422 with a readable message on the signature page. No other URL scheme or content type is ever stored or rendered.
- **F-43** A user can have at most one signature. A repeated or concurrent submit (double click, back button, two tabs) is idempotent: no error, redirect to `/thank-you`. [B-07, B-49]
- **F-44** A user who has already signed and opens `/signature` is redirected to `/thank-you`. **(changed)**: legacy redirected to `/supporter`.
- **F-45** Accessibility of the pad **(new)** [B-70]:
  - The canvas has an accessible name and instructions (`aria-describedby`).
  - A keyboard- and screen-reader-accessible alternative exists: "Sign by typing your full name". The server renders the typed name into a signature image (PNG) that is stored like a drawn one.
  - Without JavaScript, the page explains that drawing needs JavaScript and offers the typed-name alternative.

## 9. Thank-you page (`/thank-you`)

- **F-46** Shows "Thank you for your signature", the user's own signature image (alt text "Your signature"), the total number of supporters with correct pluralisation ("1 supporter", "2 supporters"), a link to the supporters list, and a "Delete signature" button.
- **F-47** The supporter count equals the number of entries in the supporters list. [B-30]
- **F-48** Users without a signature who open `/thank-you` are redirected to `/signature`. A broken image is never shown. [B-07]

## 10. Delete signature

- **F-49** `POST /signature/delete` (CSRF-protected) deletes only the current user's signature. It redirects to `/signature` with the flash "Your signature was removed". The supporter count decreases by one.
- **F-50** The "Delete signature" control is shown only to users who have signed. It asks for confirmation first (a native `<dialog>` or a confirmation page; works without JS). **(new)** [B-47]

## 11. Supporters list (`/supporters`)

- **F-51** Signed-in users can see a list of all users who have signed, **including signers without a profile**. [B-30]
- **F-52** Each entry shows:
  - The full name. If a homepage is set, the name links to it with `rel="noopener noreferrer nofollow ugc"`. If the link opens in a new tab, this is announced ("opens in new tab").
  - The age, if set.
  - The city, if set, linked to that city's page in the **same** tab.
  - Entries without age or city show no stray separators. [B-17, B-73]
- **F-53** All user-supplied values (names, city, URL) are HTML-escaped. Rendering markup or script typed by a user never executes or alters page structure (tested with an XSS payload in every field). [B-01]
- **F-54** The list is a semantic `<ol>`/`<ul>`, ordered by signing time (oldest first, tie-break by ID), and paginated (e.g. 50 per page). Pagination is accessible (`<nav aria-label="Pagination">`, `aria-current` on the current page) and the total count is shown. **(new)** [B-31, B-67]
- **F-55** If nobody has signed yet, an empty state is shown ("No supporters yet. Be the first!"). **(new)**

## 12. Supporters by city (`/supporters/city/:city`)

- **F-56** Lists the supporters whose city matches `:city` case-insensitively after trimming. The heading shows the requested city (escaped). Entries look like F-52 but without the city link. A link returns to all supporters.
- **F-57** Cities with spaces, slashes, umlauts, `?`, `#` or `&` work: links are built with `encodeURIComponent`, and matching uses the decoded value. [B-32]
- **F-58** A city with no supporters shows an empty state ("No supporters from <city> yet") and a link back. The heading is never blank. **(new)** [B-33]
- **F-59** The city page is paginated like F-54. **(new)**

## 13. Profile editing (`/profile/edit`)

- **F-60** The form is prefilled with first name, last name, email, age, city and homepage. The password field is `type="password"`, empty, with `autocomplete="new-password"`. [B-11]
- **F-61** All fields are validated with the same rules as F-19 and F-35. Errors are shown inline (F-21) and the entered values are kept. [B-29]
- **F-62** Saving updates user and profile in **one transaction**. Either everything is saved or nothing is. On success the user is redirected back to `/profile/edit` with the flash "Profile updated". **(changed)**: legacy always redirected to `/supporter`, even when the save failed. [B-29, B-48]
- **F-63** An empty password field leaves the password unchanged. Changing the email or the password requires the current password. **(new)** [B-11]
- **F-64** Changing the email to one that already exists (case-insensitively) shows a field error, and nothing is changed. [B-29]
- **F-65** Clearing an optional field (age, city, homepage) removes the stored value.
- **F-66** The edit page links to "Delete signature" (only if signed, F-50) and "Delete account" (F-67).

## 14. Delete account

- **F-67** "Delete account" opens a confirmation page (`GET /account/delete`) that explains what will be deleted. The user confirms with their current password. **(new)** [B-34]
- **F-68** `POST /account/delete` (CSRF-protected, signed in) deletes the user, profile and signature atomically. It destroys the session and redirects to `/` with the flash "Your account was deleted". The supporter count decreases accordingly. [B-34]
- **F-69** After deletion, the same email can register again.

## 15. Cross-cutting security

- **F-70** Every state-changing request is a POST protected by a CSRF token. A missing or invalid token returns a 403 page, not a stack trace. [B-08, B-13, B-14]
- **F-71** `helmet` sets security headers, including a strict CSP: no inline scripts, `img-src 'self'` (signatures are served by the private route `GET /signature/image.png`), and fonts served from self. `X-Powered-By` is disabled. **(new)** **(amended, ADR 0004)** [B-10, B-16]
- **F-72** All configuration (port, database URL, Redis URL, session secret, cookie settings, contact link) comes from environment variables validated with Zod at startup. The app refuses to start when a value is missing or invalid. The repo contains no secrets, only `.env.example`. [B-02, B-03, B-57]
- **F-73** Structured logging (pino) with request IDs. Passwords, hashes, emails, session data and signature payloads are redacted or never logged. [B-12, B-58]
- **F-74** `GET /health/ready` returns 200 when the database and Redis are reachable, otherwise 503. `GET /health/live` reports the process only. There is no `GET /healthz`. **(new)** **(amended, ADR 0011)**

## 16. UX states

- **F-75** Submit buttons get `aria-busy`/disabled after the first submit, which prevents double submits. Forms still work without JavaScript. **(new)** [B-49]
- **F-76** Every form works without JavaScript except drawing a signature, which has the typed-name fallback (F-45). **(new)**
- **F-77** Copy is consistently spelled and grammatical ("Nonsense", "Homepage", "different address", "supporters"). [B-75]

## 17. Accessibility and responsive design (new)

- **F-78** Playwright + axe reports no serious or critical violations on any page, in guest and signed-in states, including error states. Target: WCAG 2.2 AA.
- **F-79** Each page has `<html lang="en">`, `<meta charset>` as the first `<head>` child, a viewport meta tag, one `<h1>`, `<header>`/`<nav>`/`<main>`/`<footer>` landmarks and a "Skip to content" link. [B-63, B-64, B-67]
- **F-80** Every form control has a visible `<label>` (placeholders are not labels) and correct `type`/`autocomplete` (`given-name`, `family-name`, `email`, `current-password`, `new-password`, `url`). [B-65, B-71, B-72]
- **F-81** All interactive elements have a visible `:focus-visible` style with ≥ 3:1 contrast. Hover effects have a focus equivalent. [B-66, B-83]
- **F-82** Text contrast ≥ 4.5:1, body text ≥ 16px (1rem), and the layout survives 200% zoom and 400% reflow without clipping. [B-74, B-81]
- **F-83** The layout works from 320px to wide desktop with no horizontal scrolling. The signature pad scales to the container width while keeping its aspect ratio. [B-63, B-78, B-81]
- **F-84** Decorative images have `alt=""`. Icon links have a text accessible name that describes the destination (e.g. "See all supporters"), not the icon ("eye"). [B-69]
- **F-85** Animations and hover scaling respect `prefers-reduced-motion`. No element follows the mouse cursor. [B-40, B-83]
- **F-86** Fonts are self-hosted (OFL licence included). Pages make no third-party requests. [B-16]
- **F-87** The HTML of every page passes the W3C validator without errors. [B-73]

## 18. Privacy and legal (new, added in the architecture review)

- **F-88** `GET /privacy` (no guard, no session for guests) explains who runs the site and how to contact them (contact link from configuration), what is stored, who can see what (name, age, city, homepage and signing date on the supporters list for registered users; the signature image only for its owner; email never shown), why, how long it is kept, how to delete signature and account, how to request erasure or access without a password, and the user's rights. The footer of every page links to it. **(new)**
- **F-89** When an imprint URL is configured (`IMPRINT_URL`), the footer links to it in the same tab. Without it, no imprint link is rendered. A public deployment requires it. **(new)**
- **F-90** The register page states, before submitting, that the name appears on the supporters list visible to registered users, with a link to the privacy page. The onboarding page states that age, city and homepage are optional and appear next to the name on the supporters list. **(new)**
- **F-91** A user who cannot log in (lost password) can have their account, profile and signature erased on request through the contact channel named on the privacy page; the operator procedure deletes everything in one transaction like F-68. **(new)**
