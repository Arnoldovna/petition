import { and, eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { signatures, users } from '../../db/schema/index.js';

/**
 * SQL of the auth routes (DATA-MODEL.md section 4). The per-request viewer lookup and the current-password checks
 * live in `viewer.repository.ts` and `credentials.ts` (phase-1 kernel); this file holds what only registration, login
 * and account deletion need. Rows never leave the module: the service maps them to its own result types.
 */

/** A new account; every field already normalised by the form schema, the hash from the bounded hasher. */
export interface NewUser {
  firstName: string;
  lastName: string;
  email: string;
  passwordHash: string;
}

/** What `establishSession` needs after registration (ADR 0002 item 6). */
export interface CreatedUser {
  id: number;
  sessionVersion: number;
}

/** One row of the login query: everything login needs in a single round trip (B-22, B-52). */
interface LoginRecord {
  id: number;
  firstName: string;
  passwordHash: string;
  sessionVersion: number;
  /** `signatures.user_id IS NOT NULL` from the LEFT JOIN: false, never a missing row, for users without a signature. */
  hasSigned: boolean;
}

export interface AuthRepository {
  /**
   * `INSERT INTO users ... RETURNING id, session_version`. An email that exists case-insensitively throws the
   * PostgreSQL unique violation on `USERS_EMAIL_UNIQUE_INDEX`; the service turns it into `email-taken` (ADR 0008).
   */
  insertUser(user: NewUser): Promise<CreatedUser>;
  /** The account with this normalised email, joined with its signature state, or `undefined` (F-23, B-22, B-25). */
  findForLogin(email: string): Promise<LoginRecord | undefined>;
  /**
   * Rehash after a successful verify (ADR 0009), on login and in `credentials.verifyCurrentPassword`: replaces the
   * hash only while it is still `previousHash`, so a password change that committed meanwhile wins. Never touches
   * `session_version`. True when a row was updated.
   */
  updatePasswordHash(userId: number, previousHash: string, passwordHash: string): Promise<boolean>;
  /**
   * Account deletion (F-68, ADR 0013): one `DELETE FROM users` in a transaction; profile and signature go with it
   * through `ON DELETE CASCADE`. True when the account existed (B-54).
   */
  deleteUser(userId: number): Promise<boolean>;
}

export function createAuthRepository(db: Database): AuthRepository {
  return {
    async insertUser(user) {
      const [row] = await db
        .insert(users)
        .values(user)
        .returning({ id: users.id, sessionVersion: users.sessionVersion });
      if (row === undefined) throw new Error('insertUser: the insert returned no row');
      return row;
    },

    async findForLogin(email) {
      // `lower(email)` matches the expression of users_email_lower_idx, so the lookup uses the index; the value is
      // already lower-cased by the email schema (ADR 0007). The unique signatures.user_id index serves the join.
      const [row] = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          passwordHash: users.passwordHash,
          sessionVersion: users.sessionVersion,
          hasSigned: sql<boolean>`${signatures.userId} IS NOT NULL`,
        })
        .from(users)
        .leftJoin(signatures, eq(signatures.userId, users.id))
        .where(sql`lower(${users.email}) = ${email}`);
      return row;
    },

    async updatePasswordHash(userId, previousHash, passwordHash) {
      const result = await db
        .update(users)
        .set({ passwordHash })
        .where(and(eq(users.id, userId), eq(users.passwordHash, previousHash)));
      return (result.rowCount ?? 0) > 0;
    },

    async deleteUser(userId) {
      return db.transaction(async (tx) => {
        const result = await tx.delete(users).where(eq(users.id, userId));
        return (result.rowCount ?? 0) > 0;
      });
    },
  };
}
