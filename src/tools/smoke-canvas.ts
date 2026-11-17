/**
 * Canvas smoke check (ADR 0005): proves inside the distroless image that @napi-rs/canvas loads its native binary and
 * that the signature module's production code works there: `createSignatureImages` registers every shipped woff2
 * signature font (it throws when one cannot be registered), `renderTypedSignature` draws one name per font's script
 * range (latin-ext for Schibsted Grotesk; Vietnamese, Greek and Cyrillic, which only Noto Sans has), and every PNG
 * round-trips through the drawn-signature validator without a rejection and with at least 1,000 inked pixels.
 * Which family a name gets (`familyFor`) is not observable from outside the service; `signature-image.test.ts`
 * asserts it. scripts/run-e2e.mjs runs this check in the freshly built e2e image (`dist/tools/smoke-canvas.js`,
 * network off), so it covers linux/arm64 locally and linux/amd64 in CI.
 *
 * Fonts come from dist/signature-fonts (NODE_ENV=production, the image) or .dev/signature-fonts (`pnpm dev` copies
 * them); `pnpm assets:fonts .dev` creates the latter for a local run with `pnpm exec tsx src/tools/smoke-canvas.ts`.
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';

import { resolvePaths } from '../config/paths.js';
import { createSignatureImages, signatureFontPaths, type SignatureImages } from '../features/signature/index.js';

const MIN_INKED_PIXELS = 1000;

/**
 * One name per font (ADR 0005): the first needs Schibsted Grotesk's latin-ext file, the second exists only in Noto
 * Sans. `script` names what the sample covers; the check does not claim which family drew it.
 */
const SAMPLES = [
  { script: 'latin-ext', name: 'Łukasz Żółć' },
  { script: 'vietnamese, greek, cyrillic', name: 'Nguyễn Ελένη Пётр' },
] as const;

/**
 * Pixels with alpha > 0 after decoding the PNG again. Counted here rather than with the validator's own ink check, so
 * the code under test does not grade itself.
 */
async function inkedPixels(png: Buffer): Promise<number> {
  const image = await loadImage(png);
  const context = createCanvas(image.width, image.height).getContext('2d');
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  let inked = 0;
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    if ((data[alpha] ?? 0) > 0) inked += 1;
  }
  return inked;
}

/** Renders the name, validates it like an upload and returns the inked pixels of the bytes that would be stored. */
async function renderAndValidate(images: SignatureImages, name: string): Promise<number> {
  const rendered = await images.renderTypedSignature(name);
  const result = await images.validateDrawnSignature(`data:image/png;base64,${rendered.toString('base64')}`);
  if (!result.ok) throw new Error(`"${name}": the validator rejected the rendered PNG (${result.reason})`);
  return inkedPixels(result.png);
}

async function main(): Promise<void> {
  // Tooling entry point: the only setting it needs is NODE_ENV, to find the font folder of the current mode.
  const { signatureFontsDir } = resolvePaths(process.env['NODE_ENV'] === 'production' ? 'production' : 'development');
  // Throws when a font file is missing or cannot be registered, as at app startup.
  const images = createSignatureImages({ fontPaths: signatureFontPaths(signatureFontsDir) });
  for (const { script, name } of SAMPLES) {
    const inked = await renderAndValidate(images, name);
    if (inked < MIN_INKED_PIXELS) {
      throw new Error(
        `"${name}" (${script}): only ${String(inked)} inked pixels (expected ${String(MIN_INKED_PIXELS)})`,
      );
    }
    process.stdout.write(`smoke-canvas: rendered "${name}" (${script}; ${String(inked)} inked pixels, validated)\n`);
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
