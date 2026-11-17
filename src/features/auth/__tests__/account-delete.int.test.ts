import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser, type TestUser } from '../../../../test/factories.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { profiles, signatures, users } from '../../../db/schema/index.js';
import { sessionCookieOf } from './fakes.js';

/**
 * `GET /account/delete` and `POST /account/delete` on the real app (ROUTES.md section 3, F-67 to F-69, ADR 0013):
 * the confirmation page, re-authentication with the current password, one cascading delete, the ended session with
 * its flash, re-registration with the same email, the guard, CSRF and the resubmit round trip.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const FORM = 'form[action="/account/delete"]';
const PATH = '/account/delete';

interface SignedIn {
  user: TestUser;
  agent: Agent;
  csrf: string;
  page: Response;
}

async function signedIn(): Promise<SignedIn> {
  const user = await createUser(testApp.db, { email: `ada-${randomUUID()}@example.com` });
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  const page = await agent.get(PATH).expect(200);
  return { user, agent, csrf: readForm(page.text, FORM).csrf, page };
}

const userExists = async (userId: number): Promise<boolean> =>
  (await testApp.db.select({ id: users.id }).from(users).where(eq(users.id, userId))).length === 1;

describe('GET /account/delete', () => {
  it('F-67: explains what is deleted and asks for the current password', async () => {
    const { page: response } = await signedIn();
    const page = parse(response.text);

    expect(page.text('title')).toBe('Delete account · Nonsense Petition');
    expect(page.text('h1')).toBe('Delete account');
    expect(page.texts('.confirm-panel__item')).toEqual([
      'Your account: your name, your email address and your password.',
      'Your profile: age, city and homepage, if you added them.',
      'Your signature, if you signed. The supporter count goes down by one.',
    ]);
    expect(page.attr(FORM, 'method')).toBe('post');
    expect(page.has(`${FORM}[novalidate][data-guard]`)).toBe(true);
    expect(page.attr(`${FORM} input[name="_csrf"]`, 'value')).not.toBe('');
    expect(page.attr('#currentPassword', 'type')).toBe('password');
    expect(page.attr('#currentPassword', 'autocomplete')).toBe('current-password');
    expect(page.text('label[for="currentPassword"]')).toBe('current password');
    expect(page.text(`${FORM} button[type="submit"]`)).toBe('delete my account');
    expect(page.text(`${FORM} a[href="/profile/edit"]`)).toBe('keep my account');
  });

  it('F-67, F-75, F-80: the password sits in the guarded form between the list and the actions, labelled above', async () => {
    const { page: response } = await signedIn();
    const page = parse(response.text);

    expect(page.has(`.confirm-panel ${FORM}.confirm-panel__form`)).toBe(true);
    const field = page.root.querySelector(`${FORM} .confirm-panel__fields .form-field`);
    expect(field?.firstElementChild?.tagName).toBe('LABEL');
    expect(field?.querySelector('input')?.getAttribute('id')).toBe('currentPassword');
    expect(page.has(`${FORM} [placeholder]`)).toBe(false);
    expect(page.texts(`${FORM} .confirm-panel__actions .button--primary`)).toEqual(['delete my account']);
    expect(page.attr(`${FORM} .confirm-panel__actions .confirm-panel__cancel`, 'href')).toBe('/profile/edit');
    expect(page.texts('main .button--primary')).toHaveLength(1);
    expect(page.has('.error-summary')).toBe(false);
  });

  it('F-07, F-30: a guest is sent to the login page with returnTo', async () => {
    await request(testApp.app).get(PATH).expect(302).expect('location', '/login?returnTo=%2Faccount%2Fdelete');
  });
});

describe('POST /account/delete', () => {
  it('F-67, ADR 0008: an empty password is 422 "Enter your current password" and nothing is deleted', async () => {
    const { user, agent, csrf } = await signedIn();

    const page = parse((await postForm(agent, PATH, { _csrf: csrf, currentPassword: '' }).expect(422)).text);

    expect(page.texts('.error-summary__link')).toEqual(['Enter your current password']);
    expect(page.attr('.error-summary__link', 'href')).toBe('#currentPassword');
    expect(page.attr('#currentPassword', 'aria-invalid')).toBe('true');
    // F-21: the summary is focused on load and comes before the panel; the message is tied to the field.
    expect(page.has('main .error-summary[role="alert"][tabindex="-1"][autofocus]')).toBe(true);
    expect(
      page.root.querySelector('main .error-summary')?.nextElementSibling?.classList.contains('confirm-panel'),
    ).toBe(true);
    expect(page.attr('#currentPassword', 'aria-describedby')).toBe('currentPassword-error');
    expect(page.text('#currentPassword-error')).toBe('Error: Enter your current password');
    expect(await userExists(user.id)).toBe(true);
  });

  it('F-67, B-34, B-11: a wrong password is 422 "The password is incorrect", nothing is deleted, nothing echoed', async () => {
    const { user, agent, csrf } = await signedIn();

    const response = await postForm(agent, PATH, { _csrf: csrf, currentPassword: 'guessed password' }).expect(422);
    const page = parse(response.text);

    expect(page.text('#currentPassword-error')).toBe('Error: The password is incorrect');
    expect(page.attr('#currentPassword', 'value')).toBe('');
    expect(response.text).not.toContain('guessed password');
    expect(await userExists(user.id)).toBe(true);
    await agent.get(PATH).expect(200);
  });

  it('F-21, ADR 0003: the 422 page carries a token that the corrected resubmit can use', async () => {
    const { user, agent, csrf } = await signedIn();
    const invalid = await postForm(agent, PATH, { _csrf: csrf, currentPassword: 'wrong' }).expect(422);

    const { csrf: fresh } = readForm(invalid.text, FORM);

    await postForm(agent, PATH, { _csrf: fresh, currentPassword: user.password }).expect(303).expect('location', '/');
    expect(await userExists(user.id)).toBe(false);
  });

  it('F-68, F-06, B-34: deletes the account with its profile and signature in one go, then 303 /', async () => {
    const { user, agent, csrf } = await signedIn();
    await testApp.db.insert(profiles).values({ userId: user.id, age: 36, city: 'London' });
    await createSignature(testApp.db, user.id);
    const bystander = await createUser(testApp.db);
    await createSignature(testApp.db, bystander.id);

    await postForm(agent, PATH, { _csrf: csrf, currentPassword: user.password }).expect(303).expect('location', '/');

    expect(await userExists(user.id)).toBe(false);
    expect(await testApp.db.select().from(profiles).where(eq(profiles.userId, user.id))).toHaveLength(0);
    expect(await testApp.db.select().from(signatures).where(eq(signatures.userId, user.id))).toHaveLength(0);
    expect(await userExists(bystander.id)).toBe(true);
    expect(await testApp.db.select().from(signatures).where(eq(signatures.userId, bystander.id))).toHaveLength(1);
  });

  it('F-68, F-17: the session ends and the home page shows "Your account was deleted" once', async () => {
    const { user, agent, csrf, page } = await signedIn();
    const oldCookie = sessionCookieOf(page);

    await postForm(agent, PATH, { _csrf: csrf, currentPassword: user.password }).expect(303);

    const home = parse((await agent.get('/').expect(200)).text);
    expect(home.text('.flash')).toBe('Your account was deleted');
    expect(home.has('form[action="/logout"]')).toBe(false);
    expect(parse((await agent.get('/').expect(200)).text).text('.flash')).toBe('');
    // The copied old cookie is a guest too (ADR 0002 item 6).
    await request(testApp.app).get(PATH).set('Cookie', oldCookie).expect(302);
  });

  it('F-69: after deletion the same email can register again', async () => {
    const { user, agent, csrf } = await signedIn();
    await postForm(agent, PATH, { _csrf: csrf, currentPassword: user.password }).expect(303);

    const { csrf: registerToken } = await getForm(agent, '/register', 'form[action="/register"]');
    await postForm(agent, '/register', {
      _csrf: registerToken,
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: user.email,
      password: 'a brand new password',
    })
      .expect(303)
      .expect('location', '/profile');

    expect(await testApp.db.select().from(users).where(eq(users.email, user.email))).toHaveLength(1);
  });

  it("F-68, ADR 0013: only the viewer's own account is deleted; a smuggled user id is ignored", async () => {
    const { user, agent, csrf } = await signedIn();
    const victim = await createUser(testApp.db);

    await postForm(agent, PATH, { _csrf: csrf, currentPassword: victim.password, userId: String(victim.id) }).expect(
      303,
    );

    // The factory gives both users the same default password, so the check passed for the viewer's own account.
    expect(await userExists(user.id)).toBe(false);
    expect(await userExists(victim.id)).toBe(true);
  });

  it('F-07: a guest with a valid token is sent to /login (303) and nothing is deleted', async () => {
    const bystander = await createUser(testApp.db);
    const agent = request.agent(testApp.app);
    const { csrf } = await getForm(agent, '/login', 'form[action="/login"]');

    await postForm(agent, PATH, { _csrf: csrf, currentPassword: bystander.password })
      .expect(303)
      .expect('location', '/login');

    expect(await userExists(bystander.id)).toBe(true);
  });

  it('F-70: a POST without a valid CSRF token gets the 403 page and deletes nothing', async () => {
    const { user, agent } = await signedIn();

    const missing = await postForm(agent, PATH, { currentPassword: user.password });
    const forged = await postForm(agent, PATH, { _csrf: 'forged', currentPassword: user.password });

    for (const response of [missing, forged]) {
      expect(response.status).toBe(403);
      expect(parse(response.text).text('h1')).toBe('This form has expired');
    }
    expect(await userExists(user.id)).toBe(true);
  });
});
