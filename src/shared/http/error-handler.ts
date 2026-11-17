import type { ErrorRequestHandler, RequestHandler } from 'express';

import { NotFoundError } from '../errors/app-error.js';
import { renderPage } from '../view/render.js';
import { toProblem } from './problem.js';

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

/** ROUTES.md section 8: one h1, one sentence and one next step per status. */
const ERROR_PAGES: Readonly<Record<number, ErrorPageCopy>> = {
  400: BAD_REQUEST,
  403: {
    heading: 'This form has expired',
    text: 'For your security, forms expire. Go back, reload the page and send it again.',
    ...HOME,
  },
  404: { heading: 'Page not found', text: 'Check the address, or go to the home page.', ...HOME },
  413: {
    heading: 'That was too much data',
    text: 'If you were signing, clear the pad and draw a smaller signature.',
    nextHref: '/signature',
    nextLabel: 'back to signing',
  },
  429: { heading: 'Too many attempts', text: 'Please wait a few minutes, then try again.', ...HOME },
  500: SERVER_ERROR,
};

/** Any other 4xx (405 from the static routers, 415) reads like a malformed request. */
function errorPageCopy(status: number): ErrorPageCopy {
  return ERROR_PAGES[status] ?? (status >= 500 ? SERVER_ERROR : BAD_REQUEST);
}

/** After every router: unknown paths get the 404 page and never redirect (F-08, B-43). */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path}`));
};

/**
 * Registered last (ADR 0008). Express 5 forwards rejected promises here, so handlers need no try/catch. HTML clients
 * get the error page through renderPage, everything else RFC 9457 problem+json. Stacks only go to the log (F-09,
 * B-13); 5xx are logged at error with the error object, 4xx without a stack (ADR 0011).
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    // Express's default handler closes the connection; nothing else can be sent safely.
    next(error);
    return;
  }
  const problem = toProblem(error, req);
  if (problem.status >= 500) {
    req.log.error({ err: error }, 'request failed');
  } else {
    // pino-http already logs the 4xx response at warn; this line only adds the problem type.
    req.log.info({ problemType: problem.type, status: problem.status }, 'request rejected');
  }

  if (req.accepts(['html', 'json']) === 'html') {
    const copy = errorPageCopy(problem.status);
    renderPage(req, res, 'pages/error', { title: copy.heading, ...copy }, problem.status);
    return;
  }
  res.status(problem.status).type('application/problem+json').json(problem);
};
