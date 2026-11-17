import { Router, type RequestHandler } from 'express';

import { requireAuth, requireNotSigned, requireSigned } from '../../shared/auth/guards.js';
import type { SignatureController } from './signature.controller.js';

interface SignatureRouteDeps {
  controller: SignatureController;
  /** `rateLimits.sign` (ADR 0012): per user, after `requireAuth`, so the key is the viewer's id. */
  signLimiter: RequestHandler;
}

/**
 * The signature routes (ROUTES.md section 5). Guards run on GET **and** POST (F-07). The app mounts the 128 kb body
 * parser for `/signature` and the CSRF check before this router (OVERVIEW.md section 5.1, steps 11 and 14).
 *
 * - `/signature`: not signed yet; a signer goes to `/thank-you`, which makes a repeated POST idempotent (F-43, F-44).
 * - `/thank-you`, `/signature/delete`: signed only; others go to `/signature` (F-48, F-50, B-07, B-47).
 * - `/signature/image.png`: signed-in only; the controller answers 404 for a non-signer (ADR 0004 item 6).
 */
export function createSignatureRouter({ controller, signLimiter }: SignatureRouteDeps): Router {
  const router = Router();
  router.get('/signature', requireAuth, requireNotSigned, controller.showSign);
  router.post('/signature', requireAuth, requireNotSigned, signLimiter, controller.sign);
  router.get('/signature/image.png', requireAuth, controller.image);
  router.get('/signature/delete', requireAuth, requireSigned, controller.showDelete);
  router.post('/signature/delete', requireAuth, requireSigned, controller.remove);
  router.get('/thank-you', requireAuth, requireSigned, controller.thankYou);
  return router;
}
