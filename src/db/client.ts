import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from 'pino';

import * as schema from './schema/index.js';

/** The Drizzle handle repositories receive (DATA-MODEL.md section 4). Rows never leave the repository layer. */
export type Database = NodePgDatabase<typeof schema>;

/**
 * The `tx` of `db.transaction(async (tx) => ...)`. Repository functions that must join a caller's transaction (auth's
 * `credentials.apply`, the profile update, ADR 0009) take this type.
 */
export type DatabaseTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export interface DatabaseHandle {
  db: Database;
  /** Readiness probe (`select 1`); never throws. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

interface DatabaseOptions {
  /** Receives errors of idle pooled connections (database restart, network cut). */
  logger?: Pick<Logger, 'error'>;
}

/** One pool per process, created only by the composition root, migrate.ts, tools and the test harness. */
export function createDatabase(url: string, { logger }: DatabaseOptions = {}): DatabaseHandle {
  const pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    // pg waits forever for a new connection by default: an unreachable database (dropped packets) would hang every
    // query, ping() included, instead of failing.
    connectionTimeoutMillis: 5_000,
  });
  // An idle client that loses its connection makes the pool emit 'error'. Without a listener Node treats it as an
  // unhandled 'error' event and ends the process; with one, pg discards the broken client and the next query opens a
  // new connection, so a database restart only fails readiness for a moment.
  pool.on('error', (error) => {
    logger?.error({ err: error }, 'database connection error');
  });
  // `casing` must match drizzle.config.ts: camelCase keys in TypeScript, snake_case columns in SQL.
  const db = drizzle({ client: pool, schema, casing: 'snake_case' });
  return {
    db,
    async ping() {
      try {
        await pool.query('select 1');
        return true;
      } catch {
        return false;
      }
    },
    close: () => pool.end(),
  };
}
