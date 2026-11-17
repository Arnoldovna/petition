import { USERS_EMAIL_UNIQUE_INDEX } from '../../../db/schema/index.js';
import type { PasswordHasher } from '../../../shared/auth/password.js';
import type { AuthRepository, NewUser } from '../auth.repository.js';
import type { Credentials } from '../credentials.js';

/**
 * In-memory stand-ins for the auth module's own dependencies (BUILD-ORDER.md rule 4): the repository and the
 * current-password check of the credentials kernel. They implement the same interfaces as the Drizzle versions, so
 * `auth.service.test.ts` exercises the real service rules without a database.
 */

interface FakeUserRow extends NewUser {
  id: number;
  sessionVersion: number;
  hasSigned: boolean;
}

export interface FakeAuthRepository extends AuthRepository {
  /** The current rows, for assertions. */
  readonly rows: readonly FakeUserRow[];
  /** Seeds an account directly (an existing user, a signer, a user with an outdated hash). */
  seed(user: NewUser & { hasSigned?: boolean; sessionVersion?: number }): FakeUserRow;
}

/**
 * The error node-postgres raises for a duplicate on a unique index, wrapped like Drizzle wraps driver errors (the
 * SQLSTATE sits on the cause chain, which `isUniqueViolation` walks).
 */
export function uniqueViolation(constraint: string): Error {
  const driverError = Object.assign(new Error('duplicate key value violates unique constraint'), {
    code: '23505',
    constraint,
  });
  return new Error('Failed query: insert into "users"', { cause: driverError });
}

/**
 * Case-insensitive email uniqueness like `users_email_lower_idx`, identity ids, `rowCount`-style booleans (B-54).
 * `failNextInsert` lets a test simulate any other database failure.
 */
export function createFakeAuthRepository(): FakeAuthRepository & { failNextInsert(error: Error): void } {
  const rows: FakeUserRow[] = [];
  let nextId = 1;
  let insertFailure: Error | undefined;

  const add = (user: NewUser & { hasSigned?: boolean; sessionVersion?: number }): FakeUserRow => {
    if (rows.some((row) => row.email.toLowerCase() === user.email.toLowerCase())) {
      throw uniqueViolation(USERS_EMAIL_UNIQUE_INDEX);
    }
    const row: FakeUserRow = {
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      passwordHash: user.passwordHash,
      id: nextId++,
      sessionVersion: user.sessionVersion ?? 0,
      hasSigned: user.hasSigned ?? false,
    };
    rows.push(row);
    return row;
  };

  return {
    get rows() {
      return rows;
    },
    seed: add,
    failNextInsert(error) {
      insertFailure = error;
    },

    insertUser(user) {
      if (insertFailure !== undefined) {
        const error = insertFailure;
        insertFailure = undefined;
        return Promise.reject(error);
      }
      try {
        const { id, sessionVersion } = add(user);
        return Promise.resolve({ id, sessionVersion });
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error('insert failed'));
      }
    },

    findForLogin(email) {
      const row = rows.find((candidate) => candidate.email.toLowerCase() === email);
      return Promise.resolve(
        row === undefined
          ? undefined
          : {
              id: row.id,
              firstName: row.firstName,
              passwordHash: row.passwordHash,
              sessionVersion: row.sessionVersion,
              hasSigned: row.hasSigned,
            },
      );
    },

    updatePasswordHash(userId, previousHash, passwordHash) {
      const row = rows.find((candidate) => candidate.id === userId && candidate.passwordHash === previousHash);
      if (row === undefined) return Promise.resolve(false);
      row.passwordHash = passwordHash;
      return Promise.resolve(true);
    },

    deleteUser(userId) {
      const index = rows.findIndex((row) => row.id === userId);
      if (index === -1) return Promise.resolve(false);
      rows.splice(index, 1);
      return Promise.resolve(true);
    },
  };
}

/** `verifyCurrentPassword` of the credentials kernel over the fake repository's rows and the given hasher. */
export function createFakeCredentials(
  repository: Pick<FakeAuthRepository, 'rows'>,
  hasher: PasswordHasher,
): Pick<Credentials, 'verifyCurrentPassword'> {
  return {
    verifyCurrentPassword: async (userId, password) => {
      const row = repository.rows.find((candidate) => candidate.id === userId);
      return row !== undefined && (await hasher.verify(row.passwordHash, password));
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Session cookie helpers for the auth integration tests
// ---------------------------------------------------------------------------------------------------------------

/** The session cookie of a test app (plain http, so without the `__Host-` prefix; ADR 0002 item 2). */
const SESSION_COOKIE = 'petition.sid';

/** The `petition.sid=...` line of a response, or undefined when the response sets no session cookie. */
function sessionCookieLine(response: { headers: Record<string, unknown> }): string | undefined {
  const header = response.headers['set-cookie'];
  const lines = Array.isArray(header) ? header.map(String) : [];
  return lines.find((line) => line.startsWith(`${SESSION_COOKIE}=`));
}

/** `petition.sid=<value>`, ready for a `Cookie` request header (to replay an old cookie from another client). */
export function sessionCookieOf(response: { headers: Record<string, unknown> }): string {
  const pair = sessionCookieLine(response)?.split(';')[0];
  if (pair === undefined) throw new Error('the response sets no session cookie');
  return pair;
}

/** The session id inside the signed cookie value (`s:<id>.<signature>`, URL-encoded): the Redis key's last part. */
export function sessionIdOf(response: { headers: Record<string, unknown> }): string {
  const value = decodeURIComponent(sessionCookieOf(response).slice(SESSION_COOKIE.length + 1));
  const match = /^s:(.+)\.[^.]+$/.exec(value);
  if (match?.[1] === undefined) throw new Error('the session cookie is not a signed express-session id');
  return match[1];
}
