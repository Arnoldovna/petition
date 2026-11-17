import { eq } from 'drizzle-orm';

import type { Database, DatabaseTransaction } from '../../db/client.js';
import { profiles, PROFILES_USER_FK, users } from '../../db/schema/index.js';
import { isForeignKeyViolation } from '../../shared/errors/db-errors.js';
import type { Credentials } from '../auth/index.js';
import type { ProfileFields } from './profile.schema.js';

/** `users` first and last name, email and the optional profile fields of one user (`findAccount`). */
export interface AccountRecord extends ProfileFields {
  firstName: string;
  lastName: string;
  email: string;
}

/**
 * Everything one profile edit stores, in one transaction (F-62, B-29). `email` and `passwordHash` are present only
 * when they change; they go through auth's `credentials.apply`, the only writer of those columns (ADR 0009).
 */
export interface AccountChanges {
  firstName: string;
  lastName: string;
  profile: ProfileFields;
  /** Normalised by the `email` field schema (trimmed, lower-cased); only when it differs from the stored one. */
  email?: string;
  /** From `credentials.hashNewPassword`, computed before the transaction (ADR 0009). */
  passwordHash?: string;
}

/**
 * `sessionVersion` is the user's version after the commit (incremented by a new password, ADR 0002 item 9).
 * `email-taken` and `not-found` roll the whole transaction back, so nothing is saved (F-64).
 */
export type UpdateAccountResult =
  { ok: true; sessionVersion: number } | { ok: false; reason: 'email-taken' } | { ok: false; reason: 'not-found' };

/**
 * The SQL of the profile module (DATA-MODEL.md section 4). It writes `profiles` and the names in `users`; email and
 * password hash only through the injected `credentials.apply` (OVERVIEW.md section 4).
 */
export interface ProfileRepository {
  /** The optional fields of `userId`, or `undefined` before the first save. */
  findProfile(userId: number): Promise<ProfileFields | undefined>;
  /**
   * Insert or replace the optional fields (`ON CONFLICT (user_id) DO UPDATE`), so a resubmit never fails (B-28). False
   * when the account was deleted while the request ran (the foreign key `PROFILES_USER_FK`); nothing is stored then.
   */
  upsertProfile(userId: number, fields: ProfileFields): Promise<boolean>;
  /** The user with the profile if there is one (`LEFT JOIN`, never `FULL OUTER JOIN`, B-55); no password hash. */
  findAccount(userId: number): Promise<AccountRecord | undefined>;
  /** Names, credentials and profile in one transaction; all or nothing (F-62, F-64, B-29). */
  updateAccount(userId: number, changes: AccountChanges): Promise<UpdateAccountResult>;
}

export interface ProfileRepositoryDeps {
  db: Database;
  /** Auth's credentials service (`app.ts` injects it into the module); only `apply` is used here. */
  credentials: Pick<Credentials, 'apply'>;
}

type Executor = Database | DatabaseTransaction;

/** Carries an expected failure out of `db.transaction`, whose callback must throw for Drizzle to roll back. */
class RollbackWith extends Error {
  readonly result: Extract<UpdateAccountResult, { ok: false }>;

  constructor(result: Extract<UpdateAccountResult, { ok: false }>) {
    super(`profile update rolled back: ${result.reason}`);
    this.result = result;
  }
}

function upsert(executor: Executor, userId: number, { age, city, homepageUrl }: ProfileFields): Promise<unknown> {
  // `updated_at` is set by the column's `$onUpdate`, which Drizzle also applies to `ON CONFLICT DO UPDATE`.
  return executor
    .insert(profiles)
    .values({ userId, age, city, homepageUrl })
    .onConflictDoUpdate({ target: profiles.userId, set: { age, city, homepageUrl } });
}

export function createProfileRepository({ db, credentials }: ProfileRepositoryDeps): ProfileRepository {
  return {
    findProfile: async (userId) => {
      const [row] = await db
        .select({ age: profiles.age, city: profiles.city, homepageUrl: profiles.homepageUrl })
        .from(profiles)
        .where(eq(profiles.userId, userId));
      return row;
    },

    upsertProfile: async (userId, fields) => {
      try {
        await upsert(db, userId, fields);
        return true;
      } catch (error) {
        // Only the user reference means "account gone"; any other failure stays an unexpected error.
        if (isForeignKeyViolation(error, PROFILES_USER_FK)) return false;
        throw error;
      }
    },

    findAccount: async (userId) => {
      const [row] = await db
        .select({
          firstName: users.firstName,
          lastName: users.lastName,
          email: users.email,
          age: profiles.age,
          city: profiles.city,
          homepageUrl: profiles.homepageUrl,
        })
        .from(users)
        .leftJoin(profiles, eq(profiles.userId, users.id))
        .where(eq(users.id, userId));
      return row;
    },

    updateAccount: async (userId, { firstName, lastName, profile, email, passwordHash }) => {
      try {
        return await db.transaction(async (tx) => {
          // First statement: locks the user row for the rest of the transaction and proves it still exists, so the
          // profile insert below cannot hit the foreign key of an account deleted meanwhile.
          const [named] = await tx
            .update(users)
            .set({ firstName, lastName })
            .where(eq(users.id, userId))
            .returning({ sessionVersion: users.sessionVersion });
          if (named === undefined) throw new RollbackWith({ ok: false, reason: 'not-found' });

          let { sessionVersion } = named;
          if (email !== undefined || passwordHash !== undefined) {
            const applied = await credentials.apply(tx, userId, {
              ...(email === undefined ? {} : { email }),
              ...(passwordHash === undefined ? {} : { passwordHash }),
            });
            // `apply` rolls back only its savepoint; the names above must not stay either (F-64, B-29).
            if (!applied.ok) throw new RollbackWith(applied);
            ({ sessionVersion } = applied);
          }

          await upsert(tx, userId, profile);
          return { ok: true, sessionVersion } as const;
        });
      } catch (error) {
        if (error instanceof RollbackWith) return error.result;
        throw error;
      }
    },
  };
}
