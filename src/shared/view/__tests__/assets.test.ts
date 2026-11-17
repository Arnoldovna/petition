import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAssetResolver } from '../assets.js';

/** A fake dist/public/assets folder per test. */
let assetsDir: string;
let manifestPath: string;

const BUILT = {
  'app.css': 'app-0123456789.css',
  'form-guard.js': 'form-guard-ABCDEFGH.js',
  'signature-pad.js': 'signature-pad-IJKLMNOP.js',
};

function writeBuild(manifest: Record<string, string>, files: readonly string[] = Object.values(manifest)): void {
  for (const file of files) writeFileSync(join(assetsDir, file), '/* built */');
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

beforeEach(() => {
  assetsDir = join(mkdtempSync(join(tmpdir(), 'petition-assets-')), 'assets');
  mkdirSync(assetsDir);
  manifestPath = join(assetsDir, 'manifest.json');
});

afterEach(() => {
  rmSync(join(assetsDir, '..'), { recursive: true, force: true });
});

describe('createAssetResolver in development', () => {
  it('B-82: returns plain paths and never reads a manifest, even a stale one that exists', () => {
    writeBuild({ ...BUILT, 'app.css': 'app-stale000000.css' });

    const resolve = createAssetResolver({ mode: 'development', manifestPath });

    expect(resolve('app.css')).toBe('/assets/app.css');
    expect(resolve('signature-pad.js')).toBe('/assets/signature-pad.js');
  });

  it('B-82: accepts plain file names only, so no template can build a path outside /assets/', () => {
    const resolve = createAssetResolver({ mode: 'development' });

    expect(() => resolve('../server.js')).toThrow(/not a plain asset name/);
    expect(() => resolve('nested/app.css')).toThrow(/not a plain asset name/);
    expect(() => resolve('.env')).toThrow(/not a plain asset name/);
    expect(() => resolve('')).toThrow(/not a plain asset name/);
  });
});

describe('createAssetResolver in production', () => {
  it('B-82: maps logical names to the hashed files of the manifest', () => {
    writeBuild(BUILT);

    const resolve = createAssetResolver({ mode: 'production', manifestPath });

    expect(resolve('app.css')).toBe('/assets/app-0123456789.css');
    expect(resolve('form-guard.js')).toBe('/assets/form-guard-ABCDEFGH.js');
    expect(resolve('signature-pad.js')).toBe('/assets/signature-pad-IJKLMNOP.js');
  });

  it('B-82: fails fast at startup without a manifest, with a hint to build', () => {
    expect(() => createAssetResolver({ mode: 'production', manifestPath })).toThrow(/run `pnpm build` first/);
    expect(() => createAssetResolver({ mode: 'production' })).toThrow(/needs the manifest path/);
  });

  it('B-82: fails fast on a malformed manifest or one whose values are paths', () => {
    writeFileSync(manifestPath, '{ not json');
    expect(() => createAssetResolver({ mode: 'production', manifestPath })).toThrow(/cannot read/);

    writeFileSync(manifestPath, JSON.stringify({ ...BUILT, 'app.css': '../../server.js' }));
    expect(() => createAssetResolver({ mode: 'production', manifestPath })).toThrow(/cannot read/);
  });

  it('B-82: fails fast when an entry the views link is missing from the manifest', () => {
    const { 'signature-pad.js': _omitted, ...withoutPad } = BUILT;
    writeBuild(withoutPad);

    expect(() => createAssetResolver({ mode: 'production', manifestPath })).toThrow(
      /"signature-pad.js" is not in the manifest/,
    );
  });

  it('B-82: fails fast when the manifest maps a name to a file that is not there', () => {
    writeBuild(BUILT, [BUILT['app.css'], BUILT['form-guard.js']]);

    expect(() => createAssetResolver({ mode: 'production', manifestPath })).toThrow(
      /signature-pad-IJKLMNOP\.js does not exist/,
    );
  });

  it('B-82: an unknown logical name at render time is an error, never a broken link', () => {
    writeBuild(BUILT);
    const resolve = createAssetResolver({ mode: 'production', manifestPath });

    expect(() => resolve('missing.js')).toThrow(/"missing.js" is not in the asset manifest/);
  });
});
