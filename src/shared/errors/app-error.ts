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

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super({ status: 404, code: 'not-found', title: 'Not found', detail: `${resource} was not found.` });
  }
}
