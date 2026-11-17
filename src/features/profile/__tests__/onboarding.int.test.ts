import { eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createUser } from '../../../../test/factories.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { profiles, users } from '../../../db/schema/index.js';
import { createProfileRepository } from '../profile.repository.js';

/**
 * `GET`/`POST /profile` on the real app (ROUTES.md section 4): onboarding after registration with three optional
 * fields (F-33 to F-36, F-90), validation (B-18, B-26, B-27), upsert on resubmit (B-28), input types (B-72), guards
 * and CSRF (F-07, F-70). Signed-in agents come from `signIn` (ADR 0017).
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const FORM = 'main form[action="/profile"]';

/** Onboarding never changes credentials; a call would be a bug in the test. */
const unusedApply = (): never => {
  throw new Error('credentials.apply is not part of onboarding');
};

async function signedInAgent(): Promise<{ agent: Agent; userId: number }> {
  const user = await createUser(testApp.db);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { agent, userId: user.id };
}

async function storedProfile(userId: number) {
  const [row] = await testApp.db
    .select({ age: profiles.age, city: profiles.city, homepageUrl: profiles.homepageUrl })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return row;
}

/** Posts the onboarding form with a fresh token from the page. */
async function submit(agent: Agent, fields: Readonly<Record<string, string>>): Promise<Response> {
  const { csrf } = await getForm(agent, '/profile', FORM);
  return postForm(agent, '/profile', { _csrf: csrf, ...fields });
}

function expectRedirect(response: Response, status: number, location: string): void {
  expect(response.status).toBe(status);
  expect(response.headers['location']).toBe(location);
}

describe('GET /profile', () => {
  it('F-07, F-30: a guest is sent to the login page with returnTo', async () => {
    expectRedirect(await request(testApp.app).get('/profile'), 302, '/login?returnTo=%2Fprofile');
  });

  it('F-33, F-90, B-72: the form has three optional fields with the right types, the disclosure, continue and skip', async () => {
    const { agent } = await signedInAgent();

    const response = await agent.get('/profile');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^text\/html; charset=utf-8/);
    expect(response.headers['cache-control']).toBe('no-store');
    const page = parse(response.text);
    expect(page.text('title')).toBe('About you · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['About you']);
    expect(page.attr(FORM, 'method')).toBe('post');
    expect(page.has(`${FORM}[novalidate][data-guard]`)).toBe(true);
    expect(page.attr(`${FORM} input[name="_csrf"]`, 'value')).toMatch(/\S{16,}/);

    // B-72: age is a text field with a numeric keyboard (never type=number), homepage a URL field
    expect(page.attr('#age', 'type')).toBe('text');
    expect(page.attr('#age', 'inputmode')).toBe('numeric');
    expect(page.attr('#age', 'autocomplete')).toBe('off');
    expect(page.attr('#city', 'type')).toBe('text');
    expect(page.attr('#city', 'autocomplete')).toBe('address-level2');
    expect(page.attr('#homepage', 'type')).toBe('url');
    expect(page.attr('#homepage', 'autocomplete')).toBe('url');
    for (const name of ['age', 'city', 'homepage']) {
      expect(page.text(`label[for="${name}"]`)).toBe(name);
      expect(page.has(`#${name}[required]`)).toBe(false);
    }

    // F-90: the disclosure before submitting, with a link to the privacy page
    expect(page.text(FORM)).toContain(
      'Age, city and homepage are optional. If you add them, they appear next to your name on the supporters list.',
    );
    expect(page.has(`${FORM} a[href="/privacy"]`)).toBe(true);

    // F-33: "continue" submits, "skip" is a plain link to /signature
    expect(page.text(`${FORM} button[type="submit"].button--primary`)).toBe('continue');
    expect(page.text(`${FORM} a[href="/signature"]`)).toBe('skip');
    expect(page.has('.error-summary')).toBe(false);
  });

  it('F-36, B-28: revisiting with a stored profile shows the form prefilled', async () => {
    const { agent, userId } = await signedInAgent();
    await testApp.db.insert(profiles).values({ userId, age: 33, city: 'Leipzig', homepageUrl: 'https://ada.example/' });

    const { values } = await getForm(agent, '/profile', FORM);

    expect(values).toEqual({ age: '33', city: 'Leipzig', homepage: 'https://ada.example/' });
  });
});

