/**
 * Drawn-signature validation (ADR 0004 item 3) and typed-name rendering (ADR 0005), built on @napi-rs/canvas.
 * Phase-1b stub: both functions reject. The signature module implements them in phase 2a (BUILD-ORDER.md) and covers
 * every rejection reason and both fonts in `__tests__/signature-image.test.ts`.
 */
import type { SignatureImageResult } from './constants.js';
import type { SignatureFonts } from './fonts.js';

const notImplemented = (name: string): Error =>
  new Error(`${name} is not implemented yet (signature module, phase 2a)`);

/**
 * The ADR 0004 pipeline for the `signature` form field: data-URL format and length, base64 decode and size, PNG header
 * and dimensions (`inspectPngHeader`), full decode, ink check, re-encode. Resolves with the canonical re-encoded bytes
 * or a rejection reason; rejects only on an unexpected internal error.
 */
export function validateDrawnSignature(_dataUrl: string): Promise<SignatureImageResult> {
  return Promise.reject(notImplemented('validateDrawnSignature'));
}

/**
 * Draws a name that already passed the `typedName` rule (ADR 0005): one family for the whole name
 * (`fonts.familyFor`), 720 x 240 transparent canvas, ink `#000`, 96 px shrinking in 4 px steps until the text fits
 * 656 px (minimum 32 px), vertically centred. The PNG passes the same header and size checks as a drawn signature;
 * failing them is a bug and rejects.
 */
export function renderTypedSignature(_name: string, _fonts: SignatureFonts): Promise<Buffer> {
  return Promise.reject(notImplemented('renderTypedSignature'));
}
