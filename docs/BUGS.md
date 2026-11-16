# petition: Legacy Bugs, Security Holes and Anti-Patterns

An adversarial audit of the legacy app at `_legacy/src/petition` (last commit November 2018). Every finding cites real lines. Paths are relative to the legacy project root. **Every item must be resolved in the rebuild** (Definition of Done). The matching acceptance criteria are in [FEATURES.md](./FEATURES.md).

Severity: **Critical**: exploitable or leaks secrets. **High**: data loss, broken core flow or serious security weakness. **Medium**: wrong behaviour or weak practice. **Low**: quality, maintainability or polish.

Files audited: `server.js`, `db.js`, `registered_users.sql`, `signature.sql`, `user_profiles.sql`, `package.json`, `README.md`, the keys (not values) of `secrets.json`, all of `views/**/*.handlebars`, `public/*.js`, `public/*.css` and the image inventory in `public/`. jQuery is loaded from a CDN; nothing is vendored.

---

## A. Security

### B-01: Stored XSS through raw HTML helpers (Critical)
- **Location:** `server.js:301-318` and `server.js:337-354` (helpers `renderProfile`, `renderUser`); rendered unescaped with triple-stash in `views/supporter.handlebars:20-21` and `views/city.handlebars:20-21`.
- **What is wrong:** `first`, `last`, `age`, `city` and `url` from the database go straight into template-literal HTML strings (`<a ... href="https://${url}">${first} ${last}</a>`). `{{{ }}}` outputs them without escaping. Any registered user can put `<img src=x onerror=...>` in their first name, or `x" onmouseover="...` in their homepage, through `/register` or `/profile/edit`. None of these fields is validated.
- **Why it matters:** The payload runs in the browser of every logged-in user who opens the supporters list. That allows session riding, defacement and phishing. It is the most severe defect in the app.
- **Fix:** Helpers never build HTML. Use a Handlebars partial with double-stash `{{ }}` for all user data. Validate URLs (B-18). Add a strict CSP without `unsafe-inline` (B-10). Add an E2E test that stores an XSS payload in every field and asserts that it is shown as text.

### B-02: Database credentials committed to the repository (Critical)
- **Location:** `secrets.json` is tracked by git (keys `dbUser`, `dbPassword`; values deliberately not repeated here). It is loaded in `db.js:5-10`, and there is no `.gitignore`. See `~/Code/_legacy/SECRETS-REPORT.md`.
- **What is wrong:** Real credentials are in version control and in the full git history.
- **Why it matters:** Anyone with read access to the repo, or to a fork or clone, gets the credentials. Passwords are often reused across services.
- **Fix:** Rotate the password (tracked in PLAN step 0). The rebuild reads configuration only from environment variables validated with Zod, ships `.env.example` with placeholders, ignores `.env*` and runs gitleaks in lefthook pre-commit and in CI.

### B-03: Hard-coded session signing secret (Critical)
- **Location:** `server.js:9-14`. The `secret` option of `cookie-session` is a string literal in the source.
- **What is wrong:** The key that signs session cookies is public in the repo.
- **Why it matters:** With the key, an attacker can forge a cookie containing any `user` ID and be logged in as any user, including access to edit and delete endpoints.
- **Fix:** `SESSION_SECRET` comes from the environment (≥ 32 random bytes, validated at startup) and supports a list of keys for rotation. Sessions are stored server-side (B-04).

### B-04: Client-side session store, PII in the cookie, no revocation, no cookie hardening (High)
- **Location:** `server.js:7-14` (`cookie-session`, `maxAge` 14 days). Data written into it: `server.js:60-61` (first and last name), `:81`, `:113`, `:240`, `:244`, `:368`.
- **What is wrong:** `cookie-session` keeps the whole session as base64 JSON in the cookie. It is signed, not encrypted, so the user ID and full name can be read by anyone who sees the cookie. Logout (`server.js:288`) only tells the browser to drop the cookie, so a copied cookie stays valid for 14 days. `secure` and `sameSite` are not configured. There is no idle timeout and no session ID regeneration on login. `package.json` lists `express-session` and `connect-redis`, but they are never used.
- **Why it matters:** A stolen cookie cannot be invalidated, personal data leaks into the cookie, and session lifetime cannot be controlled.
- **Fix:** Use `express-session` with a Redis store (as in PLAN). The cookie holds only an opaque ID and is `httpOnly`, `secure` in production, `sameSite=lax`. Set idle and absolute timeouts, `regenerate()` on login and register, and `destroy()` on logout. The session stores only the user ID. Enable `trust proxy` behind a reverse proxy.

### B-05: Session is never checked against the database ("ghost sessions") (High)
- **Location:** `server.js:403-410` (`checkForUser` only checks that `req.session.user` is truthy).
- **What is wrong:** After an account is deleted on device A, the cookie on device B still holds the old ID. On device B, `getName` (`db.js:54-60`) returns `undefined`, `server.js:57` throws a TypeError inside `.then`, the catch only logs (`:69-71`) and the request hangs. `/profile/edit` renders an empty form (`views/edit.handlebars:10-38`).
- **Why it matters:** Users get broken pages, and authorization relies on stale client state.
- **Fix:** An auth middleware loads the user for each request (or validates the session in the store). If the user is gone, it destroys the session and treats the request as a guest request.

### B-06: Mutating routes lack authentication (High)
- **Location:** `POST /signature` (`server.js:74`), `POST /profile` (`:134`), `POST /profile/edit` (`:177`) have no `checkForUser`.
- **What is wrong:** Unauthenticated requests reach the database with `user_id = undefined`. They only fail because of NOT NULL constraints (`signature.sql:6`, `user_profiles.sql:7`), and the error is swallowed (B-20). Authorization is enforced by accident, not by design.
- **Why it matters:** This is defence by side effect. Any future schema change (a nullable column) would open the endpoint. The requests also hang.
- **Fix:** One `requireAuth` middleware on every protected router (GET and POST). Supertest tests assert a redirect for guests on every protected route.

### B-07: Missing "has signed" / "not yet signed" guards (Medium)
- **Location:** `POST /signature` (`server.js:74`) has no `alreadySigned`. `GET /thankyou` (`:272`) only checks login.
- **What is wrong:** A second POST relies on the UNIQUE constraint (`signature.sql:6`), and the failure leaves the request hanging. `/thankyou` thanks users who never signed and shows `<img src="">` (`views/thankyou.handlebars:14`), because `getPic(undefined)` returns `undefined` (`db.js:62-68`).
- **Fix:** Guard middleware based on database state. Make signature insertion idempotent (`ON CONFLICT (user_id) DO NOTHING`, then redirect to `/thank-you`).

