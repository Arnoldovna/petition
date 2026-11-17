import { Router } from 'express';

import { requireAuth } from '../../shared/auth/guards.js';
import type { ProfileController } from './profile.controller.js';

/**
 * `/profile` and `/profile/edit` (ROUTES.md section 4). Every route is for signed-in visitors only, on GET and POST
 * (F-07); CSRF is checked app-wide before the routers (ADR 0003). The `reauth` limiter of the edit form is not a route
 * middleware: whether an edit checks the current password depends on the stored email, so the controller applies it
 * through the service right before that check (ADR 0012).
 */
export function createProfileRouter(controller: ProfileController): Router {
  const router = Router();
  router.get('/profile', requireAuth, controller.showOnboarding);
  router.post('/profile', requireAuth, controller.saveOnboarding);
  router.get('/profile/edit', requireAuth, controller.showEdit);
  // requireAuth first: the controller's limiter keys by the viewer's id (`keyByUser`).
  router.post('/profile/edit', requireAuth, controller.saveEdit);
  return router;
}
