import { Writable } from 'node:stream';

import { DrizzleQueryError } from 'drizzle-orm/errors';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createLogger, createRequestLogger } from '../logger.js';

type LogLine = Record<string, unknown>;

/** A logger that writes JSON lines into memory instead of stdout. */
function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' }, destination);
  return {
    logger,
    raw: () => lines.join('\n'),
    entries: (): LogLine[] => lines.map((line) => JSON.parse(line) as LogLine),
  };
}

const SECRETS = {
  password: 'hunter2-hunter2',
  currentPassword: 'old-password-123',
  newPassword: 'new-password-456',
  passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA',
  email: 'ada@example.com',
  _csrf: 'csrf-token-value-123',
  signature: 'data:image/png;base64,iVBORw0KGgo=',
  image: 'raw-image-bytes-as-text',
  typedName: 'Ada Lovelace',
} as const;

/** A failed insert as Drizzle 0.45 reports it: parameters in message, stack and `params`, row values in pg `detail`. */
function failedInsert(): DrizzleQueryError {
  const driverError = Object.assign(
    new Error('duplicate key value violates unique constraint "users_email_lower_idx"'),
    {
      code: '23505',
      constraint: 'users_email_lower_idx',
      detail: `Key (lower(email))=(${SECRETS.email}) already exists.`,
    },
  );
  return new DrizzleQueryError(
    'insert into "users" ("first_name", "last_name", "email", "password_hash") values ($1, $2, $3, $4)',
    ['Ada', 'Lovelace', SECRETS.email, SECRETS.passwordHash],
    driverError,
  );
}

describe('createLogger redaction', () => {
  it.each(Object.entries(SECRETS))('F-73, B-12: redacts %s at the top level and one level down', (key, value) => {
    const capture = captureLogger();

    capture.logger.info({ [key]: value }, 'top level');
    capture.logger.info({ user: { [key]: value } }, 'nested');

    expect(capture.raw()).not.toContain(value);
    const [top, nested] = capture.entries();
    expect(top?.[key]).toBe('[redacted]');
    expect(nested?.['user']).toEqual({ [key]: '[redacted]' });
  });

  it('F-73, B-12: redacts the cookie and authorization request headers and the set-cookie response header', () => {
    const capture = captureLogger();

    capture.logger.info(
      {
        req: {
          method: 'GET',
          url: '/',
          headers: { cookie: 'petition.sid=s%3Asecret', authorization: 'Basic c2VjcmV0' },
        },
        res: { statusCode: 303, headers: { 'set-cookie': 'petition.sid=s%3Anew-secret' } },
      },
      'request completed',
    );

    expect(capture.raw()).not.toMatch(/secret|c2VjcmV0/);
    const [entry] = capture.entries();
    expect(entry).toMatchObject({
      req: { method: 'GET', url: '/', headers: { cookie: '[redacted]', authorization: '[redacted]' } },
      res: { statusCode: 303, headers: { 'set-cookie': '[redacted]' } },
    });
  });

  it('B-12: keeps ids and non-personal fields (domain events log ids only)', () => {
    const capture = captureLogger();

    capture.logger.info({ userId: 42, method: 'drawn' }, 'signature.created');

    expect(capture.entries()[0]).toMatchObject({ userId: 42, method: 'drawn', msg: 'signature.created' });
  });
});

