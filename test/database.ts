/**
 * The current test file's own database (conventions §7, ADR 0017, ADR 0019 §5). test/setup-database.ts sets it in
 * its `beforeAll` and clears it in its `afterAll`; everything that connects (createTestApp, factories) reads it from
 * here.
 */
let current: string | undefined;

/** The same server as `url`, another database. */
export function databaseUrl(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${encodeURIComponent(database)}`;
  return parsed.toString();
}

export function setCurrentDatabaseUrl(url: string | undefined): void {
  current = url;
}

/**
 * Throws outside a test or hook: at module top level the file's database does not exist yet. Create test apps in
 * `beforeAll`/`beforeEach`, never while the file is being collected.
 */
export function currentDatabaseUrl(): string {
  if (current === undefined) {
    throw new Error(
      'currentDatabaseUrl() was called outside a test or hook. Create the test app in beforeAll/beforeEach; ' +
        'the per-file database only exists while the file runs (test/setup-database.ts).',
    );
  }
  return current;
}
