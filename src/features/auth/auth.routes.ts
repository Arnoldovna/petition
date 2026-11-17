import { Router } from 'express';

import { requireAuth, requireGuest } from '../../shared/auth/guards.js';
import type { RateLimiters } from '../../shared/security/security.js';
import type { AuthController } from './auth.controller.js';

export interface AuthRouteDeps {
  controller: AuthController;
  /** The app's limiter instances (ADR 0012), so counters are shared with every other mount of the same limiter. */
  rateLimits: RateLimiters;
}

/**
 * The auth routes of ROUTES.md section 3. CSRF is checked app-wide before any router (OVERVIEW.md section 5.1, step
 * 14), so every POST here already carries a valid `_csrf` (F-70). Guards come first, so a request that fails one is
 * redirected without consuming a limiter's budget; limiters run before the handler, so a blocked request never
 * reaches the password hasher.
 *
 * - `reauth` is keyed by the viewer, so it must follow `requireAuth`.
 * - The two login email limiters count failed attempts only (401, 422): the owner never uses up their own budget.
 * - There is no `GET /logout` (B-08): it is the 404 page.
 */
export function createAuthRouter({ controller, rateLimits }: AuthRouteDeps): Router {
  const router = Router();

  router.get('/register', requireGuest, controller.showRegister);
  router.post('/register', requireGuest, rateLimits['auth-ip'], rateLimits['register-email'], controller.register);

  router.get('/login', requireGuest, controller.showLogin);
  router.post(
    '/login',
    requireGuest,
    rateLimits['auth-ip'],
    rateLimits['login-email-subnet'],
    rateLimits['login-email'],
    controller.login,
  );

  router.post('/logout', requireAuth, controller.logout);

  router.get('/account/delete', requireAuth, controller.showDeleteAccount);
  router.post('/account/delete', requireAuth, rateLimits.reauth, controller.deleteAccount);

  return router;
}
