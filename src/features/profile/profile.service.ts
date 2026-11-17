import type { Credentials } from '../auth/index.js';
import type { AccountChanges, AccountRecord, ProfileRepository } from './profile.repository.js';
import type {
  EditProfileInput,
  EditValues,
  OnboardingInput,
  OnboardingValues,
  ProfileFields,
} from './profile.schema.js';

/**
 * The rules of onboarding and profile editing (F-33 to F-36, F-60 to F-66, ADR 0008, ADR 0009). Expected outcomes are
 * Result values; the controller turns them into 303 or a 422 re-render. Ownership is the signed-in viewer's id,
 * passed by the controller from the session; no form field can name another user.
 */

/**
 * `current-password-required` and `wrong-password`: the email or the password changes without a correct current
 * password (F-63). `email-taken`: another account has the email (F-64). `not-found`: the account was deleted while
 * the request ran. Every failure saves nothing.
 */
export type UpdateAccountOutcome =
  | { ok: true; passwordChanged: false }
  | { ok: true; passwordChanged: true; sessionVersion: number }
  | { ok: false; reason: 'current-password-required' | 'wrong-password' | 'email-taken' | 'not-found' };

/** What the caller of `updateAccount` adds around the password check. */
interface UpdateAccountOptions {
  /**
   * Runs right before the current password is checked, and only then: an edit that changes neither the email nor the
   * password checks nothing, even with a current password filled in (by a password manager, say). The controller
   * passes the per-user `reauth` limiter here (ADR 0012); when it rejects, nothing is checked, hashed or saved.
   */
  beforePasswordCheck: () => Promise<void>;
}

export interface ProfileService {
  /** The onboarding prefill (F-36): the stored values, or empty fields before the first save. */
  onboardingValues(userId: number): Promise<OnboardingValues>;
  /**
   * Upsert of the optional fields; repeated submits never fail (F-34, F-36, B-26, B-28). `not-found`: the account was
   * deleted while the request ran, nothing is stored.
   */
  saveOnboarding(userId: number, input: OnboardingInput): Promise<{ ok: true } | { ok: false; reason: 'not-found' }>;
  /** The edit prefill (F-60), or `undefined` when the account is gone. */
  editValues(userId: number): Promise<EditValues | undefined>;
  /** Re-auth rules, then names, credentials and profile in one transaction (F-62 to F-65, B-11, B-29). */
  updateAccount(userId: number, input: EditProfileInput, options: UpdateAccountOptions): Promise<UpdateAccountOutcome>;
}

export interface ProfileServiceDeps {
  repository: ProfileRepository;
  /** Auth's re-authentication and hashing (ADR 0009); `apply` is the repository's part. */
  credentials: Pick<Credentials, 'verifyCurrentPassword' | 'hashNewPassword'>;
}

/** A stored value as a form string: `null` becomes the empty field. */
const asField = (value: string | number | null): string => (value === null ? '' : String(value));

function toOnboardingValues({ age, city, homepageUrl }: ProfileFields): OnboardingValues {
  return { age: asField(age), city: asField(city), homepage: asField(homepageUrl) };
}

const NO_PROFILE: ProfileFields = { age: null, city: null, homepageUrl: null };

function toProfileFields({ age, city, homepage }: OnboardingInput): ProfileFields {
  return { age, city, homepageUrl: homepage };
}

function toEditValues(account: AccountRecord): EditValues {
  return {
    firstName: account.firstName,
    lastName: account.lastName,
    email: account.email,
    ...toOnboardingValues(account),
  };
}

export function createProfileService({ repository, credentials }: ProfileServiceDeps): ProfileService {
  /**
   * F-63, ADR 0009: an email or password change needs the correct current password. Without such a change the
   * current password is not checked at all (no hashing cost, no answer about it).
   */
  async function reauthenticate(
    userId: number,
    currentPassword: string | null,
    { beforePasswordCheck }: UpdateAccountOptions,
  ): Promise<'current-password-required' | 'wrong-password' | undefined> {
    if (currentPassword === null) return 'current-password-required';
    await beforePasswordCheck();
    const valid = await credentials.verifyCurrentPassword(userId, currentPassword);
    return valid ? undefined : 'wrong-password';
  }

  return {
    onboardingValues: async (userId) => toOnboardingValues((await repository.findProfile(userId)) ?? NO_PROFILE),

    saveOnboarding: async (userId, input) =>
      (await repository.upsertProfile(userId, toProfileFields(input)))
        ? { ok: true }
        : { ok: false, reason: 'not-found' },

    editValues: async (userId) => {
      const account = await repository.findAccount(userId);
      return account === undefined ? undefined : toEditValues(account);
    },

    updateAccount: async (userId, input, options) => {
      const account = await repository.findAccount(userId);
      if (account === undefined) return { ok: false, reason: 'not-found' };

      // Both emails are normalised (trimmed, lower-cased; `users_email_chk`), so a change of case alone is no change.
      const emailChanged = input.email !== account.email;
      const { newPassword } = input;
      if (emailChanged || newPassword !== null) {
        const refusal = await reauthenticate(userId, input.currentPassword, options);
        if (refusal !== undefined) return { ok: false, reason: refusal };
      }

      // Hashed after the re-auth check (a wrong current password costs no second hash) and before the transaction,
      // so no row stays locked during the argon2 work (ADR 0009).
      const passwordHash = newPassword === null ? undefined : await credentials.hashNewPassword(newPassword);
      const changes: AccountChanges = {
        firstName: input.firstName,
        lastName: input.lastName,
        profile: toProfileFields(input),
        ...(emailChanged ? { email: input.email } : {}),
        ...(passwordHash === undefined ? {} : { passwordHash }),
      };

      const result = await repository.updateAccount(userId, changes);
      if (!result.ok) return result;
      return passwordHash === undefined
        ? { ok: true, passwordChanged: false }
        : { ok: true, passwordChanged: true, sessionVersion: result.sessionVersion };
    },
  };
}
