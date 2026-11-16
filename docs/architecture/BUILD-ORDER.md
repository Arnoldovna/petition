# petition: Build order

Implements PLAN.md Etappe 2: **Scaffold (incl. CI/CD) -> Backend modules (parallel) -> Frontend modules (parallel) ->
CSS & Design (+ design review) -> Tests/E2E**. Every phase ends with the `quality-gate` skill (`pnpm verify`,
`/code-review high`, `/simplify`, `pnpm verify`, conventional commit on a feature branch, PR, `gh pr checks --watch`,
squash merge), one branch and one PR per phase or sub-phase (`project-scaffold/references/conventions.md` §3).
Prerequisite (Etappe 1): this architecture has been reviewed by the architecture critic and revised
(OVERVIEW.md section 23).

`project-scaffold/references/conventions.md` is binding for everything the three projects share (Phase 0 tools,
repo bootstrap, branches, parallel model, script names, e2e and integration-test isolation, cookie names, digest
pins, CI/audit/release workflows). This file only adds petition specifics.

## Rules for parallel work

1. A module in a parallel phase edits **only the files listed for it**. Everything else is read-only.
2. Shared files (composition root, shared kernel, auth kernel, schema, migrations, layout, shared partials,
   `main.css`, `tokens.css`, test harness, CI, `package.json`/lockfile) are created in phase 1 and are read-only for
   parallel modules. If a module needs a change to a shared file, a new dependency or a migration, it stops and
   reports it; the orchestrator applies it in the phase's sequential step (2b, 4e, 5e) or between waves.
3. Every BEM class used in markup must already be defined in CSS for `check:utilities` to pass. Phase 1 creates all
   21 component CSS files with stubs; each later module adds selectors only to the CSS files it owns in that phase.
4. Feature tests live inside the feature (`features/<x>/__tests__/`), including feature-specific fakes, so test files
   never collide. Signed-in agents come from `signIn(agent, userId)` (`test/auth.ts`), never from another module's
   routes (ADR 0017).
5. **Partial parameter contracts (OVERVIEW.md section 15.2) are phase-1 API.** A module that owns a partial may change
   its markup and CSS, never its parameter names or meaning; that is a shared-file request (rule 2).
6. **One working tree, scoped checks only** (conventions §4, ADR 0017). All modules of a phase work on the phase
   branch in the same tree and do not commit. A module runs only
   `pnpm exec vitest run --project unit --project integration <own paths>`, `pnpm exec eslint <own paths>`,
   `pnpm typecheck` (fixing only its own errors) and, for CSS, `pnpm exec stylelint "<own files>"` plus
   `node scripts/check-no-utilities.mjs .` (fixing only findings in its own files). It never runs `pnpm verify`, `pnpm test:e2e`, `pnpm e2e:*`,
   `pnpm demo`, `pnpm dev`, `pnpm infra:*` or any docker compose command (Testcontainers is fine: random ports).
7. **One gate per phase.** After all modules of a phase are done, the orchestrator runs the sequential step, the full
   `pnpm verify` and the quality gate (one PR, squash-merge). The next phase branches from the updated `main`, so
   every PR is verified on top of the current `main` (no rulesets on the private free-plan repo, ADR 0017).

---

## Phase 0: Machine prerequisites (orchestrator, once; conventions §1)

- Node 26 via fnm (this Mac has 22.20), pnpm 10.34.9 installed under Node 26, git ≥ 2.31 first on `PATH`
  (`/usr/local/bin/git` 2.23 breaks lefthook), Docker Desktop running with Compose ≥ 2.24, gitleaks 8.30.1, `gh`
  logged in as Arnoldovna. Already done if imageboard was built first.
- Repository bootstrap (conventions §2): `git init -b main` in `~/Code/petition`, docs-only first commit,
  `gh repo create Arnoldovna/petition --private --source=. --remote=origin --push`.

---

## Phase 1: Scaffold (sequential, incl. CI/CD and the shared kernel; two sub-phases, each with its own gate)

One builder at a time. 1a on branch `feat/scaffold-tooling`, 1b on `feat/scaffold-contracts`; each ends with the
quality gate and a squash-merge, so a red CI only costs one sub-phase's 3-attempt budget.

