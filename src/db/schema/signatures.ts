import { sql } from 'drizzle-orm';
import { check, index, integer, pgEnum, pgTable, timestamp } from 'drizzle-orm/pg-core';

import { bytea } from './types.js';
import { users } from './users.js';

export const signatureMethod = pgEnum('signature_method', ['drawn', 'typed']);

/**
 * One validated, re-encoded PNG per user (DATA-MODEL.md section 2.4, ADR 0004). The unique `user_id` makes signing
 * idempotent (`ON CONFLICT (user_id) DO NOTHING`, F-43, B-49) and doubles as the foreign-key index.
 */
export const signatures = pgTable(
  'signatures',
  {
    id: integer().primaryKey().generatedAlwaysAsIdentity(),
    userId: integer()
      .notNull()
      .unique('signatures_user_id_key')
      .references(() => users.id, { onDelete: 'cascade' }),
    method: signatureMethod().notNull(),
    image: bytea().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('signatures_image_size_chk', sql`octet_length(${t.image}) BETWEEN 67 AND 65536`),
    // PNG magic number as a backstop behind the validation pipeline.
    check('signatures_image_png_chk', sql`substring(${t.image} FROM 1 FOR 8) = '\\x89504e470d0a1a0a'::bytea`),
    // Stable supporters order: oldest first, tie-break by id (F-54, B-31, ADR 0006).
    index('signatures_created_at_id_idx').on(t.createdAt, t.id),
  ],
);
