import { createCanvas, loadImage } from '@napi-rs/canvas';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createSignature, createUser } from '../../../../test/factories.js';
import { testSignatureFontPaths } from '../../../../test/fonts.js';
import { getForm, postForm, readForm, type Agent } from '../../../../test/forms.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { signatures, users } from '../../../db/schema/index.js';
import { createSignatureImages } from '../index.js';
import { createSignatureRepository } from '../signature.repository.js';
import { drawnSignature, inkOf, pngChunk, toDataUrl, withChunkAfterHeader } from './fakes.js';

/**
 * `GET /signature` and `POST /signature` on the real app with the real image pipeline (ADR 0004, ADR 0005): the sign
 * page markup, both forms, every rejection as a 422 re-render, the 128 kb body limit, idempotent signing and CSRF.
 */

let testApp: TestApp;

beforeAll(async () => {
  testApp = await createTestApp({ signatureImages: createSignatureImages({ fontPaths: testSignatureFontPaths() }) });
});

afterAll(async () => {
  await testApp.close();
});

const DRAWN_FORM = 'form[data-signature-pad]';
const TYPED_FORM = 'form.typed-signature__form';
const UNREADABLE = 'The signature could not be read. Clear the pad and sign again.';
const BLANK = 'Please sign before submitting';

interface Signer {
  agent: Agent;
  userId: number;
}

async function signedInAgent({ firstName = 'Ada', signed = false } = {}): Promise<Signer> {
  const user = await createUser(testApp.db, { firstName });
  if (signed) await createSignature(testApp.db, user.id);
  const agent = request.agent(testApp.app);
  await signIn(agent, user.id);
  return { agent, userId: user.id };
}

const signatureRows = (userId: number) => testApp.db.select().from(signatures).where(eq(signatures.userId, userId));

/** The token of the sign page (both forms share the session's token, ADR 0003). */
const signToken = (agent: Agent): Promise<string> => getForm(agent, '/signature', TYPED_FORM).then((form) => form.csrf);

async function postDrawn(signer: Signer, signature: string) {
  return postForm(signer.agent, '/signature', { _csrf: await signToken(signer.agent), method: 'drawn', signature });
}

async function postTyped(signer: Signer, typedName: string) {
  return postForm(signer.agent, '/signature', { _csrf: await signToken(signer.agent), method: 'typed', typedName });
}

/** PRG after a stored (or already stored) signature (F-43). */
function expectThankYouRedirect(response: request.Response): void {
  expect([response.status, response.headers['location']]).toEqual([303, '/thank-you']);
}

/** A 422 re-render of the sign page with `message` in the error summary, nothing stored, and a working token. */
async function expectSignRejected(
  signer: Signer,
  response: request.Response,
  { message, href }: { message: string; href: string },
): Promise<void> {
  expect(response.status).toBe(422);
  const page = parse(response.text);
  expect(page.text('h1')).toBe('Hey Ada');
  expect(page.attr('.error-summary', 'role')).toBe('alert');
  expect(page.texts('.error-summary__link')).toEqual([message]);
  expect(page.attr('.error-summary__link', 'href')).toBe(href);
  expect(readForm(response.text, TYPED_FORM).csrf).not.toBe('');
  expect(await signatureRows(signer.userId)).toEqual([]);
}

