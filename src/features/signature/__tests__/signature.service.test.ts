import { describe, expect, it, vi } from 'vitest';

import type { SignatureImageResult } from '../image/index.js';
import { createSignatureService } from '../signature.service.js';
import {
  createFakeSignatureRepository,
  createScriptedSignatureImages,
  rejectionOf,
  type FakeSignatureRepository,
  type ScriptedSignatureImages,
} from './fakes.js';

/** Business rules of the signature module with an in-memory repository and a scripted image service (ADR 0015). */

const UPLOAD = 'data:image/png;base64,AAAA';
const CANONICAL = Buffer.from('re-encoded drawn PNG');
const TYPED = Buffer.from('rendered typed PNG');

interface Harness {
  repository: FakeSignatureRepository;
  images: ScriptedSignatureImages;
  countSupporters: ReturnType<typeof vi.fn<() => Promise<number>>>;
  service: ReturnType<typeof createSignatureService>;
}

function createHarness(drawn: SignatureImageResult = { ok: true, png: CANONICAL }): Harness {
  const repository = createFakeSignatureRepository();
  const images = createScriptedSignatureImages({ drawn, typed: TYPED });
  const countSupporters = vi.fn<() => Promise<number>>(() => Promise.resolve(1284));
  return {
    repository,
    images,
    countSupporters,
    service: createSignatureService({ repository, signatureImages: images, countSupporters }),
  };
}

describe('sign', () => {
  it('F-42, ADR 0004 item 3.6: stores the re-encoded bytes from the validator, never the upload', async () => {
    const { service, repository, images } = createHarness();

    const result = await service.sign(7, { method: 'drawn', signature: UPLOAD });

    expect(result).toEqual({ ok: true, inserted: true });
    expect(images.validated).toEqual([UPLOAD]);
    expect(repository.rows.get(7)).toEqual({ userId: 7, method: 'drawn', image: CANONICAL });
  });

  it('F-41, F-42, B-19: a rejected drawing stores nothing and returns the reason and message for the 422', async () => {
    const { service, repository } = createHarness(rejectionOf('blank'));

    const result = await service.sign(7, { method: 'drawn', signature: UPLOAD });

    expect(result).toEqual({ ok: false, reason: 'blank', message: 'Please sign before submitting' });
    expect(repository.rows.size).toBe(0);
  });

  it('F-42: every unreadable upload gets the same message', async () => {
    for (const reason of ['format', 'too-large', 'not-png', 'dimensions', 'corrupt'] as const) {
      const { service } = createHarness(rejectionOf(reason));

      expect(await service.sign(7, { method: 'drawn', signature: UPLOAD })).toEqual({
        ok: false,
        reason,
        message: 'The signature could not be read. Clear the pad and sign again.',
      });
    }
  });

  it('F-45, B-70: a typed name is rendered by the image service and stored as method "typed"', async () => {
    const { service, repository, images } = createHarness();

    const result = await service.sign(3, { method: 'typed', typedName: "Siobhán O'Neill" });

    expect(result).toEqual({ ok: true, inserted: true });
    expect(images.rendered).toEqual(["Siobhán O'Neill"]);
    expect(images.validated).toEqual([]);
    expect(repository.rows.get(3)).toEqual({ userId: 3, method: 'typed', image: TYPED });
  });

  it('F-43, B-49: a second submission of the same user succeeds without replacing the first signature', async () => {
    const { service, repository } = createHarness();
    await service.sign(7, { method: 'typed', typedName: 'Ada Lovelace' });

    const again = await service.sign(7, { method: 'drawn', signature: UPLOAD });

    expect(again).toEqual({ ok: true, inserted: false });
    expect(repository.rows.get(7)?.method).toBe('typed');
  });

  it('F-31: an account deleted while the image rendered is not-found, not an error, and stores nothing', async () => {
    const { service, repository } = createHarness();
    repository.deletedUsers.add(7);

    await expect(service.sign(7, { method: 'typed', typedName: 'Ada Lovelace' })).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(repository.rows.size).toBe(0);
  });

  it('F-09: an internal image failure is not a form error: the promise rejects (500)', async () => {
    const { service, images, repository } = createHarness();
    images.renderTypedSignature = () => Promise.reject(new Error('font missing'));

    await expect(service.sign(7, { method: 'typed', typedName: 'Ada Lovelace' })).rejects.toThrow('font missing');
    expect(repository.rows.size).toBe(0);
  });
});

describe('imageOf and remove', () => {
  it('ADR 0004 item 6: returns the stored image of the given user only', async () => {
    const { service } = createHarness();
    await service.sign(1, { method: 'drawn', signature: UPLOAD });
    await service.sign(2, { method: 'typed', typedName: 'Grace Hopper' });

    expect(await service.imageOf(1)).toEqual(CANONICAL);
    expect(await service.imageOf(2)).toEqual(TYPED);
    expect(await service.imageOf(3)).toBeUndefined();
  });

  it("F-49, B-54: deletes only the user's own signature and reports whether there was one", async () => {
    const { service, repository } = createHarness();
    await service.sign(1, { method: 'drawn', signature: UPLOAD });
    await service.sign(2, { method: 'drawn', signature: UPLOAD });

    expect(await service.remove(1)).toBe(true);
    expect(await service.remove(1)).toBe(false);
    expect([...repository.rows.keys()]).toEqual([2]);
  });
});

describe('supporterCount', () => {
  it('F-46, F-47: is the injected supporters count, asked on every call', async () => {
    const { service, countSupporters } = createHarness();

    expect(await service.supporterCount()).toBe(1284);
    countSupporters.mockResolvedValueOnce(1285);
    expect(await service.supporterCount()).toBe(1285);
    expect(countSupporters).toHaveBeenCalledTimes(2);
  });
});
