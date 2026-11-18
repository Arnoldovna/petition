import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { fillPlaceholders, relativeFontUrls, referencedMedia } from '../build-site.mjs';

const PAGE = readFileSync(resolve(import.meta.dirname, '..', '..', 'site', 'index.html'), 'utf8');

describe('GitHub Pages page (scripts/build-site.mjs)', () => {
  it('fills every placeholder and refuses to publish one that is left over', () => {
    expect(fillPlaceholders('<p>© {{YEAR}}</p>', { YEAR: '2026' })).toBe('<p>© 2026</p>');
    expect(() => fillPlaceholders('{{YEAR}} {{TYPO}}', { YEAR: '2026' })).toThrow('unfilled placeholder {{TYPO}}');
  });

  it('the page uses exactly the placeholders the build fills', () => {
    const placeholders = new Set([...PAGE.matchAll(/\{\{([^}]*)\}\}/g)].map(([, name]) => name));
    expect(placeholders).toEqual(new Set(['YEAR']));
  });

  it('copies the media files the page references, each once', () => {
    expect(
      referencedMedia('<video poster="media/a.png"><source src="media/a.mp4"></video><img src="media/a.png">'),
    ).toEqual(['a.png', 'a.mp4']);
    expect(referencedMedia(PAGE)).toEqual(expect.arrayContaining(['demo-desktop.mp4', 'demo-mobile.webm']));
  });

  it('makes the root-relative font URLs relative to assets/, quoted or not, and fails when there are none', () => {
    expect(relativeFontUrls("src:url('/fonts/a.woff2') format('woff2'),url(/fonts/b.woff2)")).toBe(
      "src:url('../fonts/a.woff2') format('woff2'),url(../fonts/b.woff2)",
    );
    expect(() => relativeFontUrls('a{}')).toThrow('no /fonts/ URL');
  });
});
