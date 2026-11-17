import type { Router } from 'express';

import { createPagesController } from './pages.controller.js';
import { createPagesRouter } from './pages.routes.js';

/**
 * Public API of the pages module (ADR 0001, OVERVIEW.md section 4): `/`, `/about` and `/privacy`; `/home` is the
 * app's 301 to `/` (B-44). The module needs nothing from the outside world: the footer and privacy data
 * (`contactUrl`, `imprintUrl`, `year`) reach every view through `viewLocals`, and the viewer through `renderPage`.
 *
 * `PagesModuleDeps` and the `createPagesModule` signature are frozen since phase 1b (BUILD-ORDER.md rule 6).
 */
export type PagesModuleDeps = Readonly<Record<string, never>>;

export function createPagesModule(_deps: PagesModuleDeps): { router: Router } {
  return { router: createPagesRouter(createPagesController()) };
}
