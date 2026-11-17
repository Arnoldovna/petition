import { Writable } from 'node:stream';

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';

import { signIn } from '../../../../test/auth.js';
import { createUser } from '../../../../test/factories.js';
import { parse } from '../../../../test/html.js';
import { createTestApp, type TestApp, type TestAppOverrides } from '../../../../test/test-app.js';
import { createLogger } from '../../logging/logger.js';
import { productionRateLimits } from '../security.js';

/**
 * Limiter mechanics with the production limits (ADR 0012, F-26, B-10) on the test-only probes
 * `POST /__test/rate-limit/<limiter>`, which sit behind the app's real limiter instances and Redis stores. The real
 * routes (`/login`, `/register`, `/account/delete`, `/signature`) are covered in step 2b (ADR 0019 §9). This is one of
 * the two files that set `trustProxy: 1`, so each request can name its client IP in `X-Forwarded-For`.
 */

let testApp: TestApp | undefined;

async function start(overrides: TestAppOverrides = {}): Promise<TestApp> {
  testApp = await createTestApp({ rateLimits: productionRateLimits, trustProxy: 1, ...overrides });
  return testApp;
}

afterEach(async () => {
  await testApp?.close();
  testApp = undefined;
});

const AUTH_LIMIT = productionRateLimits.authPer15Min;
const QUARTER_HOUR_S = 15 * 60;

/** One probe request from `ip`, answered with `status` unless a limiter rejects it first. */
function probe(
  app: TestApp,
  limiter: string,
  ip: string,
  { status = 204, email }: { status?: number; email?: string } = {},
) {
  const call = request(app.app)
    .post(`/__test/rate-limit/${limiter}?status=${String(status)}`)
    .set('X-Forwarded-For', ip)
    .type('form');
  return call.send(email === undefined ? {} : { email });
}

/** Sends `count` probes one after another and returns their statuses. */
async function statuses(count: number, send: () => PromiseLike<{ status: number }>): Promise<number[]> {
  const result: number[] = [];
  for (let index = 0; index < count; index++) result.push((await send()).status);
  return result;
}

describe('per-IP limiter (auth-ip)', () => {
  it('F-26, B-10: the 11th request in the window is the 429 page with Retry-After and draft-8 headers', async () => {
    const app = await start();

    expect(await statuses(AUTH_LIMIT, () => probe(app, 'auth-ip', '203.0.113.7'))).toEqual(
      Array.from({ length: AUTH_LIMIT }, () => 204),
    );
    const limited = await probe(app, 'auth-ip', '203.0.113.7');

    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(/^text\/html/);
    expect(parse(limited.text).text('h1')).toBe('Too many attempts');
    const retryAfter = Number(limited.headers['retry-after']);
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(QUARTER_HOUR_S);
    expect(limited.headers['ratelimit-policy']).toMatch(
      new RegExp(`"auth-ip"; q=${String(AUTH_LIMIT)}; w=${String(QUARTER_HOUR_S)}`),
    );
    expect(limited.headers['x-ratelimit-limit']).toBeUndefined(); // no legacy headers
  });

  it('F-26, ADR 0012: another IPv4 client keeps its own budget', async () => {
    const app = await start();
    await statuses(AUTH_LIMIT + 1, () => probe(app, 'auth-ip', '203.0.113.7'));

    expect((await probe(app, 'auth-ip', '203.0.113.8')).status).toBe(204);
  });

  it('F-26, ADR 0012: IPv6 clients share one budget per /56; the next /56 has its own', async () => {
    const app = await start();
    await statuses(AUTH_LIMIT, () => probe(app, 'auth-ip', '2001:db8:1:100::1'));

    expect((await probe(app, 'auth-ip', '2001:db8:1:1ff:ffff::2')).status).toBe(429); // same /56
    expect((await probe(app, 'auth-ip', '2001:db8:1:200::1')).status).toBe(204); // next /56
  });

  it('F-26, B-10: a non-HTML client gets problem+json 429 with Retry-After', async () => {
    const app = await start();
    await statuses(AUTH_LIMIT, () => probe(app, 'auth-ip', '198.51.100.20'));

    const limited = await probe(app, 'auth-ip', '198.51.100.20').set('Accept', 'application/json');

    expect(limited.status).toBe(429);
    expect(limited.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(limited.body).toMatchObject({ status: 429 });
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
  });
});

describe('login limiters count failed attempts only', () => {
  it('F-26, ADR 0012: successes never use up the budget; the 11th failure for an email and subnet is 429', async () => {
    const app = await start();
    const ip = '203.0.113.30';
    const email = 'ada@example.org';

    const succeeded = await statuses(AUTH_LIMIT * 2, () => probe(app, 'login-email-subnet', ip, { email }));
    const failed = await statuses(AUTH_LIMIT, () => probe(app, 'login-email-subnet', ip, { status: 401, email }));

    expect(new Set(succeeded)).toEqual(new Set([204]));
    expect(new Set(failed)).toEqual(new Set([401]));
    expect((await probe(app, 'login-email-subnet', ip, { status: 401, email })).status).toBe(429);
    // The key is the normalised email (trim, lower case), so a variant shares the counter (ADR 0012)
    expect((await probe(app, 'login-email-subnet', ip, { status: 401, email: '  ADA@Example.org ' })).status).toBe(429);
    // ... while another email from the same subnet, and the same email from another subnet, still pass
    expect((await probe(app, 'login-email-subnet', ip, { status: 401, email: 'grace@example.org' })).status).toBe(401);
    expect((await probe(app, 'login-email-subnet', '198.51.100.30', { status: 401, email })).status).toBe(401);
  });
});

describe('per-user limiter (sign)', () => {
  it('F-26, B-10: the budget belongs to the signed-in user whatever the IP; another user keeps their own', async () => {
    const app = await start();
    const [ada, grace] = [await createUser(app.db), await createUser(app.db)];
    const adaAgent = request.agent(app.app);
    const graceAgent = request.agent(app.app);
    await signIn(adaAgent, ada.id);
    await signIn(graceAgent, grace.id);
    const signAs = (agent: ReturnType<typeof request.agent>, ip: string) =>
      agent.post('/__test/rate-limit/sign').set('X-Forwarded-For', ip);

    const allowed = await statuses(productionRateLimits.signPerHour, () => signAs(adaAgent, '203.0.113.40'));
    const limited = await signAs(adaAgent, '198.51.100.40');

    expect(new Set(allowed)).toEqual(new Set([204]));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60 * 60);
    // F-09, ADR 0002: the viewer is loaded before the limiters, so the 429 page keeps the signed-in navigation
    expect(parse(limited.text).has('form[action="/logout"] input[name="_csrf"]')).toBe(true);
    expect((await signAs(graceAgent, '203.0.113.40')).status).toBe(204);
  });
});

