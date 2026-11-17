import { randomUUID } from 'node:crypto';

import type { Express } from 'express';
import { pino, type Logger } from 'pino';
import { inject } from 'vitest';

import { createApp, createAppCsrf } from '../src/app.js';
import { isHttps, loadEnv } from '../src/config/env.js';
import { resolvePaths, type AppPaths } from '../src/config/paths.js';
import { createDatabase, type Database } from '../src/db/client.js';
import { createViewerRepository } from '../src/features/auth/index.js';
import type { SignatureImages } from '../src/features/signature/index.js';
import { createTimingDummy, type PasswordHasher } from '../src/shared/auth/password.js';
import { createRedisClient, type RedisClient } from '../src/shared/redis/redis.js';
import { deriveEmailKeySecret } from '../src/shared/security/rate-limit-keys.js';
import { createRateLimiters, redisRateLimitStores, type RateLimitConfig } from '../src/shared/security/security.js';
import { createSessionMiddleware, sessionPolicyFromEnv, type SessionPolicy } from '../src/shared/security/session.js';
import { createAssetResolver } from '../src/shared/view/assets.js';
import { currentDatabaseUrl } from './database.js';
import { createFakeHasher, createFakeSignatureImages } from './fakes.js';
import { createTestRoutes } from './test-routes.js';

/** Every limit of a test app unless overridden: high enough that no ordinary test ever sees a 429 (ADR 0012). */
const TEST_LIMIT = 10_000;

export interface TestAppOverrides {
  /** Default 10,000 everywhere; the two limiter test files pass `productionRateLimits` (ADR 0012). */
  rateLimits?: Partial<RateLimitConfig>;
  /** `idleMs`, `absoluteMs` and a fake clock `now` (ADR 0002). */
  sessionPolicy?: Partial<SessionPolicy>;
  /** Replaces the supporters count in the signature module (phase-2a signature tests, ADR 0006). */
  countSupporters?: () => Promise<number>;
  /** `TRUST_PROXY`; only the limiter tests set 1, to vary the client IP with `X-Forwarded-For`. Default 0. */
  trustProxy?: number;
  /** Default: a fresh `createFakeHasher()`. Pass the real `createHasher()` (and real hashes) where argon2 matters. */
  hasher?: PasswordHasher;
  /**
   * Default: `createFakeSignatureImages()`. Tests of the real ADR 0004/0005 pipeline pass
   * `createSignatureImages({ fontPaths: testSignatureFontPaths() })`.
   */
  signatureImages?: SignatureImages;
  /**
   * Further environment keys as raw strings, validated by `loadEnv` like the real environment, e.g. `COOKIE_SECURE`,
   * `IMPRINT_URL`, `NODE_ENV`. `DATABASE_URL`, `REDIS_URL`, `TRUST_PROXY` and the secrets are always the harness's.
   */
  env?: Readonly<Record<string, string>>;
  /** Default: a silent logger. Pass one with a destination to assert on log lines (B-58, ADR 0012). */
  logger?: Logger;
  /**
   * Default `resolvePaths('development')`. A test that serves generated assets of its own passes these paths with
   * `builtPublicDir` pointing at a temporary folder; `mode` stays `'development'` (plain asset paths, no manifest).
   */
  paths?: AppPaths;
  /**
   * Default `true`: mount the test-only routes (`test/test-routes.ts`). `false` builds the app like `server.ts`, without
   * `/__test/*`, to prove they exist only in the harness (F-07, ADR 0017).
   */
  testRoutes?: boolean;
}

export interface TestApp {
  app: Express;
  /** The test file's own database (ADR 0017). */
  db: Database;
  /** The run's shared Redis container; this app's keys live under `prefix`. */
  redis: RedisClient;
  /** `test-<uuid>`: sessions under `<prefix>:sess:<id>`, limiter counters under `<prefix>:rl:<limiter>:`. */
  prefix: string;
  /** Ends the pool and the Redis client (a test may have closed Redis already); the setup file drops the database. */
  close(): Promise<void>;
}

/**
 * The real app (every module, the full middleware order) on the test file's own database and the run's Redis
 * (ADR 0015, 0017, 0019 §5), with test limits, the test-only routes (`test/test-routes.ts`, unless
 * `testRoutes: false`) and fakes for the hasher and the signature images. Each call uses a fresh Redis prefix, so no
 * two apps share sessions or counters.
 *
 * Call it in `beforeAll`/`beforeEach`, never at module top level (`currentDatabaseUrl()` throws there), and `close()`
 * it in the matching `afterAll`/`afterEach`.
 */
export async function createTestApp(overrides: TestAppOverrides = {}): Promise<TestApp> {
  const env = loadEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...overrides.env,
    TRUST_PROXY: String(overrides.trustProxy ?? 0),
    DATABASE_URL: currentDatabaseUrl(),
    REDIS_URL: inject('redisUrl'),
    SESSION_SECRET: 'test-session-secret-with-at-least-32-chars',
    CSRF_SECRET: 'test-csrf-secret-with-at-least-32-characters',
  });
  const logger = overrides.logger ?? pino({ level: 'silent' });
  // Plain asset paths whatever NODE_ENV says: the views, static folders and resolver all follow this one mode.
  const paths = overrides.paths ?? resolvePaths('development');
  const prefix = `test-${randomUUID()}`;
  // The env defaults of OVERVIEW.md section 16 (120 minutes idle, 168 hours absolute) with the real clock.
  const sessionPolicy: SessionPolicy = { ...sessionPolicyFromEnv(env), ...overrides.sessionPolicy };
  const rateLimitConfig: RateLimitConfig = {
    globalPerMinute: TEST_LIMIT,
    authPer15Min: TEST_LIMIT,
    loginEmailPerHour: TEST_LIMIT,
    reauthPer15Min: TEST_LIMIT,
    signPerHour: TEST_LIMIT,
    ...overrides.rateLimits,
  };
  const hasher = overrides.hasher ?? createFakeHasher();

  const database = createDatabase(env.DATABASE_URL, { logger });
  const redis = createRedisClient({ url: env.REDIS_URL, logger });
  const close = async (): Promise<void> => {
    await Promise.all([database.close(), redis.isOpen ? redis.close() : Promise.resolve()]);
  };

  try {
    await redis.connect();
    const rateLimits = createRateLimiters({
      config: rateLimitConfig,
      stores: redisRateLimitStores(redis, prefix),
      emailKeySecret: deriveEmailKeySecret(env.SESSION_SECRET),
      logger,
    });

    const app = createApp({
      env,
      logger,
      paths,
      assets: createAssetResolver({ mode: paths.mode }),
      db: database.db,
      session: createSessionMiddleware({
        redis,
        secrets: env.SESSION_SECRET,
        secure: isHttps(env),
        prefix,
        policy: sessionPolicy,
      }),
      sessionPolicy,
      hasher,
      timingDummyHash: await createTimingDummy(hasher),
      rateLimits,
      signatureImages: overrides.signatureImages ?? createFakeSignatureImages(),
      readiness: {
        database: () => database.ping(),
        redis: () => Promise.resolve(redis.isReady),
      },
      isShuttingDown: () => false,
      countSupporters: overrides.countSupporters,
      ...(overrides.testRoutes === false
        ? {}
        : {
            testRoutes: createTestRoutes({
              findViewer: createViewerRepository(database.db).findViewer,
              sessionPolicy,
              rateLimits,
              csrf: createAppCsrf(env),
            }),
          }),
    });

    return { app, db: database.db, redis, prefix, close };
  } catch (error) {
    await close();
    throw error;
  }
}
