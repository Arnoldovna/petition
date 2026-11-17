import type { Router } from 'express';

import type { Database } from '../../db/client.js';
import type { PasswordHasher } from '../../shared/auth/password.js';
import type { RateLimiters } from '../../shared/security/security.js';
import type { SessionPolicy } from '../../shared/security/session.js';
import { createAuthController } from './auth.controller.js';
import { createAuthRepository } from './auth.repository.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createCredentials } from './credentials.js';

/**
 * Public API of the auth module (ADR 0001). It exports the auth kernel that other modules depend on through the
 * composition root: the viewer repository (`findViewer`, injected into `loadViewer`) and the credentials service
 * (injected into the profile module). Both keep their phase-1b interfaces. Consumers derive the parameter and result
 * types from `Credentials` (e.g. `Awaited<ReturnType<Credentials['apply']>>`).
 */
export { createCredentials, type Credentials } from './credentials.js';
export { createViewerRepository } from './viewer.repository.js';

/**
 * What `app.ts` passes to the auth module (ADR 0001, ADR 0002, ADR 0009, ADR 0012, OVERVIEW.md section 4). Frozen
 * since phase 1b. The session helpers (`establishSession`, `endSession`, `bindAnonymousSession`) are imported directly
 * from `shared/security`, not injected.
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

/**
 * `/register`, `/login`, `/logout` and `/account/delete` (ROUTES.md section 3). Builds only objects, opens no
 * connection and never throws, so importing the module or creating it is always safe (BUILD-ORDER.md rule 6).
 */
export function createAuthModule({ db, hasher, timingDummyHash, rateLimits, sessionPolicy }: AuthModuleDeps): {
  router: Router;
} {
  const service = createAuthService({
    users: createAuthRepository(db),
    hasher,
    timingDummyHash,
    // Account deletion re-authenticates through the same kernel as the profile edit (ADR 0009).
    credentials: createCredentials({ db, hasher }),
  });
  const controller = createAuthController({ service, sessionPolicy });
  return { router: createAuthRouter({ controller, rateLimits }) };
}
