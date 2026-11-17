import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../test/auth.js';
import { createUser, type TestUser } from '../../test/factories.js';
import { createFakeHasher, type FakeHasher } from '../../test/fakes.js';
import { getForm, postForm, type Agent } from '../../test/forms.js';
import { parse } from '../../test/html.js';
import { createTestApp, type TestApp } from '../../test/test-app.js';
import { signatures, users } from '../db/schema/index.js';
import { productionRateLimits } from '../shared/security/security.js';

/**
 * The production limits of ADR 0012 on the real routes (ADR 0019 §9, F-26, B-10): `POST /login` (`auth-ip`,
 * `login-email-subnet`, `login-email`, the last two counting failed attempts only), `POST /register` (`auth-ip`,
 * `register-email`), `POST /account/delete` and `POST /profile/edit` when it checks the current password (`reauth`) and
 * `POST /signature` (`sign`). The limiter mechanics on the test-only probes are `rate-limit.int.test.ts` (phase 1b).
 *
 * This is the second of the two files that pass `productionRateLimits` and `trustProxy: 1`, so every request names
 * its client IP in `X-Forwarded-For`. Every test uses its own client addresses (one private /24 each) and
 * its own emails or users, so no test spends another one's budget; the app's Redis prefix is fresh for this file.
 */

let testApp: TestApp;
let hasher: FakeHasher;

beforeAll(async () => {
  hasher = createFakeHasher();
  testApp = await createTestApp({ rateLimits: productionRateLimits, trustProxy: 1, hasher });
});

afterAll(async () => {
  await testApp.close();
});

const AUTH_LIMIT = productionRateLimits.authPer15Min; // 10
const LOGIN_EMAIL_LIMIT = productionRateLimits.loginEmailPerHour; // 100
const REAUTH_LIMIT = productionRateLimits.reauthPer15Min; // 5
const SIGN_LIMIT = productionRateLimits.signPerHour; // 20
const QUARTER_HOUR_S = 15 * 60;
const HOUR_S = 60 * 60;

/** Unique client addresses per test: `ips(n)` gives n distinct IPv4 addresses in one /24 of its own. */
let block = 0;
function ips(amount: number): string[] {
  block += 1;
  expect(amount).toBeLessThan(255);
  const prefix = `10.${String(Math.floor(block / 250))}.${String(block % 250)}`;
  return Array.from({ length: amount }, (_, index) => `${prefix}.${String(index + 1)}`);
}

const uniqueEmail = (label: string): string => `${label}-${randomUUID()}@example.org`;

interface Guest {
  agent: Agent;
  csrf: string;
}

/** A guest with the login form open; the token works for `/register` too (one token per session, ADR 0003). */
async function guest(ip: string): Promise<Guest> {
  const agent = request.agent(testApp.app);
  const page = await agent.get('/login').set('X-Forwarded-For', ip).expect(200);
  const csrf = parse(page.text).attr('input[name="_csrf"]', 'value') ?? '';
  expect(csrf).not.toBe('');
  return { agent, csrf };
}

function login(visitor: Guest, ip: string, email: string, password: string) {
  return postForm(visitor.agent, '/login', { _csrf: visitor.csrf, email, password }).set('X-Forwarded-For', ip);
}

/** A registration with a too-short password: a 422 that creates nothing, but counts for both register limiters. */
function register(visitor: Guest, ip: string, email: string, password = 'short') {
  return postForm(visitor.agent, '/register', {
    _csrf: visitor.csrf,
    firstName: 'Grace',
    lastName: 'Hopper',
    email,
    password,
  }).set('X-Forwarded-For', ip);
}

function expectTooManyAttempts(response: Response, windowSeconds: number): void {
  expect(response.status).toBe(429);
  expect(response.headers['content-type']).toMatch(/^text\/html/);
  expect(parse(response.text).text('h1')).toBe('Too many attempts');
  const retryAfter = Number(response.headers['retry-after']);
  expect(Number.isInteger(retryAfter)).toBe(true);
  expect(retryAfter).toBeGreaterThan(0);
  expect(retryAfter).toBeLessThanOrEqual(windowSeconds);
}

