import type { Request, Response } from 'express';

/** Every page model has a title: `<title>{{title}} · Nonsense Petition</title>` (F-16). */
export interface PageModel {
  title: string;
  /** Extra module entries for this page, e.g. `['signature-pad.js']` (form-guard.js is always loaded). */
  scripts?: readonly string[];
  [key: string]: unknown;
}

/** Last resort when even a page cannot be rendered: plain text, no internals (F-09). */
function sendRenderFailure(res: Response): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.status(500).type('text/plain').send('Something went wrong. Please try again in a moment.');
}

/**
 * The only place that calls `res.render` (ESLint `no-restricted-syntax`, ADR 0003, 0008, 0014). Every HTML response,
 * success or error, goes through it. Phase 1b adds the viewer, the CSRF token (only with a viewer or a bound
 * session) and the one-time flash here.
 *
 * A template error is logged with the request id and answered with a plain 500 instead of being passed to
 * `next()`, so a broken error page can never recurse into the error handler or reach Express's default handler.
 */
export function renderPage(req: Request, res: Response, view: string, model: PageModel, status = 200): void {
  res.status(status).render(view, model, (error: Error | null, html?: string) => {
    if (error !== null || html === undefined) {
      req.log.error({ err: error, view }, 'page render failed');
      sendRenderFailure(res);
      return;
    }
    res.send(html);
  });
}
