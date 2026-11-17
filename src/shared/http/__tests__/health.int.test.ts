import { sql } from 'drizzle-orm';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestApp, type TestApp } from '../../../../test/test-app.js';
import { createHealthRouter } from '../health.js';

describe('health endpoints on the real app', () => {
  let testApp: TestApp;

  beforeEach(async () => {
    testApp = await createTestApp();
  });

  afterEach(async () => {
    await testApp.close();
  });

  it('F-74: /health/live answers 200 while the process is up', async () => {
    const response = await request(testApp.app).get('/health/live');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it("F-74: /health/ready answers 200 when the file's database and Redis are reachable", async () => {
    const response = await request(testApp.app).get('/health/ready');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/^application\/json/);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('F-74: /health/ready answers 503 without naming the dependency when the Redis client is stopped', async () => {
    await testApp.redis.close();

    const response = await request(testApp.app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
    expect(response.text).not.toMatch(/redis|database|postgres/i);
  });

  it('F-74: /healthz does not exist (amended to /health/ready) and answers the 404 problem', async () => {
    const response = await request(testApp.app).get('/healthz').set('Accept', 'application/json');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).toMatchObject({ status: 404, title: 'Not found' });
  });

  it("ADR 0017: the test app runs on the file's own empty, migrated database, cloned from the template", async () => {
    const result = await testApp.db.execute<{ name: string }>(sql`select current_database() as name`);
    // `shared` may not import `db`, so the table is named in SQL here.
    const users = await testApp.db.execute<{ count: number }>(sql`select count(*)::int as count from users`);

    expect(result.rows[0]?.name).toMatch(/^t_[0-9a-f]{32}$/);
    expect(users.rows[0]?.count).toBe(0);
  });

  it('F-74, B-10: health responses skip the page middleware but carry the request id', async () => {
    const response = await request(testApp.app).get('/health/ready').set('x-request-id', 'probe-12345678');

    expect(response.headers['x-request-id']).toBe('probe-12345678');
    expect(response.headers['x-powered-by']).toBeUndefined();
    // Mounted before helmet, sessions and limits (OVERVIEW.md section 5.1): probes never get a CSP or a cookie.
    expect(response.headers['content-security-policy']).toBeUndefined();
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['ratelimit-policy']).toBeUndefined();
  });
});

describe('health router states the container cannot reach on its own', () => {
  const appWith = (checks: Parameters<typeof createHealthRouter>[0], shuttingDown: boolean, checkTimeoutMs?: number) =>
    express().use(
      '/health',
      createHealthRouter(checks, () => shuttingDown, { checkTimeoutMs }),
    );

  it('F-74: /health/ready answers 503 shutting-down during graceful shutdown, before running any check', async () => {
    let checked = false;
    const app = appWith(
      {
        database: () => {
          checked = true;
          return Promise.resolve(true);
        },
      },
      true,
    );

    const response = await request(app).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'shutting-down' });
    expect(checked).toBe(false);
  });

  it('F-74: a failing or throwing check gives 503, never 500', async () => {
    const failing = appWith({ database: () => Promise.resolve(false), redis: () => Promise.resolve(true) }, false);
    const throwing = appWith({ database: () => Promise.reject(new Error('connection refused')) }, false);

    for (const app of [failing, throwing]) {
      const response = await request(app).get('/health/ready');
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ status: 'unavailable' });
    }
  });

  it('F-74: a check that never settles (unreachable database) gives 503 within the check timeout', async () => {
    const hanging = appWith(
      { database: () => new Promise<boolean>(() => undefined), redis: () => Promise.resolve(true) },
      false,
      50,
    );

    const started = performance.now();
    const response = await request(hanging).get('/health/ready');

    expect(response.status).toBe(503);
    expect(response.body).toEqual({ status: 'unavailable' });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('F-74: a check that throws synchronously gives 503, never 500', async () => {
    const throwing = appWith(
      {
        database: () => {
          throw new Error('pool destroyed');
        },
      },
      false,
    );

    const response = await request(throwing).get('/health/ready');

    expect(response.status).toBe(503);
  });

  it('F-74: /health/live stays 200 while shutting down (the process is still alive)', async () => {
    const response = await request(appWith({}, true)).get('/health/live');

    expect(response.status).toBe(200);
  });
});
