import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser, type TestUser } from '../../../../test/factories.js';
import { createFakeHasher, fakePasswordHash, type FakeHasher } from '../../../../test/fakes.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { users } from '../../../db/schema/index.js';
import { sessionIdOf } from './fakes.js';

/**
 * `GET /login` and `POST /login` on the real app (ROUTES.md section 3, ADR 0009): the landing page with and without
 * a signature, one 401 for unknown email and wrong password, `returnTo` (only safe same-origin paths), the new session
 * id, rehash on login, the guest-only guard, CSRF and the resubmit round trip with the token of the 401 page.
 */

let testApp: TestApp;
let hasher: FakeHasher;

beforeAll(async () => {
  hasher = createFakeHasher();
  testApp = await createTestApp({ hasher });
});

afterAll(async () => {
  await testApp.close();
});

const FORM = 'form[action="/login"]';
const LOGIN_FAILED = 'Email or password is incorrect';
/** argon2id parameters older than the pinned ones (ADR 0009). */
const OUTDATED_PARAMETERS = '$argon2id$v=19$m=19456,t=2,p=1$';

const newUser = (overrides: Parameters<typeof createUser>[1] = {}): Promise<TestUser> =>
  createUser(testApp.db, { email: `ada-${randomUUID()}@example.com`, ...overrides });

async function loginPage(path = '/login'): Promise<{ agent: Agent; csrf: string; response: Response }> {
  const agent = request.agent(testApp.app);
  const response = await agent.get(path).expect(200);
  return { agent, csrf: readForm(response.text, FORM).csrf, response };
}

function expectFailedLogin(response: Response): ReturnType<typeof parse> {
  expect(response.status).toBe(401);
  const page = parse(response.text);
  expect(page.text('h1')).toBe('Log in');
  expect(page.texts('.error-summary__link')).toEqual([LOGIN_FAILED]);
  // B-23: never the registration page or its "email taken" message
  expect(response.text).not.toContain('already exists');
  return page;
}

describe('GET /login', () => {
  it('F-23, F-80, B-71: renders the form with visible labels and the email and current-password tokens', async () => {
    const page = parse((await request(testApp.app).get('/login').expect(200)).text);

    expect(page.text('title')).toBe('Log in · Nonsense Petition');
    expect(page.text('h1')).toBe('Log in');
    expect(page.has(`${FORM}[method="post"][novalidate][data-guard]`)).toBe(true);
    expect(page.attr('#email', 'type')).toBe('email');
    expect(page.attr('#email', 'autocomplete')).toBe('email');
    expect(page.attr('#password', 'type')).toBe('password');
    expect(page.attr('#password', 'autocomplete')).toBe('current-password');
    expect(page.text('label[for="email"]')).toBe('email');
    expect(page.text('label[for="password"]')).toBe('password');
    expect(page.has(`${FORM} input[name="returnTo"]`)).toBe(false);
    expect(page.texts('main a[href="/register"]')).toContain('register');
  });

  it('F-30: a safe returnTo becomes a hidden field', async () => {
    const page = parse((await request(testApp.app).get('/login?returnTo=%2Fsupporters%3Fpage%3D2').expect(200)).text);

    expect(page.attr(`${FORM} input[type="hidden"][name="returnTo"]`, 'value')).toBe('/supporters?page=2');
  });

  it.each([
    ['a protocol-relative URL', '//evil.example/'],
    ['an absolute URL', 'https://evil.example/'],
    ['a backslash path', '/\\evil.example'],
    ['a relative path', 'supporters'],
    ['a dot-segment trick', '/.//evil.example'],
  ])('F-30: %s in returnTo is dropped silently (no open redirect)', async (_label, value) => {
    const response = await request(testApp.app)
      .get(`/login?returnTo=${encodeURIComponent(value)}`)
      .expect(200);

    expect(parse(response.text).has('input[name="returnTo"]')).toBe(false);
  });

  it('F-22: a signed-in visitor is sent to /signature, a signer to /thank-you', async () => {
    const unsigned = await newUser();
    const signer = await newUser();
    await createSignature(testApp.db, signer.id);
    const unsignedAgent = request.agent(testApp.app);
    const signerAgent = request.agent(testApp.app);
    await signIn(unsignedAgent, unsigned.id);
    await signIn(signerAgent, signer.id);

    await unsignedAgent.get('/login').expect(302).expect('location', '/signature');
    await signerAgent.get('/login').expect(302).expect('location', '/thank-you');
  });
});

