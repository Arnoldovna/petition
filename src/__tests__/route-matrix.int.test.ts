import { randomUUID } from 'node:crypto';

import { count, eq } from 'drizzle-orm';
import request, { type Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../test/auth.js';
import { createSignature, createUser } from '../../test/factories.js';
import { getForm, postForm, type Agent } from '../../test/forms.js';
import { parse } from '../../test/html.js';
import { createTestApp, type TestApp } from '../../test/test-app.js';
import { profiles, signatures, users } from '../db/schema/index.js';

/**
 * Every route of FEATURES.md table 2.2 for the three visitor states (guest, signed in without a signature, signed in
 * with one), on GET and on POST (F-07, B-06, B-07), and every POST without or with a forged CSRF token (F-70). The
 * guards run before any handler, so a request that fails one is redirected and never reaches the database. Each case
 * gets a fresh visitor, so no case depends on another.
 *
 * The last block builds the app the way `server.ts` does, without the test-only routes, and proves that
 * `/__test/sign-in` does not exist there (ADR 0017, ROUTES.md section 7).
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

const STATES = ['guest', 'unsigned', 'signed'] as const;
type State = (typeof STATES)[number];

interface Visitor {
  agent: Agent;
  /** A valid token of the visitor's session: from the login form (guest) or the header's logout form. */
  csrf: string;
  userId: number | undefined;
}

async function visitor(state: State): Promise<Visitor> {
  const agent = request.agent(testApp.app);
  if (state === 'guest') {
    // GET /login binds an anonymous session, so the guest has a token like a real visitor with the form open.
    return { agent, csrf: (await getForm(agent, '/login')).csrf, userId: undefined };
  }
  const user = await createUser(testApp.db);
  if (state === 'signed') await createSignature(testApp.db, user.id);
  await signIn(agent, user.id);
  return { agent, csrf: (await getForm(agent, '/', 'form[action="/logout"]')).csrf, userId: user.id };
}

/** What one request must answer. `location` is exact; `type` is the start of the Content-Type. */
interface Expected {
  status: number;
  location?: string;
  type?: string;
}

const PAGE: Expected = { status: 200, type: 'text/html' };
const NOT_FOUND: Expected = { status: 404, type: 'text/html' };
const JSON_OK: Expected = { status: 200, type: 'application/json' };
const PNG: Expected = { status: 200, type: 'image/png' };
/** `requireAuth` on a page request: 302 to the login page with the requested URL as `returnTo` (F-30). */
const loginFor = (path: string): Expected => ({ status: 302, location: `/login?returnTo=${encodeURIComponent(path)}` });
const found = (location: string): Expected => ({ status: 302, location });
/** Guards on a form submission answer 303, so the browser follows with a GET (PRG). */
const seeOther = (location: string): Expected => ({ status: 303, location });
const UNPROCESSABLE: Expected = { status: 422, type: 'text/html' };

type PerState = Readonly<Record<State, Expected>>;
const same = (expected: Expected): PerState => ({ guest: expected, unsigned: expected, signed: expected });

