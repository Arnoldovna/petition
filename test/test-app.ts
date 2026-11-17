import { randomUUID } from 'node:crypto';

import { pino } from 'pino';
import { inject } from 'vitest';

import { createApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { resolvePaths } from '../src/config/paths.js';
import { createDatabase } from '../src/db/client.js';
import { createRedisClient } from '../src/shared/redis/redis.js';
import { createAssetResolver } from '../src/shared/view/assets.js';
import { currentDatabaseUrl } from './database.js';

/**
 * The real app on the file's own database and the run's Redis (ADR 0017), with a silent logger and plain asset
 * paths. Phase-1a minimal version: phase 1b adds `overrides` (rate limits, session policy, fakes, trust proxy),
 * sessions under `<prefix>:sess:` and the test-only sign-in router.
 *
 * Call it in `beforeAll`/`beforeEach`, never at module top level (currentDatabaseUrl() throws there), and `close()`
 * it in the matching `afterAll`/`afterEach`.
 */
export async function createTestApp() {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: currentDatabaseUrl(),
    REDIS_URL: inject('redisUrl'),
    SESSION_SECRET: 'test-session-secret-with-at-least-32-chars',
    CSRF_SECRET: 'test-csrf-secret-with-at-least-32-characters',
  });
  const logger = pino({ level: 'silent' });
  // Plain asset paths whatever NODE_ENV says: the views, static folders and resolver all follow this one mode.
  const paths = resolvePaths('development');
  const database = createDatabase(env.DATABASE_URL);
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  try {
    await redis.connect();
  } catch (error) {
    await database.close();
    throw error;
  }
  // Redis is shared by every file of the run: anything this app keys in Redis goes under its own prefix.
  const prefix = `test-${randomUUID()}`;

  const app = createApp({
    env,
    logger,
    paths,
    assets: createAssetResolver({ mode: paths.mode }),
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady),
    },
    isShuttingDown: () => false,
  });

  return {
    app,
    db: database.db,
    redis,
    prefix,
    /** Ends the pool and the Redis client (a test may have closed Redis already); the setup file drops the database. */
    async close(): Promise<void> {
      await Promise.all([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
    },
  };
}
