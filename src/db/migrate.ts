import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase } from './client.js';

/** drizzle/ at the repository root, from src/db (tsx) and from dist/db (image) alike. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/**
 * Applies the committed SQL migrations. Used by `pnpm db:migrate`, the one-shot compose `migrate` service and the
 * integration-test global setup (template database). With an empty journal this is a verified no-op (phase 1a).
 */
export async function runMigrations(databaseUrl: string): Promise<void> {
  const handle = createDatabase(databaseUrl);
  try {
    await migrate(handle.db, { migrationsFolder: MIGRATIONS_FOLDER });
  } finally {
    await handle.close();
  }
}

if (import.meta.main) {
  // Tooling entry point: reads DATABASE_URL directly and never prints it (ADR 0011).
  const url = process.env['DATABASE_URL'];
  if (!url) {
    process.stderr.write('migrate: DATABASE_URL is required\n');
    process.exit(1);
  }
  try {
    await runMigrations(url);
    process.stdout.write('migrate: migrations applied\n');
  } catch (error) {
    process.stderr.write(`migrate: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