/** FEATURES.md table 2.2 and ROUTES.md, GET side. */
const GET_ROUTES: readonly { path: string; expected: PerState }[] = [
  { path: '/', expected: same(PAGE) },
  { path: '/home', expected: same({ status: 301, location: '/' }) },
  { path: '/about', expected: same(PAGE) },
  { path: '/privacy', expected: same(PAGE) },
  { path: '/register', expected: { guest: PAGE, unsigned: found('/signature'), signed: found('/thank-you') } },
  { path: '/login', expected: { guest: PAGE, unsigned: found('/signature'), signed: found('/thank-you') } },
  // B-08: logging out is a POST only; there is no GET route.
  { path: '/logout', expected: same(NOT_FOUND) },
  { path: '/profile', expected: { guest: loginFor('/profile'), unsigned: PAGE, signed: PAGE } },
  { path: '/profile/edit', expected: { guest: loginFor('/profile/edit'), unsigned: PAGE, signed: PAGE } },
  { path: '/signature', expected: { guest: loginFor('/signature'), unsigned: PAGE, signed: found('/thank-you') } },
  // ADR 0004 item 6: an image URL never answers with an HTML redirect for a signed-in non-signer.
  {
    path: '/signature/image.png',
    expected: { guest: loginFor('/signature/image.png'), unsigned: NOT_FOUND, signed: PNG },
  },
  {
    path: '/signature/delete',
    expected: { guest: loginFor('/signature/delete'), unsigned: found('/signature'), signed: PAGE },
  },
  { path: '/thank-you', expected: { guest: loginFor('/thank-you'), unsigned: found('/signature'), signed: PAGE } },
  { path: '/supporters', expected: { guest: loginFor('/supporters'), unsigned: PAGE, signed: PAGE } },
  {
    path: '/supporters/city/Berlin',
    expected: { guest: loginFor('/supporters/city/Berlin'), unsigned: PAGE, signed: PAGE },
  },
  { path: '/account/delete', expected: { guest: loginFor('/account/delete'), unsigned: PAGE, signed: PAGE } },
  { path: '/health/live', expected: same(JSON_OK) },
  { path: '/health/ready', expected: same(JSON_OK) },
  { path: '/no-such-page', expected: same(NOT_FOUND) },
];

/**
 * FEATURES.md table 2.2, POST side. `body` is a deliberately invalid submission: a visitor who passes every guard
 * gets the handler's 422 re-render (proof that the request reached it) and nothing is written.
 */
const POST_ROUTES: readonly { path: string; body: Record<string, string>; expected: PerState }[] = [
  {
    path: '/register',
    body: { firstName: '', lastName: '', email: '', password: '' },
    expected: { guest: UNPROCESSABLE, unsigned: seeOther('/signature'), signed: seeOther('/thank-you') },
  },
  {
    path: '/login',
    body: { email: '', password: '' },
    expected: { guest: UNPROCESSABLE, unsigned: seeOther('/signature'), signed: seeOther('/thank-you') },
  },
  // Logging out passes for every signed-in visitor; it needs no invalid body to be harmless.
  {
    path: '/logout',
    body: {},
    expected: { guest: seeOther('/login'), unsigned: seeOther('/'), signed: seeOther('/') },
  },
  {
    path: '/profile',
    body: { age: 'abc', city: '', homepage: '' },
    expected: { guest: seeOther('/login'), unsigned: UNPROCESSABLE, signed: UNPROCESSABLE },
  },
  {
    path: '/profile/edit',
    body: {
      firstName: '',
      lastName: '',
      email: '',
      age: '',
      city: '',
      homepage: '',
      newPassword: '',
      currentPassword: '',
    },
    expected: { guest: seeOther('/login'), unsigned: UNPROCESSABLE, signed: UNPROCESSABLE },
  },
  {
    path: '/signature',
    body: { method: 'typed', typedName: '' },
    expected: { guest: seeOther('/login'), unsigned: UNPROCESSABLE, signed: seeOther('/thank-you') },
  },
  // The signer's case is the real delete (303 /signature, F-49); the other two never reach the handler.
  {
    path: '/signature/delete',
    body: {},
    expected: { guest: seeOther('/login'), unsigned: seeOther('/signature'), signed: seeOther('/signature') },
  },
  {
    path: '/account/delete',
    body: { currentPassword: '' },
    expected: { guest: seeOther('/login'), unsigned: UNPROCESSABLE, signed: UNPROCESSABLE },
  },
];

/** Read-only paths have no POST route: with a valid token, a POST there is the 404 page for everyone. */
const READ_ONLY_PATHS = [
  '/',
  '/home',
  '/about',
  '/privacy',
  '/thank-you',
  '/supporters',
  '/supporters/city/Berlin',
  '/signature/image.png',
  '/no-such-page',
] as const;

