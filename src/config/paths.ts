import { fileURLToPath } from 'node:url';

import type { Env } from './env.js';

/**
 * Where generated assets come from (ADR 0010). Production serves the hashed build in dist/ through a manifest;
 * development and tests serve the unhashed watcher output in .dev/ and never read a manifest.
 */
export type AssetMode = 'production' | 'development';

export function assetMode(nodeEnv: Env['NODE_ENV']): AssetMode {
  return nodeEnv === 'production' ? 'production' : 'development';
}

export interface AppPaths {
  /** The mode these paths belong to; the asset resolver and the static router's cache headers follow it. */
  mode: AssetMode;
  /** Handlebars views (src/views is copied into the image as is). */
  viewsDir: string;
  /** Committed static files: icons, site.webmanifest, robots.txt. */
  publicDir: string;
  /** Generated assets/ and fonts/ of the current mode. */
  builtPublicDir: string;
  /** dist/public/assets/manifest.json, written by scripts/write-manifest.mjs (production only). */
  manifestPath: string;
  /** Server-side typed-signature fonts copied by scripts/copy-fonts.mjs (ADR 0005). */
  signatureFontsDir: string;
}

/**
 * Paths resolve against this file, which sits two levels below the repository root both as src/config/paths.ts
 * (tsx, Vitest) and as dist/config/paths.js (build, image), so one set of relative URLs works everywhere.
 */
const fromRoot = (relativePath: string): string => fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));

export function resolvePaths(mode: AssetMode): AppPaths {
  const outRoot = mode === 'production' ? 'dist' : '.dev';
  return {
    mode,
    viewsDir: fromRoot('src/views'),
    publicDir: fromRoot('public'),
    builtPublicDir: fromRoot(`${outRoot}/public`),
    manifestPath: fromRoot('dist/public/assets/manifest.json'),
    signatureFontsDir: fromRoot(`${outRoot}/signature-fonts`),
  };
}
