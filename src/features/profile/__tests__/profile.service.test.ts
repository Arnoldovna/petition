import { beforeEach, describe, expect, it } from 'vitest';

import { EditProfileForm, OnboardingForm, type EditProfileInput } from '../profile.schema.js';
import { createProfileService, type ProfileService } from '../profile.service.js';
import {
  createFakeCredentials,
  createFakeProfileRepository,
  type FakeCredentials,
  type FakeProfileRepository,
} from './fakes.js';

/**
 * The rules of the profile service with in-memory fakes (ADR 0008, ADR 0009): onboarding upsert and prefill, and the
 * re-authentication, hashing and all-or-nothing rules of the edit form.
 */

const CURRENT_PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'a brand new passphrase';

let repository: FakeProfileRepository;
let credentials: FakeCredentials;
let service: ProfileService;
/** How often the edit asked the `reauth` limiter (the controller's `beforePasswordCheck`, ADR 0012). */
let reauthAttempts: number;

beforeEach(() => {
  repository = createFakeProfileRepository();
  credentials = createFakeCredentials(CURRENT_PASSWORD);
  service = createProfileService({ repository, credentials });
  reauthAttempts = 0;
});

/** `updateAccount` with a limiter stand-in that lets every request through and counts it. */
function update(userId: number, form: EditProfileInput) {
  return service.updateAccount(userId, form, {
    beforePasswordCheck: () => {
      reauthAttempts += 1;
      return Promise.resolve();
    },
  });
}

/**
 * The edit form as the browser submits it: the prefill of `userId` with empty password fields, then `overrides` (raw
 * form strings), parsed with the real schema.
 */
async function editForm(userId: number, overrides: Readonly<Record<string, string>> = {}): Promise<EditProfileInput> {
  const values = await service.editValues(userId);
  if (values === undefined) throw new Error('no such user');
  return EditProfileForm.parse({ ...values, newPassword: '', currentPassword: '', ...overrides });
}

describe('onboarding', () => {
  it('F-33, F-36: the prefill is empty before the first save and shows the stored values after it', async () => {
    const userId = repository.addUser({});

    await expect(service.onboardingValues(userId)).resolves.toEqual({ age: '', city: '', homepage: '' });

    await expect(
      service.saveOnboarding(userId, { age: 42, city: 'Berlin', homepage: 'https://example.com/' }),
    ).resolves.toEqual({ ok: true });
    await expect(service.onboardingValues(userId)).resolves.toEqual({
      age: '42',
      city: 'Berlin',
      homepage: 'https://example.com/',
    });
  });

  it('F-34, B-26: any combination of fields is stored, empty fields as null', async () => {
    const userId = repository.addUser({});

    await service.saveOnboarding(userId, OnboardingForm.parse({ age: '', city: 'Köln', homepage: '' }));

    expect(repository.profile(userId)).toEqual({ age: null, city: 'Köln', homepageUrl: null });
  });

  it('F-31: an account deleted before the save is not-found and gets no profile', async () => {
    const userId = repository.addUser({});
    repository.deleteUser(userId);

    await expect(service.saveOnboarding(userId, { age: 42, city: null, homepage: null })).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
    expect(repository.profile(userId)).toBeUndefined();
  });

  it('F-36, B-28: saving again replaces the stored values instead of failing', async () => {
    const userId = repository.addUser({}, { age: 30, city: 'Berlin', homepageUrl: 'https://old.example/' });

    await service.saveOnboarding(userId, { age: null, city: null, homepage: 'https://new.example/' });
    await service.saveOnboarding(userId, { age: null, city: null, homepage: 'https://new.example/' });

    expect(repository.profile(userId)).toEqual({ age: null, city: null, homepageUrl: 'https://new.example/' });
  });
});

