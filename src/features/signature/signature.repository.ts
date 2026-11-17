import { eq } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { signatures, SIGNATURES_USER_FK } from '../../db/schema/index.js';
import { isForeignKeyViolation } from '../../shared/errors/db-errors.js';

/** What a new signature row needs (DATA-MODEL.md section 2.4); `id` and `created_at` come from the database. */
export interface SignatureRecord {
  userId: number;
  method: (typeof signatures.$inferInsert)['method'];
  /** The canonical PNG from the image service, never the upload itself (ADR 0004 item 3.6). */
  image: Buffer;
}

/**
 * `inserted`: this call stored the row. `already-signed`: the user had signed already (a double click, a second tab).
 * `not-found`: the account was deleted while the request ran (another device, the operator's erasure).
 */
type InsertOutcome = 'inserted' | 'already-signed' | 'not-found';

/**
 * The only SQL of the signature module (DATA-MODEL.md section 4). Every query is keyed by the viewer's own user id:
 * there is no signature id in any URL, so no request can reach another user's row (ADR 0004 item 6).
 */
export interface SignatureRepository {
  /**
   * `INSERT ... ON CONFLICT (user_id) DO NOTHING` (F-43, B-49). Never throws for the duplicate, nor for the foreign
   * key of an account deleted meanwhile (`SIGNATURES_USER_FK`).
   */
  insertIfAbsent(record: SignatureRecord): Promise<InsertOutcome>;
  /** The stored PNG of `userId`, or `undefined` when the user has not signed. */
  findImage(userId: number): Promise<Buffer | undefined>;
  /** `DELETE ... WHERE user_id = $1`: true when a row was deleted (B-54). */
  deleteByUser(userId: number): Promise<boolean>;
}

export function createSignatureRepository(db: Database): SignatureRepository {
  return {
    async insertIfAbsent({ userId, method, image }) {
      try {
        const inserted = await db
          .insert(signatures)
          .values({ userId, method, image })
          .onConflictDoNothing({ target: signatures.userId })
          .returning({ id: signatures.id });
        return inserted.length > 0 ? 'inserted' : 'already-signed';
      } catch (error) {
        // Only the user reference means "account gone"; any other failure stays an unexpected error.
        if (isForeignKeyViolation(error, SIGNATURES_USER_FK)) return 'not-found';
        throw error;
      }
    },

    async findImage(userId) {
      const [row] = await db
        .select({ image: signatures.image })
        .from(signatures)
        .where(eq(signatures.userId, userId))
        .limit(1);
      return row?.image;
    },

    async deleteByUser(userId) {
      const deleted = await db.delete(signatures).where(eq(signatures.userId, userId)).returning({ id: signatures.id });
      return deleted.length > 0;
    },
  };
}