describe('GET /signature', () => {
  it('F-37, F-45, B-70: greets the viewer and offers the labelled pad and the typed-name form', async () => {
    const { agent } = await signedInAgent({ firstName: 'Mara' });

    const response = await agent.get('/signature').expect(200);

    expect(response.headers['cache-control']).toBe('no-store');
    const page = parse(response.text);
    expect(page.text('title')).toBe('Sign the petition · Nonsense Petition');
    expect(page.texts('h1')).toEqual(['Hey Mara']);
    // The drawing form is hidden until signature-pad.js enhances it (ADR 0010).
    expect(page.root.querySelector(DRAWN_FORM)?.hasAttribute('hidden')).toBe(true);
    expect(page.attr(DRAWN_FORM, 'action')).toBe('/signature');
    expect(page.attr(`${DRAWN_FORM} input[name="method"]`, 'value')).toBe('drawn');
    expect(page.attr(`${DRAWN_FORM} input[name="signature"]`, 'type')).toBe('hidden');
    const canvas = page.root.querySelector(`${DRAWN_FORM} canvas`);
    expect(canvas?.getAttribute('role')).toBe('img');
    expect(canvas?.getAttribute('aria-label')).toBe('Signature pad');
    expect(canvas?.getAttribute('data-export-width')).toBe('720');
    expect(canvas?.getAttribute('data-export-height')).toBe('240');
    const instructions = canvas?.getAttribute('aria-describedby') ?? '';
    expect(page.text(`#${instructions}`)).toMatch(/mouse, a finger or a pen/);
    expect(page.has(`${DRAWN_FORM} [role="alert"]`)).toBe(true);
    expect(page.texts(`${DRAWN_FORM} button`)).toEqual(['clear', 'sign the petition']);
    expect(page.attr(`${DRAWN_FORM} button.button--text`, 'type')).toBe('button');
    expect(page.has('script[src="/assets/signature-pad.js"]')).toBe(true);
  });

  it('F-45: without JavaScript the page explains the pad and the typed form is always visible', async () => {
    const { agent } = await signedInAgent();

    const page = parse((await agent.get('/signature').expect(200)).text);

    // Like a browser with scripting, the parser keeps <noscript> content as text; parse it as the no-JS browser does.
    const note = parse(page.root.querySelector('noscript')?.text ?? '');
    expect(note.text('.signature-pad__noscript')).toBe(
      'Drawing a signature needs JavaScript. You can sign by typing your full name below.',
    );
    const typed = page.root.querySelector(TYPED_FORM);
    expect(typed?.hasAttribute('hidden')).toBe(false);
    expect(page.text('.typed-signature__title')).toBe('Sign by typing your full name');
    expect(page.attr(`${TYPED_FORM} input[name="method"]`, 'value')).toBe('typed');
    expect(page.attr(`${TYPED_FORM} label[for="typedName"]`, 'for')).toBe('typedName');
    expect(page.attr('#typedName', 'autocomplete')).toBe('name');
    expect(page.text(`${TYPED_FORM} button`)).toBe('sign with my typed name');
    expect(page.attr(`${TYPED_FORM} button`, 'class')).toBe('button button--outlined');
    // ADR 0014: one accent button per view, the drawing form's.
    expect(page.root.querySelectorAll('.button--primary').map((button) => button.text)).toEqual(['sign the petition']);
    for (const selector of [DRAWN_FORM, TYPED_FORM]) {
      expect(page.attr(selector, 'method')).toBe('post');
      expect(page.root.querySelector(selector)?.hasAttribute('novalidate')).toBe(true);
      expect(page.root.querySelector(selector)?.hasAttribute('data-guard')).toBe(true);
      expect(readForm(page.root.toString(), selector).csrf).not.toBe('');
    }
  });

  it('F-07, F-30: a guest is sent to the login page and returns here afterwards', async () => {
    await request(testApp.app).get('/signature').expect(302).expect('location', '/login?returnTo=%2Fsignature');
  });

  it('F-44: a viewer who has signed goes to the thank-you page', async () => {
    const { agent } = await signedInAgent({ signed: true });

    await agent.get('/signature').expect(302).expect('location', '/thank-you');
  });
});