describe('createLogger error serialization', () => {
  it('F-73, B-12, B-13: a failed query logs its SQL and stack but no bound parameter or row value', () => {
    const capture = captureLogger();
    const error = failedInsert();

    capture.logger.error({ err: error }, 'request failed');

    const raw = capture.raw();
    for (const value of ['Lovelace', SECRETS.email, SECRETS.passwordHash]) expect(raw).not.toContain(value);
    const [entry] = capture.entries();
    const err = entry?.['err'] as Record<string, unknown>;
    expect(err['type']).toBe('DrizzleQueryError');
    expect(err['message']).toContain('insert into "users"');
    expect(err['message']).toContain('params: [redacted]');
    expect(err['message']).toContain('users_email_lower_idx');
    expect(err['stack']).toMatch(/\n\s+at /);
    expect(err).not.toHaveProperty('params');
    // The logged error is a copy: the original keeps its data for the code that handles it (isUniqueViolation).
    expect(error.params).toContain(SECRETS.email);
    expect((error.cause as { detail?: string }).detail).toContain(SECRETS.email);
  });

  it('B-12: drops the row values node-postgres puts into detail, also on a driver error logged directly', () => {
    const capture = captureLogger();
    const driverError = failedInsert().cause;

    capture.logger.error({ err: driverError }, 'query failed');

    expect(capture.raw()).not.toContain(SECRETS.email);
    expect(capture.entries()[0]?.['err']).toMatchObject({ code: '23505', constraint: 'users_email_lower_idx' });
  });

  it('B-12: does not trust a rewritten stack of a failed query; it keeps only the redacted message', () => {
    const capture = captureLogger();
    const error = failedInsert();
    error.stack = `custom header with ${SECRETS.email}\n    at somewhere (file.ts:1:1)`;

    capture.logger.error({ err: error }, 'request failed');

    expect(capture.raw()).not.toContain(SECRETS.email);
    expect((capture.entries()[0]?.['err'] as Record<string, unknown>)['stack']).toMatch(/params: \[redacted\]/);
  });

  it('F-73: leaves ordinary errors untouched, including their causes', () => {
    const capture = captureLogger();

    capture.logger.error({ err: new Error('outer', { cause: new Error('inner') }) }, 'failed');

    expect(capture.entries()[0]?.['err']).toMatchObject({ type: 'Error', message: 'outer: inner' });
  });
});

describe('createRequestLogger', () => {
  function appWith(capture: ReturnType<typeof captureLogger>) {
    const app = express();
    app.use(createRequestLogger(capture.logger));
    app.get('/health/ready', (_req, res) => {
      res.json({ status: 'ok' });
    });
    app.get('/page', (_req, res) => {
      res.send('ok');
    });
    app.get('/missing', (_req, res) => {
      res.status(404).send('missing');
    });
    app.get('/broken', () => {
      throw failedInsert();
    });
    // Logs like the real error handler: through the request logger, with the error object.
    const handler: ErrorRequestHandler = (error, req, res, _next) => {
      req.log.error({ err: error }, 'request failed');
      res.status(500).send('error');
    };
    app.use(handler);
    return app;
  }

  it('F-73: accepts a well-formed x-request-id and echoes it', async () => {
    const capture = captureLogger();

    const response = await request(appWith(capture)).get('/page').set('x-request-id', 'upstream-id-1234');

    expect(response.headers['x-request-id']).toBe('upstream-id-1234');
    expect(capture.entries()[0]).toMatchObject({ req: { id: 'upstream-id-1234' }, msg: 'request completed' });
  });

  it.each([
    ['too short', 'short'],
    ['with spaces', 'not a valid id'],
    ['too long', 'x'.repeat(129)],
    ['with header injection characters', 'abcdefgh;rm -rf'],
  ])('F-73: replaces an x-request-id that is %s with a UUID', async (_case, incoming) => {
    const capture = captureLogger();

    const response = await request(appWith(capture)).get('/page').set('x-request-id', incoming);

    expect(response.headers['x-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('F-73: logs 2xx at info and 4xx at warn, and never logs health checks', async () => {
    const capture = captureLogger();
    const app = appWith(capture);

    await request(app).get('/health/ready');
    await request(app).get('/page');
    await request(app).get('/missing');

    const completed = capture.entries().map((entry) => [entry['level'], (entry['req'] as { url: string }).url]);
    expect(completed).toEqual([
      [30, '/page'],
      [40, '/missing'],
    ]);
  });

  it('F-73, B-12: a 5xx is logged at error through req.log without query values or the session cookie', async () => {
    const capture = captureLogger();

    const response = await request(appWith(capture)).get('/broken').set('Cookie', 'petition.sid=s%3Asecret-session');

    expect(response.status).toBe(500);
    const raw = capture.raw();
    for (const value of [SECRETS.email, SECRETS.passwordHash, 'secret-session']) expect(raw).not.toContain(value);
    const levels = capture.entries().map((entry) => entry['level']);
    expect(levels).toEqual([50, 50]);
  });
});
