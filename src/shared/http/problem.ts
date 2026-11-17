import type { Request } from 'express';

import { APP_SLUG } from '../../config/app.js';
import { AppError } from '../errors/app-error.js';

/** RFC 9457 problem details. Extension members are allowed next to the standard fields. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [extension: string]: unknown;
}

/** Tag URIs (RFC 4151) are a valid, non-resolvable choice for problem types (RFC 9457 section 3.1.1). */
const PROBLEM_TYPE_PREFIX = `tag:arnoldovna.github.io,2026:${APP_SLUG}:problem:`;

const STATUS_TITLES: Readonly<Record<number, string>> = {
  400: 'Bad request',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  413: 'Payload too large',
  415: 'Unsupported media type',
  429: 'Too many requests',
  500: 'Internal server error',
};

/** Errors created by `http-errors` (body-parser, serve-static, csrf-csrf) carry `status` and `expose`. */
interface HttpErrorLike {
  status: number;
  expose: boolean;
  message: string;
  /** body-parser's machine-readable reason, e.g. `entity.too.large`. */
  type?: unknown;
  /** csrf-csrf's `EBADCSRFTOKEN`. */
  code?: unknown;
}

function isHttpErrorLike(error: unknown): error is HttpErrorLike {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number' &&
    'expose' in error &&
    typeof error.expose === 'boolean'
  );
}

interface KnownProblem {
  status: number;
  code: string;
  detail: string;
}

const CSRF_INVALID: KnownProblem = {
  status: 403,
  code: 'csrf-invalid',
  detail: 'The form has expired. Reload the page and send it again.',
};
const PAYLOAD_TOO_LARGE: KnownProblem = {
  status: 413,
  code: 'payload-too-large',
  detail: 'The request body is too large.',
};
const MALFORMED_BODY: KnownProblem = {
  status: 400,
  code: 'malformed-body',
  detail: 'The request body could not be read.',
};
const UNSUPPORTED_ENCODING: KnownProblem = {
  status: 415,
  code: 'unsupported-media-type',
  detail: 'The request body uses an unsupported encoding or charset.',
};

/**
 * body-parser rejections with a stable problem type and a fixed detail (ADR 0008), so neither the library's wording
 * nor anything it echoes from the request reaches the client.
 */
const BODY_PARSER_PROBLEMS: Readonly<Record<string, KnownProblem>> = {
  'entity.too.large': PAYLOAD_TOO_LARGE,
  'parameters.too.many': PAYLOAD_TOO_LARGE,
  'entity.parse.failed': MALFORMED_BODY,
  'entity.verify.failed': MALFORMED_BODY,
  'request.aborted': { status: 400, code: 'request-aborted', detail: 'The request was aborted.' },
  'request.size.invalid': MALFORMED_BODY,
  'encoding.unsupported': UNSUPPORTED_ENCODING,
  'charset.unsupported': UNSUPPORTED_ENCODING,
};

/**
 * True for the CSRF rejection (ADR 0003). The error page needs to know, because only this 403 is "This form has
 * expired"; any other 403 (a static folder refusing a path that leaves it, `ForbiddenError`) is not about a form.
 */
export function isCsrfProblem(problem: Pick<ProblemDetails, 'type'>): boolean {
  return problem.type === `${PROBLEM_TYPE_PREFIX}${CSRF_INVALID.code}`;
}

function knownProblem(error: HttpErrorLike): KnownProblem | undefined {
  if (error.code === 'EBADCSRFTOKEN') return CSRF_INVALID;
  return typeof error.type === 'string' ? BODY_PARSER_PROBLEMS[error.type] : undefined;
}

function titleFor(status: number): string {
  return STATUS_TITLES[status] ?? (status >= 500 ? 'Internal server error' : 'Bad request');
}

function generic(status: number, req: Request, detail?: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: titleFor(status),
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: req.originalUrl,
  };
}

/**
 * Maps any thrown value to a client-safe problem (ADR 0008): AppErrors keep their code and detail; CSRF and
 * body-parser rejections get stable types and fixed details; other http-errors 4xx keep their status (and their
 * message only when marked `expose`); everything else is a generic 500. Internal messages, SQL and stacks never leave
 * the server (F-09, B-13).
 */
export function toProblem(error: unknown, req: Request): ProblemDetails {
  if (error instanceof AppError) {
    return {
      ...error.extensions,
      type: `${PROBLEM_TYPE_PREFIX}${error.code}`,
      title: error.title,
      status: error.status,
      detail: error.message,
      instance: req.originalUrl,
    };
  }
  if (isHttpErrorLike(error) && error.status >= 400 && error.status < 500) {
    const known = knownProblem(error);
    if (known !== undefined) {
      return {
        type: `${PROBLEM_TYPE_PREFIX}${known.code}`,
        title: titleFor(known.status),
        status: known.status,
        detail: known.detail,
        instance: req.originalUrl,
      };
    }
    return generic(error.status, req, error.expose ? error.message : undefined);
  }
  return generic(500, req, 'An unexpected error occurred.');
}