describe('POST /signature: drawn', () => {
  it('F-42, F-17: stores the validated drawing, redirects to the thank-you page and flashes once', async () => {
    const signer = await signedInAgent();
    const upload = await drawnSignature();

    expectThankYouRedirect(await postDrawn(signer, toDataUrl(upload)));

    const [row] = await signatureRows(signer.userId);
    expect(row?.method).toBe('drawn');
    const image = await loadImage(row?.image ?? Buffer.alloc(0));
    expect([image.width, image.height]).toEqual([720, 240]);
    const thankYou = parse((await signer.agent.get('/thank-you').expect(200)).text);
    expect(thankYou.text('.flash__message')).toBe('Thank you, your signature was saved');
    expect(parse((await signer.agent.get('/thank-you').expect(200)).text).has('.flash__message')).toBe(false);
  });

  it('ADR 0004 item 3.6: stores re-encoded pixels, not the uploaded bytes with their text chunk', async () => {
    const signer = await signedInAgent();
    const upload = withChunkAfterHeader(await drawnSignature(), pngChunk('tEXt', Buffer.from('Comment\0<b>hi</b>')));

    expectThankYouRedirect(await postDrawn(signer, toDataUrl(upload)));

    const [row] = await signatureRows(signer.userId);
    expect(row?.image.equals(upload)).toBe(false);
    expect(row?.image.includes('<b>hi</b>')).toBe(false);
  });

  it('F-41, B-19: an empty pad (no JavaScript blank check) is 422 "Please sign before submitting"', async () => {
    const signer = await signedInAgent();

    const response = await postDrawn(signer, '');

    await expectSignRejected(signer, response, { message: BLANK, href: '#signature' });
    expect(parse(response.text).text('.signature-pad__message')).toBe(`Error: ${BLANK}`);
  });

  it('F-41, B-19: a transparent 720 x 240 PNG is blank too', async () => {
    const signer = await signedInAgent();

    const response = await postDrawn(signer, toDataUrl(await drawnSignature({ inkPixels: 0 })));

    await expectSignRejected(signer, response, { message: BLANK, href: '#signature' });
  });

  it('F-42, B-19: a wrong prefix, a JPEG, a wrong size and a truncated PNG are 422 "could not be read"', async () => {
    const png = await drawnSignature();
    const jpeg = await createCanvas(720, 240).encode('jpeg');
    for (const signature of [
      `data:image/jpeg;base64,${png.toString('base64')}`,
      'https://tracker.example/pixel.png',
      toDataUrl(jpeg),
      toDataUrl(await drawnSignature({ width: 700, height: 240 })),
      toDataUrl(png.subarray(0, Math.floor(png.length / 2))),
    ]) {
      const signer = await signedInAgent();

      const response = await postDrawn(signer, signature);

      await expectSignRejected(signer, response, { message: UNREADABLE, href: '#signature' });
      // The payload is never echoed back into the page (form.ts).
      expect(response.text).not.toContain(signature.slice(0, 60));
    }
  });

  it('F-42, ADR 0004 item 2: a body over 128 kb is the 413 page; up to 128 kb reaches the validator', async () => {
    const signer = await signedInAgent();

    const tooLarge = await postDrawn(signer, `data:image/png;base64,${'A'.repeat(140_000)}`);
    expect(tooLarge.status).toBe(413);
    expect(parse(tooLarge.text).text('h1')).toBe('That was too much data');
    expect(parse(tooLarge.text).attr('.page__next-link', 'href')).toBe('/signature');

    // Larger than the global 16 kb form limit, inside the route's 128 kb: a 422 from the pipeline, not a 413.
    const large = await postDrawn(signer, `data:image/png;base64,${'A'.repeat(100_000)}`);
    await expectSignRejected(signer, large, { message: UNREADABLE, href: '#signature' });
  });
});

