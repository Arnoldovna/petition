import { doubleCsrf } from 'csrf-csrf';
import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../../errors/app-error.js';
import { toProblem } from '../problem.js';

const req = { originalUrl: '/signature?page=2' } as Request;
const TYPE_PREFIX = 'tag:arnoldovna.github.io,2026:petition:problem:';

/** An `http-errors` instance as body-parser and serve-static create them. */
const httpError = (status: number, message: string, fields: Record<string, unknown> = {}) =>
  Object.assign(new Error(message), { status, statusCode: status, expose: status < 500, ...fields });

describe('toProblem', () => {
  it.each([
    [new ValidationError([{ location: 'query', path: 'page', message: 'Invalid page' }]), 400, 'validation-failed'],
    [new UnauthorizedError(), 401, 'unauthenticated'],
    [new ForbiddenError(), 403, 'forbidden'],
    [new NotFoundError('Supporter page'), 404, 'not-found'],
    [new ConflictError('Already signed', 'already-signed'), 409, 'already-signed'],
    [new PayloadTooLargeError(65_536), 413, 'payload-too-large'],
    [new TooManyRequestsError(), 429, 'too-many-requests'],
  ])('F-09, B-13: maps %s to its status and a stable tag type', (error, status, code) => {
    const problem = toProblem(error, req);

    expect(problem).toMatchObject({ status, type: `${TYPE_PREFIX}${code}`, title: error.title, detail: error.message });
    expect(problem.instance).toBe('/signature?page=2');
  });

  it('F-09: keeps AppError extensions next to the standard members, which they cannot overwrite', () => {
    const error = new AppError({
      status: 422,
      code: 'custom',
      title: 'Custom',
      detail: 'Safe detail.',
      extensions: { maxBytes: 10, status: 200, type: 'about:blank' },
    });

    expect(toProblem(error, req)).toEqual({
      maxBytes: 10,
      type: `${TYPE_PREFIX}custom`,
      title: 'Custom',
      status: 422,
      detail: 'Safe detail.',
      instance: '/signature?page=2',
    });
    expect(toProblem(new ValidationError([]), req)).toHaveProperty('errors', []);
    expect(toProblem(new PayloadTooLargeError(5), req)).toHaveProperty('maxBytes', 5);
  });

  it('F-70: maps the real csrf-csrf rejection to a 403 csrf-invalid problem with a fixed detail', () => {
    const { invalidCsrfTokenError } = doubleCsrf({
      getSecret: () => 'test-csrf-secret-with-at-least-32-characters',
      getSessionIdentifier: () => 'session-id',
    });

    expect(toProblem(invalidCsrfTokenError, req)).toEqual({
      type: `${TYPE_PREFIX}csrf-invalid`,
      title: 'Forbidden',
      status: 403,
      detail: 'The form has expired. Reload the page and send it again.',
      instance: '/signature?page=2',
    });
  });

  it.each([
    ['entity.too.large', 413, 'payload-too-large'],
    ['parameters.too.many', 413, 'payload-too-large'],
    ['entity.parse.failed', 400, 'malformed-body'],
    ['request.aborted', 400, 'request-aborted'],
    ['encoding.unsupported', 415, 'unsupported-media-type'],
    ['charset.unsupported', 415, 'unsupported-media-type'],
  ])('F-09, B-13: maps the body-parser rejection %s without its message', (type, status, code) => {
    const error = httpError(status, 'Unexpected token < in JSON at position 0: <script>', { type, body: '<script>' });

    const problem = toProblem(error, req);

    expect(problem).toMatchObject({ status, type: `${TYPE_PREFIX}${code}` });
    expect(JSON.stringify(problem)).not.toContain('script');
  });

  it('F-09: other http-errors 4xx keep their status and show the message only when it is exposed', () => {
    expect(toProblem(httpError(405, 'Method Not Allowed'), req)).toEqual({
      type: 'about:blank',
      title: 'Method not allowed',
      status: 405,
      detail: 'Method Not Allowed',
      instance: '/signature?page=2',
    });
    expect(toProblem(httpError(418, 'internal note', { expose: false }), req)).toEqual({
      type: 'about:blank',
      title: 'Bad request',
      status: 418,
      instance: '/signature?page=2',
    });
  });

  it("F-09: the router's URIError for a malformed percent-encoding keeps its 400 without the message", () => {
    const error = Object.assign(new URIError("Failed to decode param '%E0%A4%A'"), { status: 400, statusCode: 400 });

    expect(toProblem(error, req)).toEqual({
      type: 'about:blank',
      title: 'Bad request',
      status: 400,
      instance: '/signature?page=2',
    });
  });

  it.each([
    ['a plain error with SQL', new Error('Failed query: select * from users\nparams: ada@example.com')],
    ['an http-errors 5xx', httpError(503, 'upstream db-1.internal unavailable')],
    ['a thrown string', 'boom'],
    ['undefined', undefined],
    ['an object posing as an error', { status: 404 }],
  ])('F-09, B-13: turns %s into a generic 500 without internals', (_case, error) => {
    const problem = toProblem(error, req);

    expect(problem).toEqual({
      type: 'about:blank',
      title: 'Internal server error',
      status: 500,
      detail: 'An unexpected error occurred.',
      instance: '/signature?page=2',
    });
  });
});

describe('TooManyRequestsError', () => {
  it('ADR 0012: carries a whole number of seconds for Retry-After, or none', () => {
    expect(new TooManyRequestsError({ retryAfterSeconds: 59.2 }).retryAfterSeconds).toBe(60);
    expect(new TooManyRequestsError().retryAfterSeconds).toBeUndefined();
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(new TooManyRequestsError({ retryAfterSeconds: invalid }).retryAfterSeconds).toBeUndefined();
    }
  });

  it('ADR 0012: its detail names no fixed duration, because the limiter windows differ', () => {
    expect(new TooManyRequestsError().message).toBe('Too many attempts. Please wait a few minutes, then try again.');
  });
});
