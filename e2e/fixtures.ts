import { randomBytes, randomUUID } from 'node:crypto';

import { test as base, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

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
 * - **Helpers** drive the real forms (ROUTES.md); form fields are found by id, which the frozen `form-field` partial
 *   sets to the field name. Mutating specs use `uniqueCity()` and assert counts relative to a value read at the start.
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
 * (the reserved demo domain) and a random 24-character password, so parallel workers never collide.
 *
 * @public used by the phase-2+ specs and the worker fixture below.
 */
export async function registerUser(page: Page, options: RegisterOptions = {}): Promise<E2eUser> {
  const id = randomUUID();
  const user: E2eUser = {
    firstName: options.firstName ?? 'Ada',
    lastName: options.lastName ?? `Tester ${id.slice(0, 8)}`,
    email: `e2e-${id}@petition.test`,
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
  /** CSP violations seen so far in this test's context; must be empty when the test ends. */
  cspViolations: CspViolation[];
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

      await use(violations);

      expect(violations, 'Content-Security-Policy violations (F-71)').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
