import type { SignatureImageResult, SignatureImages, SignatureRejection } from './image/index.js';
import type { SignatureRepository } from './signature.repository.js';
import type { SignInput } from './signature.schema.js';

export interface SignatureServiceDeps {
  repository: SignatureRepository;
  signatureImages: SignatureImages;
  /** The supporters module's count, injected by `app.ts` (F-47, ADR 0006). */
  countSupporters: () => Promise<number>;
}

/**
 * The outcome of a signature submission (ADR 0008): saved, or rejected with the pad's message (422). `inserted` is
 * false when the user had already signed (a concurrent duplicate); the controller treats both alike (F-43, B-49).
 * `not-found`: the account was deleted while the image was rendered; nothing is stored.
 */
export type SignResult =
  | { ok: true; inserted: boolean }
  | { ok: false; reason: SignatureRejection; message: string }
  | { ok: false; reason: 'not-found' };

export type SignatureService = ReturnType<typeof createSignatureService>;

/**
 * Business rules of the signature module. Every method takes the signed-in viewer's own user id from the route's
 * guard; nothing takes a signature id, so ownership holds by construction (a user can only reach their own row).
 */
export function createSignatureService({ repository, signatureImages, countSupporters }: SignatureServiceDeps) {
  /** The canonical PNG for a submission, or the rejection of a drawn one (ADR 0004 item 3, ADR 0005). */
  async function imageFor(input: SignInput): Promise<SignatureImageResult> {
    if (input.method === 'typed') return { ok: true, png: await signatureImages.renderTypedSignature(input.typedName) };
    return signatureImages.validateDrawnSignature(input.signature);
  }

  return {
    /**
     * Validates or renders the image, then stores it once (`ON CONFLICT (user_id) DO NOTHING`). Only the bytes from
     * the image service are stored, never the upload (ADR 0004 item 3.6).
     */
    async sign(userId: number, input: SignInput): Promise<SignResult> {
      const image = await imageFor(input);
      if (!image.ok) return image;
      const outcome = await repository.insertIfAbsent({ userId, method: input.method, image: image.png });
      if (outcome === 'not-found') return { ok: false, reason: 'not-found' };
      return { ok: true, inserted: outcome === 'inserted' };
    },

    /** The viewer's own PNG for `GET /signature/image.png`, or `undefined` when there is none (ADR 0004 item 6). */
    imageOf(userId: number): Promise<Buffer | undefined> {
      return repository.findImage(userId);
    },

    /** Deletes the viewer's own signature (F-49); true when there was one. */
    remove(userId: number): Promise<boolean> {
      return repository.deleteByUser(userId);
    },

    /** The total the supporters list shows (F-46, F-47). */
    supporterCount(): Promise<number> {
      return countSupporters();
    },
  };
}
