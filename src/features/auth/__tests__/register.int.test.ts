import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { users } from '../../../db/schema/index.js';
import { createHasher } from '../../../shared/auth/password.js';
import { sessionIdOf } from './fakes.js';

/**
 * `GET /register` and `POST /register` on the real app (ROUTES.md section 3, ADR 0008, ADR 0009): the form markup,
 * validation with kept values, "email taken" whatever the password and in any letter case, the guest-only guard, CSRF
 * and the resubmit round trip with the token of the 422 page.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const PASSWORD = 'correct horse battery staple';
const FORM = 'form[action="/register"]';

type RegisterFields = Record<'firstName' | 'lastName' | 'email' | 'password', string>;

function validFields(overrides: Partial<RegisterFields> = {}): RegisterFields {
  return {
    firstName: 'Grace',
    lastName: 'Hopper',
    email: `grace-${randomUUID()}@example.com`,
    password: PASSWORD,
    ...overrides,
  };
}

async function guest(): Promise<{ agent: Agent; csrf: string }> {
  const agent = request.agent(testApp.app);
  const { csrf } = await getForm(agent, '/register', FORM);
  return { agent, csrf };
}

const accountsWithEmail = (email: string) =>
  testApp.db.select({ id: users.id }).from(users).where(eq(users.email, email));

function expectExpiredPage(response: Response): void {
  expect(response.status).toBe(403);
  expect(parse(response.text).text('h1')).toBe('This form has expired');
}

describe('GET /register', () => {
  it('F-18, F-80, B-71: renders the form with visible labels, correct types and autocomplete tokens', async () => {
    const response = await request(testApp.app).get('/register').expect(200);
    const page = parse(response.text);

    expect(page.text('title')).toBe('Register · Nonsense Petition');
    expect(page.text('h1')).toBe('Register');
    expect(page.attr(FORM, 'method')).toBe('post');
    expect(page.has(`${FORM}[novalidate][data-guard]`)).toBe(true);
    const fields = [
      { name: 'firstName', type: 'text', autocomplete: 'given-name', label: 'first name' },
      { name: 'lastName', type: 'text', autocomplete: 'family-name', label: 'last name' },
      { name: 'email', type: 'email', autocomplete: 'email', label: 'email' },
      { name: 'password', type: 'password', autocomplete: 'new-password', label: 'password' },
    ];
    for (const { name, type, autocomplete, label } of fields) {
      expect(page.attr(`${FORM} input[name="${name}"]`, 'type')).toBe(type);
      expect(page.attr(`${FORM} input[name="${name}"]`, 'autocomplete')).toBe(autocomplete);
      expect(page.text(`label[for="${name}"]`)).toBe(label);
    }
    expect(response.text).not.toContain('autocomplete="off"');
    expect(page.text('#password-hint')).toBe('At least 12 characters');
    expect(page.attr('#password', 'aria-describedby')).toBe('password-hint');
    expect(page.text(`${FORM} button[type="submit"]`)).toBe('register');
  });

  it('F-90, F-20: states before submitting that the name is shown to registered users, and links to log in', async () => {
    const page = parse((await request(testApp.app).get('/register').expect(200)).text);

    const disclosure = page.texts(`${FORM} p`).find((text) => text.startsWith('Your name appears'));
    expect(disclosure).toBe(
      'Your name appears on the supporters list, which registered users can see. Details: privacy.',
    );
    expect(page.has(`${FORM} a[href="/privacy"]`)).toBe(true);
    expect(page.texts('main a[href="/login"]')).toContain('log in');
  });

  it('F-80, B-65, F-75, F-76: each label sits above its input, no placeholder stands in, the submit is guarded', async () => {
    const page = parse((await request(testApp.app).get('/register').expect(200)).text);

    const fields = page.root.querySelectorAll(`${FORM} .form-field`);
    expect(fields.map((field) => field.querySelector('.form-field__input')?.getAttribute('name'))).toEqual([
      'firstName',
      'lastName',
      'email',
      'password',
    ]);
    for (const field of fields) {
      // The label comes first, so it is read and seen before the control (B-65: legacy put labels below).
      expect(field.firstElementChild?.tagName).toBe('LABEL');
    }
    expect(page.has(`${FORM} [placeholder]`)).toBe(false);
    expect(page.has('.error-summary')).toBe(false);
    // F-76: a plain POST form with the token, so it works without JavaScript; form-guard.ts only adds the lock.
    expect(page.attr(FORM, 'action')).toBe('/register');
    expect(page.has(`${FORM} input[type="hidden"][name="_csrf"]`)).toBe(true);
    expect(page.has(`${FORM} .form__actions button[type="submit"].button--primary`)).toBe(true);
    expect(page.texts('main .button--primary')).toEqual(['register']);
  });

  it('ADR 0003: binds the anonymous session and renders a CSRF token for it', async () => {
    const response = await request(testApp.app).get('/register').expect(200);

    expect(readForm(response.text, FORM).csrf).not.toBe('');
    expect(sessionIdOf(response)).not.toBe('');
  });

  it('F-22: a signed-in visitor who has not signed is sent to /signature, a signer to /thank-you', async () => {
    const unsigned = await createUser(testApp.db);
    const signer = await createUser(testApp.db);
    await createSignature(testApp.db, signer.id);
    const unsignedAgent = request.agent(testApp.app);
    const signerAgent = request.agent(testApp.app);
    await signIn(unsignedAgent, unsigned.id);
    await signIn(signerAgent, signer.id);

    await unsignedAgent.get('/register').expect(302).expect('location', '/signature');
    await signerAgent.get('/register').expect(302).expect('location', '/thank-you');
  });
});

describe('POST /register', () => {
  it('F-18, F-19, B-25: creates the account with trimmed names and a lower-cased email, then 303 /profile', async () => {
    const { agent, csrf } = await guest();
    const email = `Grace.${randomUUID()}@Example.COM`;

    await postForm(agent, '/register', {
      _csrf: csrf,
      ...validFields({ firstName: '  Grace  ', lastName: ' Brewster   Hopper ', email: `  ${email} ` }),
    })
      .expect(303)
      .expect('location', '/profile');

    const [row] = await testApp.db.select().from(users).where(eq(users.email, email.toLowerCase()));
    expect(row).toMatchObject({ firstName: 'Grace', lastName: 'Brewster Hopper', sessionVersion: 0 });
    expect(row?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row?.passwordHash).not.toContain(PASSWORD);
  });

  it('F-18, ADR 0002: registration signs the visitor in with a new session id', async () => {
    const agent = request.agent(testApp.app);
    const page = await agent.get('/register').expect(200);
    const anonymousId = sessionIdOf(page);

    const response = await postForm(agent, '/register', {
      _csrf: readForm(page.text, FORM).csrf,
      ...validFields(),
    }).expect(303);

    expect(sessionIdOf(response)).not.toBe(anonymousId);
    // Signed in now: the guest-only page sends the new user on to the signature page (F-22).
    await agent.get('/register').expect(302).expect('location', '/signature');
  });

  it('F-19, F-21, B-24: every invalid field gets its own message, the values are kept and the password is not', async () => {
    const { agent, csrf } = await guest();

    const response = await postForm(agent, '/register', {
      _csrf: csrf,
      firstName: '   ',
      lastName: 'Hopper',
      email: 'grace-at-example',
      password: 'tiny-secret',
    }).expect(422);
    const page = parse(response.text);

    expect(page.text('h1')).toBe('Register');
    expect(page.texts('.error-summary__link')).toEqual([
      'Enter your first name',
      'Enter a valid email address, like name@example.com',
      'Password must be at least 12 characters',
    ]);
    expect(page.attr('.error-summary', 'role')).toBe('alert');
    expect(page.attr('.error-summary__link', 'href')).toBe('#firstName');
    for (const name of ['firstName', 'email', 'password']) {
      expect(page.attr(`#${name}`, 'aria-invalid')).toBe('true');
      expect(page.attr(`#${name}`, 'aria-describedby')?.split(' ')).toContain(`${name}-error`);
      expect(page.has(`#${name}-error`)).toBe(true);
    }
    expect(page.attr('#lastName', 'aria-invalid')).toBeUndefined();
    expect(page.attr('#lastName', 'value')).toBe('Hopper');
    expect(page.attr('#email', 'value')).toBe('grace-at-example');
    expect(page.attr('#password', 'value')).toBe('');
    expect(response.text).not.toContain('tiny-secret');
    // F-20: "log in instead" belongs to the taken email only, never to a field-rule message about the email.
    expect(page.has(`${FORM} a[href="/login"]`)).toBe(false);
  });

  it('F-21, B-68: the error summary comes first, takes focus without JavaScript and every reference resolves', async () => {
    const { agent, csrf } = await guest();

    const response = await postForm(agent, '/register', {
      _csrf: csrf,
      ...validFields({ firstName: '', password: 'short' }),
    }).expect(422);
    const page = parse(response.text);

    const summary = page.root.querySelector('main .error-summary');
    expect(summary?.getAttribute('tabindex')).toBe('-1');
    expect(summary?.hasAttribute('autofocus')).toBe(true);
    expect(page.root.querySelectorAll('[autofocus]')).toHaveLength(1);
    const titleId = summary?.getAttribute('aria-labelledby') ?? '';
    expect(page.text(`#${titleId}.error-summary__title`)).toBe('There is a problem');
    // Right below the h1 and before the form, so it is the first thing after the heading.
    expect(summary?.previousElementSibling?.classList.contains('page-heading')).toBe(true);
    expect(summary?.nextElementSibling?.getAttribute('action')).toBe('/register');

    const hrefs = page.root.querySelectorAll('.error-summary__link').map((link) => link.getAttribute('href') ?? '');
    expect(hrefs).toEqual(['#firstName', '#password']);
    for (const href of hrefs) expect(page.has(`${FORM} input${href}`)).toBe(true);
    // The message is read first, then the hint; both ids exist.
    expect(page.attr('#password', 'aria-describedby')).toBe('password-error password-hint');
    expect(page.text('#password-error.form-field__error')).toBe('Error: Password must be at least 12 characters');
    expect(page.text('#password-hint')).toBe('At least 12 characters');
  });

  it('F-19: a missing field and an over-long name get their messages', async () => {
    const { agent, csrf } = await guest();

    const response = await postForm(agent, '/register', {
      _csrf: csrf,
      lastName: 'x'.repeat(101),
      email: '',
      password: '',
    }).expect(422);

    expect(parse(response.text).texts('.error-summary__link')).toEqual([
      'Enter your first name',
      'Last name must be 100 characters or fewer',
      'Enter an email address',
      'Enter a password',
    ]);
  });

  it('F-21, ADR 0003: the 422 page carries a token that a corrected resubmit can use', async () => {
    const { agent, csrf } = await guest();
    const invalid = await postForm(agent, '/register', { _csrf: csrf, ...validFields({ password: 'short' }) }).expect(
      422,
    );

    const { csrf: fresh } = readForm(invalid.text, FORM);

    expect(fresh).not.toBe('');
    await postForm(agent, '/register', { _csrf: fresh, ...validFields() })
      .expect(303)
      .expect('location', '/profile');
  });

  it('F-20, B-24, B-25: an existing email in another letter case is "taken", with a link to log in and the names kept', async () => {
    const existing = await createUser(testApp.db, { email: `ada-${randomUUID()}@example.com` });
    const { agent, csrf } = await guest();
    const shouted = `  ${existing.email.toUpperCase()} `;

    const response = await postForm(agent, '/register', {
      _csrf: csrf,
      ...validFields({ firstName: 'Ada', lastName: 'Byron', email: shouted, password: 'another long password' }),
    }).expect(422);
    const page = parse(response.text);

    expect(page.text('#email-error')).toBe('Error: An account with this email already exists.');
    expect(page.texts('.error-summary__link')).toEqual(['An account with this email already exists.']);
    expect(page.attr('#email', 'aria-invalid')).toBe('true');
    expect(page.text(`${FORM} a[href="/login"]`)).toBe('log in instead');
    // The link follows the email field directly, where the message is (F-20), not somewhere else in the form.
    const emailField = page.root.querySelector('#email')?.parentNode;
    expect(emailField?.nextElementSibling?.querySelector('a.form__link')?.getAttribute('href')).toBe('/login');
    expect(page.attr('#firstName', 'value')).toBe('Ada');
    expect(page.attr('#lastName', 'value')).toBe('Byron');
    expect(page.attr('#email', 'value')).toBe(shouted);
    expect(page.attr('#password', 'value')).toBe('');
    expect(response.text).not.toContain('another long password');
    expect(await accountsWithEmail(existing.email)).toHaveLength(1);
  });

  it('ADR 0009: an existing email with its correct password is still "taken" and signs nobody in', async () => {
    const existing = await createUser(testApp.db, { email: `ada-${randomUUID()}@example.com` });
    const { agent, csrf } = await guest();

    const response = await postForm(agent, '/register', {
      _csrf: csrf,
      ...validFields({ email: existing.email, password: existing.password }),
    }).expect(422);

    expect(parse(response.text).text('#email-error')).toBe('Error: An account with this email already exists.');
    // Still a guest: the register page renders instead of redirecting.
    await agent.get('/register').expect(200);
  });

  it('F-22, F-07: a signed-in visitor cannot register another account (303 to their page, nothing stored)', async () => {
    const user = await createUser(testApp.db);
    const agent = request.agent(testApp.app);
    await signIn(agent, user.id);
    const { csrf } = await getForm(agent, '/account/delete');
    const fields = validFields();

    await postForm(agent, '/register', { _csrf: csrf, ...fields })
      .expect(303)
      .expect('location', '/signature');

    expect(await accountsWithEmail(fields.email)).toHaveLength(0);
  });

  it('F-70: a POST without a CSRF token gets the 403 page and creates no account', async () => {
    const { agent } = await guest();
    const fields = validFields();

    expectExpiredPage(await postForm(agent, '/register', fields));
    expectExpiredPage(await postForm(request.agent(testApp.app), '/register', { _csrf: 'forged', ...fields }));

    expect(await accountsWithEmail(fields.email)).toHaveLength(0);
  });
});

describe('POST /register with the real argon2id hasher', () => {
  let realApp: TestApp;

  beforeAll(async () => {
    realApp = await createTestApp({ hasher: createHasher() });
  });

  afterAll(async () => {
    await realApp.close();
  });

  it('F-27, B-11: stores an argon2id hash with the pinned parameters (m=64 MiB, t=3, p=4)', async () => {
    const agent = request.agent(realApp.app);
    const { csrf } = await getForm(agent, '/register', FORM);
    const fields = validFields();

    await postForm(agent, '/register', { _csrf: csrf, ...fields }).expect(303);

    const [row] = await realApp.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, fields.email));
    expect(row?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
  });
});
