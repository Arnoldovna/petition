import { createHmac, hkdfSync } from 'node:crypto';

import type { Request, Response } from 'express';
import { ipKeyGenerator } from 'express-rate-limit';

import { APP_SLUG } from '../../config/app.js';

/**
 * Rate-limit key generators (ADR 0012, F-26, B-10). Pure functions of the request, unit-tested in
 * `__tests__/rate-limit-keys.test.ts`. Every limiter passes one of them as its explicit `keyGenerator`; none sets
 * `ipv6Subnet`, because express-rate-limit ignores it as soon as a custom key generator exists (conventions §8).
 */

/** IPv6 clients are limited per /56: one customer prefix, so rotating addresses inside it does not help. */
const IPV6_SUBNET = 56;

/** Info string of the HKDF step: domain separation from the session signature that uses the same secret. */
const EMAIL_KEY_INFO = `${APP_SLUG}:rate-limit-email`;
const EMAIL_KEY_BYTES = 32;
const MIN_SECRET_LENGTH = 32;

/** IPv4 as is, IPv4-mapped IPv6 as its IPv4 form, every other IPv6 address as its /56 network. */
export function keyByIp(req: Pick<Request, 'ip'>): string {
  return ipKeyGenerator(req.ip ?? '', IPV6_SUBNET);
}

/**
 * The key of the email rate limiters, derived once at startup from the first (signing) `SESSION_SECRET` entry with
 * HKDF-SHA256, so no extra environment key is needed. Rotating the session secret resets the email counters, which
 * is acceptable (ADR 0012).
 */
export function deriveEmailKeySecret(sessionSecrets: readonly string[]): Buffer {
  const [signing] = sessionSecrets;
  if (signing === undefined || signing.length < MIN_SECRET_LENGTH) {
    throw new RangeError(`the first session secret must be at least ${String(MIN_SECRET_LENGTH)} characters`);
  }
  return Buffer.from(hkdfSync('sha256', signing, Buffer.alloc(0), EMAIL_KEY_INFO, EMAIL_KEY_BYTES));
}

/**
 * `HMAC-SHA256(secret, email)` as base64url, with the email normalised exactly like the form schema (trim, lower
 * case; `fields.ts`), so `" Ada@Example.ORG "` and `ada@example.org` share one counter. A keyed hash, because an
 * unsalted hash of a low-entropy email is reversible with a dictionary: Redis never holds a recoverable address.
 * `undefined` when the body carries no usable email.
 */
export function emailKey(secret: Buffer, email: unknown): string | undefined {
  if (typeof email !== 'string') return undefined;
  const normalised = email.trim().toLowerCase();
  if (normalised.length === 0) return undefined;
  return createHmac('sha256', secret).update(normalised).digest('base64url');
}

/** `req.body.email` without trusting the body's shape (the app has only the urlencoded parser, ADR 0004). */
function bodyEmail(req: Pick<Request, 'body'>): unknown {
  const body: unknown = req.body;
  return typeof body === 'object' && body !== null && 'email' in body ? body.email : undefined;
}

/** Per email (`register-email`, `login-email`); without an email the request counts against its subnet instead. */
export function keyByEmail(secret: Buffer): (req: Pick<Request, 'ip' | 'body'>) => string {
  return (req) => emailKey(secret, bodyEmail(req)) ?? keyByIp(req);
}

/**
 * Per email and subnet (`login-email-subnet`): an attacker who knows an address can only lock it out from their own
 * subnet (ADR 0012, lockout analysis).
 */
export function keyByEmailAndSubnet(secret: Buffer): (req: Pick<Request, 'ip' | 'body'>) => string {
  return (req) => `${emailKey(secret, bodyEmail(req)) ?? 'none'}:${keyByIp(req)}`;
}

/**
 * Per signed-in user (`reauth`, `sign`). These limiters run behind `requireAuth`; should a route ever mount one
 * without it, the request counts against its subnet rather than failing (an IP key never starts with `u:`).
 */
export function keyByUser(req: Pick<Request, 'ip'>, res: Pick<Response, 'locals'>): string {
  const { viewer } = res.locals;
  return viewer === undefined ? keyByIp(req) : `u:${String(viewer.userId)}`;
}
