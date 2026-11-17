import type { Router } from 'express';

import type { Database } from '../../db/client.js';
import type { RateLimiters } from '../../shared/security/security.js';
import type { SessionPolicy } from '../../shared/security/session.js';
import type { Credentials } from '../auth/index.js';
import { createProfileController } from './profile.controller.js';
import { createProfileRepository } from './profile.repository.js';
import { createProfileRouter } from './profile.routes.js';
import { createProfileService } from './profile.service.js';

/**
 * What `app.ts` passes to the profile module (ADR 0001, ADR 0009, OVERVIEW.md section 4). Frozen since phase 1b and
 * kept unchanged by the phase-2a module (BUILD-ORDER.md rule 6).
 */
export interface ProfileModuleDeps {
  db: Database;
  /**
   * Auth's credentials service, the only writer of `users.email`, `users.password_hash` and
   * `users.session_version` (`verifyCurrentPassword`, `hashNewPassword`, `apply`; ADR 0009).
   */
  credentials: Credentials;
  /** The limiters of ADR 0012; the profile edit form uses `reauth` when it checks the current password. */
  rateLimits: RateLimiters;
  /** A new password re-establishes the current session (`establishSession(req, user, sessionPolicy)`, ADR 0002). */
  sessionPolicy: SessionPolicy;
}

/**
 * The profile module (ROUTES.md section 4): `GET`/`POST /profile` (onboarding, F-33 to F-36) and
 * `GET`/`POST /profile/edit` (F-60 to F-66). Builds its layers from the injected dependencies only; nothing here
 * connects or throws at creation time.
 */
export function createProfileModule({ db, credentials, rateLimits, sessionPolicy }: ProfileModuleDeps): {
  router: Router;
} {
  const repository = createProfileRepository({ db, credentials });
  const service = createProfileService({ repository, credentials });
  const controller = createProfileController({ service, sessionPolicy, reauth: rateLimits.reauth });
  return { router: createProfileRouter(controller) };
}
