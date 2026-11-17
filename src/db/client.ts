import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

import * as schema from './schema/index.js';

type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  /** Readiness probe (`select 1`); never throws. */
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

/** One pool per process, created only by the composition root, migrate.ts, tools and the test harness. */
export function createDatabase(url: string): DatabaseHandle {
  const pool = new Pool({
    connectionString: url,
    max: 10,
    idleTimeoutMillis: 30_000,
    // pg waits forever for a new connection by default: an unreachable database (dropped packets) would hang every
    // query, ping() included, instead of failing.
    connectionTimeoutMillis: 5_000,
  });
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
