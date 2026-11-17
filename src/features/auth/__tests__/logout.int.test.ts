import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createUser } from '../../../../test/factories.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { sessionCookieOf, sessionIdOf } from './fakes.js';

/**
 * `POST /logout` on the real app (ROUTES.md section 3, F-25, B-08, ADR 0002 item 6): POST only, CSRF-protected, the
 * old session deleted from Redis so a copied cookie is dead, and the flash "You are logged out" shown exactly once on
 * the home page.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const LOGOUT_FORM = 'form[action="/logout"]';
const LOGGED_OUT = 'You are logged out';

async function signedInAgent(): Promise<{ agent: Agent; csrf: string; cookie: string; sessionId: string }> {
  const user = await createUser(testApp.db);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  const page = await agent.get('/account/delete').expect(200);
  return {
    agent,
    csrf: readForm(page.text, LOGOUT_FORM).csrf,
    cookie: sessionCookieOf(page),
    sessionId: sessionIdOf(page),
  };
}

describe('POST /logout', () => {
  it('F-14, B-08: the logout control is a POST form with a CSRF token in the signed-in navigation', async () => {
    const { agent } = await signedInAgent();

    const page = parse((await agent.get('/account/delete').expect(200)).text);

    expect(page.attr(`header ${LOGOUT_FORM}`, 'method')).toBe('post');
    expect(page.attr(`header ${LOGOUT_FORM} input[name="_csrf"]`, 'value')).not.toBe('');
    expect(page.text(`header ${LOGOUT_FORM} button[type="submit"]`)).toBe('log out');
  });

  it('F-25, B-08: GET /logout does not log out; it is the 404 page', async () => {
    const { agent } = await signedInAgent();

    const response = await agent.get('/logout').expect(404);

    expect(parse(response.text).text('h1')).toBe('Page not found');
    await agent.get('/account/delete').expect(200);
  });

  it('F-25, F-17: logs out with 303 to / and shows "You are logged out" once', async () => {
    const { agent, csrf } = await signedInAgent();

    await postForm(agent, '/logout', { _csrf: csrf }).expect(303).expect('location', '/');

    const home = parse((await agent.get('/').expect(200)).text);
    expect(home.text('.flash')).toBe(LOGGED_OUT);
    expect(home.has(LOGOUT_FORM)).toBe(false);
    expect(home.has('header a[href="/login"]')).toBe(true);
    const again = parse((await agent.get('/').expect(200)).text);
    expect(again.text('.flash')).toBe('');
  });

  it('F-25, B-04, ADR 0002: the old session is deleted from Redis, so a copied cookie is a guest', async () => {
    const { agent, csrf, cookie, sessionId } = await signedInAgent();
    expect(await testApp.redis.exists(`${testApp.prefix}:sess:${sessionId}`)).toBe(1);

    const response = await postForm(agent, '/logout', { _csrf: csrf }).expect(303);

    expect(await testApp.redis.exists(`${testApp.prefix}:sess:${sessionId}`)).toBe(0);
    expect(sessionIdOf(response)).not.toBe(sessionId);
    await request(testApp.app)
      .get('/account/delete')
      .set('Cookie', cookie)
      .expect(302)
      .expect('location', '/login?returnTo=%2Faccount%2Fdelete');
    await agent.get('/account/delete').expect(302);
  });

  it('F-25, ADR 0003: the token of the old session cannot be replayed after logout', async () => {
    const { agent, csrf } = await signedInAgent();
    await postForm(agent, '/logout', { _csrf: csrf }).expect(303);

    const replay = await postForm(agent, '/logout', { _csrf: csrf });

    expect(replay.status).toBe(403);
    expect(parse(replay.text).text('h1')).toBe('This form has expired');
  });

  it('F-70: a logout without a valid token gets the 403 page and the visitor stays signed in', async () => {
    const { agent } = await signedInAgent();

    const missing = await postForm(agent, '/logout', {});
    const forged = await postForm(agent, '/logout', { _csrf: 'forged' });

    for (const response of [missing, forged]) {
      expect(response.status).toBe(403);
      expect(parse(response.text).text('h1')).toBe('This form has expired');
    }
    await agent.get('/account/delete').expect(200);
  });

  it('F-07: a guest with a valid token is sent to /login (303), without a flash', async () => {
    const agent = request.agent(testApp.app);
    const { csrf } = await getForm(agent, '/login', 'form[action="/login"]');

    await postForm(agent, '/logout', { _csrf: csrf }).expect(303).expect('location', '/login');

    expect(parse((await agent.get('/').expect(200)).text).text('.flash')).toBe('');
  });

  it('ADR 0003: the logout form on a 422 page of a signed-in visitor carries a working token', async () => {
    const { agent } = await signedInAgent();
    const { csrf } = await getForm(agent, '/account/delete');
    const invalid = await postForm(agent, '/account/delete', { _csrf: csrf, currentPassword: '' }).expect(422);

    const { csrf: fromInvalid } = readForm(invalid.text, LOGOUT_FORM);

    await postForm(agent, '/logout', { _csrf: fromInvalid }).expect(303).expect('location', '/');
  });
});
