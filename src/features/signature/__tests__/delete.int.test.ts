import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import { getForm, postForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { signatures } from '../../../db/schema/index.js';
import { createSignatureRepository } from '../signature.repository.js';

/**
 * Deleting a signature (F-49, F-50, ADR 0013): the confirmation page only for signers, the POST that deletes the
 * viewer's own row only, the flash, and CSRF. The count drop with the real supporters module is phase 2b.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp({ countSupporters: () => Promise.resolve(2) });
});

afterAll(async () => {
  await testApp.close();
});

const CONFIRM_FORM = 'form.confirm-panel__form';

interface Viewer {
  agent: Agent;
  userId: number;
}

async function viewer({ signed }: { signed: boolean }): Promise<Viewer> {
  const user = await createUser(testApp.db);
  if (signed) await createSignature(testApp.db, user.id);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { agent, userId: user.id };
}

const signatureRows = (userId: number) =>
  testApp.db.select({ id: signatures.id }).from(signatures).where(eq(signatures.userId, userId));

describe('GET /signature/delete', () => {
  it('F-50, ADR 0013: a signer sees what will happen, a POST form and a way to keep the signature', async () => {
    const { agent } = await viewer({ signed: true });

    const page = parse((await agent.get('/signature/delete').expect(200)).text);

    expect(page.text('title')).toBe('Delete signature · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['Delete signature']);
    expect(page.text('.confirm-panel__title')).toBe('Delete your signature?');
    expect(page.texts('.confirm-panel__item')).toContain('The supporter count goes down by one.');
    expect(page.attr(CONFIRM_FORM, 'method')).toBe('post');
    expect(page.attr(CONFIRM_FORM, 'action')).toBe('/signature/delete');
    expect(page.text(`${CONFIRM_FORM} button.button--primary`)).toBe('delete my signature');
    expect(page.attr('.confirm-panel__cancel', 'href')).toBe('/thank-you');
    expect(page.text('.confirm-panel__cancel')).toBe('keep my signature');
  });

  it('F-50, F-75, F-76: the confirmation works without JavaScript, is guarded and needs no extra field', async () => {
    const { agent } = await viewer({ signed: true });

    const page = parse((await agent.get('/signature/delete').expect(200)).text);

    expect(page.has(`${CONFIRM_FORM}[novalidate][data-guard]`)).toBe(true);
    expect(page.attr(`${CONFIRM_FORM} input[type="hidden"][name="_csrf"]`, 'value')).not.toBe('');
    expect(page.has(`${CONFIRM_FORM} .confirm-panel__fields`)).toBe(false);
    expect(page.has(`${CONFIRM_FORM} input:not([type="hidden"])`)).toBe(false);
    expect(page.has(`${CONFIRM_FORM} .confirm-panel__actions button[type="submit"].button--primary`)).toBe(true);
    expect(page.has(`${CONFIRM_FORM} .confirm-panel__actions .confirm-panel__cancel`)).toBe(true);
    expect(page.attr('.confirm-panel', 'aria-labelledby')).toBe('confirm-panel-title');
    expect(page.text('#confirm-panel-title')).toBe('Delete your signature?');
  });

  it('F-50, B-47: a viewer who has not signed is never offered the delete step', async () => {
    const { agent } = await viewer({ signed: false });

    await agent.get('/signature/delete').expect(302).expect('location', '/signature');
  });

  it('F-07, F-30: a guest is sent to the login page', async () => {
    await request(testApp.app)
      .get('/signature/delete')
      .expect(302)
      .expect('location', '/login?returnTo=%2Fsignature%2Fdelete');
  });
});

describe('POST /signature/delete', () => {
  it("F-49: deletes only the viewer's own signature, then the sign page shows the flash once", async () => {
    const own = await viewer({ signed: true });
    const other = await viewer({ signed: true });
    const { csrf } = await getForm(own.agent, '/signature/delete', CONFIRM_FORM);

    await postForm(own.agent, '/signature/delete', { _csrf: csrf }).expect(303).expect('location', '/signature');

    expect(await signatureRows(own.userId)).toEqual([]);
    expect(await signatureRows(other.userId)).toHaveLength(1);
    const signPage = parse((await own.agent.get('/signature').expect(200)).text);
    expect(signPage.text('.flash__message')).toBe('Your signature was removed');
    expect(parse((await own.agent.get('/signature').expect(200)).text).has('.flash__message')).toBe(false);
  });

  it('F-48, F-49: afterwards the thank-you page and the image are gone for the viewer', async () => {
    const { agent } = await viewer({ signed: true });
    const { csrf } = await getForm(agent, '/signature/delete', CONFIRM_FORM);
    await postForm(agent, '/signature/delete', { _csrf: csrf }).expect(303);

    await agent.get('/thank-you').expect(302).expect('location', '/signature');
    await agent.get('/signature/image.png').expect(404);
  });

  it('F-49, F-07: repeating the POST after the signature is gone redirects to the sign page (idempotent)', async () => {
    const { agent, userId } = await viewer({ signed: false });
    const { csrf } = await getForm(agent, '/signature', 'form.typed-signature__form');

    await postForm(agent, '/signature/delete', { _csrf: csrf }).expect(303).expect('location', '/signature');

    expect(await signatureRows(userId)).toEqual([]);
  });

  it('F-70: without a CSRF token the 403 page answers and the signature stays', async () => {
    const { agent, userId } = await viewer({ signed: true });

    const response = await postForm(agent, '/signature/delete', {});

    expect(response.status).toBe(403);
    expect(parse(response.text).text('h1')).toBe('This form has expired');
    expect(await signatureRows(userId)).toHaveLength(1);
  });

  it('B-54: deleteByUser reports whether a row was deleted', async () => {
    const user = await createUser(testApp.db);
    await createSignature(testApp.db, user.id);
    const repository = createSignatureRepository(testApp.db);

    expect(await repository.deleteByUser(user.id)).toBe(true);
    expect(await repository.deleteByUser(user.id)).toBe(false);
  });
});
