import type { PasswordHasher } from '../../shared/auth/password.js';
import type { Viewer } from '../../shared/auth/viewer.js';
import { USERS_EMAIL_UNIQUE_INDEX } from '../../db/schema/index.js';
import { isUniqueViolation } from '../../shared/errors/db-errors.js';
import type { AuthRepository, CreatedUser } from './auth.repository.js';
import type { DeleteAccountInput, LoginInput, RegisterInput } from './auth.schema.js';
import type { Credentials } from './credentials.js';

/**
 * The rules of registration, login and account deletion (ADR 0008, ADR 0009, ADR 0013). Expected outcomes are
 * values (discriminated unions); only unexpected failures throw. The service knows nothing about HTTP: the controller
 * maps each result to a status, a view or a redirect.
 */

export interface AuthServiceDeps {
  users: AuthRepository;
  /** The bounded argon2id hasher (ADR 0009). */
  hasher: PasswordHasher;
  /** Verified against when the email is unknown, so both failures take the same path and time (F-24, B-09). */
  timingDummyHash: string;
  /** Re-authentication for account deletion; the auth kernel owns every current-password check (ADR 0009). */
  credentials: Pick<Credentials, 'verifyCurrentPassword'>;
}

/** A new account (F-18), or the one F-20 refusal; an existing email never signs anybody in (ADR 0009). */
type RegisterResult = { ok: true; user: CreatedUser } | { ok: false; reason: 'email-taken' };

/**
 * A successful login carries what `establishSession` needs (`session`) and the viewer the visitor becomes, from which
 * the controller picks the landing page (F-23, B-22). Unknown email and wrong password are one reason (F-24, B-09).
 */
type LoginResult = { ok: true; session: CreatedUser; viewer: Viewer } | { ok: false; reason: 'invalid-credentials' };

/**
 * `deleted` is false only when the account vanished between the password check and the delete (another device
 * deleted it, or the operator erased it): the outcome the visitor asked for either way (B-54).
 */
type DeleteAccountResult = { ok: true; deleted: boolean } | { ok: false; reason: 'wrong-password' };

export interface AuthService {
  register(input: RegisterInput): Promise<RegisterResult>;
  login(input: Pick<LoginInput, 'email' | 'password'>): Promise<LoginResult>;
  deleteAccount(userId: number, input: DeleteAccountInput): Promise<DeleteAccountResult>;
}

export function createAuthService({ users, hasher, timingDummyHash, credentials }: AuthServiceDeps): AuthService {
  return {
    async register({ firstName, lastName, email, password }) {
      // Hash first, then insert: the unique index decides "taken" atomically, so two concurrent registrations of the
      // same address give one account and one F-20 message, never a 500 (B-24, B-25).
      const passwordHash = await hasher.hash(password);
      try {
        const user = await users.insertUser({ firstName, lastName, email, passwordHash });
        return { ok: true, user };
      } catch (error) {
        // Only the email index means "taken"; any other failure stays an unexpected error (B-24).
        if (isUniqueViolation(error, USERS_EMAIL_UNIQUE_INDEX)) return { ok: false, reason: 'email-taken' };
        throw error;
      }
    },

    async login({ email, password }) {
      const user = await users.findForLogin(email);
      // One code path (ADR 0009): an unknown email is verified against the dummy hash, so it costs one argon2 verify
      // like a wrong password and both get the same result (F-24, B-09, B-23).
      const valid = await hasher.verify(user?.passwordHash ?? timingDummyHash, password);
      if (user === undefined || !valid) return { ok: false, reason: 'invalid-credentials' };

      if (hasher.needsRehash(user.passwordHash)) {
        await users.updatePasswordHash(user.id, user.passwordHash, await hasher.hash(password));
      }
      return {
        ok: true,
        session: { id: user.id, sessionVersion: user.sessionVersion },
        viewer: { userId: user.id, firstName: user.firstName, hasSigned: user.hasSigned },
      };
    },

    async deleteAccount(userId, { currentPassword }) {
      // Re-authentication (F-67, ADR 0013): a hijacked session alone cannot delete the account.
      if (!(await credentials.verifyCurrentPassword(userId, currentPassword))) {
        return { ok: false, reason: 'wrong-password' };
      }
      return { ok: true, deleted: await users.deleteUser(userId) };
    },
  };
}
