import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, smallint, text, timestamp } from 'drizzle-orm/pg-core';

import { users } from './users.js';

/**
 * Optional profile details, at most one row per user (DATA-MODEL.md section 2.3). CHECK constraints pass for NULL,
 * so every field stays optional (F-34). Regular expressions inside `sql` need doubled backslashes: the template
 * literal consumes one level.
 */
export const profiles = pgTable(
  'profiles',
  {
    userId: integer()
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    age: smallint(),
    /** NFC, trimmed, inner whitespace collapsed (ADR 0007). */
    city: text(),
    homepageUrl: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    check('profiles_age_chk', sql`${t.age} BETWEEN 1 AND 120`),
    check(
      'profiles_city_chk',
      sql`${t.city} = btrim(${t.city}) AND ${t.city} !~ '\\s{2,}' AND char_length(${t.city}) BETWEEN 1 AND 100`,
    ),
    check(
      'profiles_homepage_url_chk',
      sql`char_length(${t.homepageUrl}) <= 300 AND ${t.homepageUrl} ~ '^https?://[^\\s]+$'`,
    ),
    // Case-insensitive city lookup, independent of the database default locale (ADR 0007). The supporters query uses
    // the identical expression on both sides of the comparison.
    index('profiles_city_key_idx').on(sql`lower(${t.city} COLLATE "pg_c_utf8")`),
  ],
);
