# ADR 0019: Alignment with the cross-project consistency pass (re-review)

- Status: Accepted (adversarial re-review after the consistency pass, 2026-11-16)
- Date: 2026-11-16
- Covers: conventions §1 and §3 to §9 as applied to petition; amends ADR 0012, 0015, 0016 and 0017; F-01, F-26, F-87,
  B-59, B-60

## Context

The consistency pass of 2026-11-15 (`project-scaffold/references/conventions.md`) changed rules shared by all three
projects after this architecture had been critiqued: one working tree for parallel units, one database per integration
test file, isolated e2e stacks with fixed ports per project, app-scoped cookie names, the `SEED_ALLOW` switch and the
CI/audit/release workflows. Since then the project moved to a new machine (`~`, no `~/Code`), and
PLAN.md Etappe 0 records the machine prerequisites as done through `~/.devenv.sh`. A re-review of
these docs against the new rules found steps that contradicted them or could not be built as written. Each decision
below names the problem it removes. The CI cost rule is ADR 0018.

## Decision

### 1. Phase 0 is `~/.devenv.sh`

The script changes nothing on the system, only the current shell: it prepends the newest installed nvm Node 26
(`~/.nvm/versions/node/v26.*`, 26.13.1 on 2026-11-16) and `/opt/homebrew/bin` (git 2.52, gh, docker, gitleaks 8.30.1,
lefthook) to `PATH` and exports `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`. `pnpm` is a corepack shim that is already on the
user's `PATH`; corepack runs exactly `package.json#packageManager` (`pnpm@10.34.9`). Every shell command an agent runs
starts with `source ~/.devenv.sh && `. Agents do not install fnm or Homebrew packages, do not run
`npm i -g pnpm`, and do not edit shell rc files. Conventions §1 still describes fnm and `/usr/local/bin/git`; PLAN.md
wins on conflict (flagged). Playwright browsers are not part of Phase 0: they need the Playwright version from the
lockfile, so phase 1a installs them once (`pnpm exec playwright install chromium webkit`, no `--with-deps` on macOS).
The repository bootstrap (conventions §2) is already done: `main` holds the docs-only commit, `origin` is the private
`Arnoldovna/petition`.

### 2. One working tree that stays importable

`createTestApp()` builds the real app, and `app.ts` imports all five modules' `index.ts`; every page renders shared
partials. With all units in one tree (conventions §4), one unit's half-written file can turn every other unit's
scoped tests red. Rules:

- A unit writes its internal files first and replaces its stub `index.ts` **last**, after its internal files are
  complete and its unit tests pass. The new `index.ts` keeps the frozen deps interface and must never throw at import
  or at `create<Name>Module()` time.
- Every file a unit saves must parse: TypeScript, Handlebars (a broken partial breaks every page that uses it) and CSS
  (`check-no-utilities.mjs` and `main.css` read all component files). Write whole files, not partial drafts.
- A failure caused by a sibling's file is reported to the orchestrator, never fixed by the unit.
- **Frozen** (conventions §4) means: every file created in phase 1 except the files a later unit's list in
  BUILD-ORDER.md names explicitly. Those are stubs created to be replaced (feature `index.ts` stubs, page stubs, the 21
  component CSS stubs, client entry stubs, signature image stubs, `smoke-canvas.ts`) or files handed over on purpose
  (partial markup under the frozen parameter contract, global stylesheets in phase 4a, icons). The layout
  `src/views/layouts/main.hbs`, `main.css`, `tokens.css`, the test and e2e harnesses, config, composition root, schema
  and migrations stay frozen for every unit; changes go through the orchestrator's sequential steps (2b, 3b, 4e, 5e),
  which edit only the files listed for them plus the files named in queued requests.

### 3. Dependencies enter with the phase that first uses them

`pnpm lint` runs knip (ADR 0015), which reports unused dependencies. Phase 1a ships a runnable skeleton (conventions
§3) that does not yet use sessions, CSRF, rate limits or argon2, and parallel units may not add dependencies (conventions
§4). So:

