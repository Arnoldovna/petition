# ADR 0016: Privacy notice, imprint link, demo-data guard and erasure on request

- Status: Accepted (added after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: F-88 to F-91 (new), F-01, F-06, F-15, F-67, F-68

## Context

The app collects name, email, optional age, city and homepage, and a signature image, and shows name, age, city and
homepage to every registered user. The first draft had no privacy notice where the data is collected (GDPR Art. 13),
no imprint link (a German publisher needs one under section 5 DDG once the site is public) and no erasure path for a
user who lost their password: there is no password reset, so such a user could delete neither the signature nor the
account (Art. 17). The maw navigation vocabulary already contains "imprint".

The critique also found that the compose `seed` service set `NODE_ENV=test`, which bypassed the seed's only
production guard: pointed at a real database, the `app` profile would create demo users who all share one known
password.

## Decision

**Privacy notice (F-88).** `GET /privacy` in the `pages` module, no guard, no session for guests, title "Privacy".
Content (plain prose, maw `prose` block):
- who runs the site and how to reach them: the operator named "Arnoldovna" and the `CONTACT_URL` link;
- what is stored: first and last name, email, password hash, optional age, city and homepage, the signature image,
  the signing time; no IP addresses in the database;
- who sees what: name, age, city, homepage and signing date appear on the supporters list, which every **registered**
  user can see; the signature image is visible only to its owner; email is never shown to others;
- purpose: running the (nonsense) petition; no tracking, no analytics, no third-party requests, only technically
  necessary cookies (session and CSRF), so no consent banner;
- retention: until the user deletes their signature or account; sessions end after the idle timeout or the absolute
  lifetime; rate-limit counters (keyed by IP subnet and by a keyed email hash) expire after at most one hour; server
  logs contain user ids only;
- how to delete: "delete signature" and "delete account" (links), and erasure on request without a password through
  the contact link;
- rights: access, rectification (the edit page), erasure, complaint to a supervisory authority.
The page is linked from the footer on every page and from the register and onboarding forms.

**Imprint (F-89).** Optional env key `IMPRINT_URL` (`https://` URL). When set, the footer shows "imprint" linking to
it (same tab). The app does not host the imprint text, so no personal address lands in the repository. While the repo
is private and nothing is deployed, the key stays empty and no link is rendered. The gated deploy job refuses to run
without it.

**Disclosure where data is collected (F-90).** The register page says, next to the submit button: "Your name appears
on the supporters list, which registered users can see. Details: privacy." The onboarding page says: "Age, city and
homepage are optional. If you add them, they appear next to your name on the supporters list."

**Erasure on request (F-91).** No password-reset flow: it needs outbound email, which the app deliberately does not
have (no outbound calls, OVERVIEW.md section 3). Instead:
- the privacy page names the contact channel for erasure and access requests;
- the operator verifies the request comes from the address's owner (reply from that address), then runs
  `pnpm admin:erase -- --email <address> --confirm` (`src/tools/erase-user.ts`, ADR 0013), which deletes the user with
  the same cascade transaction as `POST /account/delete` and logs `account.erased {userId}`;
- the procedure is documented in `docs/OPERATIONS.md` (written in the presentation phase together with the README).

**Demo-data guard.**
- `src/tools/seed.ts` runs only when `SEED_ALLOW=true` is set explicitly, whatever `NODE_ENV` is, and additionally
  refuses when the `users` table contains any email outside the reserved `@petition.test` domain. The error message
  names the variable, never its value.
- The compose `seed` service no longer overrides `NODE_ENV`; it sets `SEED_ALLOW: 'true'` and belongs only to the
  profiles `demo` and `e2e`. The `app` profile (migrate plus app) does not include or depend on it; `app` declares
  `depends_on: seed: { condition: service_completed_successfully, required: false }`, so in `demo` and `e2e` it waits
  for the seed and in `app` it starts without it.
- `pnpm db:seed` sets `SEED_ALLOW=true` for the local development database.

## Alternatives considered

- **Password reset by email.** Rejected for now: outbound email, a mail provider account and token handling for a
  portfolio app. Recorded as the first extension if the app ever gets real users.
- **Host the imprint text in the app.** Rejected: it would put a postal address into a public repository.
- **Seed guard on `NODE_ENV` only.** Rejected after critique (see context).

## Consequences

- New route `GET /privacy` (ROUTES.md section 2), new view `pages/privacy.hbs`, footer gains two links (shell module in
  phase 3, pages module in phase 2).
- FEATURES gains F-88 to F-91 (section 18 of FEATURES.md).
- Tests: `pages.int.test.ts` (privacy page renders for guests without creating a session, footer links, imprint link
  only when configured), `register.int.test.ts` and `onboarding.int.test.ts` (disclosure text present),
  `seed.int.test.ts` (refuses without `SEED_ALLOW`, refuses on a foreign email), `erase-user.int.test.ts`.
