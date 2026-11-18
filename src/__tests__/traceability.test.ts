import { describe, expect, it } from 'vitest';

import { listRepoFiles, readRepoFile as read } from '../../test/repo.js';

/**
 * The traceability check of BUILD-ORDER.md phase 5e, run on every `pnpm test` instead of once by hand (rule 9,
 * ADR 0019 section 10, conventions §11):
 *
 * - every FEATURES.md and BUGS.md id appears in a test title, or OVERVIEW.md section 21 names how it is verified;
 * - every BUGS.md id has a row in section 21 and every FEATURES.md id a row in the test strategy of section 17;
 * - a test title that names ids starts with them, and names only ids that exist.
 *
 * Titles are the first string argument of `describe`, `it` and `test` (with modifiers such as `.each(...)`,
 * `.describe`, `.step`) in every test location of the repository: src, test, e2e and scripts/__tests__.
 */

const ID = /\b[FB]-\d{2}\b/g;
const HAS_ID = /\b[FB]-\d{2}\b/;
/** Rule 9: a title that covers ids starts with them (`F-24, B-09: ...`); other references may follow the ids. */
const ID_PREFIX = /^[FB]-\d{2}\b/;

const featureIds = [...read('docs/FEATURES.md').matchAll(/^- \*\*(F-\d{2})\*\*/gm)].map((match) => match[1] ?? '');
const bugIds = [...read('docs/BUGS.md').matchAll(/^### (B-\d{2}):/gm)].map((match) => match[1] ?? '');
const knownIds = new Set([...featureIds, ...bugIds]);

/** Expands `F-12 to F-16` and `F-08, F-09` into the single ids. */
function expandIds(text: string): string[] {
  const ids = new Set(text.match(ID) ?? []);
  for (const [, prefix, from, to] of text.matchAll(/\b([FB])-(\d{2}) to [FB]-(\d{2})\b/g)) {
    for (let n = Number(from); n <= Number(to); n += 1) ids.add(`${prefix ?? ''}-${String(n).padStart(2, '0')}`);
  }
  return [...ids];
}

const TEST_FILE = /(?:\/__tests__\/.*\.(?:ts|mjs)|\.test\.(?:ts|mjs)|\.spec\.ts)$/;

function testFiles(): string[] {
  return ['src', 'test', 'e2e', 'scripts']
    .flatMap((dir) => listRepoFiles(dir))
    .filter((file) => TEST_FILE.test(`/${file}`))
    .sort();
}

/**
 * `describe(`, `it.each([...])(`, `test.describe.serial(`, `await test.step(`: not `regex.test(`, whose receiver is
 * preceded by a dot. The title is the string literal that directly follows.
 */
const TITLE =
  /(?<![.\w])(?:describe|it|test)(?:\.\w+(?:\([^()]*\))?)*\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)/g;

interface Title {
  file: string;
  title: string;
}

const titles: Title[] = testFiles().flatMap((file) =>
  [...read(file).matchAll(TITLE)].map((match) => ({ file, title: match[1] ?? match[2] ?? match[3] ?? '' })),
);
/** A title may name a range (`F-67 to F-69: ...`) like a section 21 row does; it covers every id in it. */
const titleIds = new Set(titles.flatMap(({ title }) => expandIds(title)));

/** The first table of an OVERVIEW.md section, as rows of trimmed cells (header and separator dropped). */
function sectionTable(heading: string): string[][] {
  const overview = read('docs/architecture/OVERVIEW.md');
  const start = overview.indexOf(`\n## ${heading}`);
  if (start < 0) throw new Error(`OVERVIEW.md has no section "${heading}"`);
  const end = overview.indexOf('\n## ', start + 1);
  return overview
    .slice(start, end < 0 ? undefined : end)
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2)
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((cell) => cell.trim()),
    );
}

/** Section 21: id -> "Verified by" (the last column). */
const verifiedOtherwise = new Map(
  sectionTable('21. BUGS traceability').flatMap((cells) => {
    const verifiedBy = cells.at(-1) ?? '';
    return expandIds(cells[0] ?? '').map((id) => [id, verifiedBy] as const);
  }),
);
const strategyIds = new Set(sectionTable('17. Test strategy').flatMap((cells) => expandIds(cells[0] ?? '')));

describe('traceability (BUILD-ORDER phase 5e)', () => {
  it('reads every requirement and finds the test titles', () => {
    expect(featureIds).toHaveLength(91);
    expect(bugIds).toHaveLength(83);
    expect(new Set(featureIds).size).toBe(featureIds.length);
    expect(new Set(bugIds).size).toBe(bugIds.length);
    // Every test location is scanned: a unit test, an integration test, an e2e spec and a script test.
    const files = new Set(titles.map(({ file }) => file));
    for (const file of [
      'src/__tests__/traceability.test.ts',
      'src/__tests__/route-matrix.int.test.ts',
      'e2e/journey-sign.spec.ts',
      'scripts/__tests__/check-views.test.mjs',
    ]) {
      expect(files, file).toContain(file);
    }
  });

  it('every FEATURES and BUGS id is in a test title or verified by the means OVERVIEW.md section 21 names', () => {
    const untraced = [...featureIds, ...bugIds].filter(
      (id) => !titleIds.has(id) && (verifiedOtherwise.get(id) ?? '') === '',
    );
    expect(untraced).toEqual([]);
  });

  it('every BUGS id has a resolution and a verification in OVERVIEW.md section 21', () => {
    expect(bugIds.filter((id) => (verifiedOtherwise.get(id) ?? '') === '')).toEqual([]);
  });

  it('every FEATURES id has a row in the test strategy of OVERVIEW.md section 17', () => {
    expect(featureIds.filter((id) => !strategyIds.has(id))).toEqual([]);
  });

  it('test titles name only ids that exist in FEATURES.md or BUGS.md', () => {
    const unknown = titles.flatMap(({ file, title }) =>
      expandIds(title)
        .filter((id) => !knownIds.has(id))
        .map((id) => `${file}: ${id} in "${title}"`),
    );
    expect(unknown).toEqual([]);
  });

  it('a test title that names ids starts with them (rule 9)', () => {
    const misplaced = titles
      .filter(({ title }) => HAS_ID.test(title) && !ID_PREFIX.test(title))
      .map(({ file, title }) => `${file}: "${title}"`);
    expect(misplaced).toEqual([]);
  });
});
