import { setTimeout as delay } from 'node:timers/promises';

import { sql } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import { postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp, type TestAppOverrides } from '../../../../test/test-app.js';

/**
 * Sessions on the real app (ADR 0002, F-28, F-29, F-31, B-04): cookie name and flags, what Redis holds, the idle
 * timeout as the Redis TTL, the absolute lifetime with a fake clock, and the no-500 regressions for stale, expired,
 * ghost and tampered cookies.
 */

let testApp: TestApp | undefined;

async function start(overrides: TestAppOverrides = {}): Promise<TestApp> {
  testApp = await createTestApp(overrides);
  return testApp;
}

afterEach(async () => {
  await testApp?.close();
  testApp = undefined;
});

const COOKIE = 'petition.sid';
/** Only technical fields may be stored in a session (F-28, ADR 0002 item 5). */
const ALLOWED_SESSION_FIELDS = ['cookie', 'userId', 'sessionVersion', 'issuedAt', 'csrfBound', 'flash'];

function setCookies(response: Response): string[] {
  const header: unknown = response.headers['set-cookie'];
  return Array.isArray(header) ? header.map(String) : [];
}

/** The `Set-Cookie` line of `name`, or undefined. */
function cookieLine(response: Response, name: string): string | undefined {
  return setCookies(response).find((line) => line.startsWith(`${name}=`));
}

/** The session id inside a signed express-session cookie value (`s:<id>.<signature>`, URL-encoded). */
function sessionIdOf(response: Response, name = COOKIE): string {
  const line = cookieLine(response, name);
  const value = decodeURIComponent(line?.slice(name.length + 1).split(';')[0] ?? '');
  const match = /^s:(.+)\.[^.]+$/.exec(value);
  if (match?.[1] === undefined) throw new Error(`no ${name} cookie in the response`);
  return match[1];
}

const sessionKey = ({ prefix }: TestApp, sessionId: string): string => `${prefix}:sess:${sessionId}`;

/**
 * Changes made "elsewhere" (another device, another request), straight in the database. `shared` may not import the
 * `db` schema (OVERVIEW.md section 7), so the statements name the table; values stay bound parameters.
 */
const deleteUser = (app: TestApp, userId: number) => app.db.execute(sql`delete from users where id = ${userId}`);
const bumpSessionVersion = (app: TestApp, userId: number) =>
  app.db.execute(sql`update users set session_version = session_version + 1 where id = ${userId}`);

/** The header shows the logout form only to a signed-in viewer, and the login link only to guests (F-14). */
function navigationOf(response: Response): 'signed-in' | 'guest' {
  const page = parse(response.text);
  const signedIn = page.has('form[action="/logout"]');
  const guest = page.has('.site-header a[href="/login"]');
  if (signedIn === guest) throw new Error('the page has no unambiguous navigation');
  return signedIn ? 'signed-in' : 'guest';
}

/** A signed-in agent and the id of its session, read from the rolling cookie of a page request. */
async function signedInAgent(app: TestApp, userId: number): Promise<{ agent: Agent; sessionId: string }> {
  const agent = request.agent(app.app);
  await signIn(agent, userId);
  const page = await agent.get('/').expect(200);
  expect(navigationOf(page)).toBe('signed-in');
  return { agent, sessionId: sessionIdOf(page) };
}

