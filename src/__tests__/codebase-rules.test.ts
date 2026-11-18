import { describe, expect, it } from 'vitest';

import { listRepoFiles, readRepoFile as read } from '../../test/repo.js';

/**
 * Source-level guarantees that no single module owns: the product scope of FEATURES.md section 1 (F-10, F-11), the copy
 * rules (F-77, B-75) and the naming map (B-53, DATA-MODEL.md section 1). Each one reads the shipped sources, so a later
 * change that brings a legacy pattern back fails here.
 */

const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.ts$/;

function listFiles(relativeDir: string, extensions: readonly string[]): string[] {
  return listRepoFiles(relativeDir).filter(
    (file) => extensions.some((extension) => file.endsWith(extension)) && !TEST_FILE.test(file),
  );
}

/** Every shipped server, browser and view source (tests excluded: they quote the bad patterns on purpose). */
const SOURCES = listFiles('src', ['.ts', '.hbs']);
const VIEWS = SOURCES.filter((file) => file.endsWith('.hbs'));

/** Files whose content matches the pattern, so a failure names where the pattern came back. */
const filesMatching = (files: readonly string[], pattern: RegExp): string[] =>
  files.filter((file) => pattern.test(read(file)));

function dependencyNames(): string[] {
  const pkg = JSON.parse(read('package.json')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
}

describe('product scope', () => {
  it('sees the shipped sources', () => {
    expect(SOURCES).toContain('src/app.ts');
    expect(SOURCES).toContain('src/client/signature-pad.ts');
    expect(VIEWS).toContain('src/views/layouts/main.hbs');
  });

  it('F-10: there is no real-time channel: no WebSocket or SSE package, and no source opens one', () => {
    const realtimePackages =
      /^(?:ws|socket\.io(?:-client)?|sockjs(?:-client)?|express-ws|uws|uWebSockets\.js|eventsource|better-sse|sse(?:-.*)?)$/;
    expect(dependencyNames().filter((name) => realtimePackages.test(name))).toEqual([]);
    expect(filesMatching(SOURCES, /\bnew\s+(?:WebSocket|EventSource)\b|text\/event-stream/i)).toEqual([]);
  });

  it('F-11: the signature form field is the only upload: no multipart parser, no file input, no multipart form', () => {
    const multipartPackages = /^(?:multer|busboy|connect-busboy|formidable|multiparty|express-fileupload)$/;
    expect(dependencyNames().filter((name) => multipartPackages.test(name))).toEqual([]);
    expect(filesMatching(VIEWS, /type\s*=\s*["']?file\b/i)).toEqual([]);
    expect(filesMatching(VIEWS, /multipart\/form-data/i)).toEqual([]);
    expect(filesMatching(SOURCES, /\bmultipart\b/i)).toEqual([]);

    // The drawing travels as the hidden `signature` field of a urlencoded POST /signature form (ADR 0004).
    const pad = read('src/views/partials/signature-pad.hbs');
    expect(pad).toMatch(/action="\/signature"/);
    expect(pad).toMatch(/<input type="hidden" name="signature"/);
  });
});

describe('copy', () => {
  /** The misspellings of the legacy UI (BUGS.md B-75), each with the word the copy uses instead. */
  const LEGACY_MISSPELLINGS: readonly (readonly [RegExp, string])[] = [
    [/\bnonesense\b/i, 'nonsense'],
    [/\bhomapage\b/i, 'homepage'],
    [/\bdiffrent\b/i, 'different'],
    [/\badress\b/i, 'address'],
    [/\b(?:you|we|they) 're\b/i, "you're"],
    [/\ball supporter\b(?!s)/i, 'all supporters'],
  ];

  it.each(LEGACY_MISSPELLINGS)('F-77, B-75: no shipped source contains %s (the copy says "%s")', (pattern) => {
    expect(filesMatching(SOURCES, pattern)).toEqual([]);
  });

  it('F-77, B-75: the product name and the supporters link are spelled as in FEATURES.md', () => {
    expect(read('src/views/layouts/main.hbs')).toContain('· Nonsense Petition</title>');
    expect(read('src/views/pages/supporters/city.hbs')).toContain('>all supporters</a>');
  });
});

describe('naming', () => {
  it('B-53: the tables are users, signatures and profiles; the hash column is password_hash, not password', () => {
    const migrations = listFiles('drizzle', ['.sql']).map(read).join('\n');
    const tables = [...migrations.matchAll(/CREATE TABLE "([^"]+)"/g)].map((match) => match[1]).sort();
    expect(tables).toEqual(['profiles', 'signatures', 'users']);
    expect(migrations).toMatch(/"password_hash" text NOT NULL/);
    expect(migrations).not.toMatch(/"password" /);
    expect(migrations).toMatch(/"homepage_url" text/);
  });

  it('B-53: one field name per concept: both profile forms call the homepage field "homepage"', () => {
    for (const view of ['src/views/pages/profile/onboarding.hbs', 'src/views/pages/profile/edit.hbs']) {
      expect(read(view), view).toMatch(/name="homepage"/);
      expect(read(view), view).not.toMatch(/name="url"/);
    }
  });
});
