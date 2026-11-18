import { randomBytes, randomUUID } from 'node:crypto';

import {
  test as base,
  expect,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
  type Response,
} from '@playwright/test';

/**
 * Shared E2E fixtures and helpers (ADR 0015, ADR 0017). Specs import `test` and `expect` from here, never from
 * `@playwright/test`, so every test gets the CSP guard and can opt into the signed-in worker user.
 *
 * - **CSP guard** (automatic, F-71): every `securitypolicyviolation` in the test's browser context fails the test at
 *   teardown. A test that provokes a violation on purpose asserts it and takes it out with `cspViolations.splice(0)`.
 * - **Signed-in worker user**: `test.use({ signedIn: true })` gives every test of the file or describe block a context
 *   that is signed in as one user per worker, registered through the real `/register` form on first use (lazily, so
 *   guest-only workers register nobody). The user is signed in and has **not signed**. Specs that sign, log out,
 *   change the email or password or delete the account register their own user with `registerUser`, because the
 *   worker user is shared by every later test of the worker.
 * - **More browser contexts** ("another device", a replayed cookie, a JavaScript twin of a no-JS page) come from the
 *   `newGuardedContext` fixture, never from `browser.newContext()`: it installs the same CSP guard, reports into the
 *   same `cspViolations` and closes the context when the test ends.
 * - **Helpers** drive the real forms (ROUTES.md); form fields are found by id, which the frozen `form-field` partial
 *   sets to the field name. Mutating specs use `uniqueCity()` and assert counts relative to a value read at the start.
 *   The shared locators and steps below (flash, error summary, document responses, login and logout, supporters
 *   rows, submit-state recorder) exist once here, so every spec reads the page the same way.
 *
 * Browser facts the specs rely on (found in phase 5):
 *
 * - Inside Playwright Test, `browser.newContext()` (and so `newGuardedContext`) inherits the project and describe
 *   options, `javaScriptEnabled: false` included. A context that needs JavaScript passes `javaScriptEnabled: true`.
 * - axe-core runs as a script in the page, so it cannot run with JavaScript disabled: a no-JS page is checked with axe
 *   on the same URL in a JavaScript-enabled context with the same cookies.
 * - Playwright's text and role queries skip `<noscript>` content even when Chromium renders it, so a no-JS note is
 *   found by structure (`noscript > p`).
 * - `base.css` sets `scroll-behavior: smooth`; a spec that scrolls and then measures positions scrolls with
 *   `behavior: 'instant'`.
 * - Playwright locator assertions wait while a navigation is pending, so a test that holds a POST on purpose reads
 *   the page through a binding (`recordSubmitStates`).
 *
 * This file is frozen from phase 1b on (BUILD-ORDER.md rule 2); changes are queued to step 5e.
 */

/**
 * A user registered through `/register`, with the plain password for login and re-authentication tests.
 *
 * @public the return type of `registerUser` and the `workerUser` fixture.
 */