describe('session cookie and store', () => {
  it('F-28, B-04, ADR 0003: a guest page creates no session and sets no cookie at all', async () => {
    const app = await start();

    const response = await request(app.app).get('/').expect(200);

    expect(setCookies(response)).toEqual([]);
    expect(await app.redis.keys(`${app.prefix}:sess:*`)).toEqual([]);
  });

  it('F-28, B-04: the cookie is petition.sid, HttpOnly, SameSite=Lax, Path=/ and not Secure over plain http', async () => {
    const app = await start();
    const user = await createUser(app.db);

    const response = await request(app.app).post('/__test/sign-in').send({ userId: user.id }).expect(204);

    const line = cookieLine(response, COOKIE) ?? '';
    expect(line).not.toBe('');
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Path=\/(;|$)/);
    expect(line).not.toMatch(/;\s*Secure/i);
    expect(line).not.toMatch(/;\s*Domain=/i);
  });

  it('F-28, ADR 0002: served over https the cookie is __Host-petition.sid and Secure', async () => {
    const app = await start({ env: { COOKIE_SECURE: 'true' }, trustProxy: 1 });
    const user = await createUser(app.db);

    const response = await request(app.app)
      .post('/__test/sign-in')
      .set('X-Forwarded-Proto', 'https')
      .send({ userId: user.id })
      .expect(204);

    const line = cookieLine(response, `__Host-${COOKIE}`) ?? '';
    expect(line).toMatch(/;\s*Secure/i);
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*Path=\/(;|$)/);
    expect(line).not.toMatch(/;\s*Domain=/i);
    expect(cookieLine(response, COOKIE)).toBeUndefined();
  });

  it('F-28, B-04, B-35: Redis holds only technical fields, never names, emails or signature data', async () => {
    const app = await start();
    const user = await createUser(app.db, { firstName: 'Grace', lastName: 'Hopper' });
    await createSignature(app.db, user.id); // a signer: "has signed" is loaded per request, never stored
    const { sessionId } = await signedInAgent(app, user.id);

    const stored = (await app.redis.get(sessionKey(app, sessionId))) ?? '';

    const fields = Object.keys(JSON.parse(stored) as object);
    expect(fields).toEqual(expect.arrayContaining(['userId', 'sessionVersion', 'issuedAt']));
    expect(fields.every((field) => ALLOWED_SESSION_FIELDS.includes(field))).toBe(true);
    expect(stored).not.toContain('Grace');
    expect(stored).not.toContain('Hopper');
    expect(stored).not.toContain(user.email);
  });

  it('F-23, ADR 0002 item 6: signing in again rotates the session id and deletes the old store entry', async () => {
    const app = await start();
    const user = await createUser(app.db);
    const { agent, sessionId } = await signedInAgent(app, user.id);

    await signIn(agent, user.id);
    const page = await agent.get('/').expect(200);

    expect(sessionIdOf(page)).not.toBe(sessionId);
    expect(await app.redis.exists(sessionKey(app, sessionId))).toBe(0);
    expect(navigationOf(page)).toBe('signed-in');
  });
});

describe('idle timeout', () => {
  it('F-29, ADR 0002 item 4: the Redis TTL is the idle timeout and every request renews it', async () => {
    const idleMs = 2_000;
    const app = await start({ sessionPolicy: { idleMs } });
    const user = await createUser(app.db);
    const { agent, sessionId } = await signedInAgent(app, user.id);
    const key = sessionKey(app, sessionId);

    const fresh = await app.redis.pTTL(key);
    expect(fresh).toBeGreaterThan(0);
    expect(fresh).toBeLessThanOrEqual(idleMs);

    await delay(400);
    const aged = await app.redis.pTTL(key);
    const page = await agent.get('/').expect(200);
    const renewed = await app.redis.pTTL(key);

    expect(aged).toBeLessThan(fresh);
    expect(renewed).toBeGreaterThan(aged);
    expect(renewed).toBeLessThanOrEqual(idleMs);
    // rolling: the cookie's lifetime is renewed with the store entry
    expect(cookieLine(page, COOKIE)).toMatch(/;\s*Expires=/i);
  });

  it('F-09, F-29: an idle-expired session (store entry gone) is a guest on the next request, never a 500', async () => {
    const app = await start();
    const user = await createUser(app.db);
    const { agent, sessionId } = await signedInAgent(app, user.id);

    await app.redis.del(sessionKey(app, sessionId)); // what Redis does when the TTL runs out

    const page = await agent.get('/').expect(200);
    expect(navigationOf(page)).toBe('guest');
    await agent.get('/no-such-page').expect(404);
  });
});

