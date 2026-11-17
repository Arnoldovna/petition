import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * The unique expression index on `lower(email)` (DATA-MODEL.md section 2.2, ADR 0007). Registration and the email
 * change of the profile edit recognise "email taken" by this name on the 23505 error, so it is defined once, here.
 */
export const USERS_EMAIL_UNIQUE_INDEX = 'users_email_lower_idx';

/**
 * Accounts (DATA-MODEL.md section 2.2). Zod validates every field first (ROUTES.md section 1); the CHECK constraints
 * are the backstop, so no code path can store an untrimmed name, a mixed-case email or a non-argon2id hash (B-61).
 */
export const users = pgTable(
  'users',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    firstName: text().notNull(),
    lastName: text().notNull(),
    /** Stored lowercased and trimmed; unique case-insensitively through `USERS_EMAIL_UNIQUE_INDEX` (ADR 0007). */
    email: text().notNull(),
    /** argon2id PHC string (ADR 0009); never leaves the auth module. */
    passwordHash: text().notNull(),
    /** Incremented with every password change; sessions with an older version become guests (ADR 0002). */
    sessionVersion: integer().notNull().default(0),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    // Case-insensitive uniqueness without the citext extension (F-02, F-20, B-25).
    uniqueIndex(USERS_EMAIL_UNIQUE_INDEX).on(sql`lower(${t.email})`),
    check(
      'users_first_name_chk',
      sql`${t.firstName} = btrim(${t.firstName}) AND char_length(${t.firstName}) BETWEEN 1 AND 100 AND ${t.firstName} !~ '[[:cntrl:]]'`,
    ),
    check(
      'users_last_name_chk',
      sql`${t.lastName} = btrim(${t.lastName}) AND char_length(${t.lastName}) BETWEEN 1 AND 100 AND ${t.lastName} !~ '[[:cntrl:]]'`,
    ),
    check(
      'users_email_chk',
      sql`${t.email} = lower(btrim(${t.email})) AND char_length(${t.email}) BETWEEN 3 AND 254 AND position('@' in ${t.email}) > 1`,
    ),
    check('users_password_hash_chk', sql`${t.passwordHash} LIKE '$argon2id$%'`),
    check('users_session_version_chk', sql`${t.sessionVersion} >= 0`),
  ],
);