describe('POST /profile', () => {
  const combinations = [
    { age: '', city: '', homepage: '' },
    { age: '42', city: '', homepage: '' },
    { age: '', city: 'Berlin', homepage: '' },
    { age: '', city: '', homepage: 'https://example.com' },
    { age: '42', city: 'Berlin', homepage: '' },
    { age: '42', city: '', homepage: 'https://example.com' },
    { age: '', city: 'Berlin', homepage: 'https://example.com' },
    { age: '42', city: 'Berlin', homepage: 'https://example.com' },
  ];

  it.each(combinations)(
    'F-33, F-34, B-26: age "$age", city "$city", homepage "$homepage" is saved (empty as NULL) and goes to /signature',
    async (fields) => {
      const { agent, userId } = await signedInAgent();

      expectRedirect(await submit(agent, fields), 303, '/signature');

      await expect(storedProfile(userId)).resolves.toEqual({
        age: fields.age === '' ? null : 42,
        city: fields.city === '' ? null : 'Berlin',
        homepageUrl: fields.homepage === '' ? null : 'https://example.com/',
      });
    },
  );

  it('F-34: a crafted request without the optional fields saves an empty profile instead of failing', async () => {
    const { agent, userId } = await signedInAgent();

    expectRedirect(await submit(agent, {}), 303, '/signature');
    await expect(storedProfile(userId)).resolves.toEqual({ age: null, city: null, homepageUrl: null });
  });

  it('F-35, B-18: values are normalised: trimmed age, collapsed city, https:// added only when no scheme is given', async () => {
    const { agent, userId } = await signedInAgent();

    await submit(agent, { age: ' 7 ', city: '  Frankfurt   am  Main ', homepage: ' example.com/me ' });
    await expect(storedProfile(userId)).resolves.toEqual({
      age: 7,
      city: 'Frankfurt am Main',
      homepageUrl: 'https://example.com/me',
    });

    await submit(agent, { age: '', city: '', homepage: 'http://example.org' });
    await expect(storedProfile(userId)).resolves.toMatchObject({ homepageUrl: 'http://example.org/' });
  });

  it('F-31: upsertProfile reports an account deleted meanwhile as false instead of throwing', async () => {
    const { id: userId } = await createUser(testApp.db);
    const repository = createProfileRepository({ db: testApp.db, credentials: { apply: unusedApply } });
    await testApp.db.delete(users).where(eq(users.id, userId));

    await expect(repository.upsertProfile(userId, { age: 30, city: 'Bonn', homepageUrl: null })).resolves.toBe(false);
    await expect(storedProfile(userId)).resolves.toBeUndefined();
  });

  it('F-36, B-28: submitting again (back button, second visit) updates the row and never fails', async () => {
    const { agent, userId } = await signedInAgent();

    expectRedirect(await submit(agent, { age: '20', city: 'Bonn', homepage: '' }), 303, '/signature');
    expectRedirect(await submit(agent, { age: '20', city: 'Bonn', homepage: '' }), 303, '/signature');
    expectRedirect(await submit(agent, { age: '', city: 'Kiel', homepage: 'kiel.example' }), 303, '/signature');

    await expect(storedProfile(userId)).resolves.toEqual({
      age: null,
      city: 'Kiel',
      homepageUrl: 'https://kiel.example/',
    });
    expect(await testApp.db.select().from(profiles).where(eq(profiles.userId, userId))).toHaveLength(1);
    expect((await getForm(agent, '/profile', FORM)).values).toEqual({
      age: '',
      city: 'Kiel',
      homepage: 'https://kiel.example/',
    });
  });

  const invalid = [
    { field: 'age', value: '1.5', message: 'Age must be a whole number between 1 and 120' },
    { field: 'age', value: '0', message: 'Age must be a whole number between 1 and 120' },
    { field: 'age', value: '121', message: 'Age must be a whole number between 1 and 120' },
    { field: 'age', value: 'forty', message: 'Age must be a whole number between 1 and 120' },
    { field: 'age', value: '007a', message: 'Age must be a whole number between 1 and 120' },
    { field: 'city', value: 'x'.repeat(101), message: 'City must be 100 characters or fewer' },
    { field: 'homepage', value: 'javascript:alert(1)', message: 'Enter a web address like https://example.com' },
    {
      field: 'homepage',
      value: 'https://https://example.com',
      message: 'Enter a web address like https://example.com',
    },
    { field: 'homepage', value: 'not a url', message: 'Enter a web address like https://example.com' },
    {
      field: 'homepage',
      value: `https://example.com/${'a'.repeat(290)}`,
      message: 'Enter a web address like https://example.com',
    },
  ];

  it.each(invalid)(
    'F-35, F-21, B-18, B-27: $field "$value" gives 422 with the message, the values kept, nothing stored',
    async ({ field, value, message }) => {
      const { agent, userId } = await signedInAgent();
      const fields = { age: '30', city: 'Hamburg', homepage: 'hamburg.example', [field]: value };

      const response = await submit(agent, fields);

      expect(response.status).toBe(422);
      const page = parse(response.text);
      expect(page.text('title')).toBe('About you · Nonsense Petition');
      expect(page.has('.error-summary[role="alert"]')).toBe(true);
      expect(page.attr('.error-summary__link', 'href')).toBe(`#${field}`);
      expect(page.text('.error-summary__link')).toBe(message);
      expect(page.attr(`#${field}`, 'aria-invalid')).toBe('true');
      expect(page.attr(`#${field}`, 'aria-describedby')).toBe(`${field}-error`);
      expect(page.text(`#${field}-error`)).toBe(`Error: ${message}`);
      expect(readForm(response.text, FORM).values).toEqual(fields);
      await expect(storedProfile(userId)).resolves.toBeUndefined();
    },
  );

  it('F-21, ADR 0003: the 422 page carries a fresh token that is accepted on resubmit', async () => {
    const { agent, userId } = await signedInAgent();

    const rejected = await submit(agent, { age: 'abc', city: '', homepage: '' });
    expect(rejected.status).toBe(422);
    const { csrf, values } = readForm(rejected.text, FORM);

    const corrected = await postForm(agent, '/profile', { _csrf: csrf, ...values, age: '64' });

    expectRedirect(corrected, 303, '/signature');
    await expect(storedProfile(userId)).resolves.toEqual({ age: 64, city: null, homepageUrl: null });
  });

  it('F-53: markup typed into a field is kept as text in the re-rendered form, never as markup', async () => {
    const { agent } = await signedInAgent();
    const payload = '"><script>alert(1)</script>';

    const response = await submit(agent, { age: payload, city: payload, homepage: '' });

    expect(response.status).toBe(422);
    expect(response.text).not.toContain('<script>alert(1)</script>');
    expect(readForm(response.text, FORM).values).toMatchObject({ age: payload, city: payload });
  });

  it('F-70: a POST without a CSRF token gets the 403 page and stores nothing', async () => {
    const { agent, userId } = await signedInAgent();

    const response = await postForm(agent, '/profile', { age: '30', city: 'Bremen', homepage: '' });

    expect(response.status).toBe(403);
    expect(parse(response.text).text('h1')).toBe('This form has expired');
    await expect(storedProfile(userId)).resolves.toBeUndefined();
  });

  it('F-07: a guest POST is refused (403, no session to bind a token to) and stores nothing', async () => {
    const before = await testApp.db.$count(profiles);

    const response = await postForm(request.agent(testApp.app), '/profile', { _csrf: 'made-up', city: 'Bremen' });

    expect(response.status).toBe(403);
    expect(await testApp.db.$count(profiles)).toBe(before);
  });

  it("ADR 0002: the profile is always the viewer's own; a crafted userId field is ignored", async () => {
    const owner = await signedInAgent();
    const other = await signedInAgent();
    await submit(owner.agent, { age: '50', city: 'Ulm', homepage: '' });

    const response = await submit(other.agent, { userId: String(owner.userId), age: '18', city: 'Jena', homepage: '' });

    expectRedirect(response, 303, '/signature');
    await expect(storedProfile(owner.userId)).resolves.toEqual({ age: 50, city: 'Ulm', homepageUrl: null });
    await expect(storedProfile(other.userId)).resolves.toEqual({ age: 18, city: 'Jena', homepageUrl: null });
    expect((await getForm(other.agent, '/profile', FORM)).values).toEqual({ age: '18', city: 'Jena', homepage: '' });
  });
});
