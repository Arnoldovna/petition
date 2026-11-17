// `pnpm assets:fonts <outDir>` (ADR 0005, ADR 0010): copies exactly the font files the app needs out of the
// @fontsource devDependencies, so neither the browser nor the runtime image needs the packages.
//
//   <outDir>/public/fonts/     Schibsted Grotesk 400 and 500, latin and latin-ext (served at /fonts, fonts.css)
//   <outDir>/signature-fonts/  server-side typed-signature fonts, weight 500: Schibsted Grotesk (latin, latin-ext)
//                              and the Noto Sans fallback (latin, latin-ext, vietnamese, greek, greek-ext, cyrillic,
//                              cyrillic-ext); never referenced by UI CSS (conventions §10)
//
// `pnpm build:assets` passes dist, `pnpm dev` passes .dev. Both target folders are emptied first, so no stale file
// survives a font update.
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(import.meta.dirname, '..');
// Literal specifiers, so knip sees that these devDependencies are used (ADR 0019 section 3).
const SCHIBSTED_GROTESK = packageFiles(import.meta.resolve('@fontsource/schibsted-grotesk/package.json'));
const NOTO_SANS = packageFiles(import.meta.resolve('@fontsource/noto-sans/package.json'));

/** @type {{ dir: string, filesDir: string, files: string[] }[]} */
export const FONT_SETS = [
  {
    dir: 'public/fonts',
    filesDir: SCHIBSTED_GROTESK,
    files: ['latin', 'latin-ext'].flatMap((subset) =>
      ['400', '500'].map((weight) => `schibsted-grotesk-${subset}-${weight}-normal.woff2`),
    ),
  },
  {
    dir: 'signature-fonts',
    filesDir: SCHIBSTED_GROTESK,
    files: ['latin', 'latin-ext'].map((subset) => `schibsted-grotesk-${subset}-500-normal.woff2`),
  },
  {
    dir: 'signature-fonts',
    filesDir: NOTO_SANS,
    files: ['latin', 'latin-ext', 'vietnamese', 'greek', 'greek-ext', 'cyrillic', 'cyrillic-ext'].map(
      (subset) => `noto-sans-${subset}-500-normal.woff2`,
    ),
  },
];

/** Only the two output roots the scripts use; anything else is a typo that could delete the wrong folder. */
export const ALLOWED_OUT_DIRS = ['dist', '.dev'];

/** The `files/` folder next to an installed package's package.json. */
function packageFiles(packageJsonUrl) {
  return fileURLToPath(new URL('files/', packageJsonUrl));
}

function main(argv) {
  const outDir = argv[0];
  if (!outDir || !ALLOWED_OUT_DIRS.includes(outDir)) {
    throw new Error(`usage: copy-fonts.mjs <${ALLOWED_OUT_DIRS.join('|')}>`);
  }
  const targets = [...new Set(FONT_SETS.map((set) => resolve(ROOT, outDir, set.dir)))];
  for (const target of targets) {
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
  }
  let count = 0;
  for (const { dir, filesDir, files } of FONT_SETS) {
    for (const file of files) {
      const source = resolve(filesDir, file);
      if (!existsSync(source)) throw new Error(`${source} not found; run pnpm install`);
      copyFileSync(source, resolve(ROOT, outDir, dir, file));
      count += 1;
    }
  }
  console.log(`copy-fonts: ${count} files to ${outDir}/{public/fonts,signature-fonts}`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`copy-fonts: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