/** `count` requests one after another (limiters count in order); returns their statuses. */
async function statuses(amount: number, send: (index: number) => PromiseLike<{ status: number }>): Promise<number[]> {
  const result: number[] = [];
  for (let index = 0; index < amount; index++) result.push((await send(index)).status);
  return result;
}

const all = (amount: number, status: number): number[] => Array.from({ length: amount }, () => status);

async function isGuest(agent: Agent, ip: string): Promise<boolean> {
  return (await agent.get('/profile').set('X-Forwarded-For', ip)).status === 302;
}

describe('POST /login', () => {
  it('F-26, B-10: the 11th failed login from one address is the 429 page, even with the right password', async () => {
    const user = await createUser(testApp.db, { email: uniqueEmail('ada') });
    const [ip = ''] = ips(1);
    const visitor = await guest(ip);

    const failed = await statuses(AUTH_LIMIT, () => login(visitor, ip, user.email, 'wrong password, guessed'));
    const verifiesBefore = hasher.verifyCalls.length;
    const limited = await login(visitor, ip, user.email, user.password);

    expect(failed).toEqual(all(AUTH_LIMIT, 401));
    expectTooManyAttempts(limited, QUARTER_HOUR_S);
    // The limiter runs before the handler: a blocked attempt never reaches the password hasher (ADR 0009, 0012).
    expect(hasher.verifyCalls.length).toBe(verifiesBefore);
    expect(await isGuest(visitor.agent, ip)).toBe(true);
  });

  it('F-26, ADR 0012: failures for one email are counted across addresses; the 101st in an hour is 429', async () => {
    const user = await createUser(testApp.db, { email: uniqueEmail('ada') });
    const addresses = ips(LOGIN_EMAIL_LIMIT / AUTH_LIMIT + 3); // 10 addresses with 10 failures each, 3 fresh ones
    const visitor = await guest(addresses[0] ?? '');
    const attackers = addresses.slice(0, LOGIN_EMAIL_LIMIT / AUTH_LIMIT);
    const [fresh = '', other = '', owner = ''] = addresses.slice(attackers.length);

    const failed: number[] = [];
    for (const ip of attackers) {
      failed.push(...(await statuses(AUTH_LIMIT, () => login(visitor, ip, user.email, 'not the password'))));
    }

    expect(failed).toEqual(all(LOGIN_EMAIL_LIMIT, 401));
    // The 101st failure comes from an address that has not tried anything yet: blocked by the per-email limiter.
    expectTooManyAttempts(await login(visitor, fresh, user.email, 'not the password'), HOUR_S);
    // The address itself is not blocked: another email from it still gets an answer ...
    expect((await login(visitor, fresh, uniqueEmail('grace'), 'not the password')).status).toBe(401);
    // ... and the email is blocked everywhere, whatever the password and however it is spelled.
    expectTooManyAttempts(await login(visitor, other, `  ${user.email.toUpperCase()} `, 'not the password'), HOUR_S);
    const ownerVisitor = await guest(owner);
    expectTooManyAttempts(await login(ownerVisitor, owner, user.email, user.password), HOUR_S);
  });

  it('F-26, ADR 0012: successful logins are not counted against the email budget', async () => {
    const user = await createUser(testApp.db, { email: uniqueEmail('ada') });
    const addresses = ips(LOGIN_EMAIL_LIMIT / AUTH_LIMIT + 7);
    const attackers = addresses.slice(0, LOGIN_EMAIL_LIMIT / AUTH_LIMIT);
    const owners = addresses.slice(attackers.length, attackers.length + 5);
    const [last = '', blocked = ''] = addresses.slice(attackers.length + owners.length);
    const visitor = await guest(attackers[0] ?? '');

    // 99 failures: one below the per-email limit of 100 ...
    for (const [index, ip] of attackers.entries()) {
      const attempts = index === attackers.length - 1 ? AUTH_LIMIT - 1 : AUTH_LIMIT;
      expect(await statuses(attempts, () => login(visitor, ip, user.email, 'not the password'))).toEqual(
        all(attempts, 401),
      );
    }
    // ... then the owner logs in five times (each login signs that agent in, so each needs a fresh one) ...
    for (const ip of owners) {
      const ownerVisitor = await guest(ip);
      await login(ownerVisitor, ip, user.email, user.password).expect(303).expect('Location', '/signature');
    }

    // ... and the 100th failure is still allowed: had the successes counted, it would be the 105th attempt.
    expect((await login(visitor, last, user.email, 'not the password')).status).toBe(401);
    expectTooManyAttempts(await login(visitor, blocked, user.email, 'not the password'), HOUR_S);
  });
});

