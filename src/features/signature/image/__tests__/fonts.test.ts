import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { testSignatureFontPaths } from '../../../../../test/fonts.js';
import { createSignatureImages, signatureFontPaths } from '../index.js';

describe('createSignatureImages font check', () => {
  it('ADR 0005: starts with every shipped signature font present', () => {
    expect(() => createSignatureImages({ fontPaths: testSignatureFontPaths() })).not.toThrow();
  });

  it('ADR 0005: fails at startup, naming the file, when a signature font is missing', () => {
    const present = testSignatureFontPaths();
    const missing = join('/nonexistent', 'noto-sans-greek-500-normal.woff2');

    expect(() =>
      createSignatureImages({ fontPaths: { primary: present.primary, fallback: [...present.fallback, missing] } }),
    ).toThrow(missing);
    // A folder without the copied fonts (a build that skipped `assets:fonts`) fails the same way.
    expect(() => createSignatureImages({ fontPaths: signatureFontPaths('/nonexistent') })).toThrow(
      /signature fonts missing/,
    );
  });
});
