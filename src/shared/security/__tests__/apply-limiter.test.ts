import type { Request, RequestHandler, Response } from 'express';
import { describe, expect, it } from 'vitest';

import { TooManyRequestsError } from '../../errors/app-error.js';
import { applyLimiter } from '../security.js';

/**
 * `applyLimiter` (ADR 0012): a limiter applied from inside a handler, the way the profile edit applies `reauth` right
 * before the password check. The limiter's answer through `next` becomes the promise's outcome.
 */

const req = {} as Request;
const res = {} as Response;

const passes: RequestHandler = (_req, _res, next) => {
  next();
};

describe('applyLimiter', () => {
  it('ADR 0012: resolves when the limiter lets the request through', async () => {
    await expect(applyLimiter(passes, req, res)).resolves.toBeUndefined();
  });

  it('F-26: rejects with the limiter rejection, so the error handler renders the 429 page', async () => {
    const tooMany = new TooManyRequestsError();
    const blocks: RequestHandler = (_req, _res, next) => {
      next(tooMany);
    };

    await expect(applyLimiter(blocks, req, res)).rejects.toBe(tooMany);
  });

  it('F-09: a non-error value passed to next and a rejected limiter promise become errors, never a hang', async () => {
    const odd: RequestHandler = (_req, _res, next) => {
      next('store down');
    };
    const broken: RequestHandler = () => Promise.reject(new Error('limiter bug'));

    await expect(applyLimiter(odd, req, res)).rejects.toThrow('rate limiter failed');
    await expect(applyLimiter(broken, req, res)).rejects.toThrow('limiter bug');
  });
});
