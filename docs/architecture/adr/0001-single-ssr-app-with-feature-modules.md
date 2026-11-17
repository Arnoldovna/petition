# ADR 0001: Single Express SSR app with feature modules

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-50, B-51, B-14, B-59, F-10, F-76

## Context

The legacy app is a 430-line `server.js` plus a `db.js` with every query (B-50). PLAN.md fixes the shape for
petition: a single app with Express 5, express-handlebars, Tailwind CLI and Redis sessions. Imageboard and
social-network are monorepos with an SPA. petition has no real-time features (F-10), no JSON API and every form must
work without JavaScript (F-76).

The critique found three couplings in the first draft: `shared/auth/viewer.ts` contained SQL and imported `db`, while
`db/seed.ts` imported `shared` (a shared/db cycle that the boundaries config had to allow); the signature image code
lived in `shared` only because the seed needed it; and both auth and profile wrote password hashes and implemented
current-password checks on their own.

## Decision

- One repository, one package, one Node process: Express 5 with express-handlebars 9 server-side rendering.
- Code is split into feature modules under `src/features/<name>/` (`pages`, `auth`, `profile`, `signature`,
  `supporters`). Each module has `*.schema.ts` (Zod), `*.repository.ts` (SQL only here), `*.service.ts` (rules),
  `*.controller.ts` (HTTP and view models), `*.routes.ts` (router and guards), `index.ts` (public factory) and
  `__tests__/`.
- Cross-cutting code lives in `src/shared/`, configuration in `src/config/`, Drizzle schema and client in `src/db/`.
  **`shared` never imports `db` or features; `db` never imports `shared` or features.**
- Tooling entry points that need features (the seed, the canvas smoke check, the manual erasure command) live in
  `src/tools/`. `tools` may import `features/<x>/index.ts`, `shared`, `db` and `config`; nothing imports `tools`.
- **Ownership of security logic.** The auth module owns every write to `users.email`, `users.password_hash` and
  `users.session_version`, and every password check. Its `index.ts` exports, besides the router:
  - `createViewerRepository(db)` with `findViewer(userId)`, injected into `loadViewer` (ADR 0002);
  - `createCredentials({ db, hasher })` with `verifyCurrentPassword(userId, password)`,
    `hashNewPassword(password)` and `apply(tx, userId, { email?, passwordHash? })` (one `UPDATE users` in a savepoint
    of the caller's transaction, bumps `session_version` when the hash changes; result
    `{ ok: true, sessionVersion } | { ok: false, reason: 'email-taken' | 'not-found' }`, ADR 0009). `app.ts` injects
    it into the profile module, which runs it inside its own edit transaction (ADR 0009).
- **The signature image code belongs to the signature feature** (`src/features/signature/image/`). Its `index.ts`
  exports `createSignatureImages(...)`; `container.ts` creates it, and `src/tools/seed.ts` uses the same export.
- `src/container.ts` is the only place that opens connections. `src/app.ts` wires middleware and modules through
  factory functions (no singletons, no DI library), following the `express-feature-module` skill.
- Browser code is a separate, tiny TypeScript tree in `src/client/` (progressive enhancement only, see ADR 0010).
- Zod schemas are the request contract. There is no `packages/shared` because there is no second consumer;
  shared field rules sit in `src/shared/validation/fields.ts`.
- ESLint `eslint-plugin-boundaries` enforces the dependency rules listed in OVERVIEW.md section 7.

## Alternatives considered

- **Monorepo with SPA (like Imageboard).** Rejected: it would duplicate routing, add a JSON API and a CSRF header
  flow, and break the no-JS requirement (F-76). PLAN.md fixes SSR for petition.
- **Layer-first folders (`controllers/`, `services/`).** Rejected: changes to one feature touch five folders, and
  import boundaries between features cannot be enforced.
- **htmx or a client framework.** Rejected: nothing in FEATURES needs partial page updates, and every extra runtime
  is a CSP and maintenance cost.
- **Keep the viewer query in `shared` with a boundaries exception.** Rejected after critique: one injected function
  removes the cycle and the exception.

## Consequences

- Each feature can be built and tested in parallel (BUILD-ORDER.md) as long as the scaffold creates the shared
  kernel, the database schema, stub `index.ts` files and the small auth kernel (`viewer.repository.ts`,
  `credentials.ts`) that other modules depend on.
- Features never import each other's internals. When a feature needs data or behaviour owned by another (the supporter
  count on the thank-you page, the credentials service in profile edit), the composition root injects a function
  (ADR 0006, ADR 0009).
- Views, partials and styles are shared resources. File ownership per phase and the frozen partial parameter
  contracts are fixed in BUILD-ORDER.md and OVERVIEW.md section 15.2.
