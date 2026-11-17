import { eq, sql } from 'drizzle-orm';

import type { Database, DatabaseTransaction } from '../../db/client.js';
import { users, USERS_EMAIL_UNIQUE_INDEX } from '../../db/schema/index.js';
import type { PasswordHasher } from '../../shared/auth/password.js';
import { isUniqueViolation } from '../../shared/errors/db-errors.js';
import { createAuthRepository } from './auth.repository.js';

/** What `apply` may change. `email` is already normalised by the `email` field schema (trimmed, lower-cased). */
interface CredentialChanges {
  email?: string;
  /** From `hashNewPassword`, computed before the caller's transaction (ADR 0009). */
  passwordHash?: string;
}

/**
 * `sessionVersion` is the user's version after the update: the caller re-establishes the current session with it
 * after a password change (ADR 0002 item 6). `not-found`: the account was deleted while the request ran.
 */
type ApplyResult =
  { ok: true; sessionVersion: number } | { ok: false; reason: 'email-taken' } | { ok: false; reason: 'not-found' };

/**
 * The single owner of password checks and of writes to `users.email`, `users.password_hash` and
 * `users.session_version` outside registration and login (ADR 0001, ADR 0009). Account deletion (auth) and profile
 * edit (profile, injected by `app.ts`) use it, so the current-password rule and the session-version bump exist once.
 * Interface frozen since phase 1b; function properties, so callers can pass them on without binding.
 */
export interface Credentials {
  /**
   * Re-authentication (F-63, F-67): true when `password` is the user's current password. A correct password stored
   * with outdated argon2 parameters is rehashed (ADR 0009); the rehash never changes `session_version`.
   */
  verifyCurrentPassword: (userId: number, password: string) => Promise<boolean>;
  /** argon2id through the bounded hasher. Call it **before** opening the transaction that stores the hash. */
  hashNewPassword: (password: string) => Promise<string>;
  /**
   * One `UPDATE users` inside the caller's transaction. A new password hash increments `session_version`, which
   * ends every other session of the user (ADR 0002 item 9); an email change alone does not. An email that another
   * account has (case-insensitively) returns `email-taken` instead of throwing (F-64).
   *
   * The update runs in a savepoint, so after `email-taken` the caller's transaction is still usable; the caller
   * decides whether to roll it back (profile edit saves nothing then, F-64).
   */
  apply: (tx: DatabaseTransaction, userId: number, changes: CredentialChanges) => Promise<ApplyResult>;
}

/** The row of the update (or of the lookup when nothing changes); none means the account is gone. */
function toApplyResult(row: { sessionVersion: number } | undefined): ApplyResult {
  return row === undefined ? { ok: false, reason: 'not-found' } : { ok: true, sessionVersion: row.sessionVersion };
}

export interface CredentialsDeps {
  db: Database;
  /** The bounded hasher from `container.ts` (ADR 0009). */
  hasher: PasswordHasher;
}

export function createCredentials({ db, hasher }: CredentialsDeps): Credentials {
  // The rehash write of login, so the "only while the verified hash is still stored" rule exists once (ADR 0009).
  const authRepository = createAuthRepository(db);
  return {
    verifyCurrentPassword: async (userId, password) => {
      const [row] = await db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.id, userId));
      if (row === undefined) return false;

      const valid = await hasher.verify(row.passwordHash, password);
      if (valid && hasher.needsRehash(row.passwordHash)) {
        // Only replaces the hash that was verified: a password change that committed meanwhile wins.
        await authRepository.updatePasswordHash(userId, row.passwordHash, await hasher.hash(password));
      }
      return valid;
    },

    hashNewPassword: (password) => hasher.hash(password),

    apply: async (tx, userId, { email, passwordHash }) => {
      if (email === undefined && passwordHash === undefined) {
        const [row] = await tx.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, userId));
        return toApplyResult(row);
      }

      try {
        const [row] = await tx.transaction((savepoint) =>
          savepoint
            .update(users)
            .set({
              ...(email === undefined ? {} : { email }),
              ...(passwordHash === undefined ? {} : { passwordHash, sessionVersion: sql`${users.sessionVersion} + 1` }),
            })
            .where(eq(users.id, userId))
            .returning({ sessionVersion: users.sessionVersion }),
        );
        return toApplyResult(row);
      } catch (error) {
        if (isUniqueViolation(error, USERS_EMAIL_UNIQUE_INDEX)) return { ok: false, reason: 'email-taken' };
        throw error;
      }
    },
  };
}
