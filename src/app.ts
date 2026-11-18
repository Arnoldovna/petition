import cookieParser from 'cookie-parser';
import express, { type Express, type RequestHandler, type Router } from 'express';
import type { Logger } from 'pino';

import { isHttps, type Env } from './config/env.js';
import type { AppPaths } from './config/paths.js';
import type { Database } from './db/client.js';
import { createAuthModule, createCredentials, createViewerRepository } from './features/auth/index.js';
import { createPagesModule } from './features/pages/index.js';
import { createProfileModule } from './features/profile/index.js';
import { createSignatureModule, type SignatureImages } from './features/signature/index.js';
import { createSupportersModule } from './features/supporters/index.js';
import type { PasswordHasher } from './shared/auth/password.js';
import { loadViewer } from './shared/auth/viewer.js';
import { errorHandler, notFoundHandler } from './shared/http/error-handler.js';
import { createHealthRouter, type ReadinessCheck } from './shared/http/health.js';
import { createStaticRouter } from './shared/http/static.js';
import { createRequestLogger } from './shared/logging/logger.js';
import { createCsrf, type Csrf } from './shared/security/csrf.js';
import { securityHeaders, type RateLimiters } from './shared/security/security.js';
import { enforceAbsoluteLifetime, type SessionPolicy } from './shared/security/session.js';
import type { AssetResolver } from './shared/view/assets.js';
import { configureViewEngine } from './shared/view/engine.js';
import { viewLocals, viewLocalsOnError } from './shared/view/locals.js';

/** Rows per supporters page (ADR 0006, F-54). */
const SUPPORTERS_PAGE_SIZE = 50;

/** Body limits (ADR 0004): forms are small; only the signature routes carry a 720 x 240 PNG data URL. */
const FORM_BODY_LIMIT = '16kb';
const SIGNATURE_BODY_LIMIT = '128kb';

/**
 * Everything the app needs from the outside world. `container.ts` builds the real one; `test/test-app.ts` builds one
 * on Testcontainers with test limits, a fake clock and fakes. Connections are opened and closed by those callers,
 * never here.
 */
export interface AppDeps {
  env: Env;
  logger: Logger;
  /** Views and static folders of one asset mode, chosen by the caller together with `assets`. */
  paths: AppPaths;
  assets: AssetResolver;
  db: Database;
  /** `createSessionMiddleware(...)`, built with the same `sessionPolicy` (cookie `maxAge` = `idleMs`, ADR 0002). */
  session: RequestHandler;
  /** Idle and absolute lifetimes and the clock (ADR 0002 item 4). */
  sessionPolicy: SessionPolicy;
  /** The bounded argon2id hasher (ADR 0009). */
  hasher: PasswordHasher;
  /** `createTimingDummy(hasher)`: verified against for unknown emails (F-24, B-23). */
  timingDummyHash: string;
  /**
   * The seven limiters of ADR 0012, built once from the `RateLimitConfig` (production values from the environment,
   * 10,000 in tests) with one Redis store and prefix each (`createRateLimiters`).
   */
  rateLimits: RateLimiters;
  /** Created once per process: font registration is process-wide (ADR 0005). */
  signatureImages: SignatureImages;
  readiness: Readonly<Record<string, ReadinessCheck>>;
  isShuttingDown: () => boolean;
  /**
   * Only `createTestApp` passes it (`POST /__test/sign-in` and friends, ADR 0017); `container.ts` never does, and
   * ESLint bans importing `test/` from application code. Mounted after the body parsers and before CSRF.
   */
  testRoutes?: Router;
  /**
   * Tests only (ADR 0006, ADR 0017): replaces the supporters module's count in the signature module, so phase-2a
   * signature tests can render the thank-you page with a fixed number. Production always counts with the real query.
   */
  countSupporters?: () => Promise<number>;
}

/**
 * The CSRF protection of the app (ADR 0003): the form field `_csrf`, bound to the session id, cookie name and flags
 * from the same "served over https" switch as the session cookie. Exported so the test harness checks its test-only
 * form with exactly the app's configuration.
 */
