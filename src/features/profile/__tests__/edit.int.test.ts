import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser, type TestUser } from '../../../../test/factories.js';
import { createFakeHasher } from '../../../../test/fakes.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { profiles, users } from '../../../db/schema/index.js';

/**
 * `GET`/`POST /profile/edit` on the real app (ROUTES.md section 4): prefill (F-60), validation (F-61), one
 * transaction (F-62, F-64, B-29), re-authentication for email and password changes (F-63, B-11, ADR 0009), clearing
 * fields (F-65), the delete links (F-66, B-47), the session after a password change (ADR 0002), guards, CSRF and the
 * conditional `reauth` limiter (ADR 0012). Signed-in agents come from `signIn` (ADR 0017).
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const FORM = 'main form[action="/profile/edit"]';
const NEW_PASSWORD = 'a brand new passphrase';
/** Hashes of the fake hasher are self-describing, so any instance verifies them (test/fakes.ts). */
const hashes = createFakeHasher();

async function signedInAgent(
  app: TestApp = testApp,
  overrides: Parameters<typeof createUser>[1] = {},
): Promise<{ agent: Agent; user: TestUser }> {
  const user = await createUser(app.db, overrides);
  const agent = request.agent(app.app);
  await signIn(agent, user.id);
  return { agent, user };
}

async function storedUser(userId: number) {
  const [row] = await testApp.db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      passwordHash: users.passwordHash,
      sessionVersion: users.sessionVersion,
    })
    .from(users)
    .where(eq(users.id, userId));
  if (row === undefined) throw new Error(`user ${String(userId)} is gone`);
  return row;
}

async function storedProfile(userId: number) {
  const [row] = await testApp.db
    .select({ age: profiles.age, city: profiles.city, homepageUrl: profiles.homepageUrl })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return row;
}

/** Submits the edit form as the browser would: the current prefill and token, then `fields` on top. */
async function submit(agent: Agent, fields: Readonly<Record<string, string>>): Promise<Response> {
  const { csrf, values } = await getForm(agent, '/profile/edit', FORM);
  return postForm(agent, '/profile/edit', { ...values, _csrf: csrf, ...fields });
}

function expectRedirect(response: Response, status: number, location: string): void {
  expect(response.status).toBe(status);
  expect(response.headers['location']).toBe(location);
}

/** A 422 re-render of the edit page with `message` on `field` (F-21, ADR 0008). */
function expectFieldError(response: Response, field: string, message: string): void {
  expect(response.status).toBe(422);
  const page = parse(response.text);
  expect(page.text('title')).toBe('Edit profile · Nonsense Petition');
  expect(page.has('.error-summary[role="alert"]')).toBe(true);
  expect(page.texts('.error-summary__link')).toContain(message);
  expect(page.attr(`.error-summary__link[href="#${field}"]`, 'href')).toBe(`#${field}`);
  expect(page.attr(`#${field}`, 'aria-invalid')).toBe('true');
  expect(page.text(`#${field}-error`)).toBe(`Error: ${message}`);
  // B-11: password values are never echoed back
  expect(page.attr('#newPassword', 'value')).toBe('');
  expect(page.attr('#currentPassword', 'value')).toBe('');
}

/** The session cookie (`name=value`) a response sets; the session is rolling, so every page response sets it. */
function sessionCookie(response: Response): string {
  const header: unknown = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header.filter((entry): entry is string => typeof entry === 'string') : [];
  const cookie = cookies.find((entry) => /^(__Host-)?petition\.sid=/.test(entry));
  if (cookie === undefined) throw new Error('the response set no session cookie');
  return cookie.split(';')[0] ?? '';
}

