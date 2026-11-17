import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { CLIENT_ENTRIES, clientBuildOptions } from '../build-client.mjs';
import { ALLOWED_OUT_DIRS, FONT_SETS } from '../copy-fonts.mjs';
import { hashedName } from '../hash-css.mjs';
import { buildManifest, logicalName, verifyManifest } from '../write-manifest.mjs';

describe('asset pipeline', () => {
  it('B-82: hashes the stylesheet name by content (sha256, 10 hex)', () => {
    expect(hashedName('app.css', 'a{}')).toMatch(/^app-[a-f0-9]{10}\.css$/);
    expect(hashedName('app.css', 'a{}')).toBe(hashedName('app.css', 'a{}'));
    expect(hashedName('app.css', 'a{}')).not.toBe(hashedName('app.css', 'b{}'));
  });

  it('B-82: production bundles are hashed with linked source maps and a metafile; development is plain', () => {
    const production = clientBuildOptions('production');
    const development = clientBuildOptions('development');

    expect(production).toMatchObject({
      entryPoints: CLIENT_ENTRIES,
      outdir: 'dist/public/assets',
      entryNames: '[name]-[hash]',
      sourcemap: 'linked',
      metafile: true,
      minify: true,
      format: 'esm',
      platform: 'browser',
      tsconfig: 'src/client/tsconfig.json',
    });
    expect(development).toMatchObject({ outdir: '.dev/public/assets', entryNames: '[name]', minify: false });
    expect(CLIENT_ENTRIES).toEqual(['src/client/form-guard.ts', 'src/client/signature-pad.ts']);
  });

  it('B-82: maps logical asset names to the hashed files', () => {
    const manifest = buildManifest({
      clientMetafile: {
        outputs: {
          'dist/public/assets/signature-pad-BBB.js': { entryPoint: 'src/client/signature-pad.ts' },
          'dist/public/assets/signature-pad-BBB.js.map': {},
          'dist/public/assets/form-guard-AAA.js': { entryPoint: 'src/client/form-guard.ts' },
          'dist/public/assets/chunk-CCC.js': {},
        },
      },
      css: { 'app.css': 'app-0123456789.css' },
      entries: CLIENT_ENTRIES,
      assetsDir: 'dist/public/assets',
    });

    expect(manifest).toEqual({
      'app.css': 'app-0123456789.css',
      'form-guard.js': 'form-guard-AAA.js',
      'signature-pad.js': 'signature-pad-BBB.js',
    });
    expect(Object.keys(manifest)).toEqual(['app.css', 'form-guard.js', 'signature-pad.js']);
    expect(logicalName('src/client/form-guard.ts')).toBe('form-guard.js');
  });

  it('B-82: refuses a manifest with a missing entry', () => {
    expect(() =>
      buildManifest({
        clientMetafile: { outputs: {} },
        css: {},
        entries: CLIENT_ENTRIES,
        assetsDir: 'dist/public/assets',
      }),
    ).toThrow('manifest is missing form-guard.js, signature-pad.js, app.css');
  });

  describe('verifyManifest', () => {
    let dir = '';
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('B-82: accepts existing files whose source maps resolve and reports everything else', () => {
      dir = mkdtempSync(join(tmpdir(), 'manifest-'));
      writeFileSync(join(dir, 'app-1.css'), 'a{}');
      writeFileSync(join(dir, 'ok-1.js'), 'x;\n//# sourceMappingURL=ok-1.js.map\n');
      writeFileSync(join(dir, 'ok-1.js.map'), '{}');
      writeFileSync(join(dir, 'nomap-1.js'), 'x;\n');
      writeFileSync(join(dir, 'broken-1.js'), 'x;\n//# sourceMappingURL=broken-1.js.map\n');

      expect(verifyManifest({ 'app.css': 'app-1.css', 'ok.js': 'ok-1.js' }, dir)).toEqual([]);
      expect(
        verifyManifest({ 'gone.js': 'gone-1.js', 'nomap.js': 'nomap-1.js', 'broken.js': 'broken-1.js' }, dir),
      ).toEqual([
        'gone.js -> gone-1.js does not exist',
        'nomap-1.js has no sourceMappingURL',
        'broken-1.js points to a missing broken-1.js.map',
      ]);
    });
  });

  it('F-86, F-45: every font file the build copies exists in the installed packages', () => {
    const files = FONT_SETS.flatMap(({ filesDir, files: names }) => names.map((name) => resolve(filesDir, name)));

    expect(files).toHaveLength(4 + 2 + 7);
    for (const file of files) expect(statSync(file).size).toBeGreaterThan(1000);
    expect(
      FONT_SETS.find((set) => set.dir === 'public/fonts')?.files.every((name) => name.startsWith('schibsted-grotesk-')),
    ).toBe(true);
    expect(FONT_SETS.flatMap((set) => set.files).some((name) => name.includes('variable'))).toBe(false);
    expect(ALLOWED_OUT_DIRS).toEqual(['dist', '.dev']);
  });
});
