// `node scripts/hash-css.mjs [file]` (end of `pnpm build:css`, ADR 0010): renames the Tailwind output
// dist/public/assets/app.css to app-<sha256-10>.css and records the mapping in dist/.asset-meta/css.json for
// scripts/write-manifest.mjs. The CSS has no source map, so renaming it is safe.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const DEFAULT_FILE = 'dist/public/assets/app.css';
export const CSS_METAFILE = 'dist/.asset-meta/css.json';

/**
 * `app.css` + content -> `app-<first 10 hex of sha256>.css`.
 *
 * @param {string} fileName
 * @param {string | Uint8Array} content
 */
export function hashedName(fileName, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const extension = extname(fileName);
  return `${basename(fileName, extension)}-${hash}${extension}`;
}

function main(argv) {
  const source = resolve(ROOT, argv[0] ?? DEFAULT_FILE);
  const content = readFileSync(source);
  if (content.length === 0) throw new Error(`${basename(source)} is empty; did the Tailwind build fail?`);
  const target = hashedName(basename(source), content);
  renameSync(source, resolve(dirname(source), target));

  const metafile = resolve(ROOT, CSS_METAFILE);
  mkdirSync(dirname(metafile), { recursive: true });
  writeFileSync(metafile, `${JSON.stringify({ [basename(source)]: target }, null, 2)}\n`);
  console.log(`hash-css: ${basename(source)} -> ${target}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`hash-css: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
