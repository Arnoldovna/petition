import { Router } from 'express';

import type { Database } from '../../db/client.js';
import type { PasswordHasher } from '../../shared/auth/password.js';
import type { RateLimiters } from '../../shared/security/security.js';
import type { SessionPolicy } from '../../shared/security/session.js';

/**
 * Public API of the auth module (ADR 0001). Since phase 1b it exports the auth kernel that other modules depend on
 * through the composition root: the viewer repository (`findViewer`, injected into `loadViewer`) and the credentials
 * service (injected into the profile module). Both are real implementations with frozen interfaces; the router is a
 * stub until the auth module replaces this file in phase 2 (BUILD-ORDER.md, rule 6), keeping these exports unchanged.
 * Consumers derive the parameter and result types from `Credentials` (e.g. `Awaited<ReturnType<Credentials['apply']>>`).
 */
export { createCredentials, type Credentials } from './credentials.js';
export { createViewerRepository } from './viewer.repository.js';

/**
 * What `app.ts` passes to the auth module (ADR 0001, ADR 0002, ADR 0009, ADR 0012, OVERVIEW.md section 4). Frozen
 * since phase 1b: the auth module replaces this file last in phase 2a (BUILD-ORDER.md rule 6) and keeps this
 * interface. The session helpers (`establishSession`, `endSession`, `bindAnonymousSession`) are imported directly from
 * `shared/security`, not injected.
 */
interface AuthModuleDeps {
  db: Database;
  hasher: PasswordHasher;
  /** `createTimingDummy(hasher)` from `container.ts`: verified against for unknown emails (F-24, B-23). */
  timingDummyHash: string;
  /**
   * The limiters of ADR 0012, built once by the composition root: `auth-ip`, `register-email`,
   * `login-email-subnet`, `login-email` and `reauth` (account deletion).
   */
  rateLimits: RateLimiters;
  /** Register and login sign the visitor in with `establishSession(req, user, sessionPolicy)` (ADR 0002 item 6). */
  sessionPolicy: SessionPolicy;
}

/** Stub: an empty router until phase 2 adds `/register`, `/login`, `/logout` and `/account/delete`. */
export function createAuthModule(_deps: AuthModuleDeps): { router: Router } {
  return { router: Router() };
}
