import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { rateLimit, type Store, type ValueDeterminingMiddleware } from 'express-rate-limit';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { RedisStore, type RedisReply } from 'rate-limit-redis';

import type { Env } from '../../config/env.js';
import { TooManyRequestsError } from '../errors/app-error.js';
import type { RedisClient } from '../redis/redis.js';
import { keyByEmail, keyByEmailAndSubnet, keyByIp, keyByUser } from './rate-limit-keys.js';

const SELF = "'self'";
const NONE = "'none'";

/**
 * Security headers (ADR 0011, F-71, B-10). An explicit CSP instead of helmet's defaults: no inline scripts or styles,
 * no third-party origins (F-86), forms only post to the app, no framing.
 *
 * `https` is `isHttps(env)`: HSTS and `upgrade-insecure-requests` are sent only when the app is served over https.
 * Otherwise WebKit applies UIR to 127.0.0.1 and the local production stack loses its styles.
 */
export function securityHeaders({ https }: { https: boolean }): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: [SELF],
        scriptSrc: [SELF],
        styleSrc: [SELF],
        imgSrc: [SELF],
        fontSrc: [SELF],
        connectSrc: [SELF],
        formAction: [SELF],
        frameAncestors: [NONE],
        baseUri: [NONE],
        objectSrc: [NONE],
        manifestSrc: [SELF],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: https,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Rate limits (ADR 0012, F-26, B-10)
// ---------------------------------------------------------------------------------------------------------------

/** The maxima of every limiter. Windows are fixed in code; only the maxima are configurable. */
export interface RateLimitConfig {
  /** `RATE_LIMIT_GLOBAL_MAX`, per minute. */
  globalPerMinute: number;
  /** `RATE_LIMIT_AUTH_MAX`, per 15 minutes: auth-ip, register-email, login-email-subnet. */
  authPer15Min: number;
  /** Ten times `authPer15Min`, per hour: login-email. */
  loginEmailPerHour: number;
  /** Fixed: re-authentication (profile email or password change, account delete), per 15 minutes. */
  reauthPer15Min: number;
  /** Fixed: signature submissions, per hour. */
  signPerHour: number;
}

const DEFAULT_GLOBAL_PER_MINUTE = 300;
const DEFAULT_AUTH_PER_15_MIN = 10;
const LOGIN_EMAIL_FACTOR = 10;

function configFromMaxima(globalPerMinute: number, authPer15Min: number): RateLimitConfig {
  return {
    globalPerMinute,
    authPer15Min,
    loginEmailPerHour: LOGIN_EMAIL_FACTOR * authPer15Min,
    reauthPer15Min: 5,
    signPerHour: 20,
  };
}

/**
 * The production limits, also what the two limiter test files pass to `createTestApp` (every other test app raises
 * all limits, conventions §7).
 */
export const productionRateLimits: Readonly<RateLimitConfig> = Object.freeze(
  configFromMaxima(DEFAULT_GLOBAL_PER_MINUTE, DEFAULT_AUTH_PER_15_MIN),
);

/** `RATE_LIMIT_GLOBAL_MAX` and `RATE_LIMIT_AUTH_MAX` (OVERVIEW.md section 16); the rest is derived or fixed. */
export function rateLimitsFromEnv(env: Pick<Env, 'RATE_LIMIT_GLOBAL_MAX' | 'RATE_LIMIT_AUTH_MAX'>): RateLimitConfig {
  return configFromMaxima(env.RATE_LIMIT_GLOBAL_MAX, env.RATE_LIMIT_AUTH_MAX);
}

/**
 * Logs one `rate_limit.relaxed` warning per configurable maximum above its production default, so a deployment that
 * kept the raised e2e limits is visible at startup (ADR 0012). Called once by the composition root.
 */
export function warnAboutRelaxedRateLimits(config: RateLimitConfig, logger: Pick<Logger, 'warn'>): void {
  const relaxed = [
    { limiter: 'global', max: config.globalPerMinute, standard: productionRateLimits.globalPerMinute },
    { limiter: 'auth', max: config.authPer15Min, standard: productionRateLimits.authPer15Min },
  ].filter(({ max, standard }) => max > standard);
  for (const { limiter, max } of relaxed) logger.warn({ limiter, max }, 'rate_limit.relaxed');
}

const MINUTE_MS = 60_000;
const QUARTER_HOUR_MS = 15 * MINUTE_MS;
const HOUR_MS = 60 * MINUTE_MS;

type KeyGenerator = ValueDeterminingMiddleware<string>;

/** One row of the limiter table in ADR 0012. */
interface LimiterSpec {
  windowMs: number;
  max: (config: RateLimitConfig) => number;
  key: (emailKeySecret: Buffer) => KeyGenerator;
  /** Count only failed responses (status >= 400): a successful login never uses up its owner's budget. */
  failedOnly: boolean;
}

const byIp = (): KeyGenerator => keyByIp;
const byUser = (): KeyGenerator => keyByUser;

