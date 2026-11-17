// `node scripts/generate-icons.mjs` (ADR 0010, B-43): renders the raster icons from the one vector source,
// public/favicon.svg, with @napi-rs/canvas, so every icon shows the same mark.
//
//   public/apple-touch-icon.png  180 x 180  <link rel="apple-touch-icon"> in the layout
//   public/icon-512.png          512 x 512  site.webmanifest (install and splash screens)
//
// The SVG is drawn at each target size (not scaled from a small raster), on an opaque square: iOS rounds the corners
// itself and fills transparent pixels with black. The output is deterministic for one @napi-rs/canvas version.
//
//   node scripts/generate-icons.mjs          write both files
//   node scripts/generate-icons.mjs --check  exit 1 when a committed file differs from a fresh render
//
// Run it by hand after changing favicon.svg and commit the SVG and both PNGs together (they are static files, not
// build output, so the Docker image and the tests need no canvas step).
import { readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';

import { createCanvas, Image } from '@napi-rs/canvas';

const ROOT = resolve(import.meta.dirname, '..');
const SOURCE = resolve(ROOT, 'public/favicon.svg');

/** Every raster icon the site serves (ROUTES.md section 7). */
const ICONS = [
  { file: 'public/apple-touch-icon.png', size: 180 },
  { file: 'public/icon-512.png', size: 512 },
];

/**
 * Draws the SVG at `size` x `size` pixels and resolves to the PNG bytes (`canvas.encode` is asynchronous). Setting the
 * image size before `src` makes @napi-rs/canvas rasterise the vector at that size, so edges stay sharp.
 *
 * @param {Buffer} svg
 * @param {number} size
 * @returns {Promise<Buffer>}
 */
async function renderPng(svg, size) {
  const image = new Image();
  image.width = size;
  image.height = size;
  image.src = svg;
  if (image.width !== size || image.height !== size || !image.complete) {
    throw new Error(`could not rasterise ${relative(ROOT, SOURCE)} at ${size} px`);
  }

  const canvas = createCanvas(size, size);
  canvas.getContext('2d').drawImage(image, 0, 0, size, size);
  return await canvas.encode('png');
}

/** @param {string} path */
function readIfPresent(path) {
  try {
    return readFileSync(path);
  } catch {
    return undefined;
  }
}

async function main(argv) {
  const unknown = argv.filter((argument) => argument !== '--check');
  if (unknown.length > 0) throw new Error(`unknown argument ${unknown.join(' ')}; usage: generate-icons.mjs [--check]`);
  const check = argv.includes('--check');

  const svg = readFileSync(SOURCE);
  const stale = [];
  for (const { file, size } of ICONS) {
    const target = resolve(ROOT, file);
    const png = await renderPng(svg, size);
    if (check) {
      const committed = readIfPresent(target);
      if (committed?.equals(png) !== true) stale.push(file);
      continue;
    }
    writeFileSync(target, png);
    console.log(`generate-icons: wrote ${file} (${size} x ${size})`);
  }

  if (stale.length > 0) {
    throw new Error(`out of date: ${stale.join(', ')}; run node scripts/generate-icons.mjs and commit the result`);
  }
  if (check) console.log('generate-icons: icons match public/favicon.svg');
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`generate-icons: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
