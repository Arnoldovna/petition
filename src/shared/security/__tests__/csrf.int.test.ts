import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createUser } from '../../../../test/factories.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';

/**
 * CSRF on the real app (ADR 0003, F-70, B-08, B-13, B-14): the app-wide protection after the body parsers, the 403
 * page, and the resubmit round trip on the test-only form `POST /__test/form` (phase 1 has no real form yet; it runs
 * the app's own CSRF configuration). Signed-in pages carry the token in the header's logout form.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const LOGOUT_FORM = 'form[action="/logout"]';
const EXPIRED = 'This form has expired';

async function signedInAgent(): Promise<Agent> {
  const user = await createUser(testApp.db);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return agent;
}

/** The token every page of a signed-in viewer carries (the logout form, ADR 0003). */
const tokenOf = (agent: Agent): Promise<string> => getForm(agent, '/', LOGOUT_FORM).then((form) => form.csrf);

function expectExpiredPage(response: Response): void {
  expect(response.status).toBe(403);
  expect(response.headers['content-type']).toMatch(/^text\/html/);
  expect(parse(response.text).text('h1')).toBe(EXPIRED);
  // B-13: no stack trace, no library internals
  expect(response.text).not.toMatch(/EBADCSRFTOKEN|ForbiddenError|invalid csrf token|\bat \S+ \(/i);
}

describe('CSRF protection', () => {
  it('F-70, B-14: a signed-in POST without a token gets the 403 page "This form has expired"', async () => {
    const agent = await signedInAgent();

    expectExpiredPage(await postForm(agent, '/profile/edit', { firstName: 'Ada' }));
    expectExpiredPage(await postForm(agent, '/__test/form', { outcome: 'valid' }));
  });

  it('B-08, F-70: page requests (GET, HEAD) pass without a token; only state changes are checked', async () => {
    const agent = await signedInAgent();

    await agent.get('/').expect(200);
    await agent.head('/').expect(200);
  });

  it('F-70: a guest POST without a session or token gets the 403 page, never reaching a route', async () => {
    expectExpiredPage(await postForm(request.agent(testApp.app), '/no-such-form', { _csrf: 'made-up' }));
  });

  it('F-70, B-13: a non-HTML client gets RFC 9457 problem+json with status 403', async () => {
    const agent = await signedInAgent();

    const response = await postForm(agent, '/__test/form', { outcome: 'valid' }).set('Accept', 'application/json');

    expect(response.status).toBe(403);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ status: 403 });
    expect(JSON.stringify(response.body)).not.toMatch(/stack/i);
  });

  it('F-70, ADR 0003: a token is bound to its session: another session cannot use it', async () => {
    const victim = await signedInAgent();
    const attacker = await signedInAgent();
    const stolen = await tokenOf(victim);
    await tokenOf(attacker); // the attacker has a CSRF cookie of their own

    expectExpiredPage(await postForm(attacker, '/__test/form', { _csrf: stolen, outcome: 'valid' }));
  });

  it('F-70, ADR 0003: a valid token passes, and a changed or repeated token field is rejected', async () => {
    const agent = await signedInAgent();
    const token = await tokenOf(agent);

    expectExpiredPage(await postForm(agent, '/__test/form', { _csrf: `${token}x`, outcome: 'valid' }));
    const repeated = await agent
      .post('/__test/form')
      .type('form')
      .send(`_csrf=${encodeURIComponent(token)}&_csrf=${encodeURIComponent(token)}&outcome=valid`);
    expectExpiredPage(repeated);

    await postForm(agent, '/__test/form', { _csrf: token, outcome: 'valid' }).expect(303).expect('location', '/');
  });

  it('F-23, ADR 0003: a new session id (sign-in) invalidates the old token; the next page issues a working one', async () => {
    const user = await createUser(testApp.db);
    const agent = request.agent(testApp.app);
    await signIn(agent, user.id);
    const oldToken = await tokenOf(agent);

    await signIn(agent, user.id);
    expectExpiredPage(await postForm(agent, '/__test/form', { _csrf: oldToken, outcome: 'valid' }));

    const newToken = await tokenOf(agent);
    expect(newToken).not.toBe(oldToken);
    await postForm(agent, '/__test/form', { _csrf: newToken, outcome: 'valid' }).expect(303);
  });

  it('F-70, ADR 0003: the CSRF cookie is app-scoped, HttpOnly, SameSite=Lax and Path=/', async () => {
    const agent = await signedInAgent();

    const response = await agent.get('/').expect(200);

    const header: unknown = response.headers['set-cookie'];
    const line = (Array.isArray(header) ? header.map(String) : []).find((cookie) =>
      cookie.startsWith('petition.x-csrf-token='),
    );
    expect(line).toMatch(/;\s*HttpOnly/i);
    expect(line).toMatch(/;\s*SameSite=Lax/i);
    expect(line).toMatch(/;\s*Path=\/(;|$)/);
  });
});

describe('resubmit round trip', () => {
  it('ADR 0003, F-21: the token from a 422 re-render lets the corrected form through (303)', async () => {
    const agent = await signedInAgent();
    const token = await tokenOf(agent);

    const invalid = await postForm(agent, '/__test/form', { _csrf: token, outcome: 'invalid' }).expect(422);
    const { csrf } = readForm(invalid.text, LOGOUT_FORM);

    expect(csrf).not.toBe('');
    await postForm(agent, '/__test/form', { _csrf: csrf, outcome: 'valid' }).expect(303).expect('location', '/');
  });

  it('ADR 0003, F-09: the 403 page of a signed-in visitor carries a fresh token, so the form can be sent again', async () => {
    const agent = await signedInAgent();

    const rejected = await postForm(agent, '/__test/form', { outcome: 'valid' });
    expectExpiredPage(rejected);
    const { csrf } = readForm(rejected.text, LOGOUT_FORM);

    await postForm(agent, '/__test/form', { _csrf: csrf, outcome: 'valid' }).expect(303);
  });
});