describe('edit prefill', () => {
  it('F-60: names, email and the optional fields; no password value at all', async () => {
    const userId = repository.addUser(
      { firstName: 'Grace', lastName: 'Hopper', email: 'grace@petition.test' },
      { age: 85, city: null, homepageUrl: 'https://grace.example/' },
    );

    await expect(service.editValues(userId)).resolves.toEqual({
      firstName: 'Grace',
      lastName: 'Hopper',
      email: 'grace@petition.test',
      age: '85',
      city: '',
      homepage: 'https://grace.example/',
    });
  });

  it('B-55: a user without a profile still has an account to edit; an unknown user has none', async () => {
    const userId = repository.addUser({ email: 'noprofile@petition.test' });

    await expect(service.editValues(userId)).resolves.toMatchObject({ email: 'noprofile@petition.test', age: '' });
    await expect(service.editValues(999)).resolves.toBeUndefined();
  });
});

describe('edit: names and profile only', () => {
  it('F-62, F-63: saves without a current password, never checks or hashes a password, keeps the version', async () => {
    const userId = repository.addUser({ email: 'ada@petition.test' });
    const form = await editForm(userId, { firstName: 'Augusta', age: '36', city: 'London' });

    await expect(update(userId, form)).resolves.toEqual({ ok: true, emailChanged: false, passwordChanged: false });

    expect(credentials.calls).toEqual([]);
    expect(reauthAttempts).toBe(0);
    expect(repository.user(userId)).toMatchObject({
      firstName: 'Augusta',
      email: 'ada@petition.test',
      passwordHash: 'hash:original',
      sessionVersion: 0,
    });
    expect(repository.profile(userId)).toEqual({ age: 36, city: 'London', homepageUrl: null });
    expect(repository.updates[0]?.changes).not.toHaveProperty('email');
    expect(repository.updates[0]?.changes).not.toHaveProperty('passwordHash');
  });

  it('F-63, ADR 0009, ADR 0012: a current password sent without any email or password change is not checked', async () => {
    const userId = repository.addUser({});
    // What a password manager submits when it fills the current-password field of a name or profile edit.
    const form = await editForm(userId, { currentPassword: 'not the password at all' });

    await expect(update(userId, form)).resolves.toEqual({ ok: true, emailChanged: false, passwordChanged: false });
    expect(credentials.calls).toEqual([]);
    // Nothing was checked, so nothing counts against the per-user re-authentication budget.
    expect(reauthAttempts).toBe(0);
  });

  it('F-65: clearing an optional field stores null', async () => {
    const userId = repository.addUser({}, { age: 40, city: 'Paris', homepageUrl: 'https://a.example/' });
    const form = await editForm(userId, { age: '', city: '', homepage: '' });

    await update(userId, form);

    expect(repository.profile(userId)).toEqual({ age: null, city: null, homepageUrl: null });
  });

  it('ADR 0007: the same email in another case after normalisation is no change and needs no password', async () => {
    const userId = repository.addUser({ email: 'ada@petition.test' });
    const form = await editForm(userId, { email: '  ADA@Petition.TEST ' });

    await expect(update(userId, form)).resolves.toEqual({ ok: true, emailChanged: false, passwordChanged: false });
    expect(credentials.calls).toEqual([]);
  });
});

