import { randomUUID } from 'node:crypto';

import { pino, type Logger } from 'pino';
import { pinoHttp } from 'pino-http';

import type { Env } from '../../config/env.js';

/**
 * Paths that never reach a log line (ADR 0011, F-73, B-12, B-58). Request bodies are never logged at all; these
 * cover headers and any object that carries personal data or credentials by mistake.
 */
const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'res.headers["set-cookie"]',
  '*.password',
  '*.currentPassword',
  '*.newPassword',
  '*.passwordHash',
  '*.email',
  '*._csrf',
  '*.signature',
  '*.image',
  '*.typedName',
];

export function createLogger(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Logger {
  return pino({
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // pino-pretty is a devDependency: only development loads it (the image runs NODE_ENV=production).
    ...(env.NODE_ENV === 'development' ? { transport: { target: 'pino-pretty' } } : {}),
  });
}

const REQUEST_ID = /^[\w-]{8,128}$/;

/** pino-http with a request id: a well-formed incoming `x-request-id` or a UUID, echoed in the response. */
export function createRequestLogger(logger: Logger) {
  return pinoHttp({
    logger,
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
