import { z } from 'zod';

/** A comma-separated list of secrets; the first one signs, the others still verify (rotation, ADR 0002). */
const secretList = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part.length > 0),
  )
  .pipe(
    z
      .array(z.string().min(32, 'every secret must be at least 32 characters'))
      .min(1, 'at least one secret is required'),
  );

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const integer = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

/** OVERVIEW.md section 16. Secrets have no defaults. */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: integer(1, 65_535, 3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  // Number of reverse proxies in front of the app (0 = none); decides the client IP for rate limits.
  TRUST_PROXY: integer(0, 5, 0),

  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' }),
  REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' }),

  // "Served over https": secure __Host- cookies, HSTS and upgrade-insecure-requests (ADR 0011). See isHttps().
  COOKIE_SECURE: z.stringbool().optional(),
  SESSION_SECRET: secretList,
  CSRF_SECRET: z.string().min(32, 'must be at least 32 characters'),
  SESSION_IDLE_MINUTES: integer(5, 1440, 120),
  SESSION_ABSOLUTE_HOURS: integer(1, 720, 168),

  RATE_LIMIT_GLOBAL_MAX: integer(1, 100_000, 300),
  RATE_LIMIT_AUTH_MAX: integer(1, 100_000, 10),

  CONTACT_URL: z
    .url({ protocol: /^https$/, error: 'must be an https:// URL' })
    .default('https://github.com/Arnoldovna'),
  IMPRINT_URL: z.url({ protocol: /^https$/, error: 'must be an https:// URL' }).optional(),
  APP_TIME_ZONE: z.string().refine(isTimeZone, 'must be an IANA time zone').default('Europe/Berlin'),
});

export type Env = z.infer<typeof EnvSchema>;

/**
 * The one "served over https" switch (ADR 0011): secure cookies with `__Host-` names, HSTS and
 * `upgrade-insecure-requests`. NODE_ENV alone never decides it; the local compose stack runs the production image
 * over plain http with COOKIE_SECURE=false.
 */
export function isHttps(env: Pick<Env, 'COOKIE_SECURE' | 'NODE_ENV'>): boolean {
  return env.COOKIE_SECURE ?? env.NODE_ENV === 'production';
}

/**
 * Parses and validates the configuration once at startup (F-72). This is the only reader of `process.env` in the
 * app; everything else receives the returned object or a slice of it through the composition root.
 *
 * Empty values count as unset, so `IMPRINT_URL=` in .env means "no imprint link" and `SESSION_SECRET=` is reported
 * as missing. The error lists the failing keys and rules only, never a value, so secrets cannot reach the logs.
 */
export function loadEnv(source: Readonly<Record<string, string | undefined>> = process.env): Env {
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = EnvSchema.safeParse(present);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.map(String).join('.') || '(root)';
      const missing = typeof issue.path[0] === 'string' && present[issue.path[0]] === undefined;
      return `  - ${key}: ${missing ? 'is required' : issue.message}`;
    });
    throw new Error(`Invalid environment configuration:\n${problems.join('\n')}`);
  }
  return result.data;
}
