/**
 * Server-side signature fonts (ADR 0005). Phase-1b stub; the signature module implements it in phase 2a
 * (BUILD-ORDER.md).
 */
import { existsSync } from 'node:fs';

import type { SignatureFontPaths } from './constants.js';

/** The registered fonts of one `createSignatureImages()` call. */
export interface SignatureFonts {
  /**
   * The one family that draws the whole `text`: `SignatureFont` when every character is in `PRIMARY`, otherwise
   * `SignatureFallback` (`glyphs.generated.ts`). Never mixes fonts within a name, so the result does not depend on
   * Skia's font fallback; the distroless image has no system fonts.
   */
  familyFor: (text: string) => string;
}

/**
 * Registers the woff2 files with @napi-rs/canvas under the family names of `SIGNATURE_FONTS`. Called once by
 * `createSignatureImages()`, which `container.ts` calls at startup, so the implementation throws there when a file is
 * missing or cannot be registered (fail fast, never on the first typed signature).
 *
 * Stub: registers nothing and returns fonts whose use throws, so creating the service already works in phase 1. It
 * already checks that every file exists, so the fail-fast promise of `container.ts` holds from phase 1 on and a build
 * or image without `signature-fonts/` cannot start.
 */
export function loadSignatureFonts(fontPaths: SignatureFontPaths): SignatureFonts {
  const missing = [...fontPaths.primary, ...fontPaths.fallback].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`signature fonts missing: ${missing.join(', ')} (pnpm build and pnpm dev copy them)`);
  }
  return {
    familyFor: () => {
      throw new Error('signature fonts are not implemented yet (signature module, phase 2a)');
    },
  };
}
