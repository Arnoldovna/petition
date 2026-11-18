// `pnpm site:build` (Etappe 3b): the GitHub Pages page in dist/site, published by .github/workflows/pages.yml.
//
//   dist/site/index.html          site/index.html with the year filled in
//   dist/site/assets/site.css     site/site.css through the Tailwind CLI, font URLs made relative
//   dist/site/fonts/              Schibsted Grotesk 400 and 500 (the app's font set, scripts/copy-fonts.mjs)
//   dist/site/media/              the demo videos and screenshots from docs/media (`pnpm media:record`, `media:readme`)
//   dist/site/favicon.svg
//
// Fails when a media file is missing, so a page with a broken video is never published.
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { FONT_SETS } from './copy-fonts.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'dist', 'site');
/**
 * The files of docs/media that the page references (`media/<file>`), read from the page itself, so the page is the
 * only list.
 *
 * @param {string} html
 */
export function referencedMedia(html) {
  return [...new Set([...html.matchAll(/\bmedia\/([\w.-]+)/g)].map(([, name]) => name))];
}

/**
 * Fills the `{{NAME}}` placeholders of the page and fails on any that is left over.
 *
 * @param {string} html
 * @param {Record<string, string>} values
 */
export function fillPlaceholders(html, values) {
  const filled = html.replaceAll(/\{\{([A-Z_]+)\}\}/g, (match, name) => values[name] ?? match);
  const left = /\{\{[^}]*\}\}/.exec(filled);
  if (left) throw new Error(`site/index.html: unfilled placeholder ${left[0]}`);
  return filled;
}

/**
 * The page lives below /<repo>/, so the app's root-relative font URLs (/fonts/...) become relative to assets/.
 *
 * @param {string} css
 */
export function relativeFontUrls(css) {
  const rewritten = css.replaceAll(/url\((["']?)\/fonts\//g, 'url($1../fonts/');
  if (rewritten === css) throw new Error('site.css: no /fonts/ URL found to rewrite (did fonts.css change?)');
  return rewritten;
}

function main() {
  const html = readFileSync(join(ROOT, 'site', 'index.html'), 'utf8');
  const media = referencedMedia(html);
  const missing = media.filter((name) => !existsSync(join(ROOT, 'docs', 'media', name)));
  if (missing.length > 0) {
    throw new Error(`missing in docs/media: ${missing.join(', ')} (run pnpm media:record and pnpm media:readme)`);
  }

  rmSync(OUT, { recursive: true, force: true });
  for (const dir of ['assets', 'fonts', 'media']) mkdirSync(join(OUT, dir), { recursive: true });

  const css = join(OUT, 'assets', 'site.css');
  // The package's bin, like the build:css script.
  const tailwind = spawnSync(
    join(ROOT, 'node_modules', '.bin', 'tailwindcss'),
    ['-i', 'site/site.css', '-o', css, '--minify'],
    {
      cwd: ROOT,
      stdio: 'inherit',
    },
  );
  if (tailwind.status !== 0) throw new Error('the Tailwind build of site/site.css failed');
  writeFileSync(css, relativeFontUrls(readFileSync(css, 'utf8')));

  const uiFonts = FONT_SETS.find((set) => set.dir === 'public/fonts');
  if (!uiFonts) throw new Error('copy-fonts.mjs has no public/fonts set');
  for (const file of uiFonts.files) copyFileSync(join(uiFonts.filesDir, file), join(OUT, 'fonts', file));
  for (const name of media) copyFileSync(join(ROOT, 'docs', 'media', name), join(OUT, 'media', name));
  copyFileSync(join(ROOT, 'public', 'favicon.svg'), join(OUT, 'favicon.svg'));

  writeFileSync(join(OUT, 'index.html'), fillPlaceholders(html, { YEAR: String(new Date().getFullYear()) }));
  console.log('build-site: dist/site is ready');
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(`build-site: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
