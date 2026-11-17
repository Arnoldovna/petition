import { readFileSync } from 'node:fs';

import { z } from 'zod';

import type { AssetMode } from '../../config/paths.js';

/** Logical asset name (`app.css`, `form-guard.js`) -> public URL (`/assets/app-<hash>.css`). */
export type AssetResolver = (logicalName: string) => string;

const ASSET_PREFIX = '/assets/';

const ManifestSchema = z.record(
  z.string(),
  // Values are file names inside dist/public/assets, never paths that could leave it.
  z.string().regex(/^[\w.-]+$/, 'must be a plain file name'),
);

interface AssetResolverOptions {
  mode: AssetMode;
  /** Required in production; development never reads a manifest (ADR 0010). */
  manifestPath?: string;
}

/**
 * Production reads `manifest.json` once and fails fast at startup when it is missing, malformed or does not map a
 * requested name, so a broken asset build can never serve a page that links a missing stylesheet. Development and
 * tests return plain paths served from .dev/public/assets, even when a stale manifest exists in dist/.
 */
export function createAssetResolver({ mode, manifestPath }: AssetResolverOptions): AssetResolver {
  if (mode === 'development') return (logicalName) => `${ASSET_PREFIX}${logicalName}`;

  if (manifestPath === undefined) throw new Error('assets: production mode needs the manifest path');
  let manifest: Record<string, string>;
  try {
    manifest = ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    throw new Error(`assets: cannot read ${manifestPath}; run \`pnpm build\` first`, { cause: error });
  }
  return (logicalName) => {
    const file = manifest[logicalName];
    if (file === undefined) throw new Error(`assets: "${logicalName}" is not in the asset manifest`);
    return `${ASSET_PREFIX}${file}`;
  };
}