describe('GET /profile/edit', () => {
  it('F-07, F-30: a guest is sent to the login page with returnTo', async () => {
    expectRedirect(await request(testApp.app).get('/profile/edit'), 302, '/login?returnTo=%2Fprofile%2Fedit');
  });

  it('F-60, B-11, B-72: prefilled names, email and profile; both password fields empty with the right types', async () => {
    const { agent, user } = await signedInAgent(testApp, {
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@petition.test',
    });
    await testApp.db.insert(profiles).values({ userId: user.id, age: 85, homepageUrl: 'https://grace.example/' });

    const response = await agent.get('/profile/edit');

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const page = parse(response.text);
    expect(page.text('title')).toBe('Edit profile · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['Edit profile']);
    expect(page.has(`${FORM}[method="post"][novalidate][data-guard]`)).toBe(true);
    expect(readForm(response.text, FORM).values).toEqual({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@petition.test',
      age: '85',
      city: '',
      homepage: 'https://grace.example/',
      newPassword: '',
      currentPassword: '',
    });

    expect(page.attr('#firstName', 'autocomplete')).toBe('given-name');
    expect(page.attr('#lastName', 'autocomplete')).toBe('family-name');
    expect(page.attr('#email', 'type')).toBe('email');
    expect(page.attr('#email', 'autocomplete')).toBe('email');
    expect(page.attr('#age', 'type')).toBe('text');
    expect(page.attr('#age', 'inputmode')).toBe('numeric');
    expect(page.attr('#homepage', 'type')).toBe('url');
    expect(page.attr('#city', 'autocomplete')).toBe('address-level2');

    expect(page.attr('#newPassword', 'type')).toBe('password');
    expect(page.attr('#newPassword', 'autocomplete')).toBe('new-password');
    expect(page.attr('#newPassword', 'aria-describedby')).toBe('newPassword-hint');
    expect(page.text('#newPassword-hint')).toBe('Leave empty to keep your password');
    expect(page.attr('#currentPassword', 'type')).toBe('password');
    expect(page.attr('#currentPassword', 'autocomplete')).toBe('current-password');
    expect(page.text('#currentPassword-hint')).toBe('Needed only when you change your email or password');
    expect(response.text).not.toContain(user.passwordHash);

    expect(page.text(`${FORM} button[type="submit"].button--primary`)).toBe('save changes');
    expect(page.has(`${FORM} a[href="/privacy"]`)).toBe(true);
  });

  it('B-55: a user who skipped onboarding (no profile row) can open the page with empty optional fields', async () => {
    const { agent } = await signedInAgent();

    const { values } = await getForm(agent, '/profile/edit', FORM);

    expect(values).toMatchObject({ age: '', city: '', homepage: '' });
  });

  it('F-66, B-47: "delete signature" is linked only for a signer; "delete account" always', async () => {
    const unsigned = await signedInAgent();
    const unsignedPage = parse((await unsigned.agent.get('/profile/edit')).text);
    expect(unsignedPage.has('a[href="/signature/delete"]')).toBe(false);
    expect(unsignedPage.text('main a[href="/account/delete"] .list-row__title')).toBe('delete account');

    const signed = await signedInAgent();
    await createSignature(testApp.db, signed.user.id);
    const signedPage = parse((await signed.agent.get('/profile/edit')).text);
    expect(signedPage.text('main a[href="/signature/delete"] .list-row__title')).toBe('delete signature');
    expect(signedPage.has('main a[href="/account/delete"]')).toBe(true);
  });
});

describe('POST /profile/edit: names and profile', () => {
  it('F-62, F-17: saves names and profile without a password, 303 back with the flash "Profile updated" shown once', async () => {
    const { agent, user } = await signedInAgent();

    const response = await submit(agent, {
      firstName: '  Augusta  Ada ',
      lastName: 'King',
      age: '36',
      city: 'London',
      homepage: 'ada.example',
    });

    expectRedirect(response, 303, '/profile/edit');
    await expect(storedUser(user.id)).resolves.toMatchObject({
      firstName: 'Augusta Ada',
      lastName: 'King',
      email: user.email,
      passwordHash: user.passwordHash,
      sessionVersion: 0,
    });
    await expect(storedProfile(user.id)).resolves.toEqual({
      age: 36,
      city: 'London',
      homepageUrl: 'https://ada.example/',
    });

    const next = parse((await agent.get('/profile/edit')).text);
    expect(next.text('.flash[role="status"] .flash__message')).toBe('Profile updated');
    expect(next.attr('#firstName', 'value')).toBe('Augusta Ada');
    const again = parse((await agent.get('/profile/edit')).text);
    expect(again.has('.flash__message')).toBe(false);
  });

  it('F-65: clearing age, city and homepage stores NULL', async () => {
    const { agent, user } = await signedInAgent();
    await testApp.db
      .insert(profiles)
      .values({ userId: user.id, age: 40, city: 'Paris', homepageUrl: 'https://paris.example/' });

    expectRedirect(await submit(agent, { age: '', city: '  ', homepage: '' }), 303, '/profile/edit');

    await expect(storedProfile(user.id)).resolves.toEqual({ age: null, city: null, homepageUrl: null });
  });

  const invalid = [
    { field: 'firstName', value: '', message: 'Enter your first name' },
    { field: 'lastName', value: 'x'.repeat(101), message: 'Last name must be 100 characters or fewer' },
    { field: 'email', value: 'not-an-email', message: 'Enter a valid email address, like name@example.com' },
    { field: 'age', value: '12.5', message: 'Age must be a whole number between 1 and 120' },
    { field: 'homepage', value: 'ftp://example.com', message: 'Enter a web address like https://example.com' },
    { field: 'newPassword', value: 'too short', message: 'Password must be at least 12 characters' },
  ];

  it.each(invalid)(
    'F-61, B-29: $field "$value" gives 422 with the inline message, the values kept, nothing saved',
    async ({ field, value, message }) => {
      const { agent, user } = await signedInAgent();
      const before = await storedUser(user.id);

      const response = await submit(agent, { firstName: 'Changed', city: 'Rome', [field]: value });

      expectFieldError(response, field, message);
      const kept = readForm(response.text, FORM).values;
      if (field !== 'newPassword') expect(kept[field]).toBe(value);
      expect(kept['city']).toBe('Rome');
      await expect(storedUser(user.id)).resolves.toEqual(before);
      await expect(storedProfile(user.id)).resolves.toBeUndefined();
    },
  );

  it('F-21, ADR 0003: the 422 page carries a fresh token that is accepted on resubmit', async () => {
    const { agent, user } = await signedInAgent();

    const rejected = await submit(agent, { firstName: '' });
    expect(rejected.status).toBe(422);
    const { csrf, values } = readForm(rejected.text, FORM);

    const corrected = await postForm(agent, '/profile/edit', { ...values, _csrf: csrf, firstName: 'Ada' });

    expectRedirect(corrected, 303, '/profile/edit');
    await expect(storedUser(user.id)).resolves.toMatchObject({ firstName: 'Ada' });
  });
});

describe('POST /profile/edit: email and password (F-63, B-11, ADR 0009)', () => {
  it('B-11: an email change without the current password gives 422 and saves nothing, names included', async () => {
    const { agent, user } = await signedInAgent();

    const response = await submit(agent, { firstName: 'Changed', email: 'new-address@petition.test' });

    expectFieldError(response, 'currentPassword', 'Enter your current password to change your email or password');
    expect(readForm(response.text, FORM).values).toMatchObject({
      firstName: 'Changed',
      email: 'new-address@petition.test',
    });
    await expect(storedUser(user.id)).resolves.toMatchObject({ firstName: 'Ada', email: user.email });
  });

  it('B-11: a new password without the current password gives 422 and keeps the old hash', async () => {
    const { agent, user } = await signedInAgent();

    expectFieldError(
      await submit(agent, { newPassword: NEW_PASSWORD }),
      'currentPassword',
      'Enter your current password to change your email or password',
    );
    await expect(storedUser(user.id)).resolves.toMatchObject({ passwordHash: user.passwordHash, sessionVersion: 0 });
  });

  it('B-11: a wrong current password gives 422 "The password is incorrect" and saves nothing', async () => {
    const { agent, user } = await signedInAgent();

    const response = await submit(agent, {
      email: 'other@petition.test',
      newPassword: NEW_PASSWORD,
      currentPassword: 'definitely not it',
    });

    expectFieldError(response, 'currentPassword', 'The password is incorrect');
    await expect(storedUser(user.id)).resolves.toMatchObject({
      email: user.email,
      passwordHash: user.passwordHash,
      sessionVersion: 0,
    });
  });

  it('F-63, ADR 0007: with the current password the email changes, stored trimmed and lower-cased; the session stays', async () => {
    const { agent, user } = await signedInAgent();

    const response = await submit(agent, { email: '  Ada.New@Petition.TEST ', currentPassword: user.password });

    expectRedirect(response, 303, '/profile/edit');
    await expect(storedUser(user.id)).resolves.toMatchObject({
      email: 'ada.new@petition.test',
      passwordHash: user.passwordHash,
      sessionVersion: 0,
    });
    await agent.get('/profile/edit').expect(200);
  });

  it('F-64, B-29: an email another account has (any case) gives 422 on email and nothing is saved at all', async () => {
    const taken = await createUser(testApp.db, { email: 'taken@petition.test' });
    const { agent, user } = await signedInAgent();
    await testApp.db.insert(profiles).values({ userId: user.id, age: 20 });

    const response = await submit(agent, {
      firstName: 'Changed',
      age: '99',
      city: 'Oslo',
      email: 'TAKEN@petition.test',
      newPassword: NEW_PASSWORD,
      currentPassword: user.password,
    });

    expectFieldError(response, 'email', 'An account with this email already exists.');
    await expect(storedUser(user.id)).resolves.toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: user.email,
      passwordHash: user.passwordHash,
      sessionVersion: 0,
    });
    await expect(storedProfile(user.id)).resolves.toEqual({ age: 20, city: null, homepageUrl: null });
    await expect(storedUser(taken.id)).resolves.toMatchObject({ email: 'taken@petition.test' });
    await agent.get('/profile/edit').expect(200);
  });

  it('ADR 0002, ADR 0009: a new password is stored, ends other sessions and gives this agent a new session id', async () => {
    const { agent, user } = await signedInAgent();
    const otherDevice = request.agent(testApp.app);
    await signIn(otherDevice, user.id);
    const oldCookie = sessionCookie(await agent.get('/profile/edit'));

    const response = await submit(agent, { newPassword: NEW_PASSWORD, currentPassword: user.password });

    expectRedirect(response, 303, '/profile/edit');
    expect(sessionCookie(response)).not.toBe(oldCookie);
    const stored = await storedUser(user.id);
    expect(stored.sessionVersion).toBe(1);
    await expect(hashes.verify(stored.passwordHash, NEW_PASSWORD)).resolves.toBe(true);
    await expect(hashes.verify(stored.passwordHash, user.password)).resolves.toBe(false);

    // this agent stays signed in and sees the flash; the other device and the old session id are guests now
    const next = await agent.get('/profile/edit');
    expect(next.status).toBe(200);
    expect(parse(next.text).text('.flash__message')).toBe('Profile updated');
    expectRedirect(await otherDevice.get('/profile/edit'), 302, '/login?returnTo=%2Fprofile%2Fedit');
    expectRedirect(
      await request(testApp.app).get('/profile/edit').set('Cookie', oldCookie),
      302,
      '/login?returnTo=%2Fprofile%2Fedit',
    );
  });

  it('F-63: an empty new password keeps the password, even when a current password is typed', async () => {
    const { agent, user } = await signedInAgent();

    expectRedirect(
      await submit(agent, { newPassword: '', currentPassword: user.password, lastName: 'Byron' }),
      303,
      '/profile/edit',
    );
    await expect(storedUser(user.id)).resolves.toMatchObject({
      lastName: 'Byron',
      passwordHash: user.passwordHash,
      sessionVersion: 0,
    });
  });
});

