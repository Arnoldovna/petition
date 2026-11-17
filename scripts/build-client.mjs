// `pnpm build:client` and `pnpm dev:client` (ADR 0010): bundles the browser entries in src/client with esbuild.
//
//   production (default)  dist/public/assets/<name>-<hash>.js + linked .js.map; the metafile goes to
//                         dist/.asset-meta/client.json for scripts/write-manifest.mjs
//   --dev                 .dev/public/assets/<name>.js + .js.map, rebuilt on change (watch mode, no manifest)
//
// esbuild names each .js and its .map consistently and writes a correct //# sourceMappingURL, so nothing is renamed
// afterwards. The bundles are ES2022 modules loaded with <script type="module" src> (CSP script-src 'self').
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import * as esbuild from 'esbuild';

const ROOT = resolve(import.meta.dirname, '..');
/** Entry points; every other file in src/client (e.g. signature-pad.core.ts) is bundled into them. */
export const CLIENT_ENTRIES = ['src/client/form-guard.ts', 'src/client/signature-pad.ts'];
export const CLIENT_METAFILE = 'dist/.asset-meta/client.json';

/**
 * esbuild options for one mode. Paths are relative to the repository root (absWorkingDir).
 *
 * @param {'production' | 'development'} mode
 * @returns {import('esbuild').BuildOptions}
 */
export function clientBuildOptions(mode) {
  const production = mode === 'production';
  return {
    absWorkingDir: ROOT,
    entryPoints: CLIENT_ENTRIES,
    outdir: production ? 'dist/public/assets' : '.dev/public/assets',
    entryNames: production ? '[name]-[hash]' : '[name]',
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    tsconfig: 'src/client/tsconfig.json',
    sourcemap: 'linked',
    minify: production,
    metafile: production,
    charset: 'utf8',
    logLevel: 'info',
  };
}

async function main(argv) {
  if (argv.includes('--dev')) {
    const context = await esbuild.context(clientBuildOptions('development'));
    await context.watch();
    console.log('build-client: watching src/client (Ctrl+C to stop)');
    return;
  }
  const result = await esbuild.build(clientBuildOptions('production'));
  const metafilePath = resolve(ROOT, CLIENT_METAFILE);
  mkdirSync(resolve(metafilePath, '..'), { recursive: true });
  writeFileSync(metafilePath, `${JSON.stringify(result.metafile, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // esbuild has already printed the build errors with file and line (logLevel: 'info').
    console.error(`build-client: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