function expectAnswer(response: Response, expected: Expected): void {
  expect(response.status).toBe(expected.status);
  expect(response.headers['location']).toBe(expected.location);
  if (expected.type !== undefined) expect(response.headers['content-type']).toMatch(new RegExp(`^${expected.type}`));
  if (expected.type === 'text/html') {
    // Every page and error page has the layout and one h1 (F-08, F-79); a 404 is the styled page, never a redirect.
    const page = parse(response.text);
    expect(page.texts('h1')).toHaveLength(1);
    if (expected.status === 404) expect(page.text('h1')).toBe('Page not found');
  }
}

const cases = <T extends { expected: PerState }>(routes: readonly T[]) =>
  routes.flatMap((route) => STATES.map((state) => ({ ...route, state, want: route.expected[state] })));

describe('GET: every route for every visitor state', () => {
  it.each(cases(GET_ROUTES))('F-07, B-06, B-07: GET $path as $state', async ({ path, state, want }) => {
    const { agent } = await visitor(state);

    expectAnswer(await agent.get(path), want);
  });
});

describe('POST: every route for every visitor state, with a valid token', () => {
  it.each(cases(POST_ROUTES))('F-07, B-06, B-07: POST $path as $state', async ({ path, body, state, want }) => {
    const { agent, csrf } = await visitor(state);

    expectAnswer(await postForm(agent, path, { _csrf: csrf, ...body }), want);
  });

  it.each(STATES.flatMap((state) => READ_ONLY_PATHS.map((path) => ({ path, state }))))(
    'F-07, F-08: POST $path as $state is the 404 page',
    async ({ path, state }) => {
      const { agent, csrf } = await visitor(state);

      expectAnswer(await postForm(agent, path, { _csrf: csrf }), NOT_FOUND);
    },
  );
});

/** Rows a guest's POST could have written if a guard were missing (B-06). */
async function rowCounts(): Promise<{ users: number; profiles: number; signatures: number }> {
  const [[userRows], [profileRows], [signatureRows]] = await Promise.all([
    testApp.db.select({ value: count() }).from(users),
    testApp.db.select({ value: count() }).from(profiles),
    testApp.db.select({ value: count() }).from(signatures),
  ]);
  return { users: userRows?.value ?? -1, profiles: profileRows?.value ?? -1, signatures: signatureRows?.value ?? -1 };
}

