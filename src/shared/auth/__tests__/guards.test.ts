import type { Request, RequestHandler, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { homeOf, requireAuth, requireGuest, requireNotSigned, requireSigned, viewerOf } from '../guards.js';
import type { Viewer } from '../viewer.js';

const UNSIGNED: Viewer = { userId: 7, firstName: 'Ada', hasSigned: false };
const SIGNED: Viewer = { userId: 8, firstName: 'Grace', hasSigned: true };

type Outcome = { passed: true } | { passed: false; status: number; location: string };

/** Runs one guard against a minimal request/response pair and reports whether it passed or where it redirected. */
function run(guard: RequestHandler, method: string, viewer: Viewer | undefined, originalUrl = '/page'): Outcome {
  const req = { method, originalUrl } as Request;
  const redirect = vi.fn<(status: number, location: string) => void>();
  const res = { locals: viewer === undefined ? {} : { viewer }, redirect } as unknown as Response;
  const next = vi.fn<(error?: unknown) => void>();

  void guard(req, res, next);

  if (next.mock.calls.length === 1 && redirect.mock.calls.length === 0) {
    expect(next).toHaveBeenCalledWith(); // never with an error: guards redirect, they do not throw
    return { passed: true };
  }
  expect(next).not.toHaveBeenCalled();
  expect(redirect).toHaveBeenCalledTimes(1);
  const [status, location] = redirect.mock.calls[0] ?? [];
  if (status === undefined || location === undefined) throw new Error('redirect without arguments');
  return { passed: false, status, location };
}

const passed: Outcome = { passed: true };
const to = (status: number, location: string): Outcome => ({ passed: false, status, location });

describe('requireAuth', () => {
  it('F-07, F-30, B-06: a guest page request goes to /login with the encoded original URL as returnTo', () => {
    expect(run(requireAuth, 'GET', undefined, '/supporters?page=2')).toEqual(
      to(302, '/login?returnTo=%2Fsupporters%3Fpage%3D2'),
    );
    expect(run(requireAuth, 'HEAD', undefined, '/profile')).toEqual(to(302, '/login?returnTo=%2Fprofile'));
  });

  it('F-07, B-06: a guest form submission gets 303 to plain /login (no returnTo for a POST URL)', () => {
    expect(run(requireAuth, 'POST', undefined, '/profile/edit')).toEqual(to(303, '/login'));
  });

  it('F-30: an unsafe original URL is dropped from returnTo instead of becoming an open redirect', () => {
    expect(run(requireAuth, 'GET', undefined, '//evil.example/x')).toEqual(to(302, '/login'));
  });

  it('F-07: signed-in visitors pass on GET and POST', () => {
    expect(run(requireAuth, 'GET', UNSIGNED)).toEqual(passed);
    expect(run(requireAuth, 'POST', SIGNED)).toEqual(passed);
  });
});

describe('requireGuest', () => {
  it('F-22: guests pass', () => {
    expect(run(requireGuest, 'GET', undefined)).toEqual(passed);
    expect(run(requireGuest, 'POST', undefined)).toEqual(passed);
  });

  it('F-22, B-48: a signed-in visitor who has not signed goes to /signature (302 GET, 303 POST)', () => {
    expect(run(requireGuest, 'GET', UNSIGNED)).toEqual(to(302, '/signature'));
    expect(run(requireGuest, 'POST', UNSIGNED)).toEqual(to(303, '/signature'));
  });

  it('F-22, B-48: a signer goes to /thank-you (302 GET, 303 POST)', () => {
    expect(run(requireGuest, 'GET', SIGNED)).toEqual(to(302, '/thank-you'));
    expect(run(requireGuest, 'POST', SIGNED)).toEqual(to(303, '/thank-you'));
  });
});

describe('requireSigned', () => {
  it('F-48, B-07: signers pass', () => {
    expect(run(requireSigned, 'GET', SIGNED)).toEqual(passed);
    expect(run(requireSigned, 'POST', SIGNED)).toEqual(passed);
  });

  it('F-48, B-07, B-35: a visitor without a signature goes to /signature', () => {
    expect(run(requireSigned, 'GET', UNSIGNED)).toEqual(to(302, '/signature'));
    expect(run(requireSigned, 'POST', UNSIGNED)).toEqual(to(303, '/signature'));
  });

  it('F-07: a guest is sent to the login page, as by requireAuth', () => {
    expect(run(requireSigned, 'GET', undefined, '/thank-you')).toEqual(to(302, '/login?returnTo=%2Fthank-you'));
    expect(run(requireSigned, 'POST', undefined, '/signature/delete')).toEqual(to(303, '/login'));
  });
});

describe('requireNotSigned', () => {
  it('F-44: visitors without a signature pass', () => {
    expect(run(requireNotSigned, 'GET', UNSIGNED)).toEqual(passed);
    expect(run(requireNotSigned, 'POST', UNSIGNED)).toEqual(passed);
  });

  it('F-43, F-44: a signer goes to /thank-you on GET (302) and on a repeated POST (303, idempotent)', () => {
    expect(run(requireNotSigned, 'GET', SIGNED)).toEqual(to(302, '/thank-you'));
    expect(run(requireNotSigned, 'POST', SIGNED)).toEqual(to(303, '/thank-you'));
  });

  it('F-07: a guest is sent to the login page, as by requireAuth', () => {
    expect(run(requireNotSigned, 'GET', undefined, '/signature')).toEqual(to(302, '/login?returnTo=%2Fsignature'));
    expect(run(requireNotSigned, 'POST', undefined, '/signature')).toEqual(to(303, '/login'));
  });
});

describe('homeOf and viewerOf', () => {
  it('F-23, B-22: the home of a signed-in visitor depends on hasSigned', () => {
    expect(homeOf(UNSIGNED)).toBe('/signature');
    expect(homeOf(SIGNED)).toBe('/thank-you');
  });

  it('viewerOf returns the viewer and fails loudly when a route forgot requireAuth', () => {
    expect(viewerOf({ locals: { viewer: SIGNED } } as unknown as Response)).toBe(SIGNED);
    expect(() => viewerOf({ locals: {} } as unknown as Response)).toThrow(/requireAuth/);
  });
});
