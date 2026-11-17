import type { Request } from 'express';
import type { SessionData } from 'express-session';

/**
 * Every flash message the app shows (F-17, F-25, F-49, F-62, F-68). Flash text is always a fixed string from code,
 * never user input (ADR 0008), and the type makes anything else a compile error.
 */
export type FlashMessage =
  | 'You are logged out'
  | 'Your account was deleted'
  | 'Thank you, your signature was saved'
  | 'Your signature was removed'
  | 'Profile updated';

/** What the session stores and the layout's `role="status"` region shows once (partial `flash`). */
export interface Flash {
  message: string;
}

declare module 'express-session' {
  interface SessionData {
    /** One-time confirmation after a redirect (ADR 0002 item 5); deleted by the render that shows it. */
    flash?: Flash;
  }
}

/**
 * Stores a confirmation for the next rendered page (ADR 0008). Call it right before the 303 of a successful POST;
 * the session is saved when the response ends. Redirect-only requests do not consume it (`takeFlash` runs in
 * `renderPage` only).
 */
export function setFlash(req: Request, message: FlashMessage): void {
  req.session.flash = { message };
}

/**
 * Reads and deletes the pending flash, for `renderPage` only, so the message is shown exactly once (F-17). Safe
 * without a session (an error inside the session middleware renders the error page without one) and against
 * unexpected store content.
 */
export function takeFlash(req: Request): Flash | undefined {
  // `req.session` is typed as always present; it is missing when the session middleware itself failed.
  const { session } = req as { session?: Partial<SessionData> };
  const flash = session?.flash;
  if (session === undefined || flash === undefined) return undefined;
  delete session.flash;
  return typeof flash.message === 'string' && flash.message.length > 0 ? { message: flash.message } : undefined;
}
