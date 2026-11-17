import { Router } from 'express';

import { renderPage } from '../../shared/view/render.js';

/**
 * Public API of the pages module (ADR 0001, OVERVIEW.md section 4): `/`, `/home` is the app's 301, `/about`,
 * `/privacy`. The module needs nothing from the outside world: the footer and privacy data (`contactUrl`,
 * `imprintUrl`, `year`) reach every view through `viewLocals`, and the viewer through `renderPage`.
 *
 * Frozen since phase 1b: the pages module replaces this file last in phase 2a (BUILD-ORDER.md rule 6) and keeps
 * `PagesModuleDeps` and the `createPagesModule` signature unchanged.
 */
export type PagesModuleDeps = Readonly<Record<string, never>>;

/**
 * Phase-1b stub. Besides the empty module it serves the temporary home page (`src/views/pages/home.hbs`), so the
 * phase-1 smoke check and the integration tests have a rendered page with the shared layout; the composition root
 * itself stays final and holds no temporary route. Phase 2a replaces both with the real pages.
 */
export function createPagesModule(_deps: PagesModuleDeps): { router: Router } {
  const router = Router();
  router.get('/', (req, res) => {
    renderPage(req, res, 'pages/home', { title: 'Home' });
  });
  return { router };
}
