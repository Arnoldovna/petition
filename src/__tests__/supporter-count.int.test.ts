import { randomUUID } from 'node:crypto';

import { count } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../test/auth.js';
import { createSignature, createUser, type TestUser } from '../../test/factories.js';
import { getForm, postForm, type Agent } from '../../test/forms.js';
import { parse } from '../../test/html.js';
import { createTestApp, type TestApp } from '../../test/test-app.js';
import { signatures } from '../db/schema/index.js';

/**
 * The supporter count across modules (F-47, F-49, F-68, B-30, B-34): this app injects **no** `countSupporters`, so the
 * thank-you page of the signature module shows the supporters module's own count, exactly as `app.ts` wires them in
 * production. The count must equal the total and the rows of the supporters list, and it must go down when a
 * signature or an account is deleted through the real routes.
 *
 * All tests share the file's database, so each one compares numbers before and after its own action instead of
 * expecting absolute values; the rows any other test left behind are counted by both sides alike.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  await testApp.close();
});

interface Member {
  user: TestUser;
  agent: Agent;
}

/** A signed-in user with a unique last name, so their row can be found in the list; `signed` adds a signature. */
async function member({ signed }: { signed: boolean }): Promise<Member> {
  const user = await createUser(testApp.db, { lastName: `Count-${randomUUID()}` });
  if (signed) await createSignature(testApp.db, user.id);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { user, agent };
}

/** The number on the thank-you page ("1,284 supporters" -> 1284) and its label. */
async function thankYouCount(agent: Agent): Promise<{ value: number; label: string }> {
  const page = parse((await agent.get('/thank-you').expect(200)).text);
  const number = page.text('.supporter-count__number') ?? '';
  expect(number).toMatch(/^\d{1,3}(,\d{3})*$/);
  return { value: Number(number.replaceAll(',', '')), label: page.text('.supporter-count__label') ?? '' };
}

interface SupportersList {
  /** The total in the heading's lead ("64 supporters"), from page 1. */
  total: number;
  /** Every row of every page, followed through the "next" links. */
  names: string[];
}

/** Reads `/supporters` page by page until there is no next page. */
async function supportersList(agent: Agent): Promise<SupportersList> {
  const names: string[] = [];
  let total: number | undefined;
  let path: string | undefined = '/supporters';
  for (let pages = 0; path !== undefined; pages++) {
    expect(pages).toBeLessThan(100); // a pagination bug must fail the test, not loop forever
    const page = parse((await agent.get(path).expect(200)).text);
    if (total === undefined) {
      const lead = /^(\d{1,3}(?:,\d{3})*) supporters?$/.exec(page.text('.page-heading__lead') ?? '');
      total = Number((lead?.[1] ?? 'NaN').replaceAll(',', ''));
    }
    names.push(...page.texts('.supporter-row__name'));
    path = page.attr('.pagination a[rel="next"]', 'href');
  }
  return { total: total ?? Number.NaN, names };
}

async function signaturesInDatabase(): Promise<number> {
  const [row] = await testApp.db.select({ value: count() }).from(signatures);
  return row?.value ?? Number.NaN;
}

const fullName = ({ user }: Member): string => `${user.firstName} ${user.lastName}`;

describe('thank-you count and supporters list (real modules)', () => {
  it('F-47, B-30: the count equals the list total and its rows, signers without a profile included', async () => {
    const withProfile = await member({ signed: true });
    // A real onboarding through the profile module, so the list has a signer with and one without a profile.
    const onboarding = await getForm(withProfile.agent, '/profile');
    await postForm(withProfile.agent, '/profile', {
      _csrf: onboarding.csrf,
      age: '36',
      city: 'Bonn',
      homepage: '',
    }).expect(303);
    const withoutProfile = await member({ signed: true });
    const notSigned = await member({ signed: false });

    const shown = await thankYouCount(withoutProfile.agent);
    const list = await supportersList(withoutProfile.agent);

    expect(shown.value).toBe(await signaturesInDatabase());
    expect(list.total).toBe(shown.value);
    expect(list.names).toHaveLength(shown.value);
    expect(shown.label).toBe(shown.value === 1 ? 'supporter' : 'supporters');
    expect(list.names).toEqual(expect.arrayContaining([fullName(withProfile), fullName(withoutProfile)]));
    expect(list.names).not.toContain(fullName(notSigned));
  });

  it('F-47, B-31: past one page of 50 rows the count is still the total of every page', async () => {
    const observer = await member({ signed: true });
    for (let index = 0; index < 51; index++) {
      const user = await createUser(testApp.db, { lastName: `Bulk-${String(index)}` });
      await createSignature(testApp.db, user.id);
    }

    const shown = await thankYouCount(observer.agent);
    const list = await supportersList(observer.agent);

    expect(shown.value).toBeGreaterThan(50);
    expect(list.total).toBe(shown.value);
    expect(list.names).toHaveLength(shown.value);
    expect(new Set(list.names).size).toBe(list.names.length); // no row twice across the page boundary
  });
});

describe('the count goes down with every deletion', () => {
  it('F-49: deleting a signature lowers the count and the list total by one and removes the row', async () => {
    const observer = await member({ signed: true });
    const leaver = await member({ signed: true });
    const before = await thankYouCount(observer.agent);
    expect((await supportersList(observer.agent)).names).toContain(fullName(leaver));

    const confirm = await getForm(leaver.agent, '/signature/delete');
    await postForm(leaver.agent, '/signature/delete', { _csrf: confirm.csrf })
      .expect(303)
      .expect('Location', '/signature');

    const after = await thankYouCount(observer.agent);
    const list = await supportersList(observer.agent);
    expect(after.value).toBe(before.value - 1);
    expect(list.total).toBe(after.value);
    expect(list.names).toHaveLength(after.value);
    expect(list.names).not.toContain(fullName(leaver));
  });

  it('F-68, B-34: deleting the account of a signer lowers the count by one; a non-signer leaves it unchanged', async () => {
    const observer = await member({ signed: true });
    const signer = await member({ signed: true });
    const nonSigner = await member({ signed: false });
    const before = await thankYouCount(observer.agent);

    const signerForm = await getForm(signer.agent, '/account/delete');
    await postForm(signer.agent, '/account/delete', {
      _csrf: signerForm.csrf,
      currentPassword: signer.user.password,
    })
      .expect(303)
      .expect('Location', '/');
    const afterSigner = await thankYouCount(observer.agent);

    const nonSignerForm = await getForm(nonSigner.agent, '/account/delete');
    await postForm(nonSigner.agent, '/account/delete', {
      _csrf: nonSignerForm.csrf,
      currentPassword: nonSigner.user.password,
    })
      .expect(303)
      .expect('Location', '/');
    const afterNonSigner = await thankYouCount(observer.agent);

    expect(afterSigner.value).toBe(before.value - 1);
    expect(afterNonSigner.value).toBe(afterSigner.value);
    const list = await supportersList(observer.agent);
    expect(list.total).toBe(afterNonSigner.value);
    expect(list.names).toHaveLength(afterNonSigner.value);
    expect(list.names).not.toContain(fullName(signer));
  });
});