describe('POST /login', () => {
  it('F-23, B-22: a user without a signature is signed in and sent to /signature', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();

    await postForm(agent, '/login', { _csrf: csrf, email: user.email, password: user.password })
      .expect(303)
      .expect('location', '/signature');

    await agent.get('/login').expect(302).expect('location', '/signature');
  });

  it('F-23: a signer is sent to /thank-you', async () => {
    const user = await newUser();
    await createSignature(testApp.db, user.id);
    const { agent, csrf } = await loginPage();

    await postForm(agent, '/login', { _csrf: csrf, email: user.email, password: user.password })
      .expect(303)
      .expect('location', '/thank-you');
  });

  it('F-23, ADR 0002: login regenerates the session id, and the old anonymous token stops working', async () => {
    const user = await newUser();
    const { agent, csrf, response: page } = await loginPage();

    const response = await postForm(agent, '/login', {
      _csrf: csrf,
      email: user.email,
      password: user.password,
    }).expect(303);

    expect(sessionIdOf(response)).not.toBe(sessionIdOf(page));
    const stale = await postForm(agent, '/logout', { _csrf: csrf });
    expect(stale.status).toBe(403);
  });

  it('F-23, B-25: the email is matched case-insensitively and with surrounding spaces', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();

    await postForm(agent, '/login', { _csrf: csrf, email: `  ${user.email.toUpperCase()}  `, password: user.password })
      .expect(303)
      .expect('location', '/signature');
  });

  it('F-24, B-09, B-23: unknown email and wrong password give the same 401 page with one message', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();

    const wrong = await postForm(agent, '/login', { _csrf: csrf, email: user.email, password: 'not the password' });
    const unknown = await postForm(agent, '/login', {
      _csrf: csrf,
      email: user.email.replace('ada-', 'nobody-'),
      password: 'not the password',
    });

    const wrongPage = expectFailedLogin(wrong);
    const unknownPage = expectFailedLogin(unknown);
    // Same session, same token, same markup: only the echoed email differs.
    expect(unknown.text.replace(user.email.replace('ada-', 'nobody-'), user.email)).toBe(wrong.text);
    expect(wrongPage.attr('.error-summary__link', 'href')).toBe('#main');
    // Neither field is marked as the wrong one.
    expect(unknownPage.attr('#email', 'aria-invalid')).toBeUndefined();
    expect(unknownPage.attr('#password', 'aria-invalid')).toBeUndefined();
  });

  it('F-24, B-09: an unknown email still runs one password verification (the dummy hash)', async () => {
    const { agent, csrf } = await loginPage();
    const before = hasher.verifyCalls.length;

    await postForm(agent, '/login', { _csrf: csrf, email: `nobody-${randomUUID()}@example.com`, password: 'x' }).expect(
      401,
    );

    expect(hasher.verifyCalls.length - before).toBe(1);
    expect(hasher.verifyCalls.at(-1)?.result).toBe(false);
  });

  it('F-24: a failed login keeps the email, never the password, and stays a guest', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();

    const response = await postForm(agent, '/login', { _csrf: csrf, email: user.email, password: 'a wrong secret' });
    const page = expectFailedLogin(response);

    expect(page.attr('#email', 'value')).toBe(user.email);
    expect(page.attr('#password', 'value')).toBe('');
    expect(response.text).not.toContain('a wrong secret');
    await agent.get('/login').expect(200);
  });

  it('F-24: a short password for an existing account gets the generic 401, never a hint about the policy', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();

    const response = await postForm(agent, '/login', { _csrf: csrf, email: user.email, password: 'x' });

    expectFailedLogin(response);
    expect(response.text).not.toContain('at least 12 characters');
  });

  it('F-24, ADR 0008: empty fields and a malformed email are 422 with field messages', async () => {
    const { agent, csrf } = await loginPage();

    const empty = parse((await postForm(agent, '/login', { _csrf: csrf, email: '', password: '' }).expect(422)).text);
    const malformed = parse(
      (await postForm(agent, '/login', { _csrf: csrf, email: 'ada-at-example', password: 'something' }).expect(422))
        .text,
    );

    expect(empty.texts('.error-summary__link')).toEqual(['Enter an email address', 'Enter a password']);
    expect(empty.attr('#email', 'aria-invalid')).toBe('true');
    expect(empty.attr('#password', 'aria-invalid')).toBe('true');
    expect(malformed.texts('.error-summary__link')).toEqual(['Enter a valid email address, like name@example.com']);
    expect(malformed.attr('#email', 'value')).toBe('ada-at-example');
  });

  it('F-30: a valid returnTo is where a successful login goes', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage('/login?returnTo=%2Fsupporters%3Fpage%3D2');

    await postForm(agent, '/login', {
      _csrf: csrf,
      email: user.email,
      password: user.password,
      returnTo: '/supporters?page=2',
    })
      .expect(303)
      .expect('location', '/supporters?page=2');
  });

  it('F-30: an unsafe returnTo in the form is ignored for the usual landing page', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();

    await postForm(agent, '/login', {
      _csrf: csrf,
      email: user.email,
      password: user.password,
      returnTo: '//evil.example/',
    })
      .expect(303)
      .expect('location', '/signature');
  });

  it('F-30: a guest who opens a protected page logs in and returns to it', async () => {
    const user = await newUser();
    const agent = request.agent(testApp.app);

    const guarded = await agent.get('/account/delete').expect(302);
    expect(guarded.headers['location']).toBe('/login?returnTo=%2Faccount%2Fdelete');
    const { csrf, values } = await getForm(agent, guarded.headers['location'] ?? '', FORM);

    expect(values['returnTo']).toBe('/account/delete');
    await postForm(agent, '/login', { _csrf: csrf, ...values, email: user.email, password: user.password })
      .expect(303)
      .expect('location', '/account/delete');
    await agent.get('/account/delete').expect(200);
  });

  it('F-30, F-21: returnTo survives a 422 and a 401 re-render, but only when it is safe', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();

    const invalid = await postForm(agent, '/login', { _csrf: csrf, email: '', password: '', returnTo: '/supporters' });
    const failed = await postForm(agent, '/login', {
      _csrf: csrf,
      email: user.email,
      password: 'wrong',
      returnTo: '/supporters',
    });
    const unsafe = await postForm(agent, '/login', {
      _csrf: csrf,
      email: '',
      password: '',
      returnTo: '//evil.example',
    });

    expect(parse(invalid.text).attr('input[name="returnTo"]', 'value')).toBe('/supporters');
    expect(parse(failed.text).attr('input[name="returnTo"]', 'value')).toBe('/supporters');
    expect(parse(unsafe.text).has('input[name="returnTo"]')).toBe(false);
  });

  it('F-21, ADR 0003: the 401 page carries a token that the next attempt can use', async () => {
    const user = await newUser();
    const { agent, csrf } = await loginPage();
    const failed = await postForm(agent, '/login', { _csrf: csrf, email: user.email, password: 'wrong password' });

    const { csrf: fresh } = readForm(failed.text, FORM);

    expect(fresh).not.toBe('');
    await postForm(agent, '/login', { _csrf: fresh, email: user.email, password: user.password }).expect(303);
  });

  it('F-27, ADR 0009: a correct password with an outdated hash is rehashed; the session version stays', async () => {
    const user = await newUser({ passwordHash: fakePasswordHash('legacy password 123', OUTDATED_PARAMETERS) });
    const { agent, csrf } = await loginPage();

    await postForm(agent, '/login', { _csrf: csrf, email: user.email, password: 'legacy password 123' }).expect(303);

    const [row] = await testApp.db
      .select({ passwordHash: users.passwordHash, sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, user.id));
    expect(row?.passwordHash).not.toBe(user.passwordHash);
    expect(hasher.needsRehash(row?.passwordHash ?? '')).toBe(false);
    expect(row?.sessionVersion).toBe(user.sessionVersion);
    // The new hash still verifies: the next login works.
    const next = await loginPage();
    await postForm(next.agent, '/login', {
      _csrf: next.csrf,
      email: user.email,
      password: 'legacy password 123',
    }).expect(303);
  });

  it('F-22, F-07: a signed-in visitor posting the login form is redirected and stays the same user', async () => {
    const signedIn = await newUser();
    const other = await newUser();
    const agent = request.agent(testApp.app);
    await signIn(agent, signedIn.id);
    const { csrf } = await getForm(agent, '/account/delete');

    await postForm(agent, '/login', { _csrf: csrf, email: other.email, password: other.password })
      .expect(303)
      .expect('location', '/signature');
  });

  it('F-70: a POST without a valid CSRF token gets the 403 page and signs nobody in', async () => {
    const user = await newUser();
    const { agent } = await loginPage();

    const missing = await postForm(agent, '/login', { email: user.email, password: user.password });
    const forged = await postForm(agent, '/login', { _csrf: 'forged', email: user.email, password: user.password });

    for (const response of [missing, forged]) {
      expect(response.status).toBe(403);
      expect(parse(response.text).text('h1')).toBe('This form has expired');
    }
    await agent.get('/login').expect(200);
  });
});
