import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { SIGNATURE_FONTS, type SignatureFontPaths } from '../src/features/signature/image/index.js';

/**
 * The `files/` folder of an installed @fontsource package. Literal specifiers, so knip sees the devDependencies in use
 * (as in scripts/copy-fonts.mjs, ADR 0019 section 3).
 */
const FONT_PACKAGES = {
  primary: new URL('files/', import.meta.resolve('@fontsource/schibsted-grotesk/package.json')),
  fallback: new URL('files/', import.meta.resolve('@fontsource/noto-sans/package.json')),
} as const;

/**
 * The signature fonts straight from `node_modules` (ADR 0005): tests need neither `pnpm assets:fonts` nor a build.
 * Same file names as `scripts/copy-fonts.mjs` copies into `<outDir>/signature-fonts`, because both read
 * `SIGNATURE_FONTS`. Throws when a file is missing, naming it, instead of letting canvas fail silently later.
 *
 * Use: `createSignatureImages({ fontPaths: testSignatureFontPaths() })` for the real image service.
 */
export function testSignatureFontPaths(): SignatureFontPaths {
  const resolve = (role: keyof typeof SIGNATURE_FONTS): string[] =>
    SIGNATURE_FONTS[role].files.map((file) => {
      const path = fileURLToPath(new URL(file, FONT_PACKAGES[role]));
      if (!existsSync(path)) throw new Error(`test/fonts.ts: ${file} is missing from node_modules (pnpm install)`);
      return path;
    });
  return { primary: resolve('primary'), fallback: resolve('fallback') };
}