### B-08: Logout via GET (Medium)
- **Location:** `server.js:287-290`; links in `views/partials/fullnav.handlebars:11`, `profilenav.handlebars:11`, `signatureNav.handlebars:9`, `logout.handlebars:2`.
- **What is wrong:** A state-changing action on GET is not covered by csurf, which ignores GET.
- **Why it matters:** Any third-party page can log users out (`<img src="https://…/logout">`). Link prefetchers can trigger it too.
- **Fix:** `POST /logout` with a CSRF token, rendered as a button in the nav.

### B-09: User enumeration on login, by response and by timing (Medium)
- **Location:** `server.js:228-270`; `db.js:88-99`.
- **What is wrong:** For an unknown email, `dbPassword` throws (`result.rows[0].password` on `undefined`, `db.js:97`), and the catch renders the **login** page (`server.js:264`). For a wrong password, the **register** page is rendered (`server.js:254`). The two responses look clearly different. An unknown email also skips bcrypt entirely, so it responds measurably faster.
- **Why it matters:** An attacker can check whether an email address has an account.
- **Fix:** One code path. Always run password verification (against a dummy argon2 hash when the user is unknown), and return the same view, status (401) and message.

### B-10: No rate limiting, no security headers (Medium)
- **Location:** `server.js` as a whole. There is no `helmet` and no rate limiter, and `x-powered-by` is on by default.
- **What is wrong:** Login and registration can be brute-forced or sprayed without limit. There is no CSP, HSTS, `X-Content-Type-Options` or frame protection, and the Express version is advertised.
- **Fix:** `helmet` with a strict CSP (no inline script, `img-src 'self' data:`, `font-src 'self'`), `app.disable('x-powered-by')`, and `express-rate-limit` with a Redis store on `/login`, `/register` and `/account/delete`.

### B-11: Weak password handling (High)
- **Location:** `db.js:101-115` (bcryptjs, default cost 10); `views/register.handlebars:23` (only `required`); `views/edit.handlebars:22` (`type="text"` for the password); `server.js:177-211` (email and password change without the current password).
- **What is wrong:** There is no length policy, so 1-character passwords are accepted. bcrypt silently truncates input to 72 bytes. On the edit page the new password is shown in clear text and can be saved by browser form autofill. Email and password can be changed without re-authentication, so a hijacked session means account takeover.
- **Fix:** argon2id with OWASP parameters, a 10–128 character policy, `type="password"` with `autocomplete="new-password"`, and the current password required for email or password changes and for account deletion.

### B-12: Password hashes and PII written to logs (High)
- **Location:** `db.js:94-96` logs the full query result **and the password hash**. Also `server.js:57-58` (names), `:148` (profile row), `:160`, `:165` (email, age, city), `:239-245` (session contents), `:276` (full signature data URL), `:296`, `:332` (all supporters), `:367`, `:380-387`; `db.js:38`, `:45`.
- **Why it matters:** Logs are usually kept longer and shared more widely than the database. A hash in the logs allows offline cracking. Logging personal data violates GDPR data minimisation.
- **Fix:** pino with `redact` paths (password, hash, email, cookie, signature), log levels, no `console.*` (ESLint `no-console`), and request IDs instead of payloads.

### B-13: Default Express error handler leaks stack traces (Medium)
- **Location:** There is no error middleware in `server.js`. `db.js:6` shows that `NODE_ENV` is only set in production.
- **What is wrong:** csurf errors (`EBADCSRFTOKEN`, for example after a session expires) and body-parser errors (413, malformed bodies) go to Express's default handler. Outside production it prints the full stack trace as HTML.
- **Fix:** A central error middleware with RFC 9457 problem details for JSON and styled HTML pages for 403, 404, 413, 422, 429 and 500. Never send stack traces to the client.

### B-14: Deprecated and end-of-life dependencies (High)
- **Location:** `package.json:10` (`node 8.9.4`, end of life since 2019), `:18` (`connect-redis` 3, unused), `:19` (`cookie-session ^2.0.0-alpha.1`, a pre-release), `:20` (`csurf`, deprecated and archived in 2022), `:21` (Express 4), `:24` (`spiced-pg`, a bootcamp-specific wrapper).
- **Why it matters:** Known vulnerabilities, no security patches, and no way to run on a supported Node version.
- **Fix:** Current Node LTS pinned in `.nvmrc`, Express 5, a maintained CSRF approach (synchronizer token in the server-side session, or `csrf-csrf`), Drizzle with `pg`, and Dependabot.

### B-15: Private contact data hard-coded in the footer (Medium)
- **Location:** `views/partials/footer.handlebars:7-11`: the author's full name, private email address and **mobile phone number** in plain text on every page.
- **Why it matters:** Scraping, spam and a privacy risk once the repo and site are public. The data is also hard-coded rather than configured.
- **Fix:** No phone number and no private email in markup. The footer shows a credit and a contact link (portfolio or contact page) from configuration.

### B-16: Third-party resources without integrity checks; GDPR issue with Google Fonts (Medium)
- **Location:** `views/layouts/main.handlebars:23` (Google Fonts), `:43` and `views/partials/canvas.handlebars:1` (jQuery from code.jquery.com, no `integrity`/`crossorigin`).
- **What is wrong:** A compromised CDN could inject script. Loading Google Fonts sends visitors' IP addresses to Google; a German court ruled this unlawful without consent (LG München I, 2022).
- **Fix:** No jQuery (vanilla TypeScript). Self-host the OFL font Schibsted Grotesk through `@fontsource` (no commercial typeface, PLAN.md). Bundle all assets locally. CSP `default-src 'self'`.

### B-17: `target="_blank"` without `rel` (Low)
- **Location:** `server.js:303`, `:307`, `:314`, `:350`.
- **What is wrong:** External homepage links omit `rel="noopener noreferrer"`. Older browsers allow reverse tabnabbing, and the referrer leaks. Internal city links also open in a new tab for no reason, which confuses users and screen readers.
- **Fix:** External user links get `rel="noopener noreferrer nofollow ugc"` and an announced "(opens in new tab)", or open in the same tab. Internal links never use `_blank`.

### B-18: Homepage URLs are not validated or normalised (Medium)
- **Location:** `db.js:144-155`, `:237-251` store the value raw. `server.js:314`, `:350` prepend `https://` unconditionally. Input fields: `views/profile.handlebars:18`, `views/edit.handlebars:31`.
- **What is wrong:** Entering `https://example.com` produces `https://https://example.com`. Any string is accepted, including spaces and quotes, which enables B-01. There is no length check, so text longer than 300 characters raises a database error that is swallowed and the request hangs (`user_profiles.sql:6`).
- **Fix:** Zod schema: trim, prepend `https://` only when no scheme is present, parse with `new URL()`, allow only `http:`/`https:`, max 300 characters. A database CHECK as a backstop.

