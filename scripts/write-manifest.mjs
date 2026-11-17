// `node scripts/write-manifest.mjs` (last step of `pnpm build:assets`, ADR 0010): writes
// dist/public/assets/manifest.json, e.g. { "app.css": "app-<h>.css", "form-guard.js": "form-guard-<h>.js", ... },
// from the esbuild metafile (scripts/build-client.mjs) and the CSS hash step (scripts/hash-css.mjs).
// src/shared/view/assets.ts requires this file in production and resolves {{asset "app.css"}} through it.
//
// Fails when an entry is missing, when a mapped file does not exist, or when a bundle's //# sourceMappingURL does not
// resolve to an existing .map, so a broken asset build never reaches an image.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve } from 'node:path';

import { CLIENT_ENTRIES, CLIENT_METAFILE } from './build-client.mjs';
import { CSS_METAFILE } from './hash-css.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const ASSETS_DIR = 'dist/public/assets';
const MANIFEST = `${ASSETS_DIR}/manifest.json`;

/** The logical name of an entry point: `src/client/form-guard.ts` -> `form-guard.js`. */
export function logicalName(entryPoint) {
  return `${basename(entryPoint, extname(entryPoint))}.js`;
}

/**
 * Builds the manifest from the esbuild metafile and the CSS mapping. Paths in the metafile are relative to the
 * repository root; manifest values are relative to the assets directory.
 *
 * @param {object} input
 * @param {{ outputs: Record<string, { entryPoint?: string }> }} input.clientMetafile
 * @param {Record<string, string>} input.css
 * @param {string[]} input.entries      expected client entry points
 * @param {string} input.assetsDir      e.g. dist/public/assets
 * @returns {Record<string, string>}    sorted by key
 */
export function buildManifest({ clientMetafile, css, entries, assetsDir }) {
  const manifest = { ...css };
  for (const [output, meta] of Object.entries(clientMetafile.outputs)) {
    if (!meta.entryPoint || !output.endsWith('.js')) continue;
    const target = relative(assetsDir, output).split('\\').join('/');
    if (target.startsWith('..')) throw new Error(`${output} is outside ${assetsDir}`);
    manifest[logicalName(meta.entryPoint)] = target;
  }
  const missing = [...entries.map(logicalName), 'app.css'].filter((name) => !(name in manifest));
  if (missing.length > 0) throw new Error(`manifest is missing ${missing.join(', ')}`);
  return Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * Checks that every mapped file exists and that each JS bundle's source map reference resolves.
 *
 * @param {Record<string, string>} manifest
 * @param {string} assetsDir absolute
 * @returns {string[]} problems
 */
export function verifyManifest(manifest, assetsDir) {
  const problems = [];
  for (const [name, file] of Object.entries(manifest)) {
    const path = resolve(assetsDir, file);
    if (!existsSync(path)) {
      problems.push(`${name} -> ${file} does not exist`);
      continue;
    }
    if (!file.endsWith('.js')) continue;
    const mapUrl = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(readFileSync(path, 'utf8'))?.[1];
    if (!mapUrl) problems.push(`${file} has no sourceMappingURL`);
    else if (!existsSync(resolve(dirname(path), mapUrl))) problems.push(`${file} points to a missing ${mapUrl}`);
  }
  return problems;
}

function readJson(path) {
  if (!existsSync(path)) throw new Error(`${relative(ROOT, path)} not found; run the asset build steps first`);
  return JSON.parse(readFileSync(path, 'utf8'));
}

function main() {
  const assetsDir = resolve(ROOT, ASSETS_DIR);
  const manifest = buildManifest({
    clientMetafile: readJson(resolve(ROOT, CLIENT_METAFILE)),
    css: readJson(resolve(ROOT, CSS_METAFILE)),
    entries: CLIENT_ENTRIES,
    assetsDir: ASSETS_DIR,
  });
  const problems = verifyManifest(manifest, assetsDir);
  if (problems.length > 0) throw new Error(`invalid asset build:\n  - ${problems.join('\n  - ')}`);
  writeFileSync(resolve(ROOT, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`write-manifest: ${MANIFEST} (${Object.keys(manifest).length} entries)`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`write-manifest: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