describe('guards decide before any handler touches the database', () => {
  it('B-06: valid submissions from a guest to every signed-in route are redirected and write nothing', async () => {
    const guest = await visitor('guest');
    const before = await rowCounts();
    const submissions: readonly [string, Record<string, string>][] = [
      ['/profile', { age: '36', city: 'Bonn', homepage: 'example.org' }],
      [
        '/profile/edit',
        {
          firstName: 'Ada',
          lastName: 'Lovelace',
          email: `ada-${randomUUID()}@example.org`,
          age: '',
          city: '',
          homepage: '',
          newPassword: '',
          currentPassword: '',
        },
      ],
      ['/signature', { method: 'typed', typedName: 'Ada Lovelace' }],
      ['/signature/delete', {}],
      ['/account/delete', { currentPassword: 'correct horse battery staple' }],
      ['/logout', {}],
    ];

    for (const [path, body] of submissions) {
      expectAnswer(await postForm(guest.agent, path, { _csrf: guest.csrf, ...body }), seeOther('/login'));
    }

    expect(await rowCounts()).toEqual(before);
  });

  it('B-07, F-43: a signer who submits a valid signature again is sent to /thank-you and keeps one signature', async () => {
    const signer = await visitor('signed');
    const userId = signer.userId ?? -1;

    const response = await postForm(signer.agent, '/signature', {
      _csrf: signer.csrf,
      method: 'typed',
      typedName: 'Ada Lovelace',
    });

    expectAnswer(response, seeOther('/thank-you'));
    const rows = await testApp.db.select({ id: signatures.id }).from(signatures).where(eq(signatures.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('B-07, F-48: a non-signer never sees the thank-you page or a broken signature image', async () => {
    const { agent } = await visitor('unsigned');

    expectAnswer(await agent.get('/thank-you'), found('/signature'));
    const image = await agent.get('/signature/image.png');
    expect(image.status).toBe(404);
    expect(image.headers['content-type']).not.toMatch(/^image\//);
  });
});

/** Whether the visitor is still in the state they started in: signed in or not, and signed or not. */
async function expectUnchanged(visitorState: State, agent: Agent): Promise<void> {
  if (visitorState === 'guest') {
    expectAnswer(await agent.get('/profile'), loginFor('/profile'));
    return;
  }
  expectAnswer(await agent.get('/account/delete'), PAGE); // still signed in, account still there
  expectAnswer(await agent.get('/thank-you'), visitorState === 'signed' ? PAGE : found('/signature'));
}

const TOKENS = [
  { token: 'missing', fields: (): Record<string, string> => ({}) },
  { token: 'forged', fields: (): Record<string, string> => ({ _csrf: `forged-${randomUUID()}` }) },
] as const;

describe('CSRF on every POST route', () => {
  it.each(cases(POST_ROUTES).flatMap((route) => TOKENS.map((token) => ({ ...route, ...token }))))(
    'F-70, B-13: POST $path as $state with a $token token is the 403 page and changes nothing',
    async ({ path, body, state, fields }) => {
      const { agent } = await visitor(state);

      const response = await postForm(agent, path, { ...body, ...fields() });

      expect(response.status).toBe(403);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.headers['location']).toBeUndefined();
      expect(parse(response.text).text('h1')).toBe('This form has expired');
      expect(response.text).not.toMatch(/EBADCSRFTOKEN|ForbiddenError|invalid csrf token|\bat \S+ \(/i);
      await expectUnchanged(state, agent);
    },
  );
});

describe('test-only routes exist only in the test harness', () => {
  /** The app as `server.ts` builds it: `createApp(deps)` without `testRoutes`, on this file's database. */
  let plain: TestApp;

  beforeAll(async () => {
    plain = await createTestApp({ testRoutes: false });
  });

  afterAll(async () => {
    await plain.close();
  });

  it('F-07, ADR 0017: the harness app signs in through POST /__test/sign-in (the control case)', async () => {
    const user = await createUser(testApp.db);
    const agent = request.agent(testApp.app);

    await agent.post('/__test/sign-in').send({ userId: user.id }).expect(204);
    expectAnswer(await agent.get('/profile'), PAGE);
  });

  it('F-07, F-08, ADR 0017: without test routes /__test/sign-in is the 404 page and signs nobody in', async () => {
    const user = await createUser(testApp.db);
    const agent = request.agent(plain.app);
    const { csrf } = await getForm(agent, '/login');

    // With a valid token the request passes CSRF and finds no route.
    expectAnswer(await postForm(agent, '/__test/sign-in', { _csrf: csrf, userId: String(user.id) }), NOT_FOUND);
    expectAnswer(await agent.get('/__test/sign-in'), NOT_FOUND);
    // The JSON body the harness uses carries no form token, so CSRF rejects it before routing (F-70).
    const json = await agent.post('/__test/sign-in').send({ userId: user.id });
    expect(json.status).toBe(403);
    expect(parse(json.text).text('h1')).toBe('This form has expired');

    expectAnswer(await agent.get('/profile'), loginFor('/profile'));
  });

  it('ADR 0017: the other test-only routes do not exist either', async () => {
    const agent = request.agent(plain.app);
    const { csrf } = await getForm(agent, '/login');

    for (const path of ['/__test/form', '/__test/rate-limit/auth-ip', '/__test/rate-limit/sign']) {
      expectAnswer(await postForm(agent, path, { _csrf: csrf, outcome: 'valid' }), NOT_FOUND);
    }
  });
});
