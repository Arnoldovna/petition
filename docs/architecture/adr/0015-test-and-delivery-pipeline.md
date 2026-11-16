# ADR 0015: Test layers, HTML validation, one-command setup and the delivery pipeline

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-41, B-42, B-59, B-60, B-62, B-73, F-01, F-74, F-78, F-87

## Context

Legacy had no tests, no CI, committed `node_modules/` and destructive schema scripts (B-59, B-60). PLAN.md fixes the
quality gate (`pnpm verify`) and the CI/CD layout.

The critique found: no one-command setup (five manual steps including three hand-generated secrets, and `stack:up`
fails without them); two HTML validators where one is enough; `release.yml` pushing `:latest` on every push to `main`
whether or not CI passed; Dependabot not covering the compose images and the Nu validator digest; Chromium-only E2E
although the signature pad fixes matter most on iOS Safari; `retries: 2` in CI hiding flakes; and a pnpm version note
that claimed PLAN.md pins the 10 line (it does not). Test data isolation and parallel builds are in ADR 0017.

## Decision

### Test layers

- **Unit** (Vitest 5, project `unit`): services with in-memory fakes (`test/fakes.ts`), pure helpers
  (`signature-image`, `png`, `glyphs`, `fields`, `redirect`, `pagination`, `rate-limit-keys`, view helpers,
  `signature-pad.core`).
- **Integration** (project `integration`, `*.int.test.ts`): the real app from `createTestApp(overrides)` with
  Testcontainers `postgres:18-alpine` and `redis:8-alpine`, **one database per test file** cloned from a migrated
  template (ADR 0017), Supertest agents. `test/forms.ts` provides `getForm(agent, path)` (extracts `_csrf` and field
  values from HTML) and `postForm(agent, path, fields)`; `test/auth.ts` provides `signIn(agent, userId)` (ADR 0017).
- **E2E** (Playwright 1.65) against a fresh, isolated production stack started by `scripts/run-e2e.mjs` (ADR 0017).
  Projects:
  - `seed-readonly`: specs that assert seed data (`supporters.spec.ts` totals, page 2, city counts). Runs first.
  - `desktop` (1440 x 900, Chromium) and `mobile` (Pixel 7, 390 x 844, Chromium): every other spec; both declare
    `dependencies: ['seed-readonly']`, so seed numbers are asserted before any spec adds or removes signers.
  - `webkit-iphone` (`devices['iPhone 15']`, WebKit): `signature-pad.spec.ts` only (touch, pointer capture, release
    outside the canvas, B-36, B-37).
  - `retries: 0` locally **and in CI**. A flaky test is a failing test and gets a root-cause fix (quality gate), never
    a retry.
  - Signed-in specs use a worker-scoped fixture that registers one user per worker and saves its `storageState`;
    specs that log out, change the password or delete the account register their own user. Mutating specs use unique
    cities (`e2e-<uuid>`) and assert counts relative to a value read at the start of the test.
  - `e2e/a11y.ts` fails on serious or critical axe violations (WCAG 2.2 AA tags).
- **HTML validity (F-87, B-73): one validator, the W3C Nu validator.** `e2e/html-validity.spec.ts` visits every page
  in guest, signed-in, error and validation states and writes each raw response body to `test-results/html/`.
  `scripts/validate-html.mjs` runs the Nu validator image with `--errors-only` over that folder. The image reference
  (tag plus digest) lives in `docker/nu-validator.Dockerfile` (`FROM ghcr.io/validator/validator:<tag>@sha256:<digest>`),
  which the script reads and Dependabot updates. html-validate is not used (F-87 names the W3C validator literally;
  Docker is required anyway).
- **Link crawler (B-42):** `e2e/links.spec.ts` follows every same-origin `href` on every page as guest and as a
  signed-in user and asserts no 404.
- **Unused code (B-41):** `knip` 6 runs in `pnpm lint` (unused files, exports, dependencies).

### One-command setup (names and contracts: `project-scaffold/references/conventions.md` §5)

- **`pnpm setup:env`** → `scripts/setup-env.mjs` (Node built-ins only): creates `.env` from `.env.example` if it is
  missing, otherwise adds only missing keys; fills empty `SESSION_SECRET`, `CSRF_SECRET`, `SEED_DEMO_PASSWORD` and
  `POSTGRES_PASSWORD` with `crypto.randomBytes(32).toString('base64url')`; an existing value is **never**
  overwritten.