- 1a installs the dependencies its files import; 1b (sequential, one builder) adds the rest. OVERVIEW.md section 20 has
  a "from" column. No dependency is added in phases 2 to 5 except by the orchestrator between waves.
- `scripts/font-glyphs.mjs` (the only `fontkit` user), the generated `glyphs.generated.ts` and the drift test
  `glyphs.test.ts` move from the 2a signature unit to 1b. The typed-name rule then works with the real glyph set from 1b
  on, and the `assets:glyphs` script never points at a missing file.
- The knip configuration is `knip.jsonc` (comments allowed). Candidates for references knip may not see are the font
  packages that `copy-fonts.mjs` and `test/fonts.ts` use by file path, the `pino-pretty` transport string and the CSS
  `@import "tailwindcss"`. Phase 1a runs knip; only a dependency knip actually reports and that is provably used gets an
  `ignoreDependencies` entry, each with a comment naming the user. Every other finding is fixed (remove the dependency
  or the dead export), never ignored. One exception, decided at the 1b gate: the helpers of the frozen e2e harness
  (`e2e/fixtures.ts`: `registerUser`, `signDrawn`, `signTyped`, `uniqueCity`, `E2eUser`) carry a `@public` JSDoc tag,
  because units may not edit that file later and their only importers are the spec files of step 2b and phase 5.
  Application code never uses the tag; a stub that nothing can import yet is created in the phase that uses it
  instead (for example `png.ts` in 2a).
- `@vitest/coverage-v8` is used by a `test:coverage` script (`vitest run --project unit --coverage`, not part of
  `verify`); services should be near full branch coverage (`express-feature-module` testing reference).

### 4. A phase-1a skeleton that can actually run

`pnpm verify` in 1a runs the schema drift check, migrations, the integration project (with the per-file database setup
from conventions §7), the production build, the image and an e2e smoke page. The 1a file list therefore includes the
template composition trimmed to health, errors, logging, helmet headers and one rendered page: `src/db/{client.ts,
migrate.ts, schema/index.ts}` (schema `export {};`, empty `drizzle/meta/_journal.json`), `src/shared/{logging,
redis, errors}`, `src/shared/http/{problem.ts, error-handler.ts, health.ts, static.ts}`,
`src/shared/security/security.ts` (headers only), `src/shared/view/{engine.ts, helpers.ts, assets.ts, render.ts}`
(no viewer, token or flash yet), `src/tools/seed.ts` (stub), and `test/{images.ts, global-setup.ts,
setup-database.ts, database.ts, test-app.ts}`. 1b completes these files. Phase 1a also runs `pnpm format` once:
`pnpm format:check` (the first `verify` step) checks `docs/**/*.md`, and 19 of the 25 doc files failed it on 2026-11-16
(Prettier 3.10.1, template config). The change is layout only.

### 5. Integration-test details that the per-file database needs

- `currentDatabaseUrl()` (`test/database.ts`) throws when called outside a test or hook; `createTestApp()` is called
  in `beforeAll`/`beforeEach`, never at module top level (the file database does not exist yet).
- `createTestApp(overrides)` returns `{ app, db, redis, prefix, close }`. `prefix` (`test-<uuid>`) lets
  `session.int.test.ts` read `<prefix>:sess:<id>` with `redis.pTTL()`. `close()` ends the pool and the Redis client;
  `test/setup-database.ts` drops the database afterwards. Vitest runs `afterAll` hooks in reverse order by default
  (`sequence.hooks: 'stack'`), so the setup file's drop runs after the test file's own `afterAll`; `WITH (FORCE)` is the
  backstop.
- `test/images.ts` reads the `postgres` and `redis` image references (`tag@sha256:…`) from `docker-compose.yml` and
  fails fast when it cannot find them. One source for both, so a Dependabot docker-compose update also reaches
  Testcontainers.
