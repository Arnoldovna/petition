import { describe, expect, it } from 'vitest';

import { isHttps, loadEnv } from '../env.js';

const SESSION_SECRET = 'session-secret-value-that-is-long-enough-1';
const CSRF_SECRET = 'csrf-secret-value-that-is-long-enough-12345';

/** The required keys; everything else has a default (OVERVIEW.md section 16). */
const REQUIRED = {
  DATABASE_URL: 'postgres://petition:local-only@127.0.0.1:5432/petition',
  REDIS_URL: 'redis://127.0.0.1:6379',
  SESSION_SECRET,
  CSRF_SECRET,
} as const;

const withEnv = (overrides: Record<string, string | undefined>) => loadEnv({ ...REQUIRED, ...overrides });

/** The error message of an invalid configuration (loadEnv throws). */
function failure(source: Record<string, string | undefined>): string {
  try {
    loadEnv(source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('expected loadEnv to throw');
}

describe('loadEnv', () => {
  it('F-72: applies the documented defaults when only the required keys are set', () => {
    const env = loadEnv(REQUIRED);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      TRUST_PROXY: 0,
      SESSION_IDLE_MINUTES: 120,
      SESSION_ABSOLUTE_HOURS: 168,
      RATE_LIMIT_GLOBAL_MAX: 300,
      RATE_LIMIT_AUTH_MAX: 10,
      CONTACT_URL: 'https://github.com/Arnoldovna',
      APP_TIME_ZONE: 'Europe/Berlin',
    });
    expect(env.COOKIE_SECURE).toBeUndefined();
    expect(env.IMPRINT_URL).toBeUndefined();
  });

  it('F-72: coerces numbers and booleans from their string form', () => {
    const env = withEnv({ PORT: '8080', TRUST_PROXY: '1', COOKIE_SECURE: 'true', RATE_LIMIT_GLOBAL_MAX: '100000' });

    expect(env).toMatchObject({ PORT: 8080, TRUST_PROXY: 1, COOKIE_SECURE: true, RATE_LIMIT_GLOBAL_MAX: 100_000 });
  });

  it('F-72, B-57: refuses to start when a required key is missing and names every missing key', () => {
    const message = failure({});

    for (const key of Object.keys(REQUIRED)) expect(message).toContain(`${key}: is required`);
  });

  it('F-72: treats an empty value as unset (an empty secret is missing, an empty IMPRINT_URL means no link)', () => {
    expect(failure({ ...REQUIRED, SESSION_SECRET: '' })).toContain('SESSION_SECRET: is required');
    expect(withEnv({ IMPRINT_URL: '' }).IMPRINT_URL).toBeUndefined();
  });

  it('B-03: rejects session and CSRF secrets shorter than 32 characters, every entry of the rotation list', () => {
    expect(failure({ ...REQUIRED, SESSION_SECRET: 'short' })).toContain('SESSION_SECRET');
    expect(failure({ ...REQUIRED, SESSION_SECRET: `${SESSION_SECRET}, short` })).toContain('SESSION_SECRET');
    expect(failure({ ...REQUIRED, CSRF_SECRET: 'x'.repeat(31) })).toContain('CSRF_SECRET');
  });

  it('B-03: reads SESSION_SECRET as a trimmed, comma-separated rotation list whose first entry signs', () => {
    const previous = 'previous-session-secret-still-valid-123';

    expect(withEnv({ SESSION_SECRET: ` ${SESSION_SECRET} , ${previous} ,` }).SESSION_SECRET).toEqual([
      SESSION_SECRET,
      previous,
    ]);
  });

  it('F-72, B-03: never puts a value into the error message, only keys and rules', () => {
    const secret = 'leaked-but-too-short';
    const message = failure({
      DATABASE_URL: 'mysql://user:hunter2@db/petition',
      REDIS_URL: 'http://cache.internal:6379',
      SESSION_SECRET: secret,
      CSRF_SECRET: secret,
      PORT: 'not-a-port',
      NODE_ENV: 'staging',
    });

    for (const value of [secret, 'hunter2', 'mysql://', 'cache.internal', 'not-a-port', 'staging']) {
      expect(message).not.toContain(value);
    }
    for (const key of ['DATABASE_URL', 'REDIS_URL', 'SESSION_SECRET', 'CSRF_SECRET', 'PORT', 'NODE_ENV']) {
      expect(message).toContain(key);
    }
  });

  it.each([
    ['DATABASE_URL', 'mysql://user@127.0.0.1/petition'],
    ['REDIS_URL', 'http://127.0.0.1:6379'],
    ['CONTACT_URL', 'http://github.com/Arnoldovna'],
    ['IMPRINT_URL', 'javascript:alert(1)'],
    ['APP_TIME_ZONE', 'Mars/Olympus_Mons'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['COOKIE_SECURE', 'maybe'],
  ])('F-72: rejects an invalid %s', (key, value) => {
    expect(failure({ ...REQUIRED, [key]: value })).toContain(`${key}:`);
  });

  it.each([
    ['PORT', '0'],
    ['PORT', '65536'],
    ['TRUST_PROXY', '6'],
    ['SESSION_IDLE_MINUTES', '4'],
    ['SESSION_IDLE_MINUTES', '1441'],
    ['SESSION_ABSOLUTE_HOURS', '721'],
    ['RATE_LIMIT_GLOBAL_MAX', '0'],
    ['RATE_LIMIT_AUTH_MAX', '100001'],
    ['PORT', '3000.5'],
  ])('F-72: rejects %s=%s outside its documented range', (key, value) => {
    expect(failure({ ...REQUIRED, [key]: value })).toContain(`${key}:`);
  });

  it('F-72: accepts the alternative URL schemes and an https imprint link', () => {
    const env = withEnv({
      DATABASE_URL: 'postgresql://petition:local-only@postgres:5432/petition',
      REDIS_URL: 'rediss://cache.example:6380',
      IMPRINT_URL: 'https://maw.example/imprint',
      APP_TIME_ZONE: 'America/New_York',
    });

    expect(env.IMPRINT_URL).toBe('https://maw.example/imprint');
    expect(env.APP_TIME_ZONE).toBe('America/New_York');
  });
});

describe('isHttps', () => {
  it('F-71: defaults to true in production and false elsewhere', () => {
    expect(isHttps({ NODE_ENV: 'production', COOKIE_SECURE: undefined })).toBe(true);
    expect(isHttps({ NODE_ENV: 'development', COOKIE_SECURE: undefined })).toBe(false);
    expect(isHttps({ NODE_ENV: 'test', COOKIE_SECURE: undefined })).toBe(false);
  });

  it('F-71: COOKIE_SECURE overrides NODE_ENV in both directions (the local production stack runs over http)', () => {
    expect(isHttps({ NODE_ENV: 'production', COOKIE_SECURE: false })).toBe(false);
    expect(isHttps({ NODE_ENV: 'development', COOKIE_SECURE: true })).toBe(true);
  });
});
