import type { Logger } from 'pino';

import type { AppDeps } from './app.js';
import { APP_SLUG } from './config/app.js';
import { isHttps, type Env } from './config/env.js';
import { assetMode, resolvePaths } from './config/paths.js';
import { createDatabase } from './db/client.js';
import { createSignatureImages, signatureFontPaths } from './features/signature/index.js';
import { createHasher, createTimingDummy } from './shared/auth/password.js';
import { createRedisClient } from './shared/redis/redis.js';
import { deriveEmailKeySecret } from './shared/security/rate-limit-keys.js';
import {
  createRateLimiters,
  rateLimitsFromEnv,
  redisRateLimitStores,
  warnAboutRelaxedRateLimits,
} from './shared/security/security.js';
import { createSessionMiddleware, sessionPolicyFromEnv } from './shared/security/session.js';
import { createAssetResolver } from './shared/view/assets.js';

/** What the container builds; `server.ts` adds `isShuttingDown`, which only the server knows. */
type ContainerDeps = Omit<AppDeps, 'isShuttingDown' | 'testRoutes' | 'countSupporters'>;

export interface Container {
  deps: ContainerDeps;
  /** Closes the pool and the Redis client; safe to call once at shutdown. */
  dispose(): Promise<void>;
}

/**
 * Composition root: the only place that opens connections. Everything else receives its dependencies as arguments,
 * so there are no module-level singletons. Every Redis key of the app lives under `APP_SLUG` (`petition:sess:`,
 * `petition:rl:<limiter>:`, conventions §8), the shape `test/test-app.ts` repeats with a fresh `test-<uuid>` prefix.
 *
 * Startup fails fast, before any connection is opened, when the asset manifest or a signature font is missing or the
 * rate-limit secret cannot be derived; and before the app listens when Redis is unreachable.
 */
export async function createContainer(env: Env, logger: Logger): Promise<Container> {
  // The asset mode is decided once, here; the app gets the paths and the resolver of that one mode.
  const paths = resolvePaths(assetMode(env.NODE_ENV));
  // Fails fast in production when the asset manifest is incomplete (ADR 0010).
  const assets = createAssetResolver({ mode: paths.mode, manifestPath: paths.manifestPath });
  // Registers the server-side signature fonts once per process; throws when one cannot be registered (ADR 0005).
  const signatureImages = createSignatureImages({ fontPaths: signatureFontPaths(paths.signatureFontsDir) });
  const emailKeySecret = deriveEmailKeySecret(env.SESSION_SECRET);
  const rateLimitConfig = rateLimitsFromEnv(env);
  warnAboutRelaxedRateLimits(rateLimitConfig, logger);
  const sessionPolicy = sessionPolicyFromEnv(env);

  const database = createDatabase(env.DATABASE_URL, { logger });
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  const dispose = async (): Promise<void> => {
    await Promise.allSettled([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
  };

  try {
    // Rejects after a few retries when Redis is unreachable, so startup fails with exit 1 (redis.ts).
    await redis.connect();
    const hasher = createHasher();
    // One argon2id hash at startup: the dummy that login verifies against for unknown emails (F-24, B-23).
    const timingDummyHash = await createTimingDummy(hasher);

    return {
      deps: {
        env,
        logger,
        paths,
        assets,
        db: database.db,
        session: createSessionMiddleware({
          redis,
          secrets: env.SESSION_SECRET,
          secure: isHttps(env),
          prefix: APP_SLUG,
          policy: sessionPolicy,
        }),
        sessionPolicy,
        hasher,
        timingDummyHash,
        rateLimits: createRateLimiters({
          config: rateLimitConfig,
          stores: redisRateLimitStores(redis, APP_SLUG),
          emailKeySecret,
          logger,
        }),
        signatureImages,
        readiness: {
          database: () => database.ping(),
          redis: () => Promise.resolve(redis.isReady),
        },
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
