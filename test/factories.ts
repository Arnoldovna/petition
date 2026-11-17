import { randomUUID } from 'node:crypto';

import { createCanvas } from '@napi-rs/canvas';

import type { Database } from '../src/db/client.js';
import { signatures, users } from '../src/db/schema/index.js';
import { MIN_INK_PIXELS, SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from '../src/features/signature/image/index.js';
import { fakePasswordHash } from './fakes.js';

/**
 * Rows for integration tests, inserted straight into the file's own database (ADR 0017): every test file starts
 * with an empty, migrated database of its own, so there is no `truncateAll`. A test that needs another starting state
 * goes into its own file. Pass the `db` of `createTestApp()`.
 */

/** The password of every factory user unless overridden; matches the hash for the fake hasher of `createTestApp`. */
const DEFAULT_PASSWORD = 'correct horse battery staple';

type UserRow = typeof users.$inferSelect;
type SignatureRow = typeof signatures.$inferSelect;

interface UserOverrides {
  firstName?: string;
  lastName?: string;
  /** Stored as given; it must already be trimmed and lower-cased (`users_email_chk`). Default: unique per call. */
  email?: string;
  /** Hashed with `fakePasswordHash`; ignored when `passwordHash` is given. */
  password?: string;
  /** A ready hash, e.g. a real argon2id one for a test app that injects the real hasher. */
  passwordHash?: string;
  sessionVersion?: number;
}

/** The inserted row plus the plain password, for login tests. */
export type TestUser = UserRow & { password: string };

/** One `users` row; unique email `user-<uuid>@petition.test` unless given. */
export async function createUser(db: Database, overrides: UserOverrides = {}): Promise<TestUser> {
  const password = overrides.password ?? DEFAULT_PASSWORD;
  const [row] = await db
    .insert(users)
    .values({
      firstName: overrides.firstName ?? 'Ada',
      lastName: overrides.lastName ?? 'Lovelace',
      email: overrides.email ?? `user-${randomUUID()}@petition.test`,
      passwordHash: overrides.passwordHash ?? fakePasswordHash(password),
      ...(overrides.sessionVersion === undefined ? {} : { sessionVersion: overrides.sessionVersion }),
    })
    .returning();
  if (row === undefined) throw new Error('createUser: the insert returned no row');
  return { ...row, password };
}

/**
 * A valid signature PNG: 720 x 240, transparent, a black stroke with far more than `MIN_INK_PIXELS` inked pixels,
 * drawn with @napi-rs/canvas directly (not through the signature module, whose image code is built in phase 2a).
 * Throws when the stroke ever drops below the ink minimum, so a fixture can never be one the real validator would
 * reject as blank (ADR 0004 item 3.5).
 */
function drawSignaturePng(): Promise<Buffer> {
  const canvas = createCanvas(SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
  const context = canvas.getContext('2d');
  context.strokeStyle = '#000';
  context.lineWidth = 6;
  context.lineCap = 'round';
  context.beginPath();
  context.moveTo(60, 150);
  context.bezierCurveTo(160, 20, 240, 220, 340, 110);
  context.bezierCurveTo(420, 30, 520, 200, 660, 90);
  context.stroke();
  const { data } = context.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
  let inked = 0;
  for (let alpha = 3; alpha < data.length; alpha += 4) if ((data[alpha] ?? 0) > 0) inked += 1;
  if (inked < MIN_INK_PIXELS)
    throw new Error(`test/factories.ts: the signature has only ${String(inked)} inked pixels`);
  return canvas.encode('png');
}

/** Drawn once per test file and shared by every `createSignature`; nothing mutates it. */
let signatureImage: Promise<Buffer> | undefined;

function signaturePng(): Promise<Buffer> {
  signatureImage ??= drawSignaturePng();
  return signatureImage;
}

interface SignatureOverrides {
  method?: 'drawn' | 'typed';
  image?: Buffer;
  /** For ordering tests (oldest first, tie-break by id; ADR 0006). */
  createdAt?: Date;
}

/** The `signatures` row of `userId` (at most one per user, `signatures_user_id_key`). */
export async function createSignature(
  db: Database,
  userId: number,
  overrides: SignatureOverrides = {},
): Promise<SignatureRow> {
  const [row] = await db
    .insert(signatures)
    .values({
      userId,
      method: overrides.method ?? 'drawn',
      image: overrides.image ?? (await signaturePng()),
      ...(overrides.createdAt === undefined ? {} : { createdAt: overrides.createdAt }),
    })
    .returning();
  if (row === undefined) throw new Error('createSignature: the insert returned no row');
  return row;
}
