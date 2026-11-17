import type { RequestHandler } from 'express';

import { currentSession, regenerateSession } from '../security/session.js';

/**
 * The signed-in visitor of the current request (ADR 0002 item 7), in `res.locals.viewer`. Guards, views and services
 * read it; "has signed" is loaded from the database on every request and never cached in the session (F-32, B-35).
 */
export interface Viewer {
  userId: number;
  firstName: string;
  hasSigned: boolean;
}

/** One row of the viewer query (DATA-MODEL.md section 4): `users LEFT JOIN signatures` by primary key. */
export interface ViewerRecord {
  id: number;
  firstName: string;
  sessionVersion: number;
  hasSigned: boolean;
}

/**
 * Injected by the composition root: the auth module's `createViewerRepository(db).findViewer` (ADR 0001). `shared`
 * contains no SQL and never imports `db` or features.
 */
export type FindViewer = (userId: number) => Promise<ViewerRecord | undefined>;

declare module 'express-session' {
  interface SessionData {
    /** Set only by `establishSession` (ADR 0002 item 6). */
    userId?: number;
    /** `users.session_version` at sign-in; a newer version in the database ends this session (ADR 0002 item 9). */
    sessionVersion?: number;
  }
}

declare global {
  // Express declares `res.locals` through this global namespace; augmenting it is the documented way to type it.
  // eslint-disable-next-line @typescript-eslint/no-namespace -- declaration merging with @types/express, no runtime code
  namespace Express {
    interface Locals {
      /** Set by `loadViewer` for a valid signed-in session, absent for guests. */
      viewer?: Viewer;
    }
  }
}

/** `users.id` is a PostgreSQL `integer` identity. Anything else in the session is treated like a ghost session. */
const MAX_INT4 = 2_147_483_647;

function isUserId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_INT4;
}

/**
 * Middleware right after the session middleware and `enforceAbsoluteLifetime` (OVERVIEW.md section 5.1, step 9), so
 * every later response, error pages included, knows the viewer.
 *
 * - No `userId` in the session: a guest; the database is not queried.
 * - The user no longer exists (account deleted elsewhere) or its `session_version` differs (password changed
 *   elsewhere): the session is regenerated and the request continues as a guest (F-31, B-05).
 * - Otherwise `res.locals.viewer` is set from the row of this request (F-32, B-35).
 */
export function loadViewer(findViewer: FindViewer): RequestHandler {
  return async (req, res, next) => {
    const session = currentSession(req);
    if (session?.userId === undefined) {
      next();
      return;
    }

    const record = isUserId(session.userId) ? await findViewer(session.userId) : undefined;
    if (record === undefined || record.sessionVersion !== session.sessionVersion) {
      await regenerateSession(req);
      next();
      return;
    }

    res.locals.viewer = { userId: record.id, firstName: record.firstName, hasSigned: record.hasSigned };
    next();
  };
}