describe('B-11, F-63, ADR 0009: edit: re-authentication', () => {
  it('B-11: an email change without the current password is refused and saves nothing', async () => {
    const userId = repository.addUser({ email: 'ada@petition.test' });
    const form = await editForm(userId, { email: 'new@petition.test', firstName: 'Changed' });

    await expect(update(userId, form)).resolves.toEqual({
      ok: false,
      reason: 'current-password-required',
    });
    expect(repository.updates).toEqual([]);
    expect(repository.user(userId)).toMatchObject({ email: 'ada@petition.test', firstName: 'Ada' });
  });

  it('B-11: a new password without the current password is refused and nothing is hashed', async () => {
    const userId = repository.addUser({});
    const form = await editForm(userId, { newPassword: NEW_PASSWORD });

    await expect(update(userId, form)).resolves.toEqual({
      ok: false,
      reason: 'current-password-required',
    });
    expect(credentials.calls).toEqual([]);
    expect(reauthAttempts).toBe(0);
    expect(repository.updates).toEqual([]);
  });

  it('B-11: a wrong current password is refused, nothing is hashed or saved', async () => {
    const userId = repository.addUser({ email: 'ada@petition.test' });
    const form = await editForm(userId, {
      email: 'new@petition.test',
      newPassword: NEW_PASSWORD,
      currentPassword: 'wrong password guess',
    });

    await expect(update(userId, form)).resolves.toEqual({ ok: false, reason: 'wrong-password' });
    expect(credentials.calls).toEqual([{ kind: 'verify', userId }]);
    expect(reauthAttempts).toBe(1);
    expect(repository.updates).toEqual([]);
  });

  it('ADR 0012: a limiter that refuses stops the edit before the password is checked; nothing is hashed or saved', async () => {
    const userId = repository.addUser({ email: 'ada@petition.test' });
    const form = await editForm(userId, {
      email: 'new@petition.test',
      newPassword: NEW_PASSWORD,
      currentPassword: CURRENT_PASSWORD,
    });
    const tooMany = new Error('too many attempts');

    await expect(
      service.updateAccount(userId, form, { beforePasswordCheck: () => Promise.reject(tooMany) }),
    ).rejects.toBe(tooMany);
    expect(credentials.calls).toEqual([]);
    expect(repository.updates).toEqual([]);
    expect(repository.user(userId)).toMatchObject({ email: 'ada@petition.test', passwordHash: 'hash:original' });
  });

  it('F-63: a correct current password allows the email change; the session version stays', async () => {
    const userId = repository.addUser({ email: 'ada@petition.test' });
    const form = await editForm(userId, { email: 'ada.new@petition.test', currentPassword: CURRENT_PASSWORD });

    await expect(update(userId, form)).resolves.toEqual({ ok: true, emailChanged: true, passwordChanged: false });
    expect(repository.updates[0]?.changes).toMatchObject({ email: 'ada.new@petition.test' });
    expect(repository.updates[0]?.changes).not.toHaveProperty('passwordHash');
    expect(repository.user(userId)).toMatchObject({ email: 'ada.new@petition.test', sessionVersion: 0 });
  });

  it('ADR 0009, ADR 0002: a new password is hashed after the check and before the update, and bumps the version', async () => {
    const userId = repository.addUser({});
    const form = await editForm(userId, { newPassword: NEW_PASSWORD, currentPassword: CURRENT_PASSWORD });

    await expect(update(userId, form)).resolves.toEqual({
      ok: true,
      emailChanged: false,
      passwordChanged: true,
      sessionVersion: 1,
    });
    expect(credentials.calls).toEqual([{ kind: 'verify', userId }, { kind: 'hash' }]);
    expect(reauthAttempts).toBe(1);
    expect(repository.updates).toHaveLength(1);
    expect(repository.updates[0]?.changes.passwordHash).toBe(`hash:${NEW_PASSWORD}`);
    expect(repository.updates[0]?.changes).not.toHaveProperty('email');
  });
});

describe('F-62, F-64, B-29: edit: all or nothing', () => {
  it('F-64: an email another account has (any case) is refused and nothing changes, password included', async () => {
    repository.addUser({ email: 'taken@petition.test' });
    const userId = repository.addUser({ email: 'ada@petition.test' }, { age: 20, city: null, homepageUrl: null });
    const form = await editForm(userId, {
      firstName: 'Changed',
      age: '99',
      email: 'taken@petition.test',
      newPassword: NEW_PASSWORD,
      currentPassword: CURRENT_PASSWORD,
    });

    await expect(update(userId, form)).resolves.toEqual({ ok: false, reason: 'email-taken' });
    expect(repository.user(userId)).toEqual({
      firstName: 'Ada',
      lastName: 'Lovelace',
      email: 'ada@petition.test',
      passwordHash: 'hash:original',
      sessionVersion: 0,
    });
    expect(repository.profile(userId)).toEqual({ age: 20, city: null, homepageUrl: null });
  });

  it('F-31: an account deleted before the save gives not-found and nothing is written', async () => {
    const userId = repository.addUser({});
    const form = await editForm(userId, { firstName: 'Changed' });
    repository.deleteUser(userId);

    await expect(update(userId, form)).resolves.toEqual({ ok: false, reason: 'not-found' });
    expect(repository.updates).toEqual([]);
    expect(credentials.calls).toEqual([]);
  });
});