- The ESLint `no-restricted-imports` rule that bans `test/**` applies to non-test sources only (`src/**/*.ts` minus
  `src/**/__tests__/**` and `src/**/*.test.ts`), because every integration test imports the harness.
- `POST /__test/sign-in` reads `{ userId }` as JSON through an `express.json({ limit: '1kb' })` parser on the test
  router itself. The app has no JSON body parser (OVERVIEW.md section 5.1), so the route would otherwise see an empty
  body.

### 6. The e2e override really isolates

- Compose concatenates `ports` across files (unique key `ip, target, published, protocol`). The override therefore
  uses `ports: !override ['127.0.0.1:${E2E_PORT:-8182}:3000']` for `app` and `ports: !reset []` for `postgres` and
  `redis`; `postgres` gets `volumes: !reset []` and `tmpfs: ['/var/lib/postgresql']`. `APP_PORT` is not involved, so
  the e2e stack and `pnpm demo` (3000) can run at the same time. Requires Compose 2.24.4 or later; verified with
  Compose 5.5 (`docker compose config`, 2026-11-16).
- `scripts/run-e2e.mjs` resolves `E2E_PORT` once (process env, else `.env`, else `8182`), validates it, and passes the
  same value to compose and to `E2E_BASE_URL`. It stops with "run `pnpm setup:env`" when `.env` is missing, runs
  `down -v --remove-orphans` before `up` (leftovers of a killed run) and always afterwards unless `--keep`, runs the
  canvas smoke check in `petition-e2e-app` (compose's default `<project>-<service>` image name), then Playwright, then
  the Nu validator only after a green Playwright run, and writes `test-results/compose.log` on any failure.
- Optional compose dependencies were verified on 2026-11-16 (Compose 5.5): with `depends_on: seed: { condition:
service_completed_successfully, required: false }`, `--profile app` starts `app` without `seed`, and
  `--profile demo` starts `app` only after `seed` exited 0; `up --wait` exits 0 in both cases.
- Playwright: `webkit-iphone` also declares `dependencies: ['seed-readonly']`, because `signature-pad.spec.ts` signs and
  so changes the totals that `supporters.spec.ts` asserts. `workers: process.env.CI ? 2 : 4` (one app container with
  384 MiB and a hasher bounded to two concurrent hashes serves every worker). Phase-5 units add `--workers=2`.
- `html-validity.spec.ts` writes the raw bodies to `html/` inside the run's output directory (`test-results/html/` in a
  full run, `test-results/5d/html/` for unit 5d); `scripts/validate-html.mjs [dir]` defaults to `test-results/html`.
  Playwright cleans its output directory at the start of a run, so no stale page is ever validated.

### 7. Seed and `.env`

- `SEED_ALLOW` is never an `.env` key and is not in `.env.example`; it is set per invocation by `pnpm db:seed` and by the
  compose `seed` service. `E2E_BASE_URL` is not in `.env.example` either (set by `run-e2e.mjs`).
- The guard is a pure, exported function in `src/tools/seed.ts` (`assertSeedAllowed(env)`), so `seed.int.test.ts` tests
  it without spawning a process; the entry point reads `process.env` and calls it.
- **Foreign users mean "skip", not "fail".** When `users` contains an email outside `@petition.test`, the seed writes
  nothing, logs `seed.skipped {reason: 'foreign-users'}` and exits 0. The first draft exited 1, which broke conventions
  §5 idempotency: a reviewer who registered during `pnpm demo` could not start `pnpm demo` again (the app waits for the
  seed to complete successfully), and a developer who registered locally could not re-run `pnpm dev:setup`. Skipping
  gives the same protection (no demo accounts with a shared password in a real database).
