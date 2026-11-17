# ADR 0017: Test data isolation, test-only sign-in and isolated stacks for parallel builds

- Status: Accepted (added after architecture critique, 2026-11-15; parallel-build part aligned with
  `project-scaffold/references/conventions.md` §4 and §6 in the cross-project consistency pass, same day; harness,
  e2e override and importability details amended by ADR 0019, 2026-11-16)
- Date: 2026-11-15
- Covers: F-07, F-26, F-47, F-54, F-55, B-06, B-60; BUILD-ORDER.md rules 1 to 9

## Context

The critique found that the first draft's test and build plan could not stay green:

- **Integration tests shared one Postgres** per Vitest run while files ran in parallel. Supporters (totals, page 2,
  ordering), thank-you (count equals list total), deletion (count goes down), city counts and the seed test all assert
  global aggregates that other files change at the same time, and `truncateAll` in one file wiped rows of another.
- **E2E specs shared the seeded database** (fully parallel, desktop and mobile), while `supporters.spec.ts` asserts
  the seed's exact numbers and journey, deletion and XSS specs add or remove signers. Locally the `postgres-data` volume
  persisted between runs (`reuseExistingServer`), so a second run saw different totals.
- **Phase 2a could not test signed-in behaviour**: until the auth PR merges, `POST /login` and `/register` return 404,
  and the harness had no other way to get an authenticated agent.
- **Parallel builders collided locally**: a fixed compose project name and fixed host ports 3000, 5432 and 6379 mean
  parallel `pnpm verify` runs fail with "port is already allocated", replace each other's containers, or quietly test
  another stack.
- **Merges were not re-verified**: the private free-plan repo has no rulesets, so a PR that was green against an older
  `main` could be squash-merged without CI on top of a sibling's merge.

## Decision

### Integration: one database per test file

- `test/global-setup.ts` starts one Postgres and one Redis container per run (image references from `test/images.ts`,
  which reads the digest-pinned `postgres` and `redis` images from `docker-compose.yml`, so compose and Testcontainers
  never drift; ADR 0019 §5), creates the database `petition_template`, applies the migrations to it, closes every
  connection to it (a template must have none) and provides the admin URL and the Redis URL.
- `test/setup-database.ts` is in the integration project's `setupFiles`. In `beforeAll` it runs
  `CREATE DATABASE "t_<random>" TEMPLATE petition_template` through the admin connection and stores the URL in
  `test/database.ts` (`currentDatabaseUrl()`); in `afterAll` it runs `DROP DATABASE ... WITH (FORCE)`. Cloning a small
  migrated template takes well under a second. Vitest runs `afterAll` hooks in reverse order by default
  (`sequence.hooks: 'stack'`), so the drop runs after the file's own `afterAll` has closed its pools; `FORCE` is the
  backstop.
- `createTestApp()` and `test/factories.ts` use `currentDatabaseUrl()`, which throws outside a test or hook; test files
  create their app in `beforeAll`/`beforeEach`, never at module top level. Every file starts with an **empty,
  migrated** database of its own, so global counts, pagination and the F-55 empty state are exact and file parallelism
  stays on.
- There is **no `truncateAll`**. A test that needs a different starting state (for example an empty supporters list)
  goes into its own test file, which gets its own empty database.
- Redis stays shared: every `createTestApp()` call uses a fresh prefix `test-<uuid>` for sessions
  (`test-<uuid>:sess:`) and rate-limit stores (`test-<uuid>:rl:<name>:`), the same shape `container.ts` builds from
  `APP_SLUG` (`petition:sess:`, `petition:rl:<name>:`).

### `createTestApp(overrides)`

```ts
interface TestAppOverrides {
  rateLimits?: Partial<RateLimitConfig>; // default 10,000 everywhere (ADR 0012)
  sessionPolicy?: Partial<SessionPolicy>; // idleMs, absoluteMs, now (ADR 0002)
  countSupporters?: () => Promise<number>; // fake for phase 2a signature tests (ADR 0006)
  trustProxy?: number; // only the two limiter test files set 1
}

interface TestApp {
  app: Express;
  db: Database; // the file's own database
  redis: RedisClient; // shared container, keys under `prefix`
  prefix: string; // `test-<uuid>`, e.g. for redis.pTTL(`${prefix}:sess:<id>`)
  close(): Promise<void>; // ends the pool and the Redis client; the setup file drops the database
}
```

### Test-only sign-in

- `test/test-routes.ts` builds a router with `POST /__test/sign-in` (JSON body `{ userId }`, parsed by an
  `express.json({ limit: '1kb' })` on this router, because the app itself only parses urlencoded forms): it loads the
  user through the injected viewer repository and calls `establishSession(req, user, policy)`; 204 on success, 404 for
  an unknown id. `test/auth.ts` exports `signIn(agent, userId)`.
- `AppDeps.testRoutes?: Router` is mounted by `app.ts` after the body parsers and before CSRF. Only `createTestApp`
  passes it; `container.ts` never does. ESLint `no-restricted-imports` bans `test/**` from every non-test file in
  `src/**` (test files under `__tests__/` import the harness by design), and `route-matrix.int.test.ts` asserts that an
  app built without `testRoutes` answers `POST /__test/sign-in` with 404.
