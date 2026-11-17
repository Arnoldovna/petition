/**
 * Server-side signature fonts (ADR 0005): registers the shipped woff2 files with @napi-rs/canvas and picks the one
 * family that can draw a whole name.
 */
import { existsSync } from 'node:fs';

import { GlobalFonts } from '@napi-rs/canvas';

import { glyphSetFromRanges } from '../../../shared/validation/fields.js';
import { SIGNATURE_FONTS, type SignatureFontPaths } from './constants.js';
import { PRIMARY } from './glyphs.generated.js';

/** The registered fonts of one `createSignatureImages()` call. */
export interface SignatureFonts {
  /**
   * The one family that draws the whole `text`: `SignatureFont` when every character is in `PRIMARY`, otherwise
   * `SignatureFallback` (`glyphs.generated.ts`). Never mixes fonts within a name, so the result does not depend on
   * Skia's font fallback; the distroless image has no system fonts.
   */
  familyFor: (text: string) => string;
}

/** Schibsted Grotesk's code points; the fallback covers every letter of it (`glyphs.test.ts`), so it needs no set. */
const PRIMARY_GLYPHS = glyphSetFromRanges(PRIMARY);

const drawableWithPrimary = (text: string): boolean =>
  Array.from(text).every((character) => PRIMARY_GLYPHS.has(character.codePointAt(0) ?? -1));

/**
 * Registers every file of one family under its alias. Skia keeps all files of an alias in one family and takes each
 * glyph from the file that contains it, so the latin and latin-ext subsets draw a name like `Łukasz` together
 * (asserted in `signature-image.test.ts`).
 */
function registerFamily(family: string, paths: readonly string[]): void {
  for (const path of paths) {
    if (GlobalFonts.registerFromPath(path, family) === null) {
      throw new Error(`cannot register signature font ${path} as ${family}`);
    }
  }
  if (!GlobalFonts.has(family)) throw new Error(`signature font family ${family} is not available after registration`);
}

/**
 * Registers the woff2 files with @napi-rs/canvas under the family names of `SIGNATURE_FONTS`. Called once by
 * `createSignatureImages()`, which `container.ts` calls at startup, so it throws there when a file is missing or
 * cannot be registered (fail fast, never on the first typed signature). Registration is process-wide in
 * @napi-rs/canvas; a second call (tests build several services) registers the same files again, which is harmless.
 */
export function loadSignatureFonts(fontPaths: SignatureFontPaths): SignatureFonts {
  const missing = [...fontPaths.primary, ...fontPaths.fallback].filter((path) => !existsSync(path));
  if (missing.length > 0) {
    throw new Error(`signature fonts missing: ${missing.join(', ')} (pnpm build and pnpm dev copy them)`);
  }
  registerFamily(SIGNATURE_FONTS.primary.family, fontPaths.primary);
  registerFamily(SIGNATURE_FONTS.fallback.family, fontPaths.fallback);

  return {
    familyFor: (text) => (drawableWithPrimary(text) ? SIGNATURE_FONTS.primary.family : SIGNATURE_FONTS.fallback.family),
  };
}
