import { join } from 'node:path';

import type { Express } from 'express';
import { create } from 'express-handlebars';

import type { AssetResolver } from './assets.js';
import { createHelpers } from './helpers.js';

interface ViewEngineOptions {
  /** src/views (config/paths.ts). */
  viewsDir: string;
  assets: AssetResolver;
}

/**
 * Configures express-handlebars once (ADR 0014, B-45): `.hbs` files in src/views/{layouts,partials,pages} and the
 * default layout `main`. Express caches compiled templates when NODE_ENV is production ("view cache").
 */
export function configureViewEngine(app: Express, { viewsDir, assets }: ViewEngineOptions): void {
  const engine = create({
    extname: '.hbs',
    defaultLayout: 'main',
    layoutsDir: join(viewsDir, 'layouts'),
    partialsDir: join(viewsDir, 'partials'),
    helpers: createHelpers({ assets }),
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
}
