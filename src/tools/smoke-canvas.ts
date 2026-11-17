/**
 * Canvas smoke check, phase-1 version (ADR 0005): proves inside the distroless image that @napi-rs/canvas loads its
 * native binary, registers the shipped woff2 signature fonts, draws text, encodes a PNG and decodes it again.
 * scripts/run-e2e.mjs runs it in the freshly built e2e image (`dist/tools/smoke-canvas.js`, network off), so it covers
 * linux/arm64 locally and linux/amd64 in CI. The signature module later switches it to renderTypedSignature plus the
 * drawn-signature validator.
 *
 * Fonts come from dist/signature-fonts (NODE_ENV=production, the image) or .dev/signature-fonts (`pnpm dev` copies
 * them); `pnpm assets:fonts .dev` creates the latter for a local run with `pnpm exec tsx src/tools/smoke-canvas.ts`.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';

import { resolvePaths } from '../config/paths.js';

const WIDTH = 720;
const HEIGHT = 240;
const FONT_SIZE = 64;
const MIN_INKED_PIXELS = 1000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface FontSet {
  family: string;
  files: readonly string[];
  /** A name only this font set can draw (ADR 0005: latin-ext for the primary font, Vietnamese, Greek, Cyrillic). */
  sample: string;
}

const FONT_SETS: readonly FontSet[] = [
  {
    family: 'SignatureFont',
    files: ['latin', 'latin-ext'].map((subset) => `schibsted-grotesk-${subset}-500-normal.woff2`),
    sample: 'Łukasz Żółć',
  },
  {
    family: 'SignatureFallback',
    files: ['latin', 'latin-ext', 'vietnamese', 'greek', 'greek-ext', 'cyrillic', 'cyrillic-ext'].map(
      (subset) => `noto-sans-${subset}-500-normal.woff2`,
    ),
    sample: 'Nguyễn Ελένη Пётр',
  },
];

function registerFonts(fontsDir: string, { family, files }: FontSet): void {
  for (const file of files) {
    const path = join(fontsDir, file);
    if (!existsSync(path)) throw new Error(`${path} is missing (scripts/copy-fonts.mjs)`);
    if (GlobalFonts.registerFromPath(path, family) === null) throw new Error(`cannot register ${file}`);
  }
  if (!GlobalFonts.has(family)) throw new Error(`font family ${family} is not available after registration`);
}

/** Draws the sample in black on a transparent canvas, round-trips it through PNG and counts the inked pixels. */
async function renderAndReadBack({ family, sample }: FontSet): Promise<number> {
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.font = `${String(FONT_SIZE)}px ${family}`;
  context.textBaseline = 'middle';
  context.fillText(sample, 32, HEIGHT / 2);

  const png = await canvas.encode('png');
  if (!png.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error(`${family}: output is not a PNG`);

  const image = await loadImage(png);
  if (image.width !== WIDTH || image.height !== HEIGHT) {
    throw new Error(`${family}: decoded size ${String(image.width)}x${String(image.height)}`);
  }
  const decoded = createCanvas(WIDTH, HEIGHT).getContext('2d');
  decoded.drawImage(image, 0, 0);
  const { data } = decoded.getImageData(0, 0, WIDTH, HEIGHT);
  let inked = 0;
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    if ((data[alpha] ?? 0) > 0) inked += 1;
  }
  return inked;
}

async function main(): Promise<void> {
  // Tooling entry point: the only setting it needs is NODE_ENV, to find the font folder of the current mode.
  const { signatureFontsDir } = resolvePaths(process.env['NODE_ENV'] === 'production' ? 'production' : 'development');
  for (const fontSet of FONT_SETS) {
    registerFonts(signatureFontsDir, fontSet);
    const inked = await renderAndReadBack(fontSet);
    if (inked < MIN_INKED_PIXELS) {
      throw new Error(`${fontSet.family}: only ${String(inked)} inked pixels (expected ${String(MIN_INKED_PIXELS)})`);
    }
    process.stdout.write(`smoke-canvas: ${fontSet.family} drew "${fontSet.sample}" (${String(inked)} inked pixels)\n`);
  }
  process.stdout.write('smoke-canvas: ok\n');
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`smoke-canvas: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