describe('POST /signature: typed', () => {
  it('F-45, B-70: renders the typed name into a PNG stored like a drawn one', async () => {
    const signer = await signedInAgent();

    expectThankYouRedirect(await postTyped(signer, '  Łukasz   Żółć '));

    const [row] = await signatureRows(signer.userId);
    expect(row?.method).toBe('typed');
    const image = await loadImage(row?.image ?? Buffer.alloc(0));
    const context = createCanvas(720, 240).getContext('2d');
    context.drawImage(image, 0, 0);
    expect(inkOf(context.getImageData(0, 0, 720, 240).data)).toBeGreaterThan(1000);
  });

  it('F-45, ADR 0005: Vietnamese, Greek and Cyrillic names and the typographic apostrophe are accepted', async () => {
    for (const name of ['Thanh Nguyễn', 'Ελένη Παπαδοπούλου', 'Пётр Ильич', 'Siobhán O’Neill']) {
      const signer = await signedInAgent();

      expectThankYouRedirect(await postTyped(signer, name));

      expect(await signatureRows(signer.userId)).toHaveLength(1);
    }
  });

  it('F-45, F-21: an empty name is 422 with the field message, aria-invalid and the summary link', async () => {
    const signer = await signedInAgent();

    const response = await postTyped(signer, '   ');

    await expectSignRejected(signer, response, { message: 'Type your full name', href: '#typedName' });
    const page = parse(response.text);
    expect(page.attr('#typedName', 'aria-invalid')).toBe('true');
    expect(page.attr('#typedName', 'aria-describedby')).toContain('typedName-error');
    expect(page.text('#typedName-error')).toBe('Error: Type your full name');
    // A typed-name error never shows up next to the pad.
    expect(page.text('.signature-pad__message')).toBe('');
  });

  it('F-45, ADR 0005: a name the fonts cannot draw keeps its value and explains the alternatives', async () => {
    const signer = await signedInAgent();

    const response = await postTyped(signer, '李小龍');

    await expectSignRejected(signer, response, {
      message:
        'We cannot draw some letters of this name yet. Type it in Latin, Greek or Cyrillic letters, or draw your signature.',
      href: '#typedName',
    });
    expect(readForm(response.text, TYPED_FORM).values['typedName']).toBe('李小龍');
  });

  it('F-53, B-01: markup in the name is rejected and echoed escaped, never as HTML', async () => {
    const signer = await signedInAgent();
    const payload = '<script>alert(1)</script>';

    const response = await postTyped(signer, payload);

    await expectSignRejected(signer, response, {
      message: 'Use letters, spaces, hyphens, apostrophes and full stops only',
      href: '#typedName',
    });
    expect(response.text).not.toContain(payload);
    expect(response.text).toContain('value="&lt;script&gt;alert(1)&lt;/script&gt;"');
    expect(readForm(response.text, TYPED_FORM).values['typedName']).toBe(payload);
  });

  it('ADR 0003, F-21: the token of the 422 re-render lets the corrected form through', async () => {
    const signer = await signedInAgent();
    const rejected = await postTyped(signer, 'X');
    const { csrf } = readForm(rejected.text, TYPED_FORM);

    await postForm(signer.agent, '/signature', { _csrf: csrf, method: 'typed', typedName: 'Ada Lovelace' })
      .expect(303)
      .expect('location', '/thank-you');
  });
});

describe('POST /signature: requests that are not a sign form', () => {
  it('F-09, B-13: a body without a known method is the 400 page, and nothing is stored', async () => {
    const signer = await signedInAgent();
    const csrf = await signToken(signer.agent);

    const bodies: readonly Record<string, string>[] = [
      { typedName: 'Ada Lovelace' },
      { method: 'stamped', typedName: 'Ada Lovelace' },
    ];
    for (const fields of bodies) {
      const response = await postForm(signer.agent, '/signature', { _csrf: csrf, ...fields });

      expect(response.status).toBe(400);
      expect(parse(response.text).text('h1')).toBe('That request could not be read');
    }
    expect(await signatureRows(signer.userId)).toEqual([]);
  });

  it('F-70: without a CSRF token the 403 page answers and nothing is stored', async () => {
    const signer = await signedInAgent();

    const response = await postForm(signer.agent, '/signature', { method: 'typed', typedName: 'Ada Lovelace' });

    expect(response.status).toBe(403);
    expect(parse(response.text).text('h1')).toBe('This form has expired');
    expect(await signatureRows(signer.userId)).toEqual([]);
  });

  it('F-07: a guest submission never reaches the route (no session, no token: 403)', async () => {
    const response = await postForm(request.agent(testApp.app), '/signature', {
      method: 'typed',
      typedName: 'Ada Lovelace',
    });

    expect(response.status).toBe(403);
  });
});

