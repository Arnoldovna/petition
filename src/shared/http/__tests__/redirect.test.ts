import type { Request } from 'express';
import { describe, expect, it } from 'vitest';

import { loginPath, safeReturnTo, sameOriginReferer } from '../redirect.js';

describe('safeReturnTo', () => {
  it.each([
    ['/supporters', '/supporters'],
    ['/supporters?page=2', '/supporters?page=2'],
    ['/supporters/city/Frankfurt%2FMain', '/supporters/city/Frankfurt%2FMain'],
    ['/supporters/city/M%C3%BCnchen?page=3', '/supporters/city/M%C3%BCnchen?page=3'],
    ['/a/../thank-you', '/thank-you'],
    ['/profile#edit', '/profile#edit'],
  ])('F-30: accepts the same-origin path %s', (value, expected) => {
    expect(safeReturnTo(value)).toBe(expected);
  });

  it.each([
    ['protocol-relative', '//evil.example/path'],
    ['backslash after the slash', '/\\evil.example'],
    ['backslash later on', '/supporters\\..\\..\\evil'],
    ['absolute https', 'https://evil.example/'],
    ['absolute same-looking', 'http://localhost:3000/supporters'],
    ['javascript:', 'javascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['relative without slash', 'supporters'],
    ['tab inside the slashes', '/\t/evil.example'],
    ['newline inside the slashes', '/\n/evil.example'],
    ['NUL character', '/supporters\u0000'],
    ['dot segment that normalises to //', '/.//evil.example'],
    ['empty', ''],
    ['longer than 512 characters', `/${'a'.repeat(512)}`],
  ])('F-30: drops a %s target', (_case, value) => {
    expect(safeReturnTo(value)).toBeUndefined();
  });

  it('F-30: accepts exactly 512 characters', () => {
    const value = `/${'a'.repeat(511)}`;

    expect(safeReturnTo(value)).toBe(value);
  });

  it('F-30: drops anything that is not a string (a repeated query parameter is an array)', () => {
    for (const value of [undefined, null, 42, ['/a', '/b'], { path: '/a' }])
      expect(safeReturnTo(value)).toBeUndefined();
  });
});

describe('loginPath', () => {
  it('F-30: carries a safe returnTo, encoded', () => {
    expect(loginPath('/supporters/city/Frankfurt%2FMain?page=2')).toBe(
      '/login?returnTo=%2Fsupporters%2Fcity%2FFrankfurt%252FMain%3Fpage%3D2',
    );
  });

  it('F-30: drops an unsafe returnTo instead of building a link to it', () => {
    expect(loginPath('//evil.example')).toBe('/login');
    expect(loginPath()).toBe('/login');
  });
});

describe('sameOriginReferer', () => {
  const requestWith = (headers: Record<string, string>, protocol = 'http') =>
    ({ protocol, get: (name: string) => headers[name.toLowerCase()] }) as Request;

  it('ROUTES 8: returns the path and query of a Referer from this origin', () => {
    const req = requestWith({ host: 'petition.test', referer: 'http://petition.test/profile/edit?x=1#top' });

    expect(sameOriginReferer(req)).toBe('/profile/edit?x=1');
  });

  it.each([
    ['another host', { host: 'petition.test', referer: 'http://evil.example/profile/edit' }],
    ['another port', { host: 'petition.test', referer: 'http://petition.test:8080/profile/edit' }],
    ['no Referer', { host: 'petition.test' }],
    ['no Host', { referer: 'http://petition.test/profile/edit' }],
    ['a malformed Referer', { host: 'petition.test', referer: 'not a url' }],
    ['a malformed Host', { host: 'bad host value', referer: 'http://petition.test/' }],
  ])('ROUTES 8: returns nothing for %s', (_case, headers: Record<string, string>) => {
    expect(sameOriginReferer(requestWith(headers))).toBeUndefined();
  });

  it('ROUTES 8: compares the scheme too (https page, http Referer)', () => {
    const req = requestWith({ host: 'petition.test', referer: 'http://petition.test/profile/edit' }, 'https');

    expect(sameOriginReferer(req)).toBeUndefined();
  });
});