describe('POST /register', () => {
  it('F-26, B-10: the 11th attempt for one email is 429 from any address, and no account is created', async () => {
    const email = uniqueEmail('grace');
    const addresses = ips(AUTH_LIMIT + 3);
    const visitor = await guest(addresses[0] ?? '');
    const attempts = addresses.slice(0, AUTH_LIMIT);
    const [fresh = '', other = '', third = ''] = addresses.slice(AUTH_LIMIT);

    const answered = await statuses(AUTH_LIMIT, (index) => register(visitor, attempts[index] ?? '', email));

    expect(answered).toEqual(all(AUTH_LIMIT, 422));
    // Every attempt counts (ADR 0012): even a valid registration is blocked now, wherever it comes from.
    expectTooManyAttempts(await register(visitor, fresh, email, 'a long enough password'), QUARTER_HOUR_S);
    expectTooManyAttempts(
      await register(visitor, other, ` ${email.toUpperCase()}`, 'a long enough password'),
      QUARTER_HOUR_S,
    );
    expect(await testApp.db.select({ id: users.id }).from(users).where(eq(users.email, email))).toEqual([]);
    // Another email from a fresh address is not affected.
    expect((await register(visitor, third, uniqueEmail('grace'))).status).toBe(422);
  });

  it('F-26, B-10: login and register share one budget per address (auth-ip); the 11th POST is 429', async () => {
    const [ip = '', neighbour = ''] = ips(2);
    const visitor = await guest(ip);

    const answered = await statuses(AUTH_LIMIT, (index) =>
      index % 2 === 0
        ? login(visitor, ip, uniqueEmail('nobody'), 'not the password')
        : register(visitor, ip, uniqueEmail('grace')),
    );

    expect(answered).toEqual(Array.from({ length: AUTH_LIMIT }, (_, index) => (index % 2 === 0 ? 401 : 422)));
    expectTooManyAttempts(await register(visitor, ip, uniqueEmail('grace')), QUARTER_HOUR_S);
    expectTooManyAttempts(await login(visitor, ip, uniqueEmail('nobody'), 'not the password'), QUARTER_HOUR_S);
    // IPv4 addresses are keyed one by one: the next address has its own budget.
    expect((await login(visitor, neighbour, uniqueEmail('nobody'), 'not the password')).status).toBe(401);
  });
});

interface Member {
  user: TestUser;
  agent: Agent;
  csrf: string;
}

/** A signed-in user; the limiters below key by the user, so the setup requests need no client address. */
async function member(): Promise<Member> {
  const user = await createUser(testApp.db, { email: uniqueEmail('member') });
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { user, agent, csrf: (await getForm(agent, '/', 'form[action="/logout"]')).csrf };
}

function deleteAccount({ agent, csrf }: Member, ip: string, currentPassword: string) {
  return postForm(agent, '/account/delete', { _csrf: csrf, currentPassword }).set('X-Forwarded-For', ip);
}

function editProfile({ agent, csrf, user }: Member, ip: string, changes: Record<string, string>) {
  return postForm(agent, '/profile/edit', {
    _csrf: csrf,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    age: '',
    city: '',
    homepage: '',
    newPassword: '',
    currentPassword: '',
    ...changes,
  }).set('X-Forwarded-For', ip);
}

