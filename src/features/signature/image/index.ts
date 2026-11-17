import { join } from 'node:path';

import { glyphSetFromRanges, type GlyphSet } from '../../../shared/validation/fields.js';
import { SIGNATURE_FONTS, type SignatureFontPaths, type SignatureImageResult } from './constants.js';
import { loadSignatureFonts } from './fonts.js';
import { FALLBACK, PRIMARY } from './glyphs.generated.js';
import { renderTypedSignature, validateDrawnSignature } from './signature-image.js';

/**
 * Public API of the signature-image service (ADR 0004, ADR 0005), owned by the signature feature (ADR 0001) and
 * re-exported by `features/signature/index.ts`. Frozen since phase 1b: `container.ts` creates the service once
 * (`createSignatureImages({ fontPaths: signatureFontPaths(paths.signatureFontsDir) })`) and injects it into the
 * signature module; the seed uses the same export; tests inject a fake (`test/fakes.ts`). The signature module
 * implements `png.ts`, `signature-image.ts` and `fonts.ts` behind this file in phase 2a without changing it.
 */

/**
 * What code outside the image folder needs: `container.ts` and `test/fonts.ts` (font files), test factories (export
 * size, ink minimum) and fakes (size bound, result and messages). The signature module's own files import the
 * constants from `./constants.js`.
 */
export {
  MIN_INK_PIXELS,
  SIGNATURE_FONTS,
  SIGNATURE_HEIGHT,
  SIGNATURE_MAX_BYTES,
  SIGNATURE_REJECTIONS,
  SIGNATURE_WIDTH,
  type SignatureFontPaths,
  type SignatureImageResult,
  type SignatureRejection,
} from './constants.js';

/** Function properties, so callers can pass them on without binding (like `Credentials`). */
export interface SignatureImages {
  /**
   * The ADR 0004 pipeline for the raw `signature` form field (`data:image/png;base64,...`). Resolves with the canonical
   * re-encoded PNG, the only bytes that may be stored, or with a rejection and its user-facing message (422, F-41,
   * F-42). Rejects only on an unexpected internal error (500).
   */
  validateDrawnSignature: (dataUrl: string) => Promise<SignatureImageResult>;
  /**
   * Renders a typed name that already passed `typedName(SIGNATURE_GLYPHS)` into a 720 x 240 PNG that is stored like a
   * drawn one (F-45, ADR 0005). Rejects on an internal error only; an accepted name always renders.
   */
  renderTypedSignature: (name: string) => Promise<Buffer>;
}

interface SignatureImagesOptions {
  /** The woff2 files of `SIGNATURE_FONTS`; `signatureFontPaths(dir)` builds them for one folder. */
  fontPaths: SignatureFontPaths;
}

/**
 * Every code point the shipped signature fonts can draw (`PRIMARY ∪ FALLBACK`, `glyphs.generated.ts`). The signature
 * schema passes it to `typedName(...)` from `shared/validation/fields.ts`, which cannot import the feature itself.
 */
export const SIGNATURE_GLYPHS: GlyphSet = glyphSetFromRanges(PRIMARY, FALLBACK);

/**
 * The font paths for a folder that holds every file of `SIGNATURE_FONTS`, such as `dist/signature-fonts` or
 * `.dev/signature-fonts` (`paths.signatureFontsDir`, filled by `scripts/copy-fonts.mjs`).
 */
export function signatureFontPaths(directory: string): SignatureFontPaths {
  return {
    primary: SIGNATURE_FONTS.primary.files.map((file) => join(directory, file)),
    fallback: SIGNATURE_FONTS.fallback.files.map((file) => join(directory, file)),
  };
}

/**
 * Creates the service and registers the signature fonts once. Call it once per process (`container.ts`, the seed):
 * font registration with @napi-rs/canvas is process-wide. Throws when a font cannot be registered, so a broken image
 * fails at startup rather than on the first typed signature.
 */
export function createSignatureImages({ fontPaths }: SignatureImagesOptions): SignatureImages {
  const fonts = loadSignatureFonts(fontPaths);
  return {
    validateDrawnSignature,
    renderTypedSignature: (name) => renderTypedSignature(name, fonts),
  };
}
