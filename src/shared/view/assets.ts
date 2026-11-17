import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { AssetMode } from '../../config/paths.js';

/** Logical asset name (`app.css`, `form-guard.js`) -> public URL (`/assets/app-<hash>.css`). */
export type AssetResolver = (logicalName: string) => string;

const ASSET_PREFIX = '/assets/';

/** Logical names and manifest values are plain file names inside the assets folder, never paths that could leave it. */
const FILE_NAME = /^[\w-][\w.-]*$/;

/** Every page links these (layout) or the sign page does (ADR 0010); a build without one of them is broken. */
const REQUIRED_ASSETS = ['app.css', 'form-guard.js', 'signature-pad.js'] as const;

const ManifestSchema = z.record(z.string().regex(FILE_NAME), z.string().regex(FILE_NAME, 'must be a plain file name'));

interface AssetResolverOptions {
  mode: AssetMode;
  /** Required in production; development never reads a manifest (ADR 0010). */
  manifestPath?: string;
}

function assertFileName(logicalName: string): void {
  if (!FILE_NAME.test(logicalName)) throw new Error(`assets: "${logicalName}" is not a plain asset name`);
}

function readManifest(manifestPath: string): Record<string, string> {
  try {
    return ManifestSchema.parse(JSON.parse(readFileSync(manifestPath, 'utf8')));
  } catch (error) {
    throw new Error(`assets: cannot read ${manifestPath}; run \`pnpm build\` first`, { cause: error });
  }
}

/** Every required entry is mapped, and every mapped file sits next to the manifest. */
function verifyManifest(manifest: Readonly<Record<string, string>>, manifestPath: string): void {
  const missing = REQUIRED_ASSETS.filter((name) => manifest[name] === undefined);
  const assetsDir = dirname(manifestPath);
  const absent = Object.values(manifest).filter((file) => !existsSync(join(assetsDir, file)));
  if (missing.length > 0 || absent.length > 0) {
    const problems = [
      ...missing.map((name) => `"${name}" is not in the manifest`),
      ...absent.map((file) => `${file} does not exist`),
    ];
    throw new Error(`assets: incomplete build in ${assetsDir} (${problems.join('; ')}); run \`pnpm build\``);
  }
}

/**
 * Production reads `manifest.json` once and fails fast at startup when it is missing or malformed, lacks one of the
 * entries the views link, or maps a name to a file that is not there, so a broken asset build can never serve a page
 * that links a missing stylesheet or script. The build itself (scripts/write-manifest.mjs) also checks source maps.
 * Development and tests return plain paths served from .dev/public/assets, even when a stale manifest exists in dist/.
 *
 * Both modes accept plain file names only, so a template can never build a path outside `/assets/`.
 */
export function createAssetResolver({ mode, manifestPath }: AssetResolverOptions): AssetResolver {
  if (mode === 'development') {
    return (logicalName) => {
      assertFileName(logicalName);
      return `${ASSET_PREFIX}${logicalName}`;
    };
  }

  if (manifestPath === undefined) throw new Error('assets: production mode needs the manifest path');
  const manifest = readManifest(manifestPath);
  verifyManifest(manifest, manifestPath);
  return (logicalName) => {
    const file = manifest[logicalName];
    if (file === undefined) throw new Error(`assets: "${logicalName}" is not in the asset manifest`);
    return `${ASSET_PREFIX}${file}`;
  };
}
