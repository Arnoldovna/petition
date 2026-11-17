import express, { type Express } from 'express';
import type { Logger } from 'pino';

import { isHttps, type Env } from './config/env.js';
import type { AppPaths } from './config/paths.js';
import { errorHandler, notFoundHandler } from './shared/http/error-handler.js';
import { createHealthRouter, type ReadinessCheck } from './shared/http/health.js';
import { createStaticRouter } from './shared/http/static.js';
import { createRequestLogger } from './shared/logging/logger.js';
import { securityHeaders } from './shared/security/security.js';
import type { AssetResolver } from './shared/view/assets.js';
import { configureViewEngine } from './shared/view/engine.js';
import { renderPage } from './shared/view/render.js';

/**
 * Everything the app needs from the outside world. `container.ts` builds the real one, `test/test-app.ts` one on
 * Testcontainers. Phase 1b adds the database, sessions, rate limits, the session policy and the feature modules.
 */
export interface AppDeps {
  env: Env;
  logger: Logger;
  /** Views and static folders of one asset mode, chosen by the caller together with `assets`. */
  paths: AppPaths;
  assets: AssetResolver;
  readiness: Readonly<Record<string, ReadinessCheck>>;
  isShuttingDown: () => boolean;
}

/**
 * The phase-1a skeleton of the middleware order in OVERVIEW.md section 5.1: settings and view engine, request
 * logger, health, security headers, static files, one rendered page, 404 and the error handler. Sessions, viewer,
 * limits, body parsers, CSRF and the feature routers slot in between in phase 1b.
 */
export function createApp(deps: AppDeps): Express {
  const { env, paths } = deps;
  const app = express();

  // 1. settings and views (B-10, B-45)
  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);
  app.set('query parser', 'simple');
  configureViewEngine(app, { viewsDir: paths.viewsDir, assets: deps.assets });

  // 2. request logger with request id (F-73)
  app.use(createRequestLogger(deps.logger));
  // 3. health, before headers, sessions and limits (F-74)
  app.use('/health', createHealthRouter(deps.readiness, deps.isShuttingDown));
  // 4. security headers (ADR 0011)
  app.use(securityHeaders({ https: isHttps(env) }));
  // 5. static files, before sessions and CSRF (B-59, ADR 0010)
  app.use(createStaticRouter({ mode: paths.mode, builtPublicDir: paths.builtPublicDir, publicDir: paths.publicDir }));

  // 15. /home is a permanent redirect, never a second home page (B-44)
  app.get('/home', (_req, res) => {
    res.redirect(301, '/');
  });
  // 16. Temporary home page until the pages module owns `/` (phase 2).
  app.get('/', (req, res) => {
    renderPage(req, res, 'pages/home', { title: 'Home' });
  });

  // 17, 18. 404 page and the error handler (F-08, F-09)
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
