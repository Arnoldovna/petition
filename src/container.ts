import type { Logger } from 'pino';

import type { Env } from './config/env.js';
import { assetMode, resolvePaths } from './config/paths.js';
import { createDatabase } from './db/client.js';
import { createRedisClient } from './shared/redis/redis.js';
import { createAssetResolver } from './shared/view/assets.js';

/**
 * Composition root: the only place that opens connections. Everything else receives its dependencies as arguments,
 * so there are no module-level singletons. Phase 1b adds sessions, the bounded hasher, rate-limit stores, the
 * session policy and the signature images.
 */
export async function createContainer(env: Env, logger: Logger) {
  // The asset mode is decided once, here; the app gets the paths and the resolver of that one mode.
  const paths = resolvePaths(assetMode(env.NODE_ENV));
  // Fails fast in production when the asset manifest is missing (ADR 0010), before any connection is opened.
  const assets = createAssetResolver({ mode: paths.mode, manifestPath: paths.manifestPath });

  const database = createDatabase(env.DATABASE_URL);
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  try {
    // Rejects after a few retries when Redis is unreachable, so startup fails fast with exit 1 (redis.ts).
    await redis.connect();
  } catch (error) {
    await database.close();
    throw error;
  }

  return {
    db: database.db,
    redis,
    paths,
    assets,
    readiness: {
      database: () => database.ping(),
      redis: () => Promise.resolve(redis.isReady),
    },
    async dispose(): Promise<void> {
      await Promise.allSettled([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
    },
  };
}
