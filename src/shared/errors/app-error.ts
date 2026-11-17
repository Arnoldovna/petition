type ProblemExtensions = Readonly<Record<string, unknown>>;

interface AppErrorInit {
  status: number;
  /** Stable, kebab-case identifier. Becomes the problem `type` and is safe to show to clients. */
  code: string;
  title: string;
  /** Human-readable, client-safe explanation. Never include secrets, SQL or stack traces. */
  detail: string;
  cause?: unknown;
  extensions?: ProblemExtensions;
}

/**
 * Base class for every error the app deliberately exposes (RFC 9457 problem details, ADR 0008). Anything that is not
 * an AppError (or an http-errors 4xx from body-parser or csrf-csrf) becomes a generic 500.
 *
 * Expected form and business outcomes are Result values, not exceptions (ADR 0008): these classes are for requests
 * that cannot continue at all (unknown page, rate limit, oversized payload).
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly extensions: ProblemExtensions;

  constructor(init: AppErrorInit) {
    super(init.detail, { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.code = init.code;
    this.title = init.title;
    this.extensions = init.extensions ?? {};
  }
}

interface ValidationIssue {
  location: 'params' | 'query' | 'body';
  path: string;
  message: string;
}

/** A request that is malformed as a whole (not a form re-render, which is a 422 Result, ADR 0008). */
export class ValidationError extends AppError {
  constructor(issues: readonly ValidationIssue[]) {
    super({
      status: 400,
      code: 'validation-failed',
      title: 'Validation failed',
      detail: 'The request contains invalid data.',
      extensions: { errors: issues },
    });
  }
}

export class UnauthorizedError extends AppError {
  constructor(detail = 'Authentication is required.') {
    super({ status: 401, code: 'unauthenticated', title: 'Unauthorized', detail });
  }
}

export class ForbiddenError extends AppError {
  constructor(detail = 'You are not allowed to perform this action.') {
    super({ status: 403, code: 'forbidden', title: 'Forbidden', detail });
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super({ status: 404, code: 'not-found', title: 'Not found', detail: `${resource} was not found.` });
  }
}

export class ConflictError extends AppError {
  constructor(detail: string, code = 'conflict') {
    super({ status: 409, code, title: 'Conflict', detail });
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(maxBytes: number) {
    super({
      status: 413,
      code: 'payload-too-large',
      title: 'Payload too large',
      detail: `The request exceeds the limit of ${String(maxBytes)} bytes.`,
      extensions: { maxBytes },
    });
  }
}

/**
 * A rate limiter rejected the request, or the password hasher queue is full (ADR 0009, ADR 0012). The 429 page names
 * no fixed duration because the windows differ; `retryAfterSeconds`, when known, becomes the `Retry-After` header
 * unless the limiter has set one already.
 */
export class TooManyRequestsError extends AppError {
  readonly retryAfterSeconds: number | undefined;

  constructor({ retryAfterSeconds }: { retryAfterSeconds?: number } = {}) {
    super({
      status: 429,
      code: 'too-many-requests',
      title: 'Too many requests',
      detail: 'Too many attempts. Please wait a few minutes, then try again.',
    });
    this.retryAfterSeconds =
      retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.ceil(retryAfterSeconds)
        : undefined;
  }
}
