import type { ErrorRequestHandler, Request, RequestHandler } from 'express';

import { NotFoundError, TooManyRequestsError } from '../errors/app-error.js';
import { renderPage } from '../view/render.js';
import { isCsrfProblem, toProblem, type ProblemDetails } from './problem.js';
import { sameOriginReferer } from './redirect.js';

interface ErrorPageCopy {
  heading: string;
  text: string;
  nextHref: string;
  nextLabel: string;
}

const HOME = { nextHref: '/', nextLabel: 'go to the home page' } as const;

const BAD_REQUEST: ErrorPageCopy = {
  heading: 'That request could not be read',
  text: 'Please go back and try again.',
  ...HOME,
};
const SERVER_ERROR: ErrorPageCopy = { heading: 'Something went wrong', text: 'Please try again in a moment.', ...HOME };

/** Only the CSRF rejection, chosen by its problem type, never by the 403 status alone (ROUTES.md section 8). */
const FORM_EXPIRED: ErrorPageCopy = {
  heading: 'This form has expired',
  text: 'For your security, forms expire. Go back, reload the page and send it again.',
  ...HOME,
};

/**
 * Every other refusal: a 403 that is not the CSRF check (a static folder refusing a path that leaves it), and the
 * `UnauthorizedError`, `ForbiddenError` and `ConflictError` that no HTML route throws today (guards redirect, business
 * rules are 422 results, ADR 0008). It names no cause it cannot know and never suggests sending the form again.
 */
const NOT_COMPLETED: ErrorPageCopy = {
  heading: 'That request could not be completed',
  text: 'Go back, or start again from the home page.',
  ...HOME,
};

/** ROUTES.md section 8: one h1, one sentence and one next step per status. */
const ERROR_PAGES: Readonly<Record<number, ErrorPageCopy>> = {
  400: BAD_REQUEST,
  404: { heading: 'Page not found', text: 'Check the address, or go to the home page.', ...HOME },
  413: {
    heading: 'That was too much data',
    text: 'If you were signing, clear the pad and draw a smaller signature.',
    nextHref: '/signature',
    nextLabel: 'back to signing',
  },
  // An unsupported body encoding or charset is a body that could not be read.
  415: BAD_REQUEST,
  429: { heading: 'Too many attempts', text: 'Please wait a few minutes, then try again.', ...HOME },
  500: SERVER_ERROR,
};

/**
 * The copy of the error page. The CSRF page links back to the form when the browser came from a page of this app
 * (ROUTES.md section 8); every other page links to its fixed next step.
 */
function errorPageCopy(req: Request, problem: ProblemDetails): ErrorPageCopy {
  if (isCsrfProblem(problem)) {
    const back = sameOriginReferer(req);
    return back === undefined ? FORM_EXPIRED : { ...FORM_EXPIRED, nextHref: back, nextLabel: 'back to the form' };
  }
  return ERROR_PAGES[problem.status] ?? (problem.status >= 500 ? SERVER_ERROR : NOT_COMPLETED);
}

/** After every router: unknown paths get the 404 page and never redirect (F-08, B-43). */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/**
 * Registered last (ADR 0008). Express 5 forwards rejected promises here, so handlers need no try/catch. HTML clients
 * get the error page through renderPage, everything else RFC 9457 problem+json. Stacks only go to the log (F-09,
 * B-13); 5xx are logged at error with the error object (query values removed by the logger's serializer), 4xx
 * without a stack (ADR 0011). A 429 carries `Retry-After` when its error knows the wait.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    // Express's default handler closes the connection; nothing else can be sent safely.
    next(error);
    return;
  }
  const problem = toProblem(error, req);
  // A limiter has usually set Retry-After already (express-rate-limit); the hasher queue relies on this one.
  if (error instanceof TooManyRequestsError && error.retryAfterSeconds !== undefined && !res.hasHeader('Retry-After')) {
    res.setHeader('Retry-After', String(error.retryAfterSeconds));
  }
  if (problem.status >= 500) {
    req.log.error({ err: error }, 'request failed');
  } else {
    // pino-http already logs the 4xx response at warn; this line only adds the problem type.
    req.log.info({ problemType: problem.type, status: problem.status }, 'request rejected');
  }

  if (req.accepts(['html', 'json']) === 'html') {
    const copy = errorPageCopy(req, problem);
    renderPage(req, res, 'pages/error', { title: copy.heading, ...copy }, problem.status);
    return;
  }
  res.status(problem.status).type('application/problem+json').json(problem);
};
