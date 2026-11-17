import { Router } from 'express';

import type { Database } from '../../db/client.js';
import type { RateLimiters } from '../../shared/security/security.js';
import type { SessionPolicy } from '../../shared/security/session.js';
import type { Credentials } from '../auth/index.js';

/**
 * What `app.ts` passes to the profile module (ADR 0001, ADR 0009, OVERVIEW.md section 4). Frozen since phase 1b: the
 * profile module replaces this file last in phase 2a (BUILD-ORDER.md rule 6) and keeps this interface.
 */
export interface ProfileModuleDeps {
  db: Database;
  /**
   * Auth's credentials service, the only writer of `users.email`, `users.password_hash` and
   * `users.session_version` (`verifyCurrentPassword`, `hashNewPassword`, `apply`; ADR 0009).
   */
  credentials: Credentials;
  /** The limiters of ADR 0012; the profile edit form uses `reauth` when a current password is submitted. */
  rateLimits: RateLimiters;
  /** A new password re-establishes the current session (`establishSession(req, user, sessionPolicy)`, ADR 0002). */
  sessionPolicy: SessionPolicy;
}

/** Phase-1b stub: an empty router until phase 2a adds `/profile` and `/profile/edit`. */
export function createProfileModule(_deps: ProfileModuleDeps): { router: Router } {
  return { router: Router() };
}
