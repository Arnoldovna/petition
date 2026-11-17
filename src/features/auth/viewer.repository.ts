import { eq, sql } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { signatures, users } from '../../db/schema/index.js';
import type { FindViewer } from '../../shared/auth/viewer.js';

/**
 * The per-request viewer lookup (ADR 0002 item 7, DATA-MODEL.md section 4), owned by auth and injected into
 * `loadViewer` by `app.ts`, so `shared` holds no SQL (ADR 0001). Interface frozen since phase 1b.
 */
export interface ViewerRepository {
  /** A function property, so `loadViewer(repository.findViewer)` needs no binding. */
  findViewer: FindViewer;
}

export function createViewerRepository(db: Database): ViewerRepository {
  return {
    findViewer: async (userId) => {
      // One primary-key lookup; the unique signatures.user_id index serves the join. "Has signed" is derived here on
      // every request, never cached (F-32, B-35).
      const [row] = await db
        .select({
          id: users.id,
          firstName: users.firstName,
          sessionVersion: users.sessionVersion,
          hasSigned: sql<boolean>`${signatures.userId} IS NOT NULL`,
        })
        .from(users)
        .leftJoin(signatures, eq(signatures.userId, users.id))
        .where(eq(users.id, userId));
      return row;
    },
  };
}