- `POSTGRES_PASSWORD` keeps the template's fixed local value `local-only` and is not generated. The dev `DATABASE_URL`
  in `.env` must name the same user, password and database; a generated password would need a derived URL and would
  lock out an existing `postgres-data` volume whenever `.env` is recreated. The database only listens on `127.0.0.1`
  (dev) or is not published at all (e2e). `pnpm dev:setup` stops with a message (key names only) when `DATABASE_URL`
  and `POSTGRES_*` disagree. Generated secrets are exactly the empty keys whose name contains `SECRET` or `PASSWORD` as a
  word: `SESSION_SECRET`, `CSRF_SECRET`, `SEED_DEMO_PASSWORD`.

### 8. Scripts

- `demo` = `node scripts/dev-setup.mjs --demo`: checks Node, Docker and Compose, runs `setup:env`, then
  `pnpm stack:demo` (`docker compose --profile demo up -d --build --wait`), and prints `http://127.0.0.1:<APP_PORT>` and
  the demo login (`demo@petition.test` plus `SEED_DEMO_PASSWORD` from `.env`, the one secret conventions §5 allows to
  print). A plain compose command cannot print anything.
- `stack:down` = `docker compose --profile app --profile demo down` (no `-v`, as in conventions §5; the extra profile
  removes the exited `seed` container). Resetting local data is a documented manual command
  (`docker compose --profile app --profile demo down -v`), not a script.

### 9. Production limits on the real routes

The 1b limiter test (`src/shared/security/__tests__/rate-limit.int.test.ts`) can only use a test-only route, because
auth does not exist yet, and units may not touch it later. Step 2b adds `src/__tests__/rate-limits.int.test.ts` with
the production limits on the real `POST /login` (11th failed attempt is the 429 page, per email across IPs through
`X-Forwarded-For` with `trustProxy: 1`, successful logins not counted), `POST /register`, `POST /account/delete`
(`reauth`) and `POST /signature` (`sign`).

### 10. Requirement ids in test titles

Conventions §11: every test title starts with the ids it covers (`F-24, B-09: unknown email and wrong password give the
same 401 page`). Phase 5e greps all ids of FEATURES.md and BUGS.md against `src/`, `test/`, `e2e/` and `scripts/`
titles (`scripts/__tests__` is a unit-test location in `vitest.config.ts`); ids verified by other means (lint, review,
CI) are listed with that means in OVERVIEW.md section 21. Since 5e, `src/__tests__/traceability.test.ts` runs this
check on every `pnpm test`.

## Alternatives considered

- **Per-unit worktrees or branches** (the first plan): no importability rules needed, but conventions §4 fixes one
  working tree. Rejected.
- **Install every dependency in 1a and silence knip until phase 2.** Hides real findings for two gates. Rejected.
- **Keep `APP_PORT=$E2E_PORT` instead of `!override`.** Works only while both files agree and couples the e2e port to a
  dev setting; conventions §6 puts the public port in the override. Rejected.
- **Keep the seed's hard refusal and reset volumes in `stack:down`.** Destroys the developer's data on every stop and
  still fails `dev:setup` after a local registration. Rejected.
- **Generate `POSTGRES_PASSWORD` and derive `DATABASE_URL` in `setup-env.mjs`.** More code and still breaks an existing
  volume after `.env` is recreated, for a database that is never reachable from outside the machine. Rejected.

## Consequences

- BUILD-ORDER.md gains the importability rules, a phase-3 sequential step (3b), a complete 1a file list and the moved
  glyph files; OVERVIEW.md sections 1, 6, 7, 16 to 23, DATA-MODEL.md section 6, ROUTES.md section 7 and ADR 0005,
  0007, 0012, 0015, 0016, 0017 are updated to match.
- If `.env` is recreated while an old `postgres-data` volume exists, the seeded demo user keeps its old password (the
  seed only inserts). `docker compose --profile app --profile demo down -v` resets it; README "Getting started" says so.
- Conventions §1 (fnm, `/usr/local/bin/git`) and §9 (no CI cost rule) are stale for this machine and for ADR 0018.
  Marina should update the shared file; petition follows PLAN.md and these ADRs meanwhile.