describe('global limiter', () => {
  it('F-26, B-10: every dynamic request counts; the 301st request in a minute is the 429 page', async () => {
    const app = await start();
    const ip = '203.0.113.50';
    const page = () => request(app.app).get('/').set('X-Forwarded-For', ip);

    const allowed = await statuses(productionRateLimits.globalPerMinute, page);
    const limited = await page();

    expect(new Set(allowed)).toEqual(new Set([200]));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeLessThanOrEqual(60);
    // Probes and health checks stay outside: static files and /health are mounted before the limiter (B-59, F-74)
    await request(app.app).get('/robots.txt').set('X-Forwarded-For', ip).expect(200);
    await request(app.app).get('/health/live').set('X-Forwarded-For', ip).expect(200);
  });
});

describe('configuration', () => {
  it('B-58, ADR 0012: no limiter logs an express-rate-limit validation error (ERR_ERL_*) on real traffic', async () => {
    const lines: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
        callback();
      },
    });
    const app = await start({ logger: createLogger({ LOG_LEVEL: 'debug', NODE_ENV: 'test' }, destination) });
    const user = await createUser(app.db);
    const agent = request.agent(app.app);
    await signIn(agent, user.id);

    // Every limiter sees IPv4 and IPv6 clients, with and without an email, signed in and as a guest.
    for (const limiter of ['auth-ip', 'register-email', 'login-email-subnet', 'login-email', 'reauth', 'sign']) {
      for (const ip of ['203.0.113.60', '2001:db8:2::60']) {
        await probe(app, limiter, ip, { email: 'ada@example.org' }).expect(204);
        await probe(app, limiter, ip).expect(204);
        await agent.post(`/__test/rate-limit/${limiter}`).set('X-Forwarded-For', ip).expect(204);
      }
    }

    expect(lines.length).toBeGreaterThan(0); // the destination really receives the app's log
    expect(lines.filter((line) => line.includes('ERR_ERL_'))).toEqual([]);
    expect(lines.filter((line) => line.includes('"rate_limit.config"') || line.includes('"rate_limit.error"'))).toEqual(
      [],
    );
  });
});
