import { join } from 'node:path';

import type { Express } from 'express';
import { create } from 'express-handlebars';

import type { CsrfTokenIssuer } from '../security/csrf.js';
import type { AssetResolver } from './assets.js';
import { createHelpers } from './helpers.js';
import { registerCsrfIssuer } from './render.js';

interface ViewEngineOptions {
  /** src/views (config/paths.ts). */
  viewsDir: string;
  assets: AssetResolver;
  /** `APP_TIME_ZONE` for `formatDate`. */
  timeZone: string;
  /** `createCsrf(...).issueToken`: `renderPage` puts a token into pages with a viewer or a bound session (ADR 0003). */
  issueCsrfToken: CsrfTokenIssuer;
}

/**
 * Configures express-handlebars once per app (ADR 0014, B-45): `.hbs` files in src/views/{layouts,partials,pages},
 * the default layout `main` (never repeated per render) and the helpers of `helpers.ts`. Express caches compiled
 * templates when NODE_ENV is production ("view cache"). Handlebars' default prototype-access protection stays on.
 */
export function configureViewEngine(
  app: Express,
  { viewsDir, assets, timeZone, issueCsrfToken }: ViewEngineOptions,
): void {
  const engine = create({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: join(viewsDir, 'layouts'),
    partialsDir: join(viewsDir, 'partials'),
    helpers: createHelpers({ assets, timeZone }),
  });
  // The promise form, so a rejected render always reaches Express's callback (and from there renderPage).
  app.engine('.hbs', (viewPath, options, callback) => {
    // Express passes the merged locals as a plain `object`; the engine expects a string-keyed record.
    const context: Record<string, unknown> = Object.fromEntries(Object.entries(options));
    engine.renderView(viewPath, context).then(
      (html) => {
        callback(null, html);
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
  app.set('view engine', '.hbs');
  app.set('views', viewsDir);
  registerCsrfIssuer(app, issueCsrfToken);
}