describe('POST /profile/edit: guards, CSRF and ownership', () => {
  it('F-70: a POST without a CSRF token gets the 403 page and saves nothing', async () => {
    const { agent, user } = await signedInAgent();
    const { values } = await getForm(agent, '/profile/edit', FORM);

    const response = await postForm(agent, '/profile/edit', { ...values, firstName: 'Changed' });

    expect(response.status).toBe(403);
    expect(parse(response.text).text('h1')).toBe('This form has expired');
    await expect(storedUser(user.id)).resolves.toMatchObject({ firstName: 'Ada' });
  });

  it('F-07: a guest POST is refused before any route runs (403, no session to bind a token to)', async () => {
    const response = await postForm(request.agent(testApp.app), '/profile/edit', { _csrf: 'x', firstName: 'Eve' });

    expect(response.status).toBe(403);
  });

  it('F-31: a session whose account was deleted meanwhile is a guest; its POST changes nothing', async () => {
    const { agent, user } = await signedInAgent();
    const { csrf, values } = await getForm(agent, '/profile/edit', FORM);
    await testApp.db.delete(users).where(eq(users.id, user.id));

    const response = await postForm(agent, '/profile/edit', { ...values, _csrf: csrf, firstName: 'Ghost' });

    // the ghost session is regenerated as a guest (ADR 0002), so the token bound to the old id fails: never a 500
    expect(response.status).toBe(403);
    expect(await testApp.db.$count(users, eq(users.firstName, 'Ghost'))).toBe(0);
  });

  it("ADR 0002: the account edited is always the viewer's own; a crafted userId field is ignored", async () => {
    const victim = await signedInAgent();
    const { agent, user } = await signedInAgent();

    const response = await submit(agent, { userId: String(victim.user.id), firstName: 'Mallory', city: 'Elsewhere' });

    expectRedirect(response, 303, '/profile/edit');
    await expect(storedUser(user.id)).resolves.toMatchObject({ firstName: 'Mallory' });
    await expect(storedUser(victim.user.id)).resolves.toMatchObject({ firstName: 'Ada' });
    await expect(storedProfile(victim.user.id)).resolves.toBeUndefined();
  });
});