describe('absolute lifetime (fake clock)', () => {
  const absoluteMs = 60_000;

  function fakeClock() {
    let now = 1_700_000_000_000;
    return {
      now: () => now,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it('F-29, ADR 0002 item 4: a session older than absoluteMs is regenerated and continues as a guest', async () => {
    const clock = fakeClock();
    const app = await start({ sessionPolicy: { absoluteMs, now: clock.now } });
    const user = await createUser(app.db);
    const { agent, sessionId } = await signedInAgent(app, user.id);

    clock.advance(absoluteMs - 1);
    expect(navigationOf(await agent.get('/').expect(200))).toBe('signed-in');

    clock.advance(1);
    const expired = await agent.get('/').expect(200);

    expect(navigationOf(expired)).toBe('guest');
    expect(await app.redis.exists(sessionKey(app, sessionId))).toBe(0);
    // Whatever express-session stores for the replacement session is anonymous.
    const replacement = sessionIdOf(expired);
    expect(replacement).not.toBe(sessionId);
    expect(JSON.parse((await app.redis.get(sessionKey(app, replacement))) ?? '{}')).not.toHaveProperty('userId');
  });

  it('F-29: activity does not extend the absolute lifetime', async () => {
    const clock = fakeClock();
    const app = await start({ sessionPolicy: { absoluteMs, now: clock.now } });
    const user = await createUser(app.db);
    const { agent } = await signedInAgent(app, user.id);

    for (let step = 0; step < 3; step++) {
      clock.advance(absoluteMs / 3 - 1);
      expect(navigationOf(await agent.get('/').expect(200))).toBe('signed-in');
    }
    clock.advance(3);
    expect(navigationOf(await agent.get('/').expect(200))).toBe('guest');
  });

  it('F-09, F-29, ADR 0002: a form posted after the absolute expiry gets the 403 page, never a 500', async () => {
    const clock = fakeClock();
    const app = await start({ sessionPolicy: { absoluteMs, now: clock.now } });
    const user = await createUser(app.db);
    const { agent } = await signedInAgent(app, user.id);
    const { csrf } = readForm((await agent.get('/').expect(200)).text, 'form[action="/logout"]');

    clock.advance(absoluteMs);
    const response = await postForm(agent, '/profile/edit', { _csrf: csrf, firstName: 'Ada' });

    expect(response.status).toBe(403);
    expect(parse(response.text).text('h1')).toBe('This form has expired');
    expect(navigationOf(response)).toBe('guest');
  });
});

describe('stale and broken cookies never cause a 500', () => {
  it('F-09, F-31, B-05: the cookie of a deleted account shows the guest page, also on the next request', async () => {
    const app = await start();
    const user = await createUser(app.db);
    const { agent, sessionId } = await signedInAgent(app, user.id);

    await deleteUser(app, user.id);

    expect(navigationOf(await agent.get('/').expect(200))).toBe('guest');
    expect(navigationOf(await agent.get('/').expect(200))).toBe('guest');
    expect(await app.redis.exists(sessionKey(app, sessionId))).toBe(0);
  });

  it('F-09, F-31, ADR 0002 item 9: a session_version bumped elsewhere (password change) shows the guest page', async () => {
    const app = await start();
    const user = await createUser(app.db);
    const { agent } = await signedInAgent(app, user.id);

    await bumpSessionVersion(app, user.id);

    expect(navigationOf(await agent.get('/').expect(200))).toBe('guest');
  });

  it('F-09, B-05, ADR 0002: a ghost cookie on a POST with its valid old token gets the 403 page', async () => {
    const app = await start();
    const user = await createUser(app.db);
    const { agent } = await signedInAgent(app, user.id);
    const { csrf } = readForm((await agent.get('/').expect(200)).text, 'form[action="/logout"]');

    await deleteUser(app, user.id);
    const response = await postForm(agent, '/__test/form', { _csrf: csrf, outcome: 'valid' });

    expect(response.status).toBe(403);
    expect(parse(response.text).text('h1')).toBe('This form has expired');
  });

  it('F-09, B-04: a cookie with a forged signature is ignored: guest page, no new session', async () => {
    const app = await start();
    const user = await createUser(app.db);
    const { sessionId } = await signedInAgent(app, user.id);

    const forged = `${COOKIE}=${encodeURIComponent(`s:${sessionId}.forged-signature`)}`;
    const response = await request(app.app).get('/').set('Cookie', forged).expect(200);

    expect(navigationOf(response)).toBe('guest');
    expect(setCookies(response)).toEqual([]);
  });

  it('F-09: a signed-in visitor on an unknown path gets the 404 page with the signed-in navigation', async () => {
    const app = await start();
    const user = await createUser(app.db);
    const { agent } = await signedInAgent(app, user.id);

    const response = await agent.get('/no-such-page').expect(404);

    expect(navigationOf(response)).toBe('signed-in');
  });
});