### 1a. Repository, tooling, CI/CD, Docker, runnable skeleton

Source: `project-scaffold` `templates/monorepo` plus `templates/single-app` overrides (see its README), placeholders
`<slug>` = `petition`. Deviations from the templates are listed in OVERVIEW.md section 6.

| File | Notes |
|---|---|
| `.github/actions/setup/action.yml`, `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `.github/workflows/audit.yml`, `.github/dependabot.yml`, `.github/pull_request_template.md` | release.yml triggered by `workflow_run` of CI on `main`, runs only on `conclusion == 'success'`, checks out `head_sha` (ADR 0015); `audit.yml` per conventions §9; dependabot: npm, github-actions, docker `['/', '/docker']`, docker-compose `/`; ci lint job adds the schema drift check (`pnpm exec drizzle-kit generate && git diff --exit-code -- drizzle && test -z "$(git status --porcelain -- drizzle)"`); ci e2e job runs `node scripts/setup-env.mjs`, installs Chromium and WebKit, runs `pnpm test:e2e`, uploads `test-results/` (incl. `html/`, `compose.log`) on failure; job `dev-setup-smoke` runs `pnpm dev:setup` twice (`.env` byte-identical) |
| `.editorconfig`, `.nvmrc` (26), `.npmrc` (`engine-strict=true`), `.prettierrc.json`, `.prettierignore`, `.gitignore` (+ `.dev/`, `test-results/`), `.dockerignore` (+ `.dev/`, `public/assets/`, `public/fonts/`), `.gitleaks.toml`, `.gitleaks.dir.toml` | |
| `commitlint.config.js`, `lefthook.yml`, `lint-staged.config.js` | |
| `package.json` | scripts per the list below; dependencies exactly as OVERVIEW.md section 20; `packageManager: pnpm@10.34.9` (ADR 0015) |
| `pnpm-workspace.yaml` | `onlyBuiltDependencies: [argon2, esbuild, lefthook]`, `minimumReleaseAge: 1440` |
| `tsconfig.base.json`, `tsconfig.json` (exclude `src/client`), `tsconfig.build.json`, `src/client/tsconfig.json`, `e2e/tsconfig.json` | |
| `eslint.config.js` | single-app template + `import-x/no-cycle` (`eslint-plugin-import-x` 4.18.1, conventions §9) + `client` element (browser globals, may import only `client`) + `tools` element (may import features' `index.ts`, shared, db, config); `shared` may **not** import `db`; `no-restricted-syntax` bans `sql.raw` and `res.render` outside `src/shared/view/render.ts`; `no-restricted-imports` bans `test/**` from `src/**` |
| `stylelint.config.mjs` | from `modular-css-tailwind4`; override allowing `outline: none` only in `src/styles/components/form-field.css` (underline focus replacement) |
| `knip.json` | entries per OVERVIEW.md section 6 |
| `vitest.config.ts` | template + integration `setupFiles: ['./test/setup-database.ts']` (one database per file, ADR 0017) |
| `playwright.config.ts` | projects `seed-readonly`, `desktop`, `mobile` (both depend on `seed-readonly`), `webkit-iphone` (`signature-pad.spec.ts` only); `retries: 0`; no `webServer`; requires `E2E_BASE_URL` (ADR 0015, 0017) |
| `drizzle.config.ts` | template |
| `docker-compose.yml` | single-app template, every image pinned by digest (conventions §9), + profiles `app` (migrate, app), `demo` and `e2e` (+ seed with `SEED_ALLOW: 'true'`, no `NODE_ENV` override); `app` `depends_on: seed: { condition: service_completed_successfully, required: false }`; host ports from `POSTGRES_PORT`, `REDIS_PORT`, `APP_PORT`; env adds `CONTACT_URL`, `IMPRINT_URL`, `APP_TIME_ZONE`, `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS`, `RATE_LIMIT_*`; app `mem_limit: 384m` comment (ADR 0009) |
| `docker-compose.e2e.yml` | Postgres on tmpfs, `ports: !reset []` for Postgres and Redis, app on `127.0.0.1:${APP_PORT}`, raised rate limits (ADR 0017) |
| `docker/nu-validator.Dockerfile` | only `FROM ghcr.io/validator/validator:<tag>@sha256:<digest>`, read by `validate-html.mjs`, updated by Dependabot |
| `Dockerfile` | single-app template (base images by digest) + `COPY scripts scripts` in the build stage; runtime copies `dist/` (incl. `dist/public`, `dist/signature-fonts`, `dist/tools`), `public/`, `src/views/`, `drizzle/` |
| `.env.example` | keys from OVERVIEW.md section 16, secrets empty |
| `LICENSE` (MIT, Arnoldovna), `LICENSES/OFL-SchibstedGrotesk.txt`, `LICENSES/OFL-NotoSans.txt`, `README.md` (stub) | |
| `scripts/check-no-utilities.mjs` | verbatim from `modular-css-tailwind4` |
| `scripts/{setup-env.mjs, dev-setup.mjs, run-e2e.mjs, check-views.mjs, build-client.mjs, hash-css.mjs, write-manifest.mjs, copy-fonts.mjs, validate-html.mjs}` | ADR 0010, 0014, 0015, 0017; conventions §5, §6 |
| Runnable skeleton: `src/server.ts`, `src/container.ts`, `src/app.ts`, `src/config/{app.ts, env.ts}` (template composition with health routes only), `src/views/layouts/main.hbs` + temporary `src/views/pages/home.hbs`, `src/styles/{main,tokens,base,utilities,fonts}.css`, `src/client/{form-guard,signature-pad}.ts` as `export {};`, `src/tools/smoke-canvas.ts` (phase-1 version: raw @napi-rs/canvas, ADR 0005), `test/images.ts` (digest-pinned Testcontainers images), `test/global-setup.ts` + `src/shared/http/__tests__/health.int.test.ts` (readiness against Testcontainers; Vitest exits 1 when the integration project has no test files), `src/config/__tests__/env.test.ts`, `e2e/{a11y.ts, smoke.spec.ts}` | so every tool in `pnpm verify` (build, image, canvas smoke, e2e smoke) has something to run; no schema yet (`drizzle/meta/_journal.json` with empty `entries`, conventions §3); `src/tools/seed.ts` as a stub (`SEED_ALLOW` guard, "nothing to seed yet", exit 0; filled in 2b); 1b replaces the composition with the final wiring and generates `0000_init.sql` |
| `docs/FEATURES.md` | apply the amendments in OVERVIEW.md section 2.2 (F-88 to F-91 are already in) |

`package.json` scripts: `setup:env`, `dev:setup`, `demo`, `dev`, `dev:server`, `dev:css`, `dev:client`, `build`,
`build:css`, `build:client`, `build:assets`, `assets:fonts`, `assets:icons`, `assets:glyphs`, `start`, `lint`
(`eslint . --max-warnings=0 && knip && node scripts/check-views.mjs`), `lint:css`, `check:utilities`, `format`,
`format:check`, `typecheck` (server, client, e2e), `test`, `test:watch`, `test:integration`, `test:e2e`
(`node scripts/run-e2e.mjs`), `e2e:up`, `e2e:down`, `secrets:scan`, `verify`, `infra:up`, `infra:down`, `stack:up`,
`stack:demo`, `stack:down` (`down -v`), `db:generate`, `db:migrate`, `db:seed` (`SEED_ALLOW=true`), `admin:erase`,
`prepare`.

**Gate 1a** (branch `feat/scaffold-tooling`): `pnpm verify` green locally (arm64) and in CI (amd64), incl. the
phase-1 canvas smoke check inside the distroless image; `pnpm install` refuses Node < 26; release workflow builds the
image only after CI is green on `main`; `git ls-files | grep -E '\.env$|\.pem$|secrets'` is empty.

### 1b. Shared kernel (everything later phases depend on)

Branch `feat/scaffold-contracts`. Files that already exist from the 1a skeleton are completed here.

| Area | Files | Covers |
|---|---|---|
| Composition | `src/server.ts`, `src/container.ts`, `src/app.ts` (final middleware order, OVERVIEW 5.1; mounts all five modules; `AppDeps` incl. `rateLimits`, `sessionPolicy`, `assets`, optional `testRoutes`) | B-20, B-50, F-09 |
| Config | `src/config/{app.ts, env.ts, paths.ts}`, `src/config/__tests__/env.test.ts` | F-72, B-57, B-03 |
| Database | `src/db/{client.ts, migrate.ts}`, `src/db/schema/{index.ts, types.ts, users.ts, profiles.ts, signatures.ts}`, `drizzle/0000_init.sql` + `meta/` (generated, reviewed), `src/db/__tests__/schema.int.test.ts` | F-01 to F-06, B-60, B-61 |
| Errors and HTTP | `src/shared/errors/{app-error.ts, db-errors.ts}`, `src/shared/http/{problem.ts, error-handler.ts, form.ts, flash.ts, redirect.ts, pagination.ts, health.ts, static.ts}` + unit tests, `health.int.test.ts` | F-08, F-09, F-17, F-30, F-74, B-13, B-43 |
| Auth kernel (shared) | `src/shared/auth/{password.ts (bounded hasher), guards.ts, viewer.ts (loadViewer, no SQL)}` + `password.test.ts`, `guards.test.ts`, `viewer.int.test.ts` | F-07, F-27, F-31, F-32, B-05, B-06, B-35, B-48 |
| Auth kernel (feature) | `src/features/auth/{viewer.repository.ts, credentials.ts}` + `__tests__/credentials.int.test.ts`; `src/features/auth/index.ts` stub exporting the router stub, `createViewerRepository`, `createCredentials` (real implementations; owned by auth from phase 2 on, interfaces frozen) | ADR 0001, 0002, 0009 |
| Security | `src/shared/security/{session.ts, csrf.ts, security.ts, rate-limit-keys.ts}` + `rate-limit-keys.test.ts`, `session.int.test.ts` (incl. TTL and fake-clock expiry, no-500 regressions), `csrf.int.test.ts` (incl. resubmit round trip), `rate-limit.int.test.ts` (production limits, tested against a test-only route in the harness) | F-26, F-28, F-29, F-70, F-71, B-04, B-08, B-10, B-14 |
| Logging, Redis | `src/shared/logging/logger.ts` + `logger.test.ts`, `src/shared/redis/redis.ts` | F-73, B-12, B-58 |
| Validation | `src/shared/validation/fields.ts` + `fields.test.ts` (all rules and messages from ROUTES.md section 1, incl. email whitespace and case; `typedName` takes the glyph set as a parameter) | F-19, F-35, B-18, B-24, B-26, B-27, B-56 |
| Signature image (contract only) | `src/features/signature/image/{constants.ts, index.ts}` with the `SignatureImages` interface and factory signature; `png.ts`, `signature-image.ts`, `fonts.ts`, `glyphs.generated.ts` as stubs (`not implemented`, empty glyph lists) | ADR 0004, 0005 |
| View engine | `src/shared/view/{engine.ts, helpers.ts, assets.ts, locals.ts, render.ts}` + `helpers.test.ts`, `assets.test.ts`, `render.test.ts` (token only with viewer or bound session; flash consumed only on render) | F-15, F-16, F-17, F-21, B-45, B-75 |
| Feature stubs | `src/features/{pages,profile,signature,supporters}/index.ts`: final `<Name>ModuleDeps` interface and `create<Name>Module()` returning an empty `Router()` (supporters also `countSupporters: () => Promise<number>` returning 0) | ADR 0001 |
| Tools | `src/tools/erase-user.ts` + `erase-user.int.test.ts` (the phase-1 `smoke-canvas.ts` exists since 1a) | ADR 0005, 0013, 0016 |
| Views (shared) | `src/views/layouts/main.hbs`; partials `site-header`, `site-footer`, `flash`, `page-heading`, `csrf-field`, `button`, `form-field`, `error-summary`, `row-list`, `list-row`, `empty-state`, `pagination`, `confirm-panel` (final semantic markup and **frozen parameters**, OVERVIEW 15.2); `src/views/pages/error.hbs`; temporary `src/views/pages/home.hbs` stub (replaced by the pages module) | F-14, F-79, B-46, B-64, B-67 |
| Styles | `src/styles/{main.css, tokens.css (accent vermilion), base.css, utilities.css, fonts.css}`; all 21 files in `src/styles/components/` as stubs (`@layer components { .<block> { display: block; } }` plus the element classes used by the shared partials) | B-76, B-82 |
| Client | `src/client/form-guard.ts`, `src/client/signature-pad.ts` as `export {};` entries so the asset build works | ADR 0010 |
| Static | `public/favicon.svg` (placeholder field), `public/site.webmanifest`, `public/robots.txt` | B-43 |
| Test harness | `test/{images.ts (from 1a), global-setup.ts (template database), setup-database.ts, database.ts, test-app.ts (overrides), test-routes.ts, auth.ts (signIn), fakes.ts (hasher, signature images), forms.ts, html.ts, fonts.ts, factories.ts}` (factories draw a valid 720 x 240 PNG with @napi-rs/canvas directly; no `truncateAll`) | ADR 0015, 0017 |
| E2E harness | `e2e/fixtures.ts` (worker-scoped signed-in storageState, registerUser, signDrawn, signTyped, uniqueCity); `e2e/smoke.spec.ts` extended (signed-in page, CSP) | F-78 |

**Gate 1b exit checks** (in addition to the quality gate):
- `pnpm verify` green locally (arm64) and in CI (amd64); release workflow builds the image only after CI is green on
  `main`.
- The canvas smoke check (phase-1 version, ADR 0005) passes inside the distroless image on both architectures; it is
  part of `test:e2e`.
- Integration files demonstrably run in parallel (Vitest output), each on its own database (ADR 0017).
- `pnpm install && pnpm demo` on a clean clone (no `.env`) ends with the app at `http://127.0.0.1:3000` (seed
  content arrives in 2b).
- `schema.int.test.ts` proves every constraint, cascade and `lower(... COLLATE "pg_c_utf8")` for `München`.
- `git ls-files | grep -E '\.env$|\.pem$|secrets'` is empty.

---

## Phase 2: Backend modules

### 2a. Parallel modules

Each module: Zod schemas, repository (interface + Drizzle), service (Result types), controller (view models, rendered
with `renderPage`), routes (guards, limiters), `index.ts` (replaces the stub, same deps interface), unit and
integration tests (signed-in agents via `signIn`), and the page templates with complete semantic markup built from
the shared partials. CSS: structural rules only, in the files listed.

#### Module `pages`

| Files | |
|---|---|
| `src/features/pages/{pages.controller.ts, pages.routes.ts, index.ts}` | |
| `src/features/pages/__tests__/pages.int.test.ts` | |
| `src/views/pages/{home.hbs, about.hbs, privacy.hbs}` (home replaces the stub) | |
| `src/styles/components/prose.css` | |

Covers F-12, F-13, F-14 (nav per state through the shared header), F-16, F-88, F-89; B-42, B-44, B-62 (about lists the
rebuild stack).

#### Module `auth`

| Files | |
|---|---|
| `src/features/auth/{auth.schema.ts, auth.repository.ts, auth.service.ts, auth.controller.ts, auth.routes.ts, index.ts}` (keeps the phase-1 exports of `viewer.repository.ts` and `credentials.ts` unchanged) | |
| `src/features/auth/__tests__/{fakes.ts, auth.service.test.ts, register.int.test.ts, login.int.test.ts, logout.int.test.ts, account-delete.int.test.ts}` | |
| `src/views/pages/auth/{register.hbs, login.hbs, account-delete.hbs}` | |

Covers F-18 to F-27, F-30 (returnTo on login), F-67 to F-69, F-70 (POST cases), F-90 (register disclosure); B-08, B-09,
B-11, B-22, B-23, B-24, B-25, B-34, B-52, B-54, B-71.

#### Module `profile`

| Files | |
|---|---|
| `src/features/profile/{profile.schema.ts, profile.repository.ts, profile.service.ts, profile.controller.ts, profile.routes.ts, index.ts}` (deps include auth's `Credentials`, injected by `app.ts`) | |
| `src/features/profile/__tests__/{fakes.ts, profile.service.test.ts, onboarding.int.test.ts, edit.int.test.ts}` | |
| `src/views/pages/profile/{onboarding.hbs, edit.hbs}` | |

Covers F-33 to F-36, F-60 to F-66, F-90 (onboarding disclosure); B-11 (re-auth, password field), B-18, B-26, B-27,
B-28, B-29, B-47 (edit page link only when signed), B-55, B-72.

#### Module `signature`

| Files | |
|---|---|
| `src/features/signature/{signature.schema.ts, signature.repository.ts, signature.service.ts, signature.controller.ts, signature.routes.ts, index.ts}` (`index.ts` also exports `createSignatureImages`) | |
| `src/features/signature/__tests__/{fakes.ts, signature.service.test.ts, sign.int.test.ts, thank-you.int.test.ts, delete.int.test.ts}` (thank-you and delete use a fake `countSupporters` from `createTestApp`; F-47 itself is asserted in 2b) | |
| `src/features/signature/image/{png.ts, signature-image.ts, fonts.ts, glyphs.generated.ts}` (implements the phase-1 contract) + `image/__tests__/{png.test.ts, signature-image.test.ts, glyphs.test.ts}` | |
| `scripts/font-glyphs.mjs` (`pnpm assets:glyphs`), `src/tools/smoke-canvas.ts` (switch to `renderTypedSignature` + validator) | |
| `src/views/pages/signature/{sign.hbs, thank-you.hbs, delete.hbs}` | |
| `src/views/partials/{signature-pad.hbs, typed-signature.hbs, signature-frame.hbs}` (pad markup hidden until phase 3 enhances it) | |
| `src/styles/components/{signature-pad.css, typed-signature.css, signature-frame.css, supporter-count.css}` | |

Covers F-37, F-41 (server), F-42, F-43, F-44, F-45 (typed path, glyph set and noscript), F-46, F-48, F-49, F-50, F-71
(image route); B-07, B-19, B-47, B-49, B-54, B-70 (server side).

#### Module `supporters`

| Files | |
|---|---|
| `src/features/supporters/{supporters.schema.ts, supporters.repository.ts, supporters.service.ts, supporters.controller.ts, supporters.routes.ts, index.ts}` | `index.ts` returns `{ router, countSupporters }` |
| `src/features/supporters/__tests__/{fakes.ts, supporters.service.test.ts, supporters.int.test.ts, city.int.test.ts}` | |
| `src/views/pages/supporters/{list.hbs, city.hbs}`, `src/views/partials/supporter-row.hbs` | |
| `src/styles/components/{supporter-list.css, supporter-row.css}` | |

Covers F-51 to F-59, F-53 (XSS payload in every field), F-47 (count source); B-01, B-17, B-30, B-31, B-32, B-33, B-52.

The four modules have no ordering dependency: none needs another module's routes for its tests (rule 4).

### 2b. Sequential integration step (orchestrator)

| Files | Covers |
|---|---|
| Apply queued shared-file requests from 2a | |
| `src/tools/{seed.ts, seed-data.ts, seed-signatures.ts}`, `src/tools/__tests__/seed.int.test.ts` (content per DATA-MODEL.md section 6; `SEED_ALLOW` and foreign-email guards) | F-01, B-60 |
| `src/__tests__/supporter-count.int.test.ts` (real modules: thank-you count equals supporters total; count goes down after signature delete and after account delete) | F-47, F-49, F-68 |
| `src/__tests__/route-matrix.int.test.ts` (every route x guest / unsigned / signed, GET and POST, CSRF-missing for every POST; `/__test/sign-in` is 404 without test routes) | F-07, F-70, B-06, B-07 |
| `src/__tests__/headers.int.test.ts` (both `COOKIE_SECURE` positions under `NODE_ENV=production`; HTML not compressed, assets compressed) | F-71, B-10, B-16 |
| `src/__tests__/error-pages.int.test.ts` (signed-in nav on 413, 429, 403; flash survives redirect-only requests) | F-08, F-09, B-13, B-20, B-43 |

Phase 2 quality gate (branch `feat/backend-modules`).

---

## Phase 3: Frontend modules (parallel)

Progressive enhancement, partial refinement and accessibility wiring. Integration tests of a feature may be updated
only by the module that owns the matching page files (listed). Partial parameters stay frozen (rule 5): the `forms`
module changes the markup of `form-field`, `button` and `error-summary`, but `sign.hbs`, `typed-signature.hbs` and
`thank-you.hbs` (owned by other modules) keep working because the parameters do not change.

#### Module `signature-pad`

| Files | |
|---|---|
| `src/client/{signature-pad.ts, signature-pad.core.ts}`, `src/client/__tests__/signature-pad.core.test.ts` | |
| `src/views/pages/signature/sign.hbs`, `src/views/partials/{signature-pad.hbs, typed-signature.hbs}` | |
| `src/styles/components/{signature-pad.css, typed-signature.css}` (structure: aspect ratio 3/1, `touch-action: none`, hidden state) | |
| `src/features/signature/__tests__/sign.int.test.ts` | markup assertions only |

Covers F-38, F-39, F-40, F-41 (client), F-45 (labelled canvas, `aria-describedby`), F-83 (pad scales); B-36, B-37,
B-38, B-39, B-63 (canvas), B-70.

#### Module `forms`

| Files | |
|---|---|
| `src/client/form-guard.ts` | |
| `src/views/partials/{form-field.hbs, error-summary.hbs, button.hbs, csrf-field.hbs, confirm-panel.hbs}` (markup only, parameters frozen) | |
| `src/views/pages/auth/*.hbs`, `src/views/pages/profile/*.hbs`, `src/views/pages/signature/delete.hbs` | |
| `src/styles/components/{form.css, form-field.css, error-summary.css, button.css, confirm-panel.css}` (structure) | |
| `src/features/{auth,profile}/__tests__/*.int.test.ts`, `src/features/signature/__tests__/delete.int.test.ts` | markup assertions only |

Covers F-20 (link to log in), F-21, F-60, F-75, F-76, F-80; B-49 (client), B-65, B-68, B-71, B-72.

#### Module `shell`

| Files | |
|---|---|
| `src/views/layouts/main.hbs`, `src/views/partials/{site-header.hbs, site-footer.hbs, flash.hbs, page-heading.hbs, row-list.hbs, list-row.hbs}` | |
| `src/views/pages/{home.hbs, about.hbs, privacy.hbs, error.hbs}` | |
| `public/{favicon.svg, apple-touch-icon.png, icon-512.png, site.webmanifest, robots.txt}`, `scripts/generate-icons.mjs` | |
| `src/styles/components/{page.css, site-header.css, site-footer.css, flash.css, page-heading.css, row-list.css, list-row.css, prose.css}` (structure) | |
| `src/features/pages/__tests__/pages.int.test.ts`, `src/__tests__/error-pages.int.test.ts` | markup assertions only |

Covers F-12, F-14 (at most three nav links, about in the footer for signed-in users), F-15, F-16, F-17, F-79, F-84,
F-86 (font preload, no third parties), F-88, F-89 (footer links); B-15, B-42, B-43, B-45, B-46, B-63, B-64, B-67, B-69,
B-75.

#### Module `supporters-ui`

| Files | |
|---|---|
| `src/views/pages/supporters/{list.hbs, city.hbs}`, `src/views/pages/signature/thank-you.hbs` | |
| `src/views/partials/{supporter-row.hbs, pagination.hbs, empty-state.hbs, signature-frame.hbs}` | |
| `src/styles/components/{supporter-list.css, supporter-row.css, pagination.css, empty-state.css, signature-frame.css, supporter-count.css}` (structure) | |
| `src/features/supporters/__tests__/*.int.test.ts`, `src/features/signature/__tests__/thank-you.int.test.ts` | markup assertions only |

Covers F-46, F-52, F-54 (accessible pagination), F-55, F-56, F-58, F-84; B-17, B-33, B-67 (lists), B-73.

Phase 3 quality gate (branch `feat/frontend-modules`).

---

## Phase 4: CSS & design (parallel, then design review)

Tokens are frozen (`tokens.css` only changes in 4e). Each group owns its files; all values come from tokens, BEM only,
`@layer components`, logical properties, container queries, `motion-safe`. Reference: `maw-design-system`
components and `references/screenshots/maw-target-*.png`.

| Group | Files | Covers |
|---|---|---|
| 4a shell | `src/styles/{base.css, utilities.css, fonts.css}`, `components/{page, site-header, site-footer, flash, page-heading, prose, row-list, list-row}.css` | F-79, F-81, F-82, F-83, F-85, F-86; B-63, B-66, B-74, B-78, B-81, B-83 |
| 4b forms | `components/{form, form-field, error-summary, button, confirm-panel}.css` | F-80, F-81, F-82; B-65, B-66, B-68, B-77 |
| 4c signature | `components/{signature-pad, typed-signature, signature-frame, supporter-count}.css` | F-38 (`touch-action`), F-83; B-38, B-63 |
| 4d supporters | `components/{supporter-list, supporter-row, pagination, empty-state}.css` | F-52 (no stray separators), F-54; B-73, B-74, B-77, B-79, B-80 |

**4e. Design review (sequential):** apply queued token requests; against the seeded demo stack (`pnpm demo`,
http://127.0.0.1:3000; never the e2e stack) take screenshots at 390 x 844, 768 x 1024, 1440 x 900, dark
at 1440, one hover and one focus state, for home, register (with errors), sign, thank-you, supporters, city, edit,
privacy, 404. Score with `maw-design-system/references/review-rubric.md` (anti-AI gate clean, no criterion 0, total at
least 24/30; accent button at most once per view, nav at most three links). Use `design-taste-frontend` only as a lens:
`copy-lint.mjs` on all views (F-77, B-75) and overflow, tap-size and a11y checks at 1440/1024/768/390/320. Also open the
local `pnpm demo` stack once in Safari to confirm styles load over plain http (ADR 0011). Fix findings in the owning
files, then the phase 4 quality gate (branch `feat/css-design`).

---

## Phase 5: Tests and E2E (parallel by spec file)

Shared E2E helpers (`e2e/a11y.ts`, `e2e/fixtures.ts`) exist since phase 1; changes to them are queued to 5e. Every
spec follows ADR 0015: seed numbers only in `seed-readonly` specs, mutating specs use their own users and unique
cities and assert relative counts, no 429 assertions (integration only), no retries.

The orchestrator starts **one** stack with `pnpm e2e:up` (project `petition-e2e`, `E2E_PORT` 8182). Units never run
`pnpm test:e2e`, `pnpm e2e:*` or docker compose (conventions §4); 5d may `docker run` the Nu validator through
`node scripts/validate-html.mjs`.

**5.0 Seed-readonly (sequential, first):** one unit writes `e2e/supporters.spec.ts` (project `seed-readonly`: seed
totals, page 2, city counts; F-51 to F-59) and runs it alone against the fresh stack:
`E2E_BASE_URL=http://127.0.0.1:8182 pnpm exec playwright test --project seed-readonly --output=test-results/5-0 --reporter=list`.
It is never re-run against the shared stack after mutating units have started; the final `pnpm verify` (fresh stack,
seed-readonly first) proves it again.

**5a to 5d (parallel, after 5.0):** each unit runs only
`E2E_BASE_URL=http://127.0.0.1:8182 pnpm exec playwright test <own spec files> --no-deps --output=test-results/<group> --reporter=list`
(`--no-deps` skips the `seed-readonly` dependency project, whose exact numbers the other units are changing).

| Group | Files | Covers |
|---|---|---|
| 5a journeys | `e2e/{journey-sign.spec.ts, journey-typed.spec.ts, auth.spec.ts, profile.spec.ts}` | F-17, F-18 to F-36, F-60 to F-66, F-75, F-76, F-90; B-22, B-49 |
| 5b signature and deletion | `e2e/{signature-pad.spec.ts (desktop, mobile, webkit-iphone), deletion.spec.ts}` | F-38 to F-45, F-49, F-50, F-67 to F-69; B-34, B-36 to B-39, B-70 |
| 5c safety | `e2e/{xss.spec.ts, links.spec.ts}` | F-53, F-56 (unique-city paths); B-01, B-30 to B-33, B-42 |
| 5d quality | `e2e/{a11y.spec.ts, html-validity.spec.ts, security-headers.spec.ts}` | F-71, F-78 to F-88; B-16, B-63 to B-74, B-81, B-83 |

**5e. Close-out (sequential):** `pnpm e2e:down`; apply queued helper changes; run `pnpm verify` twice in a row (flake check; each run
starts from a fresh E2E stack); walk the Definition of Done from PLAN.md: CI green, every FEATURES id has a passing test
(table in OVERVIEW.md section 17), every BUGS id resolved (OVERVIEW.md section 21), no utility classes, only maw tokens,
gitleaks clean, axe without serious or critical violations. README with screenshots and `docs/OPERATIONS.md` follow
in Etappe 3. Phase 5 quality gate (branch `test/e2e`).