const accountExists = async (userId: number): Promise<boolean> =>
  (await testApp.db.select({ id: users.id }).from(users).where(eq(users.id, userId))).length === 1;

describe('POST /account/delete (reauth)', () => {
  it('F-26, ADR 0012: the 6th attempt of one user is 429 from any address, even with the right password', async () => {
    const addresses = ips(REAUTH_LIMIT + 2);
    const owner = await member();
    const bystander = await member();

    const wrong = await statuses(REAUTH_LIMIT, (index) => deleteAccount(owner, addresses[index] ?? '', 'wrong guess'));
    const limited = await deleteAccount(owner, addresses[REAUTH_LIMIT] ?? '', owner.user.password);

    expect(wrong).toEqual(all(REAUTH_LIMIT, 422));
    expectTooManyAttempts(limited, QUARTER_HOUR_S);
    expect(await accountExists(owner.user.id)).toBe(true);
    // The budget belongs to the user: another user on the same address deletes their account.
    await deleteAccount(bystander, addresses[0] ?? '', bystander.user.password)
      .expect(303)
      .expect('Location', '/');
    expect(await accountExists(bystander.user.id)).toBe(false);
  });

  it('F-26, ADR 0012: profile edits that check the current password share the budget; other edits do not count', async () => {
    const [ip = ''] = ips(1);
    const guesser = await member();
    const editor = await member();

    // Three wrong passwords on the delete form and two on an email change: five re-authentications.
    const answered = [
      ...(await statuses(3, () => deleteAccount(guesser, ip, 'wrong guess'))),
      ...(await statuses(2, () =>
        editProfile(guesser, ip, { email: uniqueEmail('new'), currentPassword: 'wrong guess' }),
      )),
    ];
    expect(answered).toEqual(all(REAUTH_LIMIT, 422));
    expectTooManyAttempts(await deleteAccount(guesser, ip, guesser.user.password), QUARTER_HOUR_S);

    // Name edits check no password and never touch the budget, however many there are, also when a password manager
    // filled in the current password.
    const edits = await statuses(REAUTH_LIMIT * 2, (index) =>
      editProfile(editor, ip, {
        firstName: `Grace ${String(index)}`,
        ...(index % 2 === 0 ? {} : { currentPassword: editor.user.password }),
      }),
    );
    expect(edits).toEqual(all(REAUTH_LIMIT * 2, 303));
    await deleteAccount(editor, ip, editor.user.password).expect(303).expect('Location', '/');
  });
});

describe('POST /signature (sign)', () => {
  it('F-26, B-10: the 21st submission of one user in an hour is 429 and stores nothing', async () => {
    const addresses = ips(SIGN_LIMIT + 1);
    const signer = await member();
    const other = await member();
    const sign = (visitor: Member, ip: string, typedName: string) =>
      postForm(visitor.agent, '/signature', { _csrf: visitor.csrf, method: 'typed', typedName }).set(
        'X-Forwarded-For',
        ip,
      );

    // Rejected submissions count too: a client cannot probe the validator without limit.
    const rejected = await statuses(SIGN_LIMIT, (index) => sign(signer, addresses[index] ?? '', ''));
    const limited = await sign(signer, addresses[SIGN_LIMIT] ?? '', 'Grace Hopper');

    expect(rejected).toEqual(all(SIGN_LIMIT, 422));
    expectTooManyAttempts(limited, HOUR_S);
    // F-09: the 429 page keeps the signed-in navigation (the viewer is loaded before the limiters).
    expect(parse(limited.text).has('form[action="/logout"] input[name="_csrf"]')).toBe(true);
    expect(
      await testApp.db.select({ id: signatures.id }).from(signatures).where(eq(signatures.userId, signer.user.id)),
    ).toEqual([]);
    // Another user is not affected.
    await sign(other, addresses[0] ?? '', 'Grace Hopper')
      .expect(303)
      .expect('Location', '/thank-you');
  });
});
