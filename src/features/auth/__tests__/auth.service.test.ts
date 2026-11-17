import { beforeEach, describe, expect, it } from 'vitest';

import { createFakeHasher, fakePasswordHash, type FakeHasher } from '../../../../test/fakes.js';
import { createAuthService, type AuthService } from '../auth.service.js';
import { createFakeAuthRepository, createFakeCredentials, uniqueViolation } from './fakes.js';

/** Unit tests of the auth rules with in-memory fakes (ADR 0008, ADR 0009, ADR 0013). */

const PASSWORD = 'correct horse battery staple';
/** argon2id parameters older than the pinned ones (ADR 0009): `needsRehash` is true for them. */
const OUTDATED_PARAMETERS = '$argon2id$v=19$m=19456,t=2,p=1$';
const ADA = { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' };

let hasher: FakeHasher;
let users: ReturnType<typeof createFakeAuthRepository>;
let timingDummyHash: string;
let service: AuthService;

beforeEach(() => {
  hasher = createFakeHasher();
  users = createFakeAuthRepository();
  timingDummyHash = fakePasswordHash('a secret nobody knows');
  service = createAuthService({
    users,
    hasher,
    timingDummyHash,
    credentials: createFakeCredentials(users, hasher),
  });
});

const seedAda = (overrides: { passwordHash?: string; hasSigned?: boolean; sessionVersion?: number } = {}) =>
  users.seed({ ...ADA, passwordHash: fakePasswordHash(PASSWORD), ...overrides });

describe('register', () => {
  it('F-18, F-27: creates the account with a hash of the password, never the password itself', async () => {
    const result = await service.register({ ...ADA, password: PASSWORD });

    expect(result).toEqual({ ok: true, user: { id: 1, sessionVersion: 0 } });
    const [row] = users.rows;
    expect(row).toMatchObject(ADA);
    expect(row?.passwordHash).not.toContain(PASSWORD);
    expect(await hasher.verify(row?.passwordHash ?? '', PASSWORD)).toBe(true);
  });

  it('F-20, B-24, ADR 0009: an existing email is "email-taken" whatever the password, and nobody is signed in', async () => {
    seedAda();

    expect(await service.register({ ...ADA, password: PASSWORD })).toEqual({ ok: false, reason: 'email-taken' });
    expect(await service.register({ ...ADA, password: 'a different password' })).toEqual({
      ok: false,
      reason: 'email-taken',
    });
    expect(users.rows).toHaveLength(1);
  });

  it('B-24: a unique violation on another constraint is not reported as "email taken"', async () => {
    const failure = uniqueViolation('some_other_unique_idx');
    users.failNextInsert(failure);

    await expect(service.register({ ...ADA, password: PASSWORD })).rejects.toBe(failure);
  });

  it('B-24: a database outage stays an unexpected error instead of becoming "email taken"', async () => {
    const outage = new Error('connection terminated unexpectedly');
    users.failNextInsert(outage);

    await expect(service.register({ ...ADA, password: PASSWORD })).rejects.toBe(outage);
  });
});

describe('login', () => {
  it('F-23, B-22: a user without a signature logs in and is told hasSigned = false', async () => {
    const ada = seedAda();

    expect(await service.login({ email: ADA.email, password: PASSWORD })).toEqual({
      ok: true,
      session: { id: ada.id, sessionVersion: 0 },
      viewer: { userId: ada.id, firstName: 'Ada', hasSigned: false },
    });
  });

  it('F-23: a signer logs in with hasSigned = true and the current session version', async () => {
    const ada = seedAda({ hasSigned: true, sessionVersion: 3 });

    expect(await service.login({ email: ADA.email, password: PASSWORD })).toEqual({
      ok: true,
      session: { id: ada.id, sessionVersion: 3 },
      viewer: { userId: ada.id, firstName: 'Ada', hasSigned: true },
    });
  });

  it('F-24, B-09, B-23: unknown email and wrong password give the same result', async () => {
    seedAda();

    const unknown = await service.login({ email: 'nobody@example.com', password: PASSWORD });
    const wrong = await service.login({ email: ADA.email, password: 'not the password' });

    expect(unknown).toEqual({ ok: false, reason: 'invalid-credentials' });
    expect(wrong).toEqual(unknown);
  });

  it('F-24, B-09: an unknown email is verified against the dummy hash, so both failures run one argon2 verify', async () => {
    const ada = seedAda();

    await service.login({ email: 'nobody@example.com', password: PASSWORD });
    await service.login({ email: ADA.email, password: 'not the password' });

    expect(hasher.verifyCalls).toEqual([
      { hash: timingDummyHash, result: false },
      { hash: ada.passwordHash, result: false },
    ]);
  });

  it('F-27, ADR 0009: a correct password stored with outdated parameters is rehashed on login', async () => {
    const outdated = fakePasswordHash(PASSWORD, OUTDATED_PARAMETERS);
    const ada = seedAda({ passwordHash: outdated, sessionVersion: 2 });

    const result = await service.login({ email: ADA.email, password: PASSWORD });

    expect(result.ok).toBe(true);
    const stored = users.rows.find((row) => row.id === ada.id);
    expect(stored?.passwordHash).not.toBe(outdated);
    expect(hasher.needsRehash(stored?.passwordHash ?? '')).toBe(false);
    expect(await hasher.verify(stored?.passwordHash ?? '', PASSWORD)).toBe(true);
    // A rehash is not a password change: other sessions stay valid (ADR 0002 item 9).
    expect(stored?.sessionVersion).toBe(2);
  });

  it('ADR 0009: a current hash is not rehashed, and a wrong password never triggers a rehash', async () => {
    const current = seedAda();
    const outdatedHash = fakePasswordHash(PASSWORD, OUTDATED_PARAMETERS);
    const old = users.seed({ ...ADA, email: 'old@example.com', passwordHash: outdatedHash });

    await service.login({ email: ADA.email, password: PASSWORD });
    await service.login({ email: 'old@example.com', password: 'not the password' });

    expect(hasher.hashCount).toBe(0);
    expect(users.rows.find((row) => row.id === current.id)?.passwordHash).toBe(current.passwordHash);
    expect(users.rows.find((row) => row.id === old.id)?.passwordHash).toBe(outdatedHash);
  });
});

describe('deleteAccount', () => {
  it('F-67, B-34: a wrong current password deletes nothing', async () => {
    const ada = seedAda();

    expect(await service.deleteAccount(ada.id, { currentPassword: 'not the password' })).toEqual({
      ok: false,
      reason: 'wrong-password',
    });
    expect(users.rows).toHaveLength(1);
  });

  it('F-68, B-54: the correct current password deletes the account and reports that a row was deleted', async () => {
    const ada = seedAda();
    const other = users.seed({ ...ADA, email: 'other@example.com', passwordHash: fakePasswordHash(PASSWORD) });

    expect(await service.deleteAccount(ada.id, { currentPassword: PASSWORD })).toEqual({ ok: true, deleted: true });
    expect(users.rows.map((row) => row.id)).toEqual([other.id]);
  });

  it('B-54: an account that vanished after the password check is reported as not deleted, not as an error', async () => {
    const vanishing = createAuthService({
      users,
      hasher,
      timingDummyHash,
      credentials: { verifyCurrentPassword: () => Promise.resolve(true) },
    });

    expect(await vanishing.deleteAccount(999, { currentPassword: PASSWORD })).toEqual({ ok: true, deleted: false });
  });
});