describe('POST /profile/edit: the reauth limiter (ADR 0012)', () => {
  let limited: TestApp;

  beforeAll(async () => {
    limited = await createTestApp({ rateLimits: { reauthPer15Min: 2 } });
  });

  afterAll(async () => {
    await limited.close();
  });

  async function submitTo(agent: Agent, fields: Readonly<Record<string, string>>): Promise<Response> {
    const { csrf, values } = await getForm(agent, '/profile/edit', FORM);
    return postForm(agent, '/profile/edit', { ...values, _csrf: csrf, ...fields });
  }

  it('B-11, F-26: saves that check the current password are limited per user; other saves are not counted', async () => {
    const { agent } = await signedInAgent(limited);

    for (const city of ['Graz', 'Linz', 'Wels']) {
      expectRedirect(await submitTo(agent, { city }), 303, '/profile/edit');
    }
    // A password manager fills the current-password field of every save; without an email or password change the
    // password is not checked, so these saves do not count either (ADR 0012).
    for (const city of ['Enns', 'Ybbs', 'Melk']) {
      expectRedirect(await submitTo(agent, { city, currentPassword: 'autofilled password' }), 303, '/profile/edit');
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      expect((await submitTo(agent, { email: 'x@petition.test', currentPassword: 'guess guess' })).status).toBe(422);
    }

    const blocked = await submitTo(agent, { email: 'x@petition.test', currentPassword: 'guess guess' });

    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toMatch(/^\d+$/);
    expect(parse(blocked.text).text('h1')).toBe('Too many attempts');
    expectRedirect(await submitTo(agent, { city: 'Steyr' }), 303, '/profile/edit');

    const other = await signedInAgent(limited);
    expect((await submitTo(other.agent, { email: 'y@petition.test', currentPassword: 'guess guess' })).status).toBe(
      422,
    );
  });
});