- From phase 1 on, every module's integration tests can work with guest, signed-in-unsigned and signed-in-signed
  agents (`createUser`, `createSignature` from `test/factories.ts` plus `signIn`). Real login and registration are
  tested only in the auth module's own files.

### E2E: a fresh, private stack per run

- `pnpm test:e2e` runs `scripts/run-e2e.mjs` (contract: conventions §6; details ADR 0019 §6):
  1. resolves `E2E_PORT` once (process environment, else `.env`, else **8182**), validates it, and passes the same
     value to compose and to `E2E_BASE_URL=http://127.0.0.1:<port>`; stops with "run `pnpm setup:env`" when `.env` is
     missing (the stack needs its secrets);
  2. `docker compose -p petition-e2e -f docker-compose.yml -f docker-compose.e2e.yml --profile e2e down -v
--remove-orphans` (leftovers of a killed run), then `up -d --build --wait`;
  3. runs the canvas smoke check in the image that stack built (`petition-e2e-app`, compose's default
     `<project>-<service>` name; ADR 0005);
  4. runs `playwright test` with the passed arguments, then, only if it passed, `node scripts/validate-html.mjs`; on any
     failure writes `test-results/compose.log`;
  5. always runs `down -v --remove-orphans` at the end (`--keep` leaves the stack up for debugging).
     `pnpm e2e:up` / `pnpm e2e:down` (`--up` / `--down`) are the two halves for the phase-5 orchestrator; `--up` prints
     `E2E_BASE_URL`.
- `docker-compose.e2e.yml`: `postgres` with `ports: !reset []`, `volumes: !reset []` and
  `tmpfs: ['/var/lib/postgresql']`; `redis` with `ports: !reset []`; `app` with
  `ports: !override ['127.0.0.1:${E2E_PORT:-8182}:3000']` (compose would otherwise concatenate it with the base file's
  `APP_PORT` mapping), `RATE_LIMIT_GLOBAL_MAX=100000`, `RATE_LIMIT_AUTH_MAX=100000` (ADR 0012); seed enabled (profile
  `e2e`, ADR 0016). Needs Compose 2.24.4 or later.
- `playwright.config.ts` has no `webServer` and no `reuseExistingServer`: the script owns the stack, and the config
  requires `E2E_BASE_URL`.
- Seed assertions run in the `seed-readonly` project before the mutating projects (ADR 0015).

### Parallel units and merge order (conventions §3, §4)

- Parallel units of a phase share **one working tree** on the phase branch, own disjoint files, do not commit and run
  only scoped checks (Vitest and ESLint on their own paths, `pnpm typecheck` fixing only their own errors).
  Integration tests use Testcontainers (random ports and one database per file), so concurrent scoped runs do not
  interfere. Units never run `pnpm verify`, `pnpm test:e2e`, `pnpm e2e:*`, `pnpm demo` or docker compose.
- Because the test app imports every module, the shared tree must stay importable: a unit replaces its stub
  `index.ts` last, every saved file parses, and failures caused by a sibling's file are reported, never fixed
  (BUILD-ORDER rule 6, ADR 0019 §2).
- The orchestrator runs the full `pnpm verify` once after the wave and then the quality gate: **one PR per phase**.
  Phases run one after another and each branches from the updated `main`, so every PR is verified on top of the
  current `main` without `gh pr update-branch` (the private free-plan repo has no rulesets; PLAN.md: rulesets when
  public).
- Phase 5: the orchestrator starts one stack with `pnpm e2e:up`. The seed-readonly spec (`supporters.spec.ts`) runs
  first, alone, against that fresh stack (BUILD-ORDER 5.0); only then do the mutating units run
  `E2E_BASE_URL=<printed url> pnpm exec playwright test <own specs> --no-deps --workers=2` in parallel, each with its
  own `--output` folder. `--no-deps` keeps the `seed-readonly` dependency project from re-running against data the
  other units are changing. The final `pnpm verify` runs everything, seed-readonly first, on a fresh stack.
- The development infrastructure (`pnpm infra:up`, compose project `petition`) is only for `pnpm dev` and `pnpm demo`;
  its host ports come from `POSTGRES_PORT` and `REDIS_PORT` (defaults 5432 and 6379). Parallel units do not need it.

## Alternatives considered

- **`fileParallelism: false` for integration tests.** Simpler, but the suite would run several times slower, and a
  forgotten cleanup in one file would still leak into the next.
- **A machine-wide lock around `test:e2e`.** Avoids collisions but serialises the slowest step of every parallel
  builder; isolated stacks cost only disk and CPU.
- **Build auth sequentially before phase 2a.** Removes the sign-in problem but lengthens the critical path; the
  test-only route is a few lines and keeps real login tests in the auth module.

## Consequences

- Docker runs at most one e2e stack per project at a time (`petition-e2e`), plus one Testcontainers pair per
  concurrent integration run.
- The template's `test-app.ts`, `global-setup.ts` and `playwright.config.ts` are adapted, not copied verbatim; the
  deviations are listed in OVERVIEW.md section 6.
- Running `pnpm verify` twice in a row (phase 5e) starts from the same state both times.