const LIMITERS = {
  global: { windowMs: MINUTE_MS, max: (c) => c.globalPerMinute, key: byIp, failedOnly: false },
  'auth-ip': { windowMs: QUARTER_HOUR_MS, max: (c) => c.authPer15Min, key: byIp, failedOnly: false },
  'register-email': { windowMs: QUARTER_HOUR_MS, max: (c) => c.authPer15Min, key: keyByEmail, failedOnly: false },
  'login-email-subnet': {
    windowMs: QUARTER_HOUR_MS,
    max: (c) => c.authPer15Min,
    key: keyByEmailAndSubnet,
    failedOnly: true,
  },
  'login-email': { windowMs: HOUR_MS, max: (c) => c.loginEmailPerHour, key: keyByEmail, failedOnly: true },
  reauth: { windowMs: QUARTER_HOUR_MS, max: (c) => c.reauthPer15Min, key: byUser, failedOnly: false },
  sign: { windowMs: HOUR_MS, max: (c) => c.signPerHour, key: byUser, failedOnly: false },
} as const satisfies Record<string, LimiterSpec>;

type LimiterName = keyof typeof LIMITERS;

/** Each limiter needs its own store instance with its own key prefix (express-rate-limit `ERR_ERL_STORE_REUSE`). */
export type RateLimitStoreFactory = (limiter: string) => Store;

/**
 * Redis-backed counters under `<prefix>:rl:<limiter>:` (`petition:rl:auth-ip:` in production, `test-<uuid>:rl:...` in
 * tests), so limits hold across restarts and instances. The client must be connected before the first request.
 */
export function redisRateLimitStores(redis: RedisClient, prefix: string): RateLimitStoreFactory {
  return (limiter) =>
    new RedisStore({
      prefix: `${prefix}:rl:${limiter}:`,
      sendCommand: (...args: string[]) => redis.sendCommand<RedisReply>(args),
    });
}

interface RateLimiterOptions {
  /** Shown in `RateLimit-Policy` and logged as `rate_limit.hit {limiter}`. */
  name: string;
  windowMs: number;
  limit: number;
  keyGenerator: KeyGenerator;
  store: Store;
  /** Receives express-rate-limit's configuration warnings (`ERR_ERL_*`) instead of the console (B-58). */
  logger: Pick<Logger, 'warn' | 'error'>;
  skipSuccessfulRequests?: boolean;
}

/**
 * One express-rate-limit 8 instance with the conventions of ADR 0012: an explicit key generator (never
 * `ipv6Subnet`), IETF draft-8 headers, no legacy headers, and the rejection routed to the error handler as
 * `TooManyRequestsError`, which renders the 429 page (or problem+json). express-rate-limit has already set
 * `Retry-After` from the window when the handler runs. Create limiters at startup, never inside a request.
 */
export function rateLimiter({
  name,
  windowMs,
  limit,
  keyGenerator,
  store,
  logger,
  skipSuccessfulRequests = false,
}: RateLimiterOptions): RequestHandler {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator,
    store,
    skipSuccessfulRequests,
    identifier: name,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    logger: {
      warn: (error, message) => {
        logger.warn({ err: error, limiter: name }, message ?? 'rate_limit.config');
      },
      error: (error, message) => {
        logger.error({ err: error, limiter: name }, message ?? 'rate_limit.error');
      },
    },
    handler: (req, _res, next) => {
      req.log.warn({ limiter: name }, 'rate_limit.hit');
      next(new TooManyRequestsError());
    },
  });
}

/**
 * Applies a limiter from inside a handler, for a limit that covers only part of a route's work: the `reauth` limiter
 * on `POST /profile/edit` counts only the edits that check the current password (ADR 0012), which only the service
 * knows after reading the stored email. Resolves when the request may go on; rejects with what the limiter passes to
 * `next` (`TooManyRequestsError`, the 429 page with `Retry-After`, or a store failure).
 */
export function applyLimiter(limiter: RequestHandler, req: Request, res: Response): Promise<void> {
  return new Promise((resolve, reject) => {
    const next: NextFunction = (error?: unknown) => {
      if (error === undefined || error === null) resolve();
      else reject(error instanceof Error ? error : new Error('rate limiter failed', { cause: error }));
    };
    // express-rate-limit reports its own failures through `next`; a rejection would be a bug in it, not lost either.
    Promise.resolve(limiter(req, res, next)).catch(reject);
  });
}

/** Every limiter of ADR 0012, ready to mount: `global` in `app.ts`, the others on the feature routes. */
export type RateLimiters = Readonly<Record<LimiterName, RequestHandler>>;

interface RateLimitersOptions {
  config: RateLimitConfig;
  stores: RateLimitStoreFactory;
  /** `deriveEmailKeySecret(env.SESSION_SECRET)` (rate-limit-keys.ts). */
  emailKeySecret: Buffer;
  logger: Pick<Logger, 'warn' | 'error'>;
}

/** Builds all seven limiters once per app, each with its own store and prefix. */
export function createRateLimiters({ config, stores, emailKeySecret, logger }: RateLimitersOptions): RateLimiters {
  const limiter = (name: LimiterName): RequestHandler => {
    const spec: LimiterSpec = LIMITERS[name];
    return rateLimiter({
      name,
      windowMs: spec.windowMs,
      limit: spec.max(config),
      keyGenerator: spec.key(emailKeySecret),
      store: stores(name),
      logger,
      skipSuccessfulRequests: spec.failedOnly,
    });
  };
  return Object.freeze({
    global: limiter('global'),
    'auth-ip': limiter('auth-ip'),
    'register-email': limiter('register-email'),
    'login-email-subnet': limiter('login-email-subnet'),
    'login-email': limiter('login-email'),
    reauth: limiter('reauth'),
    sign: limiter('sign'),
  });
}
