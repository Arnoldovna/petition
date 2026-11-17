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

function generic(status: number, req: Request, detail?: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: STATUS_TITLES[status] ?? 'Error',
    status,
    ...(detail === undefined ? {} : { detail }),
    instance: req.originalUrl,
  };
}

/**
 * Maps any thrown value to a client-safe problem (ADR 0008): AppErrors keep their code and detail, http-errors 4xx
 * keep their status (and their message only when marked `expose`), everything else is a generic 500. Internal
 * messages, SQL and stacks never leave the server (F-09, B-13).
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
    return generic(error.status, req, error.expose ? error.message : undefined);
  }
  return generic(500, req, 'An unexpected error occurred.');
}
