// `pnpm assets:glyphs` (ADR 0005, ADR 0019 section 3): derives the set of characters the server can draw into a typed
// signature from the fonts it actually ships, and writes it to src/features/signature/image/glyphs.generated.ts.
//
//   PRIMARY   Schibsted Grotesk 500 (`SignatureFont`), latin + latin-ext
//   FALLBACK  Noto Sans 500 (`SignatureFallback`), latin, latin-ext, vietnamese, greek(-ext), cyrillic(-ext)
//
// The font files are exactly the `signature-fonts` sets of scripts/copy-fonts.mjs, so the measured fonts and the
// shipped fonts cannot diverge. Each list holds every code point that the woff2 files' `cmap` maps to a real glyph
// (not `.notdef`), except control characters (`\p{Cc}`, e.g. U+0000 and U+000D, which some subsets map but which are
// never drawn), as sorted, merged, inclusive ranges. The output is formatted with the project's Prettier config, so
// `pnpm format:check` accepts it as written.
//
//   node scripts/font-glyphs.mjs           write the file
//   node scripts/font-glyphs.mjs --stdout  print the file instead of writing it
//
// glyphs.test.ts imports `generate()` and compares its result with the committed file.
//
// Rerun it after any @fontsource update (Dependabot); the drift test fails until the committed file matches.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

import { openSync } from 'fontkit';
import { format, resolveConfig } from 'prettier';

import { FONT_SETS } from './copy-fonts.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUTPUT = resolve(ROOT, 'src/features/signature/image/glyphs.generated.ts');

/** Which shipped font package becomes which list (ADR 0005). */
const LISTS = [
  { name: 'PRIMARY', packageName: '@fontsource/schibsted-grotesk', family: 'SignatureFont' },
  { name: 'FALLBACK', packageName: '@fontsource/noto-sans', family: 'SignatureFallback' },
];

/** @typedef {[first: number, last: number]} CodePointRange */

/**
 * The `signature-fonts` set of copy-fonts.mjs that comes from `packageName`, with the package version read from the
 * installed package.json next to its `files/` folder.
 * @param {string} packageName
 */
function shippedFontSet(packageName) {
  const matches = FONT_SETS.filter((set) => set.dir === 'signature-fonts').flatMap((set) => {
    const manifest = JSON.parse(readFileSync(join(set.filesDir, '..', 'package.json'), 'utf8'));
    return manifest.name === packageName ? [{ ...set, version: String(manifest.version) }] : [];
  });
  if (matches.length !== 1) {
    throw new Error(`expected one signature-fonts set from ${packageName} in copy-fonts.mjs, found ${matches.length}`);
  }
  return /** @type {(typeof matches)[number]} */ (matches[0]);
}

/** Control characters: mapped by some subsets, never text a signature can show. */
const CONTROL = /^\p{Cc}$/u;

/**
 * Every code point except control characters that at least one of the files maps to a real glyph.
 * @param {string} filesDir
 * @param {readonly string[]} files
 */
function codePointsOf(filesDir, files) {
  /** @type {Set<number>} */
  const codePoints = new Set();
  for (const file of files) {
    const font = openSync(join(filesDir, file));
    if (!('characterSet' in font)) throw new Error(`${file} is a font collection, expected a single font`);
    for (const codePoint of font.characterSet) {
      if (font.hasGlyphForCodePoint(codePoint) && !CONTROL.test(String.fromCodePoint(codePoint))) {
        codePoints.add(codePoint);
      }
    }
  }
  if (codePoints.size === 0) throw new Error(`no glyphs found in ${files.join(', ')}`);
  return codePoints;
}

/**
 * Sorted code points as inclusive ranges; consecutive code points are merged into one range.
 * @param {Iterable<number>} codePoints
 * @returns {CodePointRange[]}
 */
function toRanges(codePoints) {
  /** @type {CodePointRange[]} */
  const ranges = [];
  for (const codePoint of [...codePoints].sort((a, b) => a - b)) {
    const last = ranges.at(-1);
    if (last !== undefined && codePoint === last[1] + 1) last[1] = codePoint;
    else ranges.push([codePoint, codePoint]);
  }
  return ranges;
}

/** @param {number} codePoint */
const hex = (codePoint) => `0x${codePoint.toString(16).padStart(4, '0')}`;

/** The source of glyphs.generated.ts, formatted with the project's Prettier config. The drift test calls it. */
export async function generate() {
  const blocks = LISTS.map(({ name, packageName, family }) => {
    const { filesDir, files, version } = shippedFontSet(packageName);
    const codePoints = codePointsOf(filesDir, files);
    const letters = [...codePoints].filter((codePoint) => /^\p{L}$/u.test(String.fromCodePoint(codePoint))).length;
    const ranges = toRanges(codePoints);
    return [
      '/**',
      ` * \`${family}\`: ${packageName} ${version}, ${String(codePoints.size)} code points (${String(letters)} letters).`,
      ...files.map((file) => ` * - ${file}`),
      ' */',
      `export const ${name}: readonly CodePointRange[] = [`,
      ...ranges.map(([first, last]) => `  [${hex(first)}, ${hex(last)}],`),
      '];',
    ].join('\n');
  });

  const header = [
    '// Generated by scripts/font-glyphs.mjs (`pnpm assets:glyphs`). Do not edit by hand: rerun the script after a font',
    '// update; __tests__/glyphs.test.ts fails while this file and the installed fonts disagree (ADR 0005).',
    '//',
    '// Every code point the shipped signature fonts map to a glyph, as sorted, non-adjacent inclusive ranges. The',
    '// typed-name rule accepts letters and marks from PRIMARY ∪ FALLBACK; the renderer uses `SignatureFont` when every',
    '// character is in PRIMARY and `SignatureFallback` otherwise.',
  ].join('\n');
  const source = [
    header,
    "import type { CodePointRange } from '../../../shared/validation/fields.js';",
    ...blocks,
  ].join('\n\n');

  const options = (await resolveConfig(OUTPUT)) ?? {};
  return format(source, { ...options, filepath: OUTPUT });
}

async function main(argv) {
  const unknown = argv.filter((argument) => argument !== '--stdout');
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown.join(' ')}; usage: font-glyphs.mjs [--stdout]`);

  const output = await generate();
  if (argv.includes('--stdout')) {
    process.stdout.write(output);
    return;
  }
  writeFileSync(OUTPUT, output);
  console.log(`font-glyphs: wrote ${relative(ROOT, OUTPUT)}`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`font-glyphs: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
