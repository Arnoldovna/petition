import type { Router } from 'express';

import type { Database } from '../../db/client.js';
import type { RateLimiters } from '../../shared/security/security.js';
import type { SignatureImages } from './image/index.js';
import { createSignatureController } from './signature.controller.js';
import { createSignatureRepository } from './signature.repository.js';
import { createSignatureRouter } from './signature.routes.js';
import { createSignatureService } from './signature.service.js';

/**
 * Public API of the signature module (ADR 0001, ADR 0004, ADR 0005). The image service is created once by the
 * composition root (`createSignatureImages`, fonts registered at startup) and injected here; the seed uses the same
 * export. These exports and `SignatureModuleDeps` are the phase-1b contract and stay unchanged; the export size is
 * re-exported for the seed's generated signatures (phase 2b).
 */
export {
  createSignatureImages,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  signatureFontPaths,
  type SignatureImages,
} from './image/index.js';

export interface SignatureModuleDeps {
  db: Database;
  /** Validates drawn and renders typed signatures (ADR 0004, 0005); tests may inject a fake (`test/fakes.ts`). */
  signatureImages: SignatureImages;
  /**
   * The supporters total for the thank-you page (F-46, F-47): the supporters module's `countSupporters`, injected by
   * `app.ts` so both pages count with the same query (ADR 0006). The signature module never imports supporters.
   */
  countSupporters: () => Promise<number>;
  /** The limiters of ADR 0012; `POST /signature` uses `sign`. */
  rateLimits: RateLimiters;
}

/**
 * `/signature`, `/signature/image.png`, `/signature/delete` and `/thank-you` (ROUTES.md section 5). Builds the
 * repository, service, controller and router; opens no connection and does nothing that can throw, so creating the
 * app never fails here (BUILD-ORDER.md rule 6).
 */
export function createSignatureModule(deps: SignatureModuleDeps): { router: Router } {
  const service = createSignatureService({
    repository: createSignatureRepository(deps.db),
    signatureImages: deps.signatureImages,
    countSupporters: deps.countSupporters,
  });
  const router = createSignatureRouter({
    controller: createSignatureController(service),
    signLimiter: deps.rateLimits.sign,
  });
  return { router };
}