### B-19: Signature payload is not validated (High)
- **Location:** `server.js:74-91`, `db.js:18-23`, `views/signature.handlebars:16` (hidden input `value=""`), `signature.sql:5` (`TEXT NOT NULL`, which accepts `''`), `views/thankyou.handlebars:14`.
- **What is wrong:** Clicking SUBMIT without drawing stores an empty string, because NOT NULL does not reject `''`. The thank-you page then shows a broken image. Any string (an external tracking URL, megabytes of text up to body-parser's implicit 100 KB default at `server.js:19-23`) is stored and later used as `<img src>`. A body over the limit triggers an unhandled 413 error page (B-13).
- **Fix:** Validate on the server: `data:image/png;base64,` prefix, base64-decode, PNG magic bytes, expected dimensions, decoded size ≤ 64 KB, and not blank. Set an explicit body size limit on that route. Add a client-side blank check before submit. Store bytes as `bytea`, or keep a CHECK on length.

---

## B. Correctness and reliability

### B-20: Swallowed errors leave requests hanging forever (High)
- **Location:** catch blocks that only `console.log` and never respond: `server.js:69-71`, `:88-90`, `:153-155`, `:172-174`, `:322-324`, `:358-360`, `:371-373`, `:393-395`.
- **What is wrong:** On any database error the browser spins until it times out. Users get no feedback, and connections pile up.
- **Fix:** Use async handlers. Express 5 forwards rejected promises to `next(err)`, and the central error middleware (B-13) renders a proper page. Expected errors (validation, unique violation `23505`) are mapped to 4xx with inline messages.

### B-21: Unreturned nested promises and missing catch (High)
- **Location:** `server.js:238-251` (login: `getUserId(...).then(...getSignatureId(...).then(...))`, neither returned), `:273-284` (`/thankyou`: no catch at all), `:381-391` (`/delete`: inner `deleteProfile` and `deleteRegister` not returned).
- **What is wrong:** Rejections in the inner promises are unhandled. On Node ≥ 15 an unhandled rejection crashes the process, and on older versions the request hangs. The outer `.catch` never sees them.
- **Fix:** Flat `async/await` in services and the `@typescript-eslint/no-floating-promises` lint rule.

### B-22: Login hangs for every user who has not signed (High)
- **Location:** `db.js:34-41` (`return num.rows[0].id`, which throws when there is no row); `server.js:242-249` (the `else` branch that should redirect to `/signature` is unreachable).
- **Reproduce:** Register, skip signing, log out, log in again. The request never completes (unhandled rejection, B-21).
- **Fix:** The query returns `null` when there is no signature. Login logic: verify, then load the user with a `LEFT JOIN` on signatures (B-52), then redirect based on the result. Add a test for "login without signature".

### B-23: Wrong password shows the registration page with "email already taken" (Medium)
- **Location:** `server.js:252-258` renders `register` with `error`; the message comes from `views/register.handlebars:16-18`. The log line says "EMAIL ALREADY EXISTS".
- **Why it matters:** The message is false and confusing, and the user lands on the wrong form. It also enables enumeration (B-09).
- **Fix:** See B-09 and F-24.

### B-24: Every registration error is reported as "email already taken"; input is lost (Medium)
- **Location:** `server.js:117-124`; `views/register.handlebars:15-19`; `db.js:78-83` (`|| null` coercion).
- **What is wrong:** Empty or whitespace-only names, database outages and hashing failures all show "THIS EMAIL IS ALREADY TAKEN". The form is re-rendered empty, so the user must retype everything. Whitespace-only names pass, because `' ' || null` is `' '`.
- **Fix:** Zod validation with field-level messages, unique violation mapped to an error on the email field, and submitted values re-rendered (except the password).

### B-25: Email addresses are case-sensitive (Medium)
- **Location:** `registered_users.sql:7` (`UNIQUE` on raw `VARCHAR`); `db.js:90`, `:119` (`WHERE email = $1`).
- **What is wrong:** `Anna@x.de` and `anna@x.de` become two accounts. Logging in with different capitalisation fails.
- **Fix:** Trim and lower-case on input, `citext` column or unique index on `lower(email)`, and case-insensitive lookup.

### B-26: Onboarding profile crashes when age is empty but city or homepage is filled (High)
- **Location:** `server.js:137` only skips the insert when **all three** fields are empty. `db.js:152` passes `age` as-is (no `|| null`, unlike every other query).
- **Reproduce:** On `/profile`, enter only a city and submit. PostgreSQL rejects `''` for an `INT` column ("invalid input syntax for type integer"). The error is swallowed and the request hangs (B-20).
- **Fix:** Zod with `z.coerce` and empty-string-to-`null` preprocessing for all optional fields. Add a test for every combination of optional fields.

### B-27: Age validation is missing or wrong (Medium)
- **Location:** `views/profile.handlebars:16` (`pattern="[0-9.]+"` allows `1.5`, `...`, `007`); `views/edit.handlebars:25` (no constraint at all); no server check; `user_profiles.sql:4` (`INT`, no CHECK).
- **What is wrong:** Decimals and text cause database errors (hang), and nonsense ages such as 0 or 9999 are stored.
- **Fix:** Integer 1–120 on the server, `inputmode="numeric"` on the client, and a database CHECK.

### B-28: Revisiting the onboarding form causes a unique-violation hang (Medium)
- **Location:** `server.js:127-157` (GET `/profile` is always reachable, and the home page links to it at `views/home.handlebars:8`); `db.js:144-155` (plain `INSERT`); `user_profiles.sql:7` (`user_id UNIQUE`).
- **Reproduce:** Fill `/profile`, press Back, submit again, or open `/profile` from the home page later. The second INSERT violates UNIQUE and the request hangs.
- **Fix:** Upsert (as `updateUserProfiles` already does in `db.js:237-251`), or redirect to `/profile/edit` when a profile exists. Prefill the form.

### B-29: Profile edit reports success when it fails, and is not atomic (High)
- **Location:** `server.js:180-218`. The chain `.then(update profile).catch(log).then(redirect)` runs the redirect after the catch, so it always runs.
- **What is wrong:** Changing the email to one that is taken, clearing the first name (`|| null` → NOT NULL violation) or typing letters into age all fail silently, and the user is still sent to `/supporter` as if it worked. The profile and the user record are updated in two separate statements without a transaction. If the second fails, the first stays applied, which is a partial update.
- **Fix:** Validate first. Run both updates in one `db.transaction()`. On error, re-render the form with messages. On success, show a flash and redirect (F-62).

### B-30: Supporter list hides signers who skipped the profile; count and list disagree (High)
- **Location:** `db.js:157-172` and `:174-192` use `JOIN user_profiles` (an inner join). `server.js:137-138` creates no profile row when all fields are left empty. `db.js:43-48` counts every row in `save`.
- **What is wrong:** A user who skips the optional profile and signs is counted on `/thankyou` ("SEE ALL n SUPPORTER") but never appears on `/supporter`.
- **Fix:** Select from signatures, `JOIN users`, `LEFT JOIN profiles`. Count and list use the same base query.

### B-31: Supporter lists are unordered and unpaginated (Medium)
- **Location:** `db.js:157-172`, `:174-192`: no `ORDER BY`, no `LIMIT`.
- **What is wrong:** Order depends on the query plan and can change between requests. Every row (with all columns) is loaded and rendered at once, which does not scale.
- **Fix:** `ORDER BY signatures.created_at, signatures.id`, with keyset or offset pagination (e.g. 50 per page) and an index (B-61).

### B-32: City links break for many real city names (Medium)
- **Location:** `server.js:303`, `:307` (`href="/supporter/${city}"`, not encoded); `db.js:185` (`LOWER(city)=LOWER($1)`, not trimmed).
- **What is wrong:** "Frankfurt/Main", "St. Gallen?" or "A#B" produce broken paths, and the catch-all sends the user to `/home` (B-43). "Berlin " (trailing space) and "Berlin" are different cities.
- **Fix:** `encodeURIComponent` when building links. Normalise city on write (trim, collapse whitespace). Match case-insensitively on the normalised value, with an index on `lower(city)`.

### B-33: City page has no empty state and takes its heading from the first row (Low)
- **Location:** `views/city.handlebars:11` (`{{result.0.city}}`).
- **What is wrong:** An unknown city, or no matches, gives the heading "HERE ARE ALL SUPPORTER FROM :" and an empty list.
- **Fix:** The heading comes from the requested (decoded, escaped) parameter, plus an explicit empty state (F-58).

### B-34: Account deletion is non-atomic, unconfirmed and relies on manual cascade (High)
- **Location:** `server.js:376-396` (three sequential deletes, nested and unreturned); `signature.sql:6` and `user_profiles.sql:7` (FKs without `ON DELETE CASCADE`); `views/partials/deleteAccount.handlebars:1-4` (one click, no confirmation).
- **What is wrong:** If a later delete fails, the account is half-deleted: the signature is gone but the user still exists. One accidental click irreversibly deletes the account. No re-authentication is needed.
- **Fix:** `ON DELETE CASCADE` with a single `DELETE FROM users` inside a transaction, a confirmation page asking for the current password, then session destroy and a flash message.

### B-35: Signature state cached in the session goes stale (Medium)
- **Location:** `server.js:81`, `:244`, `:368` write `req.session.signatureId`. `:275` loads the image by that ID. `:420-426` (`alreadySigned`) trusts it.
- **What is wrong:** If the signature is deleted on another device, the first device still has the old ID. `/signature` then redirects to `/supporter`, and the user cannot sign again until they log out. `/thankyou` shows a broken image.
- **Fix:** Derive signature state from the database by `user_id` on every request (F-32).

### B-36: Last strokes (or the whole signature) are lost when the mouse is released outside the canvas (High)
- **Location:** `public/index.js:21-31`.
- **What is wrong:** `toDataURL()` is written to the hidden input only on `mouseup` **over the canvas**. `mouseleave` sets `paint = false` without serialising. If the user finishes a stroke outside the canvas, the drawing is never saved, or an older state is saved. The canvas looks signed, but an empty or partial value is submitted (combined with B-19).
- **Fix:** Pointer Events with `setPointerCapture`. Serialise on `pointerup` and again in the form's `submit` handler.

### B-37: Signature pad does not work on touch devices (High)
- **Location:** `public/index.js:5-31` (jQuery `mousedown`, `mousemove`, `mouseup`, `mouseleave` only).
- **Why it matters:** Phones and tablets cannot sign the petition at all, and touch moves scroll the page.
- **Fix:** Pointer Events (mouse, touch, pen), `touch-action: none` on the canvas.

### B-38: Wrong pointer coordinates, blurry HiDPI output, invalid canvas size (Medium)
- **Location:** `public/index.js:10`, `:16` (`e.pageX - this.offsetLeft`); `views/signature.handlebars:21` (`width="456px"`, an invalid attribute value because it must be an integer); `public/style.css:195-201` (fixed CSS size repeated).
- **What is wrong:** `offsetLeft` is relative to the `offsetParent`, not the page. Inside a positioned container, or with borders or padding, strokes appear offset from the cursor. There is no `devicePixelRatio` scaling, so lines are blurry on Retina screens. The fixed 456px width overflows small screens.
- **Fix:** Use `getBoundingClientRect()`, scale the backing store by DPR, and size the canvas responsively with `aspect-ratio`, recomputing on resize.

### B-39: O(n²) redraw and no way to clear (Low)
- **Location:** `public/index.js:44-61` (clears and replays **every** point on every `mousemove`); `views/signature.handlebars` (no clear button).
- **What is wrong:** Drawing gets slower as the signature grows. A user who makes a mistake has to reload the page.
- **Fix:** Draw only the newest segment incrementally and add a "Clear" button (F-40).

### B-40: `plus.js` throws on the city page; a hint follows the mouse cursor (Low)
- **Location:** `views/city.handlebars:5` (the `.cursor` element is commented out) and `:39` (still loads `plus.js`); `public/plus.js:1-10`; `public/style.css:393-400`; `views/supporter.handlebars:13`.
- **What is wrong:** On `/supporter/:city`, `document.querySelector(".cursor")` is `null`, so `cursor.style` throws a TypeError on **every** mouse move. On `/supporter`, the "Click on a name or city!" hint is absolutely positioned at the mouse coordinates. It covers content, can cause horizontal overflow near the right edge, ignores `prefers-reduced-motion`, and is meaningless for keyboard and touch users.
- **Fix:** Remove it. Make links look like links instead.

### B-41: Dead code and unused assets (Low)
- **Location:**
  - `public/about.js` (whole file). No template loads it. It needs a `Matter` global that is never included and a `section.shapes` element that does not exist, and it references textures (`outline-2x.png`, `ball.png`) that are not in the repo.
  - `views/partials/logout.handlebars` is never used. `views/partials/script.handlebars` is empty but included (`views/logIn.handlebars:40`).
  - `public/deleteg.png`, `eyeg.png`, `profileg.png`, `signatureg.png` are never referenced.
  - `public/input.css` contains only a comment and is still loaded (`main.handlebars:27`).
  - Commented-out code in `server.js:34-36`, `:53`, `:62`, `:78-79`, …; `db.js:2`, `:25-32`, `:50-52`; `views/city.handlebars:44-66`; `views/thankyou.handlebars:27-30`, `:36`, `:40`; `views/home.handlebars:7`, `:9`; `public/text.css:35-61`.
  - Dead CSS: `.number`, `.groß`, `.middle` (`public/style.css:239-258`, only used in commented markup); `section` (`:142-144`, no `<section>` exists); `.footer .left {}` (`public/menu.css:54-55`).
  - The empty `.kasten` div (`main.handlebars:33-35`) has no styles.
- **Fix:** Delete it. ESLint `no-unused-vars`, Stylelint, `knip` for unused files and exports.

### B-42: Broken internal link (Low)
- **Location:** `views/home.handlebars:13` links to `./signup`, which does not exist. The catch-all silently redirects back to `/home`, so the signature icon on the home page appears to do nothing.
- **Fix:** Link to `/signature`. An E2E link crawler asserts that no internal link returns 404.

### B-43: Catch-all redirect instead of 404; missing favicon files are answered with HTML (Medium)
- **Location:** `server.js:398-400`; `views/layouts/main.handlebars:4-19` reference `apple-icon-*.png`, `android-icon-192x192.png`, `favicon-*.png`, `ms-icon-144x144.png` and `manifest.json`. **None of these files exist** in `public/`.
- **What is wrong:** Every unknown GET, including 13 icon/manifest requests on **every page load**, gets a 302 to `/home`, so the browser downloads the home page HTML as an "icon". Search engines see soft-404s, and typos in URLs are hidden.
- **Fix:** A real 404 handler and status. A minimal, real icon set (SVG favicon + `apple-touch-icon` + web manifest) generated at build time.

### B-44: No route for `/` (Low)
- **Location:** `server.js:34-36` (commented out). `/` only works through the catch-all redirect to `/home`.
- **Fix:** The home page is served at `/`. `/home` returns 301 to `/`.

### B-45: Missing and non-descriptive page titles; redundant render options (Low)
- **Location:** `server.js:297-320` and `:333-356` pass no `title`, so `/supporter` and `/supporter/:city` have an **empty `<title>`**. Every other page uses the identical title "PETITION" (`:41`, `:48`, `:65`, `:96`, `:121`, `:130`, `:168`, `:224`, `:256`, `:266`, `:279`). `layout: "main"`, which is already the default, is repeated in every `res.render`.
- **Why it matters:** WCAG 2.4.2 (Page Titled), browser history, SEO.
- **Fix:** Each page sets a unique title through a view-model helper. Configure the default layout once.

### B-46: Six copy-pasted navigation partials that ignore auth state (Medium)
- **Location:** `views/partials/menu.handlebars`, `aboutnav.handlebars`, `fullnav.handlebars`, `profilenav.handlebars`, `signatureNav.handlebars`, `logout.handlebars`. Each page hard-codes which one to use.
- **What is wrong:** The markup is duplicated. Home, About, Login and Register always show the guest nav even when the user is logged in. The About nav shows "SUPPORTER" to guests, which only redirects to `/register`. The login nav has no Register link, and the register nav has no Register link (only Login). There is no current-page indication.
- **Fix:** One nav partial driven by `isAuthenticated`, `hasSigned` and `currentPath`, with `aria-current` (F-14).

### B-47: "Delete signature" is offered to users who have not signed (Low)
- **Location:** `views/edit.handlebars:45`; `views/supporter.handlebars:30` (the supporter page is reachable without signing, through the edit redirect at `server.js:217`).
- **What is wrong:** The button posts, deletes nothing and redirects to `/signature`, which is confusing.
- **Fix:** Render it only when the user has signed, with a confirmation step.

### B-48: Inconsistent redirects and no feedback after actions (Low)
- **Location:** `server.js:217` (after editing, always go to `/supporter`, even for non-signers and on failure); `:289` (logout lands on `/register`); `:389` (account deletion lands on `/home` without a message); `:369` (signature deleted, no message); `:412-418` (the middleware named `loggedIn` actually means "guests only").
- **Fix:** A defined navigation flow (FEATURES section 2.2), flash messages (F-17), and clear middleware names (`requireAuth`, `requireGuest`, `requireSigned`, `requireNotSigned`).

### B-49: Double-submit race conditions (Medium)
- **Location:** `server.js:100-125` (register), `:74-91` (signature), `:134-157` (profile).
- **What is wrong:** A double click sends two requests. For register, the second hits the email UNIQUE constraint and renders "email already taken", although the first request created the account and set the cookie. For signature and profile, the second request hangs (B-20), and that hanging navigation is what the user sees.
- **Fix:** Idempotent handlers (upsert, or `ON CONFLICT DO NOTHING` then redirect), map unique violations to the correct outcome, and disable the submit button after the first click (F-75).

---

## C. Architecture and code quality

### B-50: God files with no layering (Medium)
- **Location:** `server.js` (430 lines: config, middleware, every route, view helpers, guards); `db.js` (every query, plus password hashing).
- **What is wrong:** No separation between transport, business logic and persistence. Password hashing lives in the database module. The view helpers are redefined as closures on **every request** and duplicated between `server.js:300-319` and `:336-355`, with slightly different output.
- **Fix:** Feature modules as in PLAN (`features/auth`, `profile`, `signature`, `supporters`), each with routes → controller → service → repository, a Zod schema and tests. ESLint import boundaries. Helpers and partials registered once.

### B-51: Hand-rolled promisification and mixed styles (Low)
- **Location:** `db.js:101-115`, `:125-142` wrap callback APIs in `new Promise` (bcryptjs already supports promises). Throughout: `var` mixed with `const`, `function` callbacks mixed with arrow functions, and `require` with no modules.
- **Fix:** TypeScript strict, ESM, `async/await`, argon2's promise API, and ESLint plus Prettier.

### B-52: Redundant sequential queries (Low)
- **Location:** Login runs three sequential queries for one user: `dbPassword`, `getUserId`, `getSignatureId` (`server.js:230-249`). `/thankyou` runs two independent queries one after the other (`:273-275`). Account deletion runs three (`:376-391`). There are no N+1 loops in the app, but the round trips are unnecessary.
- **Fix:** Login: one `SELECT u.id, u.password_hash, s.id AS signature_id FROM users u LEFT JOIN signatures s ...`. Thank-you: one query or `Promise.all`. Deletion: one cascading DELETE.

### B-53: Misleading names (Low)
- **Location:** `db.js:18` `getData` performs an **INSERT**. The table `save` (`signature.sql:3`) stores signatures. The column `password` (`registered_users.sql:8`) stores a hash. Other examples: `giveEditData` (`db.js:194`), `getNumber` (`:43`), `getPic` (`:62`), `dbPassword` (`:88`), the `loggedIn` middleware meaning "guest only" (`server.js:412`), the CSS class `.kasten`, and the form field `homepage` versus `url` for the same data (`views/profile.handlebars:18` versus `views/edit.handlebars:31`).
- **Fix:** Intention-revealing names: `users`, `signatures`, `profiles`, `password_hash`, `homepageUrl`; `createSignature`, `countSupporters`, `findSignatureByUserId`; one field name per concept.

### B-54: DELETE helpers return meaningless values (Low)
- **Location:** `db.js:253-290` return `result.rows[0]` from `DELETE` statements without `RETURNING`, which is always `undefined`, and these values are then logged as "results" (`server.js:367`, `:380-387`).
- **Fix:** Return `rowCount` or a boolean, and test it.

### B-55: `FULL OUTER JOIN` where `LEFT JOIN` is meant (Low)
- **Location:** `db.js:197-202`.
- **What is wrong:** The intent is "the user, plus their profile if it exists". `FULL OUTER JOIN` with a `WHERE` on `registered_users.id` only works by accident, and it misleads readers.
- **Fix:** `LEFT JOIN`, or the Drizzle relational query.

### B-56: Validation by database error (Medium)
- **Location:** `db.js:79-82`, `:217`, `:230`, `:246` coerce empty strings to `null` **in order to** trigger NOT NULL errors. There is no input validation anywhere on the server.
- **Fix:** Shared Zod schemas validate every request body, query and parameter at the edge. The database constraints are only a backstop.

### B-57: Hard-coded and inconsistent configuration (Medium)
- **Location:** `server.js:428` (port fallback 8080); `server.js:12` (cookie lifetime); `db.js:6-10` (the environment decides whether secrets are read from a file or from the environment); `db.js:12-14` (host `localhost`, port 5432 and database name `signature` hard-coded; the URL is malformed: `postgres:user:pass@...` is missing `//`).
- **Fix:** One `config.ts` that parses `process.env` with Zod (`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET`, `PORT`, `NODE_ENV`, `CONTACT_URL`, …). Fail fast. Docker Compose for local services.

### B-58: Debug logging left in production code (Low)
- **Location:** About 40 `console.log` calls in `server.js` and `db.js` (examples: `server.js:57`, `:82-85`, `:165`, `:276`, `:296`, `:405`, `:429`), and `public/index.js:1`, `public/about.js:1`.
- **Fix:** pino (B-12) and ESLint `no-console`.

### B-59: Repository and tooling hygiene (Medium)
- **Location:**
  - **`node_modules/` is committed** (2,404 tracked files).
  - `.DS_Store` is committed.
  - There is no `.gitignore`.
  - `package.json:6-8` has only `start`: no lint, format, typecheck, test or build scripts.
  - There are **no tests at all**.
  - Unused dependencies: `connect-redis`, `express-session`, `cookie-parser` (`package.json:17`, `:18`, `:23`). `body-parser` is redundant with `express.urlencoded`.
  - There is no CI.
  - `csurf` is mounted before `express.static` (`server.js:25-32`), so every static asset request runs CSRF token generation and may set a session cookie.
- **Fix:** As in PLAN: pnpm, `.gitignore`, ESLint flat config, Prettier, Stylelint, Vitest + Supertest + Testcontainers + Playwright/axe, lefthook + gitleaks, GitHub Actions CI. Static assets are served before session and CSRF middleware, with cache headers and compression.

### B-60: Destructive, order-dependent schema scripts instead of migrations (Medium)
- **Location:** `registered_users.sql:1`, `signature.sql:1`, `user_profiles.sql:1` each start with `DROP TABLE IF EXISTS`.
- **What is wrong:** Re-running a script wipes production data. `registered_users.sql` cannot be dropped while the dependent tables exist, so the scripts only work in an undocumented order. There is no migration history, no seed data, and the README has no setup steps.
- **Fix:** Drizzle schema in TypeScript, generated versioned migrations, `pnpm db:migrate` and `pnpm db:seed`, and Testcontainers to run the migrations in integration tests.

### B-61: Missing constraints and indexes; weak column types (Medium)
- **Location:**
  - `registered_users.sql:5-8`: `first`, `last` and `email` accept `''` and whitespace; there is no email format or length CHECK; the email UNIQUE is case-sensitive.
  - `registered_users.sql:9`, `signature.sql:7`: `TIMESTAMP` without time zone.
  - `user_profiles.sql:2-8`: no CHECK on `age`, `city` or `url`; no `created_at`/`updated_at`; a surrogate `id` even though `user_id` is unique and could be the PK.
  - `signature.sql:5`: unbounded `TEXT` holding base64, which inflates storage by about 33%.
  - `signature.sql:6`, `user_profiles.sql:7`: FKs without `ON DELETE CASCADE`.
  - No index supports `LOWER(city)` (`db.js:185`, sequential scan) or ordering signatures by date.
- **Fix:** See F-02 to F-06.

### B-62: Outdated README (Low)
- **Location:** `README.md:2` (typo "your can", 2018 tech list); `README.md:5` (demo GIF hosted on a third-party recording service, which may disappear).
- **Fix:** Portfolio README as in PLAN: screenshots/GIF committed to the repo, architecture diagram, badges, setup, "What I learned".

---

## D. HTML, accessibility and UX

### B-63: No viewport meta tag; fixed pixel layout (High)
- **Location:** `views/layouts/main.handlebars:3-28` (no `<meta name="viewport">`); `public/style.css:182` (`width: 489px`), `:199` (`456px`), `:226` (`457px`), `:340` (`150px`); `public/text.css:6` (`font-size: 69px`); `public/menu.css:22` (`padding: 20px 50px` on each floated link).
- **What is wrong:** Mobile browsers render a 980px desktop viewport scaled down. Content cannot reflow, and the signature box overflows on small screens.
- **Fix:** Viewport meta, mobile-first fluid layout, `clamp()` type scale from tokens, and a responsive canvas (B-38).

### B-64: `<meta charset>` not within the first 1024 bytes (Low)
- **Location:** `views/layouts/main.handlebars:21`, after 17 icon/meta lines (the first 1024 bytes contain no charset).
- **What is wrong:** Browsers must find the declaration in the first 1024 bytes. Otherwise they guess the encoding or reparse the page.
- **Fix:** `<meta charset="utf-8">` as the first child of `<head>`.

### B-65: Form controls without labels (High)
- **Location:** `views/register.handlebars:20-23`, `views/logIn.handlebars:20-21`, `views/profile.handlebars:16-18`: placeholders only. `views/edit.handlebars:13-32`: `<label for="first">` etc., but the inputs have **no `id`**, so the labels are not associated, and they sit below the inputs.
- **Why it matters:** WCAG 1.3.1, 3.3.2 and 4.1.2. Screen readers announce the fields as "edit text". The placeholder disappears while typing.
- **Fix:** A visible `<label for>` with matching `id` above every control, hints through `aria-describedby`.

### B-66: Focus indicators removed globally (High)
- **Location:** `public/style.css:39-44` (`button, textarea, select, input { outline: none; }`).
- **Why it matters:** Keyboard users cannot see where they are (WCAG 2.4.7, 2.4.11).
- **Fix:** A token-based `:focus-visible` ring on all interactive elements. Stylelint forbids `outline: none` without a replacement.

### B-67: No semantic structure (Medium)
- **Location:** The navigation is `<div class="menu">` (all nav partials). The footer is `<div class="footer">` (`views/partials/footer.handlebars:1`). There is no `<main>`, no `<h1>` on any page, and page headings are styled `<div>`s (`.squareSupporter`, `.squareThankyou`, `.squareAbout`). Form titles are `<p>` (`views/register.handlebars:14`, `views/logIn.handlebars:12`). The supporters are one `<p>` each instead of a list (`views/supporter.handlebars:18-23`). There is no skip link. Layout uses `<br>` (`views/edit.handlebars`, `views/register.handlebars`, `views/logIn.handlebars`, `views/profile.handlebars`).
- **Fix:** Landmarks, one `<h1>` per page, a logical heading order, `<ul>`/`<ol>` for lists, a skip link, and CSS for spacing (F-79).

### B-68: Error messages are not announced or linked to fields (Medium)
- **Location:** `views/register.handlebars:15-19`, `views/logIn.handlebars:14-18`. An empty `.error` div is always rendered, with no `role="alert"`, no `aria-live`, no `aria-invalid` and no `aria-describedby`. The register message is in all caps.
- **Fix:** An error summary that receives focus, plus inline messages (F-21).

### B-69: Poor image alternatives and oversized raster icons (Medium)
- **Location:** `views/home.handlebars:8`, `:13`, `:15`, `:16`: the icon links' only names are `alt="profile"`, `"signature"`, `"eye"`, `"trash"`, so screen readers announce "link, eye". The decorative `click.png` has `alt="click"` (`views/logIn.handlebars:33`) and `alt="login"` (`views/register.handlebars:32`); it should be empty. The PNGs are 534–676px wide (`public/*.png`) but shown at 11–152px (`public/text.css:18`, `:64`, `:70`, `:77`; `public/style.css:72`), which wastes bandwidth.
- **Fix:** Inline SVG icons with `aria-hidden="true"`, link text or `aria-label` naming the destination ("See all supporters"), and `alt=""` for decoration.

### B-70: Signature canvas is inaccessible (High)
- **Location:** `views/signature.handlebars:13-25`: the `<canvas>` has no fallback content, no accessible name and no instructions for assistive technology. Signing is impossible without a pointing device, and there is no no-JS fallback.
- **Fix:** See F-45 (labelled canvas, typed-name alternative, no-JS message).

### B-71: `autocomplete="off"` on login and registration (Medium)
- **Location:** `views/logIn.handlebars:11`, `views/register.handlebars:13`.
- **Why it matters:** It blocks password managers, which pushes users toward weak, reused passwords. It also fails WCAG 1.3.5 (Identify Input Purpose).
- **Fix:** Correct tokens: `given-name`, `family-name`, `email`, `current-password`, `new-password`.

### B-72: Wrong input types (Low)
- **Location:** Age is `type="text"` (`views/profile.handlebars:16`, `views/edit.handlebars:25`). Homepage is `type="text"` (`views/profile.handlebars:18`, `views/edit.handlebars:31`). Password on the edit page is `type="text"` (`views/edit.handlebars:22`, see B-11).
- **Fix:** `inputmode="numeric"` for age, `type="url"` for homepage, `type="password"` for passwords, with server validation as the authority.

### B-73: Invalid or malformed HTML (Medium)
- **Location:**
  - Unclosed footer tag: `views/partials/footer.handlebars:21` is `</div` with no `>`, so it merges with the next tag and the footer nesting is broken.
  - Unclosed span in generated HTML: `server.js:305` and `:341` emit `<span class="cities">${age}<span>` (opening tag instead of `</span>`).
  - Missing whitespace between attributes: `views/register.handlebars:13` (`method="post"autocomplete`), `:20`, `:22`, `:23`; `views/edit.handlebars:13`, `:16`, `:19`; `views/home.handlebars:13`, `:15`, `:16`; `server.js:350` (`"target=`).
  - Invalid canvas `width="456px"` (`views/signature.handlebars:21`).
  - jQuery is loaded **twice** on the signature page (`views/partials/canvas.handlebars:1` and `views/layouts/main.handlebars:43`), and on every other page it is loaded although unused.
  - Inconsistent page structure: the footer is inside `.background` on login and register (`views/logIn.handlebars:42-43`, `views/register.handlebars:38-41`) but outside it on all other pages.
- **Fix:** W3C validation in CI (e.g. `html-validate` on rendered pages in E2E), one layout with fixed slots, and scripts loaded only where needed as `type="module"`.

### B-74: Tiny text, low contrast, faux bold, clipping footer (Medium)
- **Location:**
  - Base sizes of 10–12px: `public/style.css:32`, `:37`, `:49`, `:57`, `:119`, `:156`, `:280`, `:325`; `public/menu.css:24`, `:51`.
  - Menu hover colour `rgba(255,153,0,0.87)` on white has a contrast ratio of **1.96:1** (`public/menu.css:34`).
  - Link hover green `#76950c` / `rgb(118,149,12)` on white has **3.46:1** (`public/style.css:79`, `:289`; `public/text.css:14`). Both are below 4.5:1.
  - Lato is loaded only at weight 400 (`views/layouts/main.handlebars:23`) but used at `font-weight: 900` (`public/style.css:15`, `:22`, `:67`, `:100`, `:167`, `:189`), so the browser synthesises a faux bold.
  - The footer has a fixed `height: 75px` with `overflow: hidden` (`public/menu.css:46`, `:48`), so its content is clipped when text is zoomed (WCAG 1.4.4).
  - Text is set in uppercase in the markup rather than with CSS, so screen readers may spell it out letter by letter.
- **Fix:** Tokenised type scale (body ≥ 1rem), colour tokens checked for contrast, load only the font weights in use, no fixed heights on text containers, and `text-transform` in CSS where uppercase is wanted.

### B-75: Spelling and grammar errors in the UI (Low)
- **Location:**
  - "NONESENSE": `views/partials/menu.handlebars:6`, `aboutnav.handlebars:5`, `fullnav.handlebars:5`, `profilenav.handlebars:5`, `signatureNav.handlebars:5`, `footer.handlebars:18`.
  - "HOMAPAGE": `views/edit.handlebars:32`.
  - "DIFFRENT EMAIL ADRESS": `views/register.handlebars:17`.
  - "You 're": `views/logIn.handlebars:32`.
  - "ALL SUPPORTER" should be "supporters": `views/supporter.handlebars:10`, `views/city.handlebars:11`, `views/thankyou.handlebars:24`; there is no pluralisation for a count of 1.
  - The author's surname is misspelled: `views/partials/footer.handlebars:7`.
- **Fix:** Proofread the copy. Use a pluralisation helper.

---

## E. CSS architecture

### B-76: No design tokens; hard-coded colours and fonts everywhere (Medium)
- **Location:**
  - The hover colour `rgba(255, 197, 110, 0.93)` is written 9 times (`public/style.css:18`, `:61`, `:109`, `:204`, `:308`, `:333`, `:365`, `:369`, `:403`).
  - A second orange appears in `public/menu.css:34`.
  - The same green is written two ways (`#76950c` at `public/style.css:79`, `rgb(118,149,12)` at `:289` and `public/text.css:14`).
  - Other hard-coded colours: `rgb(255,244,218)` (`public/menu.css:40`), `rgb(38,38,7)` (`public/text.css:10`), `rgb(163,163,163)` (`public/style.css:36`, `:324`), plus `black` and `white` keywords throughout.
  - `"Lato", sans-serif` is declared 19 times in `style.css`; `"Archivo Black"` 5 times across the CSS files.
  - There are no custom properties.
- **Fix:** Tailwind 4 `@theme` tokens (maw-studio identity, accent `#F85D33`), with the default palette, shadows and radii removed, and a Stylelint rule that forbids hard-coded colours.

### B-77: Massive copy-paste duplication (Medium)
- **Location:** The "black box" pattern (`padding: 11px; margin-left: 50px; background: black; color: white; font-family: Lato; font-size: 11px`) is repeated in `.square`, `.squareSignup`, `.squareAbout`, `.squareProfile`, `.squareSignature`, `.squareThankyou`, `#sig`, `.squareSupporter`, `.back`, `.squareEdit`, `.partial button`, `#allSupporter a` and `.about li` (`margin-left: 50px` appears 14 times and `background: black` 13 times in `public/style.css`). Each block has its own copy of the `p`, `button` and `button:hover` rules (`public/style.css:98-110`, `:165-172`, `:187-205`, `:328-334`, `:402-404`).
- **Fix:** A few BEM components (`.panel`, `.form`, `.button`, `.supporter-list`) built from tokens with `@apply` in separate CSS files, as in PLAN. No utility classes in markup.

### B-78: Magic numbers and spacer divs (Medium)
- **Location:**
  - `margin-top: 126px` to clear the fixed header (`public/style.css:2`).
  - Fixed heights of 320 and 315px (`public/style.css:8`, `:161`, `:181`).
  - Spacer elements used for layout: `.space` 94px, `.spaceProfile` 50px, `.spacemore` 200px (`public/style.css:111-113`, `:174-176`, `:310-312`), with empty divs in the markup (`views/logIn.handlebars:37`, `views/profile.handlebars:26`, `views/city.handlebars:34`).
  - Footer `margin-top: 101px` (`public/menu.css:44`).
  - `transform: translate(45%)`, `translate(30%, 30%)`, `left: 700px` (`public/style.css:244`, `:257`, `:397`).
  - Negative margin nudges `-2px` and `-10px` (`public/text.css:71`, `:76`).
  - Odd percentages: 39%, 44%, 87%, 88%, 88.75%, 91%.
- **Fix:** A spacing scale from tokens and a layout built with flex/grid and `gap`. A sticky header (instead of a fixed one plus a magic offset), with `scroll-padding-top` from a token.

### B-79: Problematic selectors and naming (Low)
- **Location:**
  - ID selectors: `#sig`, `#allSupporter` (`public/style.css:220-237`, `:346-366`).
  - Mixed camelCase and kebab-case class names (`.squareSignup` versus `.supporter-list`).
  - A non-ASCII class name: `.groß` (`public/style.css:247`).
  - Unscoped element selectors with global side effects: `input`, `button`, `form p`, `section` (`public/style.css:20-62`, `:142`).
  - Ambiguous generic classes: `.right`, `.left`, `.flex`, `.partial`, `.links`, `.names`.
- **Fix:** BEM-only class selectors, no IDs in CSS, ASCII kebab-case names, and base element styles limited to a small reset layer.

### B-80: Conflicting, duplicate and ineffective declarations (Low)
- **Location:**
  - `padding-left: 25px` is immediately overridden by `padding: 11px` (`public/style.css:147-148`, `:207-208`).
  - `margin-top: 20px` is declared twice in one rule (`public/style.css:348`, `:350`).
  - `.about ul` is defined twice (`public/style.css:132-137` and `:387-391`), and so is `.about li` (`:138-140` and `:372-385`), with conflicting values: a 30px font on the `ul`, but 11px on each `li`. A 3×3 grid is used for 6 items.
  - `text-decoration: none` on a `div` (`public/style.css:277`) has no effect.
  - `bottom: 0` without positioning (`public/menu.css:49`).
  - `float: right` inside a flex container (`public/menu.css:57`) is ignored.
- **Fix:** Stylelint with `declaration-block-no-duplicate-properties`, `no-duplicate-selectors` and `declaration-block-no-shorthand-property-overrides`.

### B-81: Float layout, `100vw` and an overlapping fixed header (Medium)
- **Location:** `public/menu.css:9` (`width: 100vw`, which causes horizontal scrolling whenever a vertical scrollbar is present); `:18`, `:29` (float-based nav); `:10` (a fixed header with no `scroll-padding`, so focused elements can end up hidden underneath it, WCAG 2.4.11).
- **Fix:** Flex/grid nav, `width: 100%`, a sticky header and `scroll-padding-top`.

### B-82: Four separate stylesheets, one of them empty; no build (Low)
- **Location:** `views/layouts/main.handlebars:24-27` (`style.css`, `menu.css`, `text.css`, `input.css`; `input.css` is only a comment). There is no minification, cache busting or compression.
- **Fix:** Tailwind CLI build to a single hashed, minified CSS file, served with long-lived cache headers.

### B-83: Hover-only feedback, motion without preference checks (Low)
- **Location:** `public/text.css:22-33` (`transform: scale(1.1)` on hover, with no transition and no focus equivalent). All `:hover` colour changes in `public/style.css` and `public/menu.css` have no `:focus-visible` counterpart.
- **Fix:** Pair `:hover` with `:focus-visible`, use transitions from motion tokens, and respect `prefers-reduced-motion: reduce`.

---

## F. Checked and not found

These were checked explicitly so that the rebuild does not regress:

- **SQL injection:** none. Every query in `db.js` uses `$n` parameters. The rebuild keeps this guarantee with Drizzle, which never interpolates raw strings (`sql.raw` is forbidden by lint).
- **CSRF on POST forms:** every legacy POST form includes `_csrf` (csurf). The only CSRF-relevant gap is GET logout (B-08). The rebuild must keep CSRF protection on every POST.
- **`!important`:** not used in any CSS file.
- **File uploads:** the app has none apart from the signature data URL (B-19).
- **Real-time features:** none.
- **Plaintext password storage:** passwords are hashed (bcrypt). Handling is still weak (B-11, B-12).
