import type { Request, Response } from 'express';
import { MemoryStore } from 'express-rate-limit';
import { describe, expect, it, vi } from 'vitest';

import type { Viewer } from '../../auth/viewer.js';
import {
  deriveEmailKeySecret,
  emailKey,
  keyByEmail,
  keyByEmailAndSubnet,
  keyByIp,
  keyByUser,
} from '../rate-limit-keys.js';
import {
  createRateLimiters,
  productionRateLimits,
  rateLimiter,
  rateLimitsFromEnv,
  warnAboutRelaxedRateLimits,
} from '../security.js';

const SESSION_SECRET = 'unit-test-session-secret-with-at-least-32-chars';
const secret = deriveEmailKeySecret([SESSION_SECRET]);

/** The (fields, message) call shape the limiters use on the injected pino logger. */
type LogFn = (fields: unknown, message?: string) => void;

/** The two request fields the key generators read. */
function requestFrom(ip: string | undefined, body?: unknown): Pick<Request, 'ip' | 'body'> {
  return { ip, body };
}

function responseFor(viewer?: Viewer): Pick<Response, 'locals'> {
  return { locals: viewer === undefined ? {} : { viewer } };
}

describe('keyByIp', () => {
  it('F-26, B-10: two IPv6 addresses in the same /56 share one key', () => {
    const first = keyByIp(requestFrom('2001:db8:aa:bb00::1'));
    const second = keyByIp(requestFrom('2001:db8:aa:bbff:ffff:ffff:ffff:fffe'));

    expect(first).toBe(second);
    expect(first).toBe('2001:db8:aa:bb00::/56');
  });

  it('F-26, B-10: IPv6 addresses in different /56 networks get different keys', () => {
    expect(keyByIp(requestFrom('2001:db8:aa:bb00::1'))).not.toBe(keyByIp(requestFrom('2001:db8:aa:cc00::1')));
  });

  it('F-26: IPv4 and IPv4-mapped IPv6 (Supertest on ::ffff:127.0.0.1) give the same, stable IPv4 key', () => {
    expect(keyByIp(requestFrom('203.0.113.7'))).toBe('203.0.113.7');
    expect(keyByIp(requestFrom('::ffff:127.0.0.1'))).toBe('127.0.0.1');
    expect(keyByIp(requestFrom('::ffff:127.0.0.1'))).toBe(keyByIp(requestFrom('127.0.0.1')));
    expect(keyByIp(requestFrom('203.0.113.7'))).not.toBe(keyByIp(requestFrom('203.0.113.8')));
  });

  it('F-26: a request without an address (closed socket) still gets a key instead of throwing', () => {
    expect(keyByIp(requestFrom(undefined))).toBe('');
  });
});

describe('email keys', () => {
  it('F-26: the email is normalised like the form schema, so spaces and case share one counter', () => {
    const normalised = emailKey(secret, 'ada@example.org');

    expect(emailKey(secret, '  Ada@Example.ORG ')).toBe(normalised);
    expect(emailKey(secret, 'ADA@EXAMPLE.ORG')).toBe(normalised);
    expect(emailKey(secret, 'bob@example.org')).not.toBe(normalised);
  });

  it('F-26, B-12: the key is a keyed hash that never contains the address', () => {
    const key = emailKey(secret, 'ada.lovelace@example.org');

    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/); // HMAC-SHA256, base64url without padding
    expect(key).not.toContain('ada');
    expect(key).not.toContain('example');
    // Another secret gives another key: without the secret, a dictionary of emails reveals nothing.
    expect(emailKey(deriveEmailKeySecret([`${SESSION_SECRET}-rotated`]), 'ada.lovelace@example.org')).not.toBe(key);
  });

  it('F-26: no usable email in the body falls back to the subnet key', () => {
    const fallback = keyByIp(requestFrom('2001:db8:aa:bb00::1'));
    const byEmail = keyByEmail(secret);

    expect(byEmail(requestFrom('2001:db8:aa:bb00::1', {}))).toBe(fallback);
    expect(byEmail(requestFrom('2001:db8:aa:bb00::1', undefined))).toBe(fallback);
    expect(byEmail(requestFrom('2001:db8:aa:bb00::1', { email: '   ' }))).toBe(fallback);
    // A repeated field arrives as an array from the urlencoded parser.
    expect(byEmail(requestFrom('2001:db8:aa:bb00::1', { email: ['a@example.org', 'b@example.org'] }))).toBe(fallback);
  });

  it('F-26: keyByEmail keys by the email across addresses', () => {
    const byEmail = keyByEmail(secret);
    const fromHome = byEmail(requestFrom('203.0.113.7', { email: 'ada@example.org' }));
    const fromPhone = byEmail(requestFrom('2001:db8:aa:bb00::1', { email: ' ADA@example.org' }));

    expect(fromHome).toBe(fromPhone);
    expect(fromHome).toBe(emailKey(secret, 'ada@example.org'));
  });

  it('F-26: keyByEmailAndSubnet separates the same email from different subnets', () => {
    const bySubnet = keyByEmailAndSubnet(secret);
    const email = { email: 'ada@example.org' };
    const home = bySubnet(requestFrom('2001:db8:aa:bb00::1', email));

    expect(bySubnet(requestFrom('2001:db8:aa:bbcc::99', email))).toBe(home); // same /56
    expect(bySubnet(requestFrom('2001:db8:aa:cc00::1', email))).not.toBe(home);
    expect(home).toBe(`${String(emailKey(secret, 'ada@example.org'))}:2001:db8:aa:bb00::/56`);
    expect(bySubnet(requestFrom('203.0.113.7', {}))).toBe('none:203.0.113.7');
  });
});

