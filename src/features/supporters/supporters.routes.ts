import { Router } from 'express';

import { requireAuth } from '../../shared/auth/guards.js';
import type { SupportersController } from './supporters.controller.js';

/**
 * ROUTES.md section 6. Both pages are for signed-in visitors only (F-51); guests are redirected to the login page with
 * `returnTo`. Read-only GET routes: no CSRF, no form limiter; the global limiter of `app.ts` applies (ADR 0012).
 */
export function createSupportersRouter(controller: SupportersController): Router {
  const router = Router();
  router.get('/supporters', requireAuth, controller.list);
  router.get('/supporters/city/:city', requireAuth, controller.city);
  return router;
}
