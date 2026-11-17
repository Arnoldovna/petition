import { randomUUID } from 'node:crypto';

import { pino, stdSerializers, type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { pinoHttp } from 'pino-http';

import type { Env } from '../../config/env.js';

/** Fields that carry credentials or personal data (ADR 0011). */
const SENSITIVE_KEYS = [
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'email',
  '_csrf',
  'signature',
  'image',
  'typedName',
];

/**
 * Paths that never reach a log line (ADR 0011, F-73, B-12, B-58). Request bodies are never logged at all; these
 * cover headers and any object that carries personal data or credentials by mistake, as a top-level field
 * (`log.info({ email })`) or one level down (`log.info({ user: { email } })`).
 */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((key) => `*.${key}`),
];

const REDACTED = '[redacted]';
/** How far down a `cause` chain errors are made safe; matches the depth db-errors.ts searches. */
const MAX_CAUSE_DEPTH = 5;

/**
 * DrizzleQueryError's message is exactly `Failed query: ${query}\nparams: ${params}`, so everything after the known
 * prefix is parameters. A message of any other shape is dropped as a whole rather than guessed at.
 */
function messageWithoutParams(message: string, query: unknown): string {
  const prefix = typeof query === 'string' ? `Failed query: ${query}\nparams: ` : undefined;
  return prefix !== undefined && message.startsWith(prefix) ? `${prefix}${REDACTED}` : REDACTED;
}

/**
 * A copy of `error` (and its causes) without bound query parameters. Drizzle's DrizzleQueryError writes every
 * parameter into its message, its stack and an enumerable `params` property, and node-postgres errors repeat row
 * values in `detail` ("Key (lower(email))=(...) already exists", "Failing row contains (...)"). An unexpected database
 * error would otherwise log emails, names and password hashes (B-12). The SQL text with `$1` placeholders stays.
 */
function withoutQueryValues(error: Error, depth = 0): Error {
  const record = error as Error & Record<string, unknown>;
  const params = record['params'];
  const hasValues = params !== undefined || typeof record['detail'] === 'string';
  const cause =
    record.cause instanceof Error && depth < MAX_CAUSE_DEPTH
      ? withoutQueryValues(record.cause, depth + 1)
      : record.cause;
  if (!hasValues && cause === record.cause) return error;

  const message = params === undefined ? error.message : messageWithoutParams(error.message, record['query']);
  // The stack header repeats the original message verbatim; replacing that exact text keeps the frames. A stack
  // without it (rewritten by someone) is not trusted to be free of the parameters.
  const stack =
    params === undefined || error.stack?.includes(error.message) === true
      ? error.stack?.replace(error.message, message)
      : `${error.name}: ${message}`;

  const copy = Object.create(Object.getPrototypeOf(error) as object) as Error & Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (key !== 'params' && key !== 'detail') copy[key] = value;
  }
  Object.defineProperties(copy, {
    message: { value: message, enumerable: false, writable: true, configurable: true },
    stack: { value: stack, enumerable: false, writable: true, configurable: true },
    cause: { value: cause, enumerable: false, writable: true, configurable: true },
  });
  return copy;
}

/**
 * pino's standard error serializer (type, message and stack with causes) on a copy without query values. pino-http
 * wraps custom serializers so that they receive the already serialized error; that object keeps the original error
 * as the non-enumerable `raw`, which is serialized again from scratch.
 */
function serializeError(value: unknown): unknown {
  const raw: unknown = typeof value === 'object' && value !== null && 'raw' in value ? value.raw : undefined;
  const error = value instanceof Error ? value : raw instanceof Error ? raw : undefined;
  return error === undefined ? value : stdSerializers.err(withoutQueryValues(error));
}

/**
 * The app logger (ADR 0011). `destination` replaces stdout (tests capture the JSON lines); without it, development
 * pretty-prints through pino-pretty, a devDependency that only development loads (the image runs
 * NODE_ENV=production).
 */
export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>, destination?: DestinationStream): Logger {
  const options: LoggerOptions = {
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: REDACTED },
    serializers: { err: serializeError },
  };
  if (destination !== undefined) return pino(options, destination);
  return pino(env.NODE_ENV === 'development' ? { ...options, transport: { target: 'pino-pretty' } } : options);
}

const REQUEST_ID = /^[\w-]{8,128}$/;

/** pino-http with a request id: a well-formed incoming `x-request-id` or a UUID, echoed in the response. */
export function createRequestLogger(logger: Logger) {
  return pinoHttp({
    logger,
    // pino-http installs its own serializers on the request loggers (`req.log`), so the safe one is passed again.
    serializers: { err: serializeError },
    genReqId: (req, res) => {
      const incoming = req.headers['x-request-id'];
      const id = typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
      res.setHeader('x-request-id', id);
      return id;
    },
    // 5xx at error (with the error object), 4xx at warn, the rest at info.
    customLogLevel: (_req, res, error) => {
      if (error !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    // Health checks are polled every few seconds and are not logged (ADR 0011).
    autoLogging: { ignore: (req) => req.url?.startsWith('/health/') ?? false },
  });
}