export function createAppCsrf(env: Pick<Env, 'CSRF_SECRET' | 'COOKIE_SECURE' | 'NODE_ENV'>): Csrf {
  return createCsrf({ secret: env.CSRF_SECRET, secure: isHttps(env) });
}

/**
 * The middleware order of OVERVIEW.md section 5.1. The numbers below are its steps; the order is part of the
 * security design (static files before sessions, the viewer before every error page, CSRF after the body parsers),
 * so a change here is an architecture change.
 */
export function createApp(deps: AppDeps): Express {
  const { env, paths } = deps;
  const app = express();
  const csrf = createAppCsrf(env);

  // 1. settings and views (B-10, B-45)
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');
  configureViewEngine(app, {
    viewsDir: paths.viewsDir,
    assets: deps.assets,
    timeZone: env.APP_TIME_ZONE,
    issueCsrfToken: csrf.issueToken,
  });

  // 2. request logger with request id (F-73)
  app.use(createRequestLogger(deps.logger));
  // 3. health, before headers, sessions and limits (F-74)
  app.use('/health', createHealthRouter(deps.readiness, deps.isShuttingDown));
  // 4. security headers (ADR 0011)
  app.use(securityHeaders({ https: isHttps(env) }));
  // 5. static files, before sessions and CSRF, so they never create a session (B-59, ADR 0010)
  app.use(createStaticRouter({ mode: paths.mode, builtPublicDir: paths.builtPublicDir, publicDir: paths.publicDir }));
  // 6. layout data and Cache-Control: no-store for every dynamic response (F-15, F-89); 6a. the same for the 404 page
  // of a missing asset or font, an error raised in step 5 that skips step 6
  app.use(viewLocalsOnError(env));
  app.use(viewLocals(env));
  // 7. Redis session (ADR 0002)
  app.use(deps.session);
  // 8. a signed-in session past its absolute lifetime continues as a guest (F-29)
  app.use(enforceAbsoluteLifetime(deps.sessionPolicy));
  // 9. the viewer from the database on every request; ghost and outdated sessions become guests (F-31, F-32)
  const viewers = createViewerRepository(deps.db);
  app.use(loadViewer(viewers.findViewer));
  // 10. global limiter per IP subnet (ADR 0012, B-10)
  app.use(deps.rateLimits.global);
  // 11. urlencoded forms only; the signature routes allow the PNG data URL (ADR 0004). No JSON parser.
  app.use('/signature', express.urlencoded({ extended: false, limit: SIGNATURE_BODY_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT }));
  // 12. test-only routes (createTestApp only, ADR 0017)
  if (deps.testRoutes !== undefined) app.use(deps.testRoutes);
  // 13, 14. CSRF on every POST, PUT, PATCH and DELETE (ADR 0003, F-70, B-14)
  app.use(cookieParser());
  app.use(csrf.protection);
  // 15. /home is a permanent redirect, never a second home page (B-44)
  app.get('/home', (_req, res) => {
    res.redirect(301, '/');
  });

  // 16. feature routers; guards and limiters are per route inside each module. Cross-module data and behaviour are
  // injected here, so no module imports another (ADR 0001).
  const supporters = createSupportersModule({ db: deps.db, pageSize: SUPPORTERS_PAGE_SIZE });
  const modules = [
    createPagesModule({}),
    createAuthModule({
      db: deps.db,
      hasher: deps.hasher,
      timingDummyHash: deps.timingDummyHash,
      rateLimits: deps.rateLimits,
      sessionPolicy: deps.sessionPolicy,
    }),
    createProfileModule({
      db: deps.db,
      credentials: createCredentials({ db: deps.db, hasher: deps.hasher }),
      rateLimits: deps.rateLimits,
      sessionPolicy: deps.sessionPolicy,
    }),
    createSignatureModule({
      db: deps.db,
      signatureImages: deps.signatureImages,
      countSupporters: deps.countSupporters ?? supporters.countSupporters,
      rateLimits: deps.rateLimits,
    }),
    supporters,
  ];
  for (const { router } of modules) app.use(router);

  // 17, 18. 404 page and the error handler (F-08, F-09)
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