export interface E2eUser {
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

/** Raw onboarding values as typed into `/profile` (all optional, F-34). */
interface ProfileFields {
  age?: string;
  city?: string;
  homepage?: string;
}

interface RegisterOptions {
  firstName?: string;
  lastName?: string;
  /** A given email, e.g. the email of a deleted account that must be free again (F-69); default `e2e-<uuid>@...`. */
  email?: string;
  /** When given, also completes onboarding with these values ("continue"), which ends on `/signature`. */
  profile?: ProfileFields;
}

/** One reported Content-Security-Policy violation. */
interface CspViolation {
  page: string;
  directive: string;
  blockedURI: string;
  sourceFile: string;
  line: number;
}

interface WorkerAccount {
  user: E2eUser;
  storageState: Awaited<ReturnType<BrowserContext['storageState']>>;
}

declare global {
  interface Window {
    /** Installed by the CSP guard through `exposeBinding`; absent outside E2E runs. */
    __e2eReportCspViolation?: (violation: Omit<CspViolation, 'page'>) => Promise<void>;
  }
}

/** Waits until the page shows exactly `pathname` (no query), e.g. after a PRG redirect. */
async function expectPath(page: Page, pathname: string): Promise<void> {
  await expect(page).toHaveURL(new URL(pathname, page.url()).href);
}

/**
 * A city no other test uses (`e2e-<uuid>`, ADR 0015), so a spec can count and list its own supporters.
 *
 * @public used by the phase-2+ specs (supporters, journey); knip cannot see future importers.
 */
export function uniqueCity(): string {
  return `e2e-${randomUUID()}`;
}

/**
 * Registers a new user through `/register` (F-18) on a **guest** page and leaves that page signed in as the user, on
 * `/profile` (onboarding) or, with `profile`, on `/signature` after onboarding. Email `e2e-<uuid>@petition.test`
 * (the reserved demo domain, unless `email` is given) and a random 24-character password, so parallel workers never
 * collide.
 *
 * @public used by the phase-2+ specs and the worker fixture below.
 */
export async function registerUser(page: Page, options: RegisterOptions = {}): Promise<E2eUser> {
  const id = randomUUID();
  const user: E2eUser = {
    firstName: options.firstName ?? 'Ada',
    lastName: options.lastName ?? `Tester ${id.slice(0, 8)}`,
    email: options.email ?? `e2e-${id}@petition.test`,
    password: randomBytes(18).toString('base64url'),
  };

  await page.goto('/register');
  await page.locator('#firstName').fill(user.firstName);
  await page.locator('#lastName').fill(user.lastName);
  await page.locator('#email').fill(user.email);
  await page.locator('#password').fill(user.password);
  // Implicit submission: the button label is the auth module's copy, the field ids are the frozen partial contract.
  await page.locator('#password').press('Enter');
  await expectPath(page, '/profile');

  if (options.profile !== undefined) {
    const { age = '', city = '', homepage = '' } = options.profile;
    await page.locator('#age').fill(age);
    await page.locator('#city').fill(city);
    await page.locator('#homepage').fill(homepage);
    await page.getByRole('button', { name: 'continue' }).click();
    await expectPath(page, '/signature');
  }
  return user;
}

/**
 * Signs with a drawn signature (F-37 to F-41): one long stroke across the pad with the mouse, then "sign the
 * petition". Needs JavaScript (the drawing form is enhanced by signature-pad.js) and a signed-in user who has not
 * signed; ends on `/thank-you`. Touch input is covered by `signature-pad.spec.ts` on WebKit.
 *
 * @public used by the phase-2+ specs.
 */
export async function signDrawn(page: Page): Promise<void> {
  await page.goto('/signature');
  const pad = page.getByRole('img', { name: 'Signature pad' });
  await expect(pad).toBeVisible();
  const box = await pad.boundingBox();
  if (box === null) throw new Error('signDrawn: the signature pad has no layout box');

  // Relative points, so the stroke fits the pad at every viewport width (F-83).
  const at = (x: number, y: number): [number, number] => [box.x + box.width * x, box.y + box.height * y];
  const stroke: [number, number][] = [
    [0.25, 0.25],
    [0.4, 0.75],
    [0.55, 0.3],
    [0.7, 0.7],
    [0.9, 0.4],
  ];
  await page.mouse.move(...at(0.1, 0.6));
  await page.mouse.down();
  for (const [x, y] of stroke) await page.mouse.move(...at(x, y), { steps: 8 });
  await page.mouse.up();

  await page.getByRole('button', { name: 'sign the petition' }).click();
  await expectPath(page, '/thank-you');
}

/**
 * Signs by typing the full name (F-45, the keyboard and no-JS path); ends on `/thank-you`. Needs a signed-in user
 * who has not signed.
 *
 * @public used by the phase-2+ specs.
 */
export async function signTyped(page: Page, typedName = 'Ada Lovelace'): Promise<void> {
  await page.goto('/signature');
  await page.locator('#typedName').fill(typedName);
  await page.getByRole('button', { name: 'sign with my typed name' }).click();
  await expectPath(page, '/thank-you');
}

// ------------------------------------------------------------------------------------------------------------------
// Shared locators and steps (queued from the phase-5 units, BUILD-ORDER 5e)
// ------------------------------------------------------------------------------------------------------------------

/**
 * Rows per supporters page, the spec value of ADR 0006 (F-54) that `supporters.spec.ts` asserts, like the integration
 * tests do. Helpers read the page count from the page instead (`lastListPage`).
 */
export const SUPPORTERS_PAGE_SIZE = 50;

/** "First Last", as the supporter row and the sign page print it. */
export function fullName(user: Pick<E2eUser, 'firstName' | 'lastName'>): string {
  return `${user.firstName} ${user.lastName}`;
}

/** `/supporters/city/<encoded>`, built the way the app builds its city links (F-57). */
export function cityPath(city: string): string {
  return `/supporters/city/${encodeURIComponent(city)}`;
}

/** The supporters `<ol>` of the page (F-54: a semantic ordered list; the pagination uses a `<ul>`). */
export function supporterList(page: Page): Locator {
  return page.getByRole('main').locator('ol');
}

/** The full names of the rows, in document order (the frozen `supporter-row` partial puts exactly the name there). */
export function supporterNames(page: Page): Locator {
  return supporterList(page).getByRole('listitem').locator('.supporter-row__name');
}

/** The row of one supporter, found by the exact full name. */
export function supporterRow(page: Page, name: string): Locator {
  return supporterList(page)
    .getByRole('listitem')
    .filter({ has: page.locator('.supporter-row__name').getByText(name, { exact: true }) });
}

/**
 * The last page number of the open list page, from its pagination status ("page 1 of 6"); a list that fits on one
 * page has no pagination at all (the frozen `pagination` partial). Read from the page, so the search never depends on
 * the page size.
 */
async function lastListPage(page: Page): Promise<number> {
  const status = page.getByRole('navigation', { name: 'Pagination' }).locator('.pagination__status');
  if ((await status.count()) === 0) return 1;
  const last = Number(/ of (\d+)$/.exec((await status.innerText()).trim())?.[1]);
  expect(last, 'the pagination names the last page').toBeGreaterThan(1);
  return last;
}

/**
 * The row of `name` on the paginated supporters list, searched from the last page backwards. Rows are ordered by
 * signing time and a new signer is appended, so a row can only move to an earlier page while the search runs (when
 * other workers delete earlier signatures); `toPass` searches again in the rare case of a concurrent commit.
 */
export async function findSupporterRow(page: Page, name: string): Promise<Locator> {
  await expect(async () => {
    await page.goto('/supporters');
    const last = await lastListPage(page);
    for (let pageNumber = last; pageNumber >= 1; pageNumber -= 1) {
      // A one-page list is already open; otherwise every page, page 1 last, is opened in turn.
      if (last > 1) {
        const response = await page.goto(pageNumber === 1 ? '/supporters' : `/supporters?page=${String(pageNumber)}`);
        // A page that no longer exists (concurrent deletions shortened the list): its rows moved to earlier pages.
        if (response?.status() !== 200) continue;
      }
      if ((await supporterRow(page, name).count()) === 1) return;
    }
    throw new Error(`${name} is on no page of the supporters list`);
  }).toPass();
  return supporterRow(page, name);
}

/** Opens the city page and checks that exactly these supporters are listed, or the empty state for none (F-56, F-58). */
export async function expectCitySupporters(page: Page, city: string, names: readonly string[]): Promise<void> {
  await page.goto(cityPath(city));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Supporters from ${city}`);
  await expect(supporterNames(page)).toHaveText([...names]);
  if (names.length === 0) {
    await expect(page.getByRole('heading', { level: 2, name: `No supporters from ${city} yet` })).toBeVisible();
  }
}

/** The one-time flash region (F-17): `role="status"`, always present in `<main>`. */
export function flash(page: Page): Locator {
  return page.getByRole('main').getByRole('status');
}

/** The error summary of a 422/401 re-render (F-21, B-68). */
export function errorSummary(page: Page): Locator {
  return page.getByRole('alert', { name: 'There is a problem' });
}

/** An invalid field: `aria-invalid` and a description that starts with its message (F-21, B-68). */
export async function expectFieldError(field: Locator, message: string, hint?: string): Promise<void> {
  await expect(field).toHaveAttribute('aria-invalid', 'true');
  await expect(field).toHaveAccessibleDescription(`Error: ${message}${hint === undefined ? '' : ` ${hint}`}`);
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** `page.goto` for a spec that inspects the document response; fails instead of returning `null`. */
export async function gotoResponse(page: Page, path: string): Promise<Response> {
  const response = await page.goto(path);
  if (response === null) throw new Error(`no response for ${path}`);
  return response;
}

/** The final document of a navigation started by `act`: a re-render (422, 401, 4xx) or the page after a PRG redirect. */
export async function documentAfter(page: Page, act: () => Promise<unknown>): Promise<Response> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().isNavigationRequest() &&
      candidate.frame() === page.mainFrame() &&
      !REDIRECT_STATUSES.has(candidate.status()),
  );
  await act();
  return response;
}

/** Waits for the response to the POST to `path` that `submit` sends, and returns its status. */
export async function postStatus(page: Page, path: string, submit: () => Promise<void>): Promise<number> {
  const response = page.waitForResponse(
    (candidate) => candidate.request().method() === 'POST' && new URL(candidate.url()).pathname === path,
  );
  await submit();
  return (await response).status();
}

/** Fills and sends the login form on the current `/login` page; 303 on success, 401 for wrong credentials (F-24). */
export async function submitLogin(page: Page, email: string, password: string): Promise<number> {
  await page.getByLabel('email', { exact: true }).fill(email);
  await page.getByLabel('password', { exact: true }).fill(password);
  return postStatus(page, '/login', () => page.getByRole('button', { name: 'log in' }).click());
}

/** Opens `/login` as a guest and sends the form; returns the status. */
export async function tryLogIn(page: Page, email: string, password: string): Promise<number> {
  await page.goto('/login');
  return submitLogin(page, email, password);
}

/** Logs in through `/login` (F-23) and expects success. */
export async function logIn(page: Page, email: string, password: string): Promise<void> {
  expect(await tryLogIn(page, email, password), `log in as ${email}`).toBe(303);
}

/** Logs out with the navigation's POST button (F-25) and waits for the home page. */
export async function logOut(page: Page): Promise<void> {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'log out' }).click();
  await expect(page).toHaveURL('/');
}

/** The app's session or CSRF cookie: `petition.<name>`, or `__Host-petition.<name>` over https. */
export async function cookieOf(context: BrowserContext, name: 'sid' | 'x-csrf-token') {
  const cookie = (await context.cookies()).find((candidate) => candidate.name.endsWith(`petition.${name}`));
  if (cookie === undefined) throw new Error(`cookie petition.${name} is not set`);
  return cookie;
}

/** A second browser ("another device") signed in as `user`, opened through `newGuardedContext`. */
export async function signInOnSecondDevice(
  newGuardedContext: (options?: BrowserContextOptions) => Promise<BrowserContext>,
  user: Pick<E2eUser, 'email' | 'password'>,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await newGuardedContext();
  const page = await context.newPage();
  await logIn(page, user.email, user.password);
  return { context, page };
}

/** One observed state of a submit button (F-75). */
export interface SubmitState {
  ariaBusy: string | null;
  disabled: boolean;
}

let submitStateBindings = 0;

/**
 * Records every change of `aria-busy` and `disabled` on a submit button (F-75). The page reports through a binding,
 * because locators wait for a pending navigation and the test holds that navigation on purpose.
 */
export async function recordSubmitStates(page: Page, button: Locator): Promise<SubmitState[]> {
  submitStateBindings += 1;
  const binding = `__e2eSubmitState${String(submitStateBindings)}`;
  const states: SubmitState[] = [];
  await page.exposeBinding(binding, (_source, state: SubmitState) => {
    states.push(state);
  });
  await button.evaluate((element, name) => {
    if (!(element instanceof HTMLButtonElement)) throw new Error('recordSubmitStates: not a button');
    const report = Reflect.get(window, name) as (state: SubmitState) => Promise<void>;
    new MutationObserver(() => {
      void report({ ariaBusy: element.getAttribute('aria-busy'), disabled: element.disabled });
    }).observe(element, { attributes: true, attributeFilter: ['aria-busy', 'disabled'] });
  }, binding);
  return states;
}

/**
 * Fails the test on every `securitypolicyviolation` in `context` (F-71): the page reports through a binding into
 * `violations`, which the `cspViolations` fixture asserts empty at teardown.
 */
async function installCspGuard(context: BrowserContext, violations: CspViolation[]): Promise<void> {
  await context.exposeBinding('__e2eReportCspViolation', ({ page }, violation: Omit<CspViolation, 'page'>) => {
    violations.push({ page: page.url(), ...violation });
  });
  // Init scripts are injected by Playwright, not by the page, so the CSP under test does not block them.
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      void window.__e2eReportCspViolation?.({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
        sourceFile: event.sourceFile,
        line: event.lineNumber,
      });
    });
  });
}

/** Registers the worker user in a context of its own and keeps its cookies (session and CSRF) for later contexts. */
async function registerWorkerAccount(browser: Browser, baseURL: string | undefined): Promise<WorkerAccount> {
  const context = await browser.newContext({ baseURL });
  try {
    const user = await registerUser(await context.newPage());
    return { user, storageState: await context.storageState() };
  } finally {
    await context.close();
  }
}

interface E2eFixtures {
  /** Option: start every test of the file or block signed in as the worker user (`test.use({ signedIn: true })`). */
  signedIn: boolean;
  /** The worker user's names and credentials (registers it on first use). */
  workerUser: E2eUser;
  /** CSP violations seen so far in this test's contexts; must be empty when the test ends. */
  cspViolations: CspViolation[];
  /**
   * Opens another browser context ("another device") with the CSP guard of this test; `baseURL` is preset and the
   * project and describe options are inherited. Every context it opens is closed when the test ends.
   */
  newGuardedContext: (options?: BrowserContextOptions) => Promise<BrowserContext>;
}

interface E2eWorkerFixtures {
  /** Lazily registers one user per worker; every later call returns the same account. */
  workerAccount: () => Promise<WorkerAccount>;
}

export const test = base.extend<E2eFixtures, E2eWorkerFixtures>({
  workerAccount: [
    async ({ browser }, use, workerInfo) => {
      let account: Promise<WorkerAccount> | undefined;
      await use(() => (account ??= registerWorkerAccount(browser, workerInfo.project.use.baseURL)));
    },
    { scope: 'worker' },
  ],

  signedIn: [false, { option: true }],

  storageState: async ({ signedIn, storageState, workerAccount }, use) => {
    await use(signedIn ? (await workerAccount()).storageState : storageState);
  },

  workerUser: async ({ workerAccount }, use) => {
    await use((await workerAccount()).user);
  },

  cspViolations: [
    async ({ context }, use) => {
      const violations: CspViolation[] = [];
      await installCspGuard(context, violations);

      await use(violations);

      expect(violations, 'Content-Security-Policy violations (F-71)').toEqual([]);
    },
    { auto: true },
  ],

  newGuardedContext: async ({ browser, baseURL, cspViolations }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async (options = {}) => {
      const context = await browser.newContext({ baseURL, ...options });
      contexts.push(context);
      await installCspGuard(context, cspViolations);
      return context;
    });
    // Closing is idempotent, so a test may close its context early.
    await Promise.all(contexts.map((context) => context.close()));
  },
});

export { expect };
