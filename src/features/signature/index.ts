import { Router } from 'express';

import type { Database } from '../../db/client.js';
import type { RateLimiters } from '../../shared/security/security.js';
import type { SignatureImages } from './image/index.js';

/**
 * Public API of the signature module (ADR 0001, ADR 0004, ADR 0005). The image service is created once by the
 * composition root (`createSignatureImages`, fonts registered at startup) and injected here; the seed uses the same
 * export. Frozen since phase 1b: the signature module replaces this file last in phase 2a (BUILD-ORDER.md rule 6) and
 * keeps these exports and `SignatureModuleDeps` unchanged.
 */
export { createSignatureImages, signatureFontPaths, type SignatureImages } from './image/index.js';

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
 * Phase-1b stub: an empty router until phase 2a adds `/signature`, `/signature/image.png`, `/signature/delete` and
 * `/thank-you`.
 */
export function createSignatureModule(_deps: SignatureModuleDeps): { router: Router } {
  return { router: Router() };
}
