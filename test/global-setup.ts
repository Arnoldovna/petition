import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer } from '@testcontainers/redis';
import { Client, escapeIdentifier } from 'pg';
import type { TestProject } from 'vitest/node';

import { runMigrations } from '../src/db/migrate.js';
import { databaseUrl } from './database.js';
import { composeImages } from './images.js';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Admin connection to the container's maintenance database; only test/setup-database.ts uses it. */
    adminDatabaseUrl: string;
    /** The migrated template every test file clones its own database from. */
    templateDatabase: string;
    redisUrl: string;
  }
}

const TEMPLATE_DATABASE = 'petition_template';

/**
 * One Postgres and one Redis per integration run (conventions §7, ADR 0017), from the digest-pinned images in
 * docker-compose.yml. The migrations run once into `petition_template`; test/setup-database.ts then clones it for
 * every test file, so files run in parallel without sharing rows.
 */
export default async function setup(project: TestProject) {
  const images = composeImages();
  const [postgres, redis] = await Promise.all([
    new PostgreSqlContainer(images.postgres).start(),
    new RedisContainer(images.redis).start(),
  ]);
  const adminDatabaseUrl = postgres.getConnectionUri();

  const admin = new Client({ connectionString: adminDatabaseUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${escapeIdentifier(TEMPLATE_DATABASE)}`);
    await runMigrations(databaseUrl(adminDatabaseUrl, TEMPLATE_DATABASE));
    // CREATE DATABASE ... TEMPLATE fails while anyone is connected to the template. runMigrations has closed its
    // pool; this ends anything that might still linger.
    await admin.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [TEMPLATE_DATABASE],
    );
  } finally {
    await admin.end();
  }

  project.provide('adminDatabaseUrl', adminDatabaseUrl);
  project.provide('templateDatabase', TEMPLATE_DATABASE);
  project.provide('redisUrl', redis.getConnectionUrl());

  return async () => {
    await Promise.all([postgres.stop(), redis.stop()]);
  };
}
