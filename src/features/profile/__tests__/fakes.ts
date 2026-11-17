import type { Credentials } from '../../auth/index.js';
import type { AccountChanges, AccountRecord, ProfileRepository, UpdateAccountResult } from '../profile.repository.js';
import type { ProfileFields } from '../profile.schema.js';

/**
 * In-memory fakes for the profile service's unit tests (BUILD-ORDER.md rule 4). The repository fake keeps the
 * all-or-nothing contract of `updateAccount` (F-62, F-64): a taken email or a missing account changes nothing.
 */

interface FakeUser {
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
  sessionVersion: number;
}

export interface FakeProfileRepository extends ProfileRepository {
  /** Adds a user (and optionally a profile) and returns its id. */
  addUser(user: Partial<FakeUser>, profile?: ProfileFields): number;
  /** Snapshot of a user, or `undefined` when it does not exist. */
  user(userId: number): FakeUser | undefined;
  /** Snapshot of a profile, or `undefined` before the first save. */
  profile(userId: number): ProfileFields | undefined;
  /** Removes a user and its profile, as a deletion on another device would. */
  deleteUser(userId: number): void;
  /** Every `updateAccount` call, in order. */
  readonly updates: readonly { userId: number; changes: AccountChanges }[];
}

export function createFakeProfileRepository(): FakeProfileRepository {
  const users = new Map<number, FakeUser>();
  const profiles = new Map<number, ProfileFields>();
  const updates: { userId: number; changes: AccountChanges }[] = [];
  let nextId = 1;

  const emailTakenByOther = (userId: number, email: string): boolean =>
    [...users].some(([id, user]) => id !== userId && user.email.toLowerCase() === email.toLowerCase());

  return {
    get updates() {
      return updates;
    },

    addUser: (user, profile) => {
      const id = nextId++;
      users.set(id, {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: `user${String(id)}@petition.test`,
        passwordHash: 'hash:original',
        sessionVersion: 0,
        ...user,
      });
      if (profile !== undefined) profiles.set(id, { ...profile });
      return id;
    },

    user: (userId) => {
      const user = users.get(userId);
      return user === undefined ? undefined : { ...user };
    },

    profile: (userId) => {
      const profile = profiles.get(userId);
      return profile === undefined ? undefined : { ...profile };
    },

    deleteUser: (userId) => {
      users.delete(userId);
      profiles.delete(userId);
    },

    findProfile: (userId) => {
      const profile = profiles.get(userId);
      return Promise.resolve(profile === undefined ? undefined : { ...profile });
    },

    upsertProfile: (userId, fields) => {
      // Like `PROFILES_USER_FK`: no profile for an account that does not exist (any more).
      if (!users.has(userId)) return Promise.resolve(false);
      profiles.set(userId, { ...fields });
      return Promise.resolve(true);
    },

    findAccount: (userId) => {
      const user = users.get(userId);
      if (user === undefined) return Promise.resolve(undefined);
      const profile = profiles.get(userId) ?? { age: null, city: null, homepageUrl: null };
      const account: AccountRecord = {
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        ...profile,
      };
      return Promise.resolve(account);
    },

    updateAccount: (userId, changes) => {
      updates.push({ userId, changes });
      const user = users.get(userId);
      let result: UpdateAccountResult;
      if (user === undefined) result = { ok: false, reason: 'not-found' };
      else if (changes.email !== undefined && emailTakenByOther(userId, changes.email)) {
        result = { ok: false, reason: 'email-taken' };
      } else {
        const sessionVersion = user.sessionVersion + (changes.passwordHash === undefined ? 0 : 1);
        users.set(userId, {
          firstName: changes.firstName,
          lastName: changes.lastName,
          email: changes.email ?? user.email,
          passwordHash: changes.passwordHash ?? user.passwordHash,
          sessionVersion,
        });
        profiles.set(userId, { ...changes.profile });
        result = { ok: true, sessionVersion };
      }
      return Promise.resolve(result);
    },
  };
}

/** One call to the fake credentials, in order, so tests can assert "hash after verify, before the transaction". */
type CredentialsCall = { kind: 'verify'; userId: number } | { kind: 'hash' };

export interface FakeCredentials extends Pick<Credentials, 'verifyCurrentPassword' | 'hashNewPassword'> {
  readonly calls: readonly CredentialsCall[];
}

/**
 * Re-authentication and hashing without argon2: `password` is every user's current password; a hash is
 * `hash:<password>`. Records each call (the plain password is not recorded).
 */
export function createFakeCredentials(password: string): FakeCredentials {
  const calls: CredentialsCall[] = [];
  return {
    get calls() {
      return calls;
    },
    verifyCurrentPassword: (userId, candidate) => {
      calls.push({ kind: 'verify', userId });
      return Promise.resolve(candidate === password);
    },
    hashNewPassword: (plain) => {
      calls.push({ kind: 'hash' });
      return Promise.resolve(`hash:${plain}`);
    },
  };
}