describe('POST /signature: the account is deleted while the image renders', () => {
  it('F-31: the visitor is sent to the login page (303) instead of the 500 page, and nothing is stored', async () => {
    const real = createSignatureImages({ fontPaths: testSignatureFontPaths() });
    // Account deletion on another device, between the viewer lookup of this request and its insert.
    let deleteAccount: () => Promise<unknown> = () => Promise.resolve();
    const racing = await createTestApp({
      signatureImages: {
        ...real,
        renderTypedSignature: async (name) => {
          await deleteAccount();
          return real.renderTypedSignature(name);
        },
      },
    });
    try {
      const { id: userId } = await createUser(racing.db);
      deleteAccount = () => racing.db.delete(users).where(eq(users.id, userId));
      const agent = request.agent(racing.app);
      await signIn(agent, userId);
      const { csrf } = await getForm(agent, '/signature', TYPED_FORM);

      const response = await postForm(agent, '/signature', { _csrf: csrf, method: 'typed', typedName: 'Ada Lovelace' });

      expect([response.status, response.headers['location']]).toEqual([303, '/login']);
      expect(await racing.db.select().from(signatures).where(eq(signatures.userId, userId))).toEqual([]);
    } finally {
      await racing.close();
    }
  });
});

describe('POST /signature: idempotent', () => {
  it('F-43, B-07: a viewer who has signed is sent to the thank-you page and the signature stays', async () => {
    const signer = await signedInAgent({ signed: true });
    const [before] = await signatureRows(signer.userId);
    const { csrf } = await getForm(signer.agent, '/thank-you', 'form[action="/logout"]');

    await postForm(signer.agent, '/signature', { _csrf: csrf, method: 'typed', typedName: 'Ada Lovelace' })
      .expect(303)
      .expect('location', '/thank-you');

    expect(await signatureRows(signer.userId)).toEqual([before]);
  });

  it('F-43, B-49: a double click (two concurrent submissions) gives two redirects and one signature', async () => {
    const signer = await signedInAgent();
    const csrf = await signToken(signer.agent);
    const fields = { _csrf: csrf, method: 'typed', typedName: 'Ada Lovelace' };

    const responses = await Promise.all([
      postForm(signer.agent, '/signature', fields),
      postForm(signer.agent, '/signature', fields),
    ]);

    expect(responses.map((response) => [response.status, response.headers['location']])).toEqual([
      [303, '/thank-you'],
      [303, '/thank-you'],
    ]);
    expect(await signatureRows(signer.userId)).toHaveLength(1);
  });

  it('F-43, B-49: insertIfAbsent stores the first signature and reports the duplicate without an error', async () => {
    const user = await createUser(testApp.db);
    const repository = createSignatureRepository(testApp.db);
    const image = await drawnSignature();

    expect(await repository.insertIfAbsent({ userId: user.id, method: 'drawn', image })).toBe('inserted');
    expect(await repository.insertIfAbsent({ userId: user.id, method: 'typed', image })).toBe('already-signed');

    const rows = await signatureRows(user.id);
    expect(rows.map((row) => row.method)).toEqual(['drawn']);
  });

  it('F-31: insertIfAbsent reports an account deleted meanwhile as not-found instead of throwing', async () => {
    const user = await createUser(testApp.db);
    const repository = createSignatureRepository(testApp.db);
    await testApp.db.delete(users).where(eq(users.id, user.id));

    await expect(
      repository.insertIfAbsent({ userId: user.id, method: 'drawn', image: await drawnSignature() }),
    ).resolves.toBe('not-found');
  });
});
