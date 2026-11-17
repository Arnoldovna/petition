import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

import {
  SIGNATURE_HEIGHT,
  SIGNATURE_MAX_BYTES,
  SIGNATURE_REJECTIONS,
  SIGNATURE_WIDTH,
  type SignatureImageResult,
  type SignatureImages,
  type SignatureRejection,
} from '../src/features/signature/image/index.js';
import type { PasswordHasher } from '../src/shared/auth/password.js';
import { testSignatureFontPaths } from './fonts.js';

/**
 * Shared fakes of the test harness (ADR 0015, ADR 0017): the password hasher and the signature image service that
 * `createTestApp` injects by default. Feature-specific fakes (in-memory repositories) live in each feature's
 * `__tests__/fakes.ts` (BUILD-ORDER.md rule 4).
 */

// ---------------------------------------------------------------------------------------------------------------
// Password hasher
// ---------------------------------------------------------------------------------------------------------------

/**
 * The PHC prefix of the pinned argon2id parameters (ADR 0009). Fake hashes carry it, so they pass the
 * `users_password_hash_chk` constraint and `needsRehash` is false for them, as for a real current hash.
 */
const CURRENT_PARAMETERS = '$argon2id$v=19$m=65536,t=3,p=4$';

/** `$argon2id$v=19$<params>$<salt>$<digest>`: the fake keeps the PHC shape, so tests can vary the parameters. */
const PHC_HASH = /^\$argon2id\$v=19\$[^$]+\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

const digest = (salt: string, plain: string): Buffer =>
  createHash('sha256').update(salt).update('\0').update(plain, 'utf8').digest();

const unpadded = (bytes: Buffer): string => bytes.toString('base64').replace(/=+$/, '');

/**
 * A fake argon2id string for `plain`: a salted SHA-256 instead of argon2, so creating users and logging in costs
 * microseconds instead of 64 MiB and a few hundred milliseconds each. `parameters` defaults to the pinned ones; pass
 * an older set (e.g. `'$argon2id$v=19$m=19456,t=2,p=1$'`) to store a hash that `needsRehash` reports (ADR 0009).
 * Test data only: never a real password.
 */
export function fakePasswordHash(plain: string, parameters: string = CURRENT_PARAMETERS): string {
  const salt = unpadded(randomBytes(16));
  return `${parameters}${salt}$${unpadded(digest(salt, plain))}`;
}

function fakeVerify(hash: string, plain: string): boolean {
  const match = PHC_HASH.exec(hash);
  if (match === null) return false;
  const [, salt = '', expected = ''] = match;
  const actual = Buffer.from(unpadded(digest(salt, plain)));
  const stored = Buffer.from(expected);
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

/** One `verify` call, so tests can prove the dummy-hash path runs for unknown emails (F-24, B-23). */
interface VerifyCall {
  hash: string;
  result: boolean;
}

export interface FakeHasher extends PasswordHasher {
  /** Every `verify` in call order; the plain password is not recorded. */
  readonly verifyCalls: readonly VerifyCall[];
  /** Number of `hash` calls (registration, password change, rehash). */
  readonly hashCount: number;
}

/**
 * The `PasswordHasher` contract (ADR 0009) without argon2: stateless (salt and digest live in the hash string), so
 * hashes from `fakePasswordHash` (factories) verify in any fake hasher. `needsRehash` is true for every hash that does
 * not carry the pinned parameters. The bounded semaphore is not modelled; `password.test.ts` covers it.
 */
export function createFakeHasher(): FakeHasher {
  const verifyCalls: VerifyCall[] = [];
  let hashCount = 0;
  return {
    get verifyCalls() {
      return verifyCalls;
    },
    get hashCount() {
      return hashCount;
    },
    hash: (plain) => {
      hashCount += 1;
      return Promise.resolve(fakePasswordHash(plain));
    },
    verify: (hash, plain) => {
      const result = fakeVerify(hash, plain);
      verifyCalls.push({ hash, result });
      return Promise.resolve(result);
    },
    needsRehash: (hash) => !hash.startsWith(CURRENT_PARAMETERS),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Signature images
// ---------------------------------------------------------------------------------------------------------------

const DATA_URL_PREFIX = 'data:image/png;base64,';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/**
 * The lower size bound of `signatures_image_size_chk` (DATA-MODEL.md section 2.4); the upper one is
 * `SIGNATURE_MAX_BYTES`.
 */
const MIN_STORED_BYTES = 67;

const rejection = (reason: SignatureRejection): SignatureImageResult => ({
  ok: false,
  reason,
  message: SIGNATURE_REJECTIONS[reason],
});

/** Family name for the fake's typed signatures; distinct from the app's `SignatureFont`, so the two never mix. */
const FAKE_FONT_FAMILY = 'PetitionTestSignature';

/** Registers the primary signature font from node_modules once per process (font registration is process-wide). */
function ensureFakeFont(): void {
  if (GlobalFonts.has(FAKE_FONT_FAMILY)) return;
  for (const path of testSignatureFontPaths().primary) {
    if (GlobalFonts.registerFromPath(path, FAKE_FONT_FAMILY) === null) {
      throw new Error(`test/fakes.ts: cannot register ${path}`);
    }
  }
}

/**
 * The name in black on a transparent 720 x 240 canvas, with a font from node_modules: deterministic on every machine
 * (no system fonts), always enough ink, and a different image per name.
 */
async function drawTypedName(name: string): Promise<Buffer> {
  ensureFakeFont();
  const canvas = createCanvas(SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.font = `64px ${FAKE_FONT_FAMILY}`;
  context.textBaseline = 'middle';
  context.fillText(name, 32, SIGNATURE_HEIGHT / 2, SIGNATURE_WIDTH - 64);
  return canvas.encode('png');
}

/** The calls a fake signature service received, for assertions. */
export interface FakeSignatureImages extends SignatureImages {
  readonly typedNames: readonly string[];
}

/**
 * A fast, predictable stand-in for `createSignatureImages()` (ADR 0004, ADR 0005), and the default of
 * `createTestApp`, so no module's tests depend on the signature module's image code while it is being built (ADR
 * 0019 §2). Drawn: accepts any `data:image/png;base64,` payload whose bytes start with the PNG signature and fit the
 * stored size bounds, and returns those bytes unchanged; it checks neither the dimensions nor the ink, so tests of
 * the real pipeline inject `createSignatureImages({ fontPaths: testSignatureFontPaths() })` instead. Typed: draws the
 * name into a valid 720 x 240 PNG.
 */
export function createFakeSignatureImages(): FakeSignatureImages {
  const typedNames: string[] = [];
  return {
    get typedNames() {
      return typedNames;
    },
    validateDrawnSignature: (dataUrl) => {
      if (!dataUrl.startsWith(DATA_URL_PREFIX)) return Promise.resolve(rejection('format'));
      const bytes = Buffer.from(dataUrl.slice(DATA_URL_PREFIX.length), 'base64');
      if (bytes.length === 0) return Promise.resolve(rejection('format'));
      if (bytes.length > SIGNATURE_MAX_BYTES) return Promise.resolve(rejection('too-large'));
      if (bytes.length < MIN_STORED_BYTES || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
        return Promise.resolve(rejection('not-png'));
      }
      return Promise.resolve({ ok: true, png: bytes });
    },
    renderTypedSignature: (name) => {
      typedNames.push(name);
      return drawTypedName(name);
    },
  };
}
