/**
 * Signature image constants and the value types derived from them (ADR 0004, ADR 0005, OVERVIEW.md section 8). Frozen
 * since phase 1b: the signature module implements png.ts, signature-image.ts and fonts.ts against them, and the views
 * hand the export size to the browser through data attributes, never through an import.
 *
 * The public API is `index.ts`. The implementation files import from here rather than from `index.ts`, so the module
 * stays free of import cycles.
 */

/** Fixed export size of the pad, independent of screen size and pixel ratio (ADR 0004 item 1, 3:1). */
export const SIGNATURE_WIDTH = 720;
export const SIGNATURE_HEIGHT = 240;

/**
 * Upper bound for the decoded upload **and** for the re-encoded PNG that is stored (64 KiB, ADR 0004 items 3.2 and
 * 3.6); the same bound as `signatures_image_size_chk` (DATA-MODEL.md).
 */
export const SIGNATURE_MAX_BYTES = 65_536;

/** At least this many pixels with alpha > 0, otherwise the signature counts as blank (ADR 0004 item 3.5, F-41). */
export const MIN_INK_PIXELS = 150;

/**
 * The two font families of the typed signature and the woff2 files registered under each (ADR 0005). The file names
 * are the `signature-fonts` sets of `scripts/copy-fonts.mjs`; `glyphs.generated.ts` holds the code points of exactly
 * these files. `SignatureFont` draws a name when all its characters are in `PRIMARY`, otherwise `SignatureFallback`.
 */
export const SIGNATURE_FONTS = {
  primary: {
    family: 'SignatureFont',
    files: ['schibsted-grotesk-latin-500-normal.woff2', 'schibsted-grotesk-latin-ext-500-normal.woff2'],
  },
  fallback: {
    family: 'SignatureFallback',
    files: [
      'noto-sans-latin-500-normal.woff2',
      'noto-sans-latin-ext-500-normal.woff2',
      'noto-sans-vietnamese-500-normal.woff2',
      'noto-sans-greek-500-normal.woff2',
      'noto-sans-greek-ext-500-normal.woff2',
      'noto-sans-cyrillic-500-normal.woff2',
      'noto-sans-cyrillic-ext-500-normal.woff2',
    ],
  },
} as const;

/**
 * Absolute paths of the files in `SIGNATURE_FONTS`, per family. `container.ts` builds them from
 * `paths.signatureFontsDir` (`signatureFontPaths` in `index.ts`); tests resolve them from `node_modules`.
 */
export type SignatureFontPaths = { readonly [Role in keyof typeof SIGNATURE_FONTS]: readonly string[] };

/**
 * Why a drawn signature was rejected, with the user-facing message the sign page shows next to the pad (ADR 0004
 * item 3, ROUTES.md section 1). Only an image without enough ink asks the user to sign; every other reason means the
 * upload could not be read.
 *
 * - `format`: not a string of the form `data:image/png;base64,<base64>` within the length limit, or empty after decoding
 * - `too-large`: the decoded or the re-encoded PNG is larger than `SIGNATURE_MAX_BYTES`
 * - `not-png`: no PNG signature or the first chunk is not `IHDR` (for example JPEG bytes behind a PNG prefix)
 * - `dimensions`: not `SIGNATURE_WIDTH` x `SIGNATURE_HEIGHT`
 * - `corrupt`: the full decode fails (truncated or damaged data)
 * - `blank`: fewer than `MIN_INK_PIXELS` inked pixels (F-41)
 */
const UNREADABLE = 'The signature could not be read. Clear the pad and sign again.';

export const SIGNATURE_REJECTIONS = {
  format: UNREADABLE,
  'too-large': UNREADABLE,
  'not-png': UNREADABLE,
  dimensions: UNREADABLE,
  corrupt: UNREADABLE,
  blank: 'Please sign before submitting',
} as const;

export type SignatureRejection = keyof typeof SIGNATURE_REJECTIONS;

/**
 * The outcome of validating a drawn signature (ADR 0004 item 3). On success `png` holds the canonical re-encoded bytes,
 * the only bytes that may be stored. On failure the controller re-renders the sign page with HTTP 422 and `message`
 * (F-42); `reason` is for tests and logs and is never shown.
 */
export type SignatureImageResult =
  | { ok: true; png: Buffer }
  | { ok: false; reason: SignatureRejection; message: (typeof SIGNATURE_REJECTIONS)[SignatureRejection] };
