import { randomUUID } from 'node:crypto';

import { Client, escapeIdentifier } from 'pg';
import { afterAll, beforeAll, inject } from 'vitest';

import { databaseUrl, setCurrentDatabaseUrl } from './database.js';

/**
 * Integration `setupFiles` entry: every test file gets its own empty, migrated database cloned from the template
 * (conventions §7, ADR 0017). Cloning a small template takes well under a second; there is no truncate helper.
 *
 * Vitest runs `afterAll` hooks in reverse order (`sequence.hooks: 'stack'`), so the drop below runs after the test
 * file's own `afterAll` has closed its pools; `WITH (FORCE)` ends any connection that is still open.
 */
const adminDatabaseUrl = inject('adminDatabaseUrl');
const database = `t_${randomUUID().replaceAll('-', '')}`;

async function asAdmin(sql: string): Promise<void> {
  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(sql);
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  const template = escapeIdentifier(inject('templateDatabase'));
  await asAdmin(`CREATE DATABASE ${escapeIdentifier(database)} TEMPLATE ${template}`);
  setCurrentDatabaseUrl(databaseUrl(adminDatabaseUrl, database));
});

afterAll(async () => {
  setCurrentDatabaseUrl(undefined);
  await asAdmin(`DROP DATABASE IF EXISTS ${escapeIdentifier(database)} WITH (FORCE)`);
});