describe('deriveEmailKeySecret', () => {
  it('F-26: derives a stable 32-byte key that differs from the session secret itself', () => {
    const again = deriveEmailKeySecret([SESSION_SECRET]);

    expect(secret).toHaveLength(32);
    expect(again.equals(secret)).toBe(true);
    expect(secret.toString('utf8')).not.toContain(SESSION_SECRET.slice(0, 8));
    expect(deriveEmailKeySecret([`${SESSION_SECRET}x`]).equals(secret)).toBe(false);
    // Only the signing (first) secret counts: older secrets kept for verification change nothing.
    expect(deriveEmailKeySecret([SESSION_SECRET, 'older-secret-kept-for-verification-only']).equals(secret)).toBe(true);
  });

  it('B-03: refuses a session secret shorter than 32 characters', () => {
    expect(() => deriveEmailKeySecret(['too-short'])).toThrow(RangeError);
    expect(() => deriveEmailKeySecret([])).toThrow(RangeError);
  });
});

describe('keyByUser', () => {
  it('F-26: keys by the signed-in user, whatever the address', () => {
    const viewer: Viewer = { userId: 42, firstName: 'Ada', hasSigned: false };

    expect(keyByUser(requestFrom('203.0.113.7'), responseFor(viewer))).toBe('u:42');
    expect(keyByUser(requestFrom('2001:db8::1'), responseFor(viewer))).toBe('u:42');
  });

  it('F-26: without a viewer (a route that forgot requireAuth) it counts against the subnet instead of failing', () => {
    expect(keyByUser(requestFrom('2001:db8:aa:bb00::1'), responseFor())).toBe('2001:db8:aa:bb00::/56');
  });
});

describe('the limiters built from these keys', () => {
  it('F-26, B-10: express-rate-limit accepts every key generator without an ERR_ERL_* warning', () => {
    const logger = { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };

    const limiters = createRateLimiters({
      config: productionRateLimits,
      stores: () => new MemoryStore(),
      emailKeySecret: secret,
      logger,
    });

    expect(Object.keys(limiters).sort()).toEqual([
      'auth-ip',
      'global',
      'login-email',
      'login-email-subnet',
      'reauth',
      'register-email',
      'sign',
    ]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('F-26: the check above is live: a key generator on the raw req.ip is reported (ERR_ERL_KEY_GEN_IPV6)', () => {
    const logger = { warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() };

    rateLimiter({
      name: 'naive',
      windowMs: 60_000,
      limit: 1,
      keyGenerator: (req) => req.ip ?? '',
      store: new MemoryStore(),
      logger,
    });

    expect(logger.error).toHaveBeenCalledOnce();
    const [fields, message] = logger.error.mock.calls[0] ?? [];
    expect(message).toBe('rate_limit.error');
    expect(fields).toMatchObject({ limiter: 'naive', err: { code: 'ERR_ERL_KEY_GEN_IPV6' } });
  });
});

describe('rate limit configuration', () => {
  it('F-26: production defaults are 300 per minute globally and 10 per 15 minutes for auth, the rest derived or fixed', () => {
    expect(productionRateLimits).toEqual({
      globalPerMinute: 300,
      authPer15Min: 10,
      loginEmailPerHour: 100,
      reauthPer15Min: 5,
      signPerHour: 20,
    });
    expect(rateLimitsFromEnv({ RATE_LIMIT_GLOBAL_MAX: 300, RATE_LIMIT_AUTH_MAX: 10 })).toEqual(productionRateLimits);
    expect(rateLimitsFromEnv({ RATE_LIMIT_GLOBAL_MAX: 50, RATE_LIMIT_AUTH_MAX: 3 })).toMatchObject({
      globalPerMinute: 50,
      authPer15Min: 3,
      loginEmailPerHour: 30,
    });
  });

  it('F-26: maxima above the production defaults log one rate_limit.relaxed warning each; defaults log nothing', () => {
    const logger = { warn: vi.fn<LogFn>() };

    warnAboutRelaxedRateLimits(productionRateLimits, logger);
    warnAboutRelaxedRateLimits(rateLimitsFromEnv({ RATE_LIMIT_GLOBAL_MAX: 10, RATE_LIMIT_AUTH_MAX: 2 }), logger);
    expect(logger.warn).not.toHaveBeenCalled();

    warnAboutRelaxedRateLimits(
      rateLimitsFromEnv({ RATE_LIMIT_GLOBAL_MAX: 100_000, RATE_LIMIT_AUTH_MAX: 100_000 }),
      logger,
    );
    expect(logger.warn.mock.calls).toEqual([
      [{ limiter: 'global', max: 100_000 }, 'rate_limit.relaxed'],
      [{ limiter: 'auth', max: 100_000 }, 'rate_limit.relaxed'],
    ]);
  });
});
