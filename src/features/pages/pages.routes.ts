import { Router } from 'express';

import type { PagesController } from './pages.controller.js';

/**
 * `GET /`, `/about` and `/privacy` (ROUTES.md section 2): no guard and no limiter beyond the global one, because
 * every visitor may read them. `GET /home` is the app's 301 to `/` (app.ts step 15, B-44), never a second home page.
 * HEAD is answered by the same handlers (Express), without using up a flash (renderPage).
 */
export function createPagesRouter(controller: PagesController): Router {
  const router = Router();
  router.get('/', controller.home);
  router.get('/about', controller.about);
  router.get('/privacy', controller.privacy);
  return router;
}