- **`pnpm dev:setup`** → `scripts/dev-setup.mjs`:
  1. checks Node 26 (`.nvmrc`), pnpm (version from `packageManager`), Docker (daemon reachable, Compose v2.24 or
     later for `!reset`) and git 2.31 or later; prints what is missing and exits 1;
  2. runs `setup:env`;
  3. runs `pnpm infra:up`, `pnpm db:migrate`, `pnpm db:seed`. Idempotent.
- **`pnpm demo`** = `pnpm setup:env && pnpm stack:demo` (production image with migrate and seed, compose profile
  `demo`, ADR 0016 for the seed guard; prints the URL and the demo login). A reviewer runs
  `pnpm install && pnpm demo` and opens `http://127.0.0.1:3000`.
- No script is named `setup`, because `pnpm setup` is a pnpm built-in command (it configures `PNPM_HOME`) and would
  never reach a package script.
- The CI `e2e` job and the `dev-setup-smoke` job call `node scripts/setup-env.mjs`; the template's `sed` loop over
  `.env.example` (which also touched S3 keys petition does not have) is not copied. `dev-setup-smoke` runs
  `pnpm dev:setup` twice and checks that `.env` is byte-identical after the second run.

### CI and CD

- **CI** (`ci.yml` from the project-scaffold template): jobs lint (+ schema drift check on `drizzle/`), typecheck,
  unit, integration, build, e2e (Nu validator, canvas smoke check, `playwright install --with-deps chromium webkit`),
  `dev-setup-smoke`, gitleaks. SHA-pinned actions, `permissions: contents: read`, concurrency cancel-in-progress.
- **Audit** (`audit.yml`, conventions §9): `pnpm audit --prod --audit-level=high` weekly, on lockfile changes on
  `main` and on demand; not a PR check.
- **CD** (`release.yml`): triggered by `workflow_run` of `CI` with `types: [completed]` and `branches: [main]`; the job
  runs only when `github.event.workflow_run.conclusion == 'success'` and `github.event.workflow_run.event == 'push'`,
  and checks out `github.event.workflow_run.head_sha`. It builds and pushes `ghcr.io/arnoldovna/petition` with tags
  `sha-<sha>` and `latest`, provenance and SBOM. `workflow_dispatch` stays for manual rebuilds. Deploy job present but
  gated by `vars.DEPLOY_ENABLED == 'true'`; its checklist requires `IMPRINT_URL` (ADR 0016), at least 384 MiB memory
  (ADR 0009) and no `text/html` compression at the proxy (ADR 0010).
- **Dependabot:** `npm` (grouped prod/dev, 3-day cooldown), `github-actions`, `docker` for `/` (Dockerfile) and
  `/docker` (Nu validator), `docker-compose` for `/` (`postgres:18-alpine`, `redis:8-alpine`). Every image is pinned
  by digest (compose, Dockerfile, `test/images.ts`, the Nu validator), conventions §9.
- **Merge order:** one PR per phase on the phase branch (conventions §3, §4), squash-merged by the quality gate; the
  next phase branches from the updated `main`.
- **Migrations:** drizzle-kit generated SQL committed in `drizzle/`, applied by the `migrate` one-shot service
  (never from the web process), and once per integration run into the template database (B-60).

### pnpm version

- pnpm stays on **10.34.9** (`packageManager`), chosen on purpose: the `project-scaffold` templates and their
  verified `onlyBuiltDependencies` and `minimumReleaseAge` behaviour are pnpm 10, all three projects share them, and the
  10 line still receives releases (last 2026-10-25). Moving to 11 or 12 is a cross-project change that starts in the
  `project-scaffold` skill (re-verify build-script approval and release-age settings), not in one repository.
  (`versions.md` no longer claims that PLAN.md pins the 10 line; corrected in the 2026-11-15 consistency pass.)

## Alternatives considered

- **html-validate only** (fast, npm-only). Rejected for F-87's literal "W3C validator"; one validator is enough.
- **Release with `needs:` inside `ci.yml`.** Equivalent; `workflow_run` keeps the template's two-file layout.
- **Keep `retries: 2` in CI.** Rejected: it hides exactly the shared-state bugs the critique found.

## Consequences

- Docker is required for `pnpm verify` locally (Testcontainers, the E2E stack, the canvas smoke check and the Nu
  validator).
- E2E data: every run starts from an empty database plus the seed (ADR 0017). The global "no supporters yet" state
  (F-55) is covered in integration tests in a file with its own empty database, not in E2E.
- `pnpm verify` stays the single local gate; `test:e2e` is `node scripts/run-e2e.mjs` (stack up, smoke, Playwright,
  Nu, stack down).
