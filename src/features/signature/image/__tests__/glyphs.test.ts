import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { type CodePointRange, glyphSetFromRanges, typedName } from '../../../../shared/validation/fields.js';
import { FALLBACK, PRIMARY } from '../glyphs.generated.js';
import { SIGNATURE_FONTS, SIGNATURE_GLYPHS, signatureFontPaths } from '../index.js';

const ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));
const GENERATED_FILE = fileURLToPath(new URL('../glyphs.generated.ts', import.meta.url));

/** Loads one of the repository's .mjs scripts at run time; the TypeScript project does not type-check them. */
async function importScript(name: string): Promise<unknown> {
  const module: unknown = await import(pathToFileURL(join(ROOT, 'scripts', name)).href);
  return module;
}

const GlyphScript = z.object({ generate: z.custom<() => Promise<unknown>>((value) => typeof value === 'function') });
const CopyFontsScript = z.object({
  FONT_SETS: z.array(z.object({ dir: z.string(), filesDir: z.string(), files: z.array(z.string()) })),
});

const codePointsOf = (text: string): number[] => Array.from(text, (character) => character.codePointAt(0) ?? -1);
const charactersIn = (ranges: readonly CodePointRange[], text: string): boolean =>
  codePointsOf(text).every((codePoint) => glyphSetFromRanges(ranges).has(codePoint));
const isLetterOrMark = (codePoint: number): boolean => /^[\p{L}\p{M}]$/u.test(String.fromCodePoint(codePoint));

function* expand(ranges: readonly CodePointRange[]): Generator<number> {
  for (const [first, last] of ranges) {
    for (let codePoint = first; codePoint <= last; codePoint += 1) yield codePoint;
  }
}

describe('glyphs.generated.ts', () => {
  it('F-45, ADR 0005: matches the cmap of the installed signature fonts (drift: rerun `pnpm assets:glyphs`)', async () => {
    const { generate } = GlyphScript.parse(await importScript('font-glyphs.mjs'));

    const regenerated = z.string().parse(await generate());

    expect(regenerated).toBe(readFileSync(GENERATED_FILE, 'utf8'));
  });

  it('ADR 0005: both lists are sorted, non-overlapping, non-adjacent ranges of drawable code points', () => {
    for (const ranges of [PRIMARY, FALLBACK]) {
      expect(ranges.length).toBeGreaterThan(0);
      let previousLast = -2;
      for (const [first, last] of ranges) {
        expect(first).toBeLessThanOrEqual(last);
        // A gap of at least one code point; adjacent ranges would have been merged.
        expect(first).toBeGreaterThan(previousLast + 1);
        previousLast = last;
      }
      expect(previousLast).toBeLessThanOrEqual(0x10ffff);
      expect([...expand(ranges)].filter((codePoint) => /^\p{Cc}$/u.test(String.fromCodePoint(codePoint)))).toEqual([]);
    }
  });

  it('F-45, ADR 0005: Schibsted Grotesk covers latin and latin-ext names, and nothing beyond', () => {
    expect(charactersIn(PRIMARY, "Łukasz Żółć Ğülşen Çağlar O'Brien-Smith Jr.")).toBe(true);
    // Vietnamese, Greek and Cyrillic need the fallback (ADR 0005 spike and smoke check samples).
    for (const letter of ['ễ', 'Ε', 'П']) expect(charactersIn(PRIMARY, letter)).toBe(false);
  });

  it('F-45, ADR 0005: Noto Sans adds Vietnamese, Greek and Cyrillic, but no CJK or Arabic', () => {
    expect(charactersIn(FALLBACK, "Nguyễn Ελένη Пётр Łukasz O'Brien-Smith Jr.")).toBe(true);
    for (const letter of ['李', 'م', 'अ']) expect(charactersIn(FALLBACK, letter)).toBe(false);
  });

  it('F-45, ADR 0005: every name the typed-name rule accepts can be drawn in one font', () => {
    // The rule accepts letters and marks from PRIMARY ∪ FALLBACK plus space . ' - ; the renderer uses SignatureFont
    // only when the whole name is in PRIMARY, else SignatureFallback. That is safe only while FALLBACK holds every
    // letter and mark of PRIMARY and both fonts hold the punctuation.
    const fallback = glyphSetFromRanges(FALLBACK);
    const primaryOnly = [...expand(PRIMARY)].filter(
      (codePoint) => isLetterOrMark(codePoint) && !fallback.has(codePoint),
    );

    expect(primaryOnly.map((codePoint) => String.fromCodePoint(codePoint))).toEqual([]);
    expect(charactersIn(PRIMARY, " .'-")).toBe(true);
    expect(charactersIn(FALLBACK, " .'-")).toBe(true);
  });
});

describe('SIGNATURE_GLYPHS', () => {
  const schema = typedName(SIGNATURE_GLYPHS);

  it('F-45, ADR 0005: the typed-name rule accepts Latin, Vietnamese, Greek and Cyrillic names with the shipped glyphs', () => {
    for (const name of ['Łukasz Żółć', 'Nguyễn Văn An', 'Ελένη Παπαδοπούλου', 'Пётр Ильич', 'O’Brien']) {
      expect(schema.safeParse(name).success, name).toBe(true);
    }
  });

  it('F-45, ADR 0005: names the fonts cannot draw get the glyph message', () => {
    const result = schema.safeParse('李小龍');

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'We cannot draw some letters of this name yet. Type it in Latin, Greek or Cyrillic letters, or draw your signature.',
    ]);
  });
});

describe('SIGNATURE_FONTS', () => {
  it('ADR 0005: registers exactly the signature-fonts files that scripts/copy-fonts.mjs ships', async () => {
    const { FONT_SETS } = CopyFontsScript.parse(await importScript('copy-fonts.mjs'));
    const shipped = FONT_SETS.filter((set) => set.dir === 'signature-fonts').flatMap((set) => set.files);

    expect([...SIGNATURE_FONTS.primary.files, ...SIGNATURE_FONTS.fallback.files].sort()).toEqual(shipped.sort());
    expect(SIGNATURE_FONTS.primary.files.every((file) => file.startsWith('schibsted-grotesk-'))).toBe(true);
    expect(SIGNATURE_FONTS.fallback.files.every((file) => file.startsWith('noto-sans-'))).toBe(true);
  });

  it('ADR 0005: signatureFontPaths places every file of both families in the given folder', () => {
    const { primary, fallback } = signatureFontPaths('/srv/app/dist/signature-fonts');

    expect(primary).toEqual([
      '/srv/app/dist/signature-fonts/schibsted-grotesk-latin-500-normal.woff2',
      '/srv/app/dist/signature-fonts/schibsted-grotesk-latin-ext-500-normal.woff2',
    ]);
    expect(fallback).toHaveLength(7);
    expect(fallback).toContain('/srv/app/dist/signature-fonts/noto-sans-vietnamese-500-normal.woff2');
    expect(fallback.every((path) => path.startsWith('/srv/app/dist/signature-fonts/noto-sans-'))).toBe(true);
  });
});
