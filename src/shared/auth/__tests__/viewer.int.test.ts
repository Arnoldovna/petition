import { randomBytes, randomUUID } from 'node:crypto';

import { RedisStore } from 'connect-redis';
import express, { type ErrorRequestHandler, type Express } from 'express';
import session from 'express-session';
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';

import { createRedisClient, type RedisClient } from '../../redis/redis.js';
import { requireAuth, requireGuest } from '../guards.js';
import { loadViewer, type FindViewer, type ViewerRecord } from '../viewer.js';

/** A fresh random secret per run: tests never commit secret-shaped literals (gitleaks, ADR 0011). */
const testSecret = (): string => randomBytes(32).toString('base64url');

/**
 * `loadViewer` between a real express-session with the Redis store (the run's Redis container, keys under a fresh
 * prefix) and an injected lookup. The lookup is an in-memory table here: `shared` never imports `db` or features
 * (ADR 0001). The real viewer query against PostgreSQL is covered in features/auth/__tests__/credentials.int.test.ts.
 */

let redis: RedisClient;

beforeAll(async () => {
  redis = createRedisClient({ url: inject('redisUrl'), logger: pino({ level: 'silent' }) });
  await redis.connect();
});

afterAll(async () => {
  await redis.close();
});

interface Harness {
  app: Express;
  /** The "database": edit it to simulate changes made elsewhere (another device, another request). */
  users: Map<number, ViewerRecord>;
  findViewer: ReturnType<typeof vi.fn<FindViewer>>;
  /** The Redis key of a session id. */
  key(sessionId: string): string;
}

function createHarness(): Harness {
  const prefix = `test-${randomUUID()}:sess:`;
  const users = new Map<number, ViewerRecord>();
  const findViewer = vi.fn<FindViewer>((userId) => Promise.resolve(users.get(userId)));

  const app = express();
  app.use(
    session({
      name: 'petition.sid',
      secret: testSecret(),
      store: new RedisStore({ client: redis, prefix }),
      resave: false,
      saveUninitialized: false,
      cookie: { httpOnly: true, sameSite: 'lax', secure: false },
    }),
  );
  app.use(loadViewer(findViewer));

  // Stand-in for establishSession: new id, then the user id and the version at sign-in. The raw id is stored as given
  // (also invalid ones), to test what loadViewer does with unexpected store content.
  app.post('/sign-in/:id', (req, res, next) => {
    req.session.regenerate((error: unknown) => {
      if (error !== undefined && error !== null) {
        next(error);
        return;
      }
      const userId = Number(req.params.id);
      req.session.userId = userId;
      req.session.sessionVersion = users.get(userId)?.sessionVersion ?? 0;
      res.json({ sessionId: req.sessionID });
    });
  });
  app.get('/whoami', (req, res) => {
    res.json({ viewer: res.locals.viewer ?? null, sessionId: req.sessionID });
  });
  // A later step of the same request that writes the session (flash, CSRF binding): must work after regeneration.
  app.post('/remember', (req, res) => {
    req.session.flash = { message: 'remembered' };
    res.json({ viewer: res.locals.viewer ?? null, sessionId: req.sessionID });
  });
  app.get('/flash', (req, res) => {
    res.json({ flash: req.session.flash ?? null, viewer: res.locals.viewer ?? null });
  });
  app.get('/login', requireGuest, (_req, res) => {
    res.status(200).send('login page');
  });
  app.get('/profile', requireAuth, (_req, res) => {
    res.status(200).send('profile page');
  });
  const errorHandler: ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(500).send('error page');
  };
  app.use(errorHandler);

  return { app, users, findViewer, key: (sessionId) => `${prefix}${sessionId}` };
}

interface SessionBody {
  sessionId: string;
}

interface WhoAmI {
  viewer: { userId: number; firstName: string; hasSigned: boolean } | null;
  sessionId: string;
}

describe('loadViewer', () => {
  let harness: Harness;
  let agent: ReturnType<typeof request.agent>;

  beforeEach(() => {
    harness = createHarness();
    harness.users.set(1, { id: 1, firstName: 'Ada', sessionVersion: 0, hasSigned: false });
    agent = request.agent(harness.app);
  });

  async function signIn(userId: number): Promise<string> {
    const response = await agent.post(`/sign-in/${String(userId)}`).expect(200);
    return (response.body as SessionBody).sessionId;
  }

  it('F-32: a guest request never queries the database and has no viewer', async () => {
    const response = await agent.get('/whoami').expect(200);

    expect((response.body as WhoAmI).viewer).toBeNull();
    expect(harness.findViewer).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined(); // saveUninitialized: false, no session for guests
  });

  it('ADR 0002: a valid session gets the viewer from the lookup of this request', async () => {
    await signIn(1);
    const response = await agent.get('/whoami').expect(200);

    expect((response.body as WhoAmI).viewer).toEqual({ userId: 1, firstName: 'Ada', hasSigned: false });
    expect(harness.findViewer).toHaveBeenLastCalledWith(1);
  });

  it('F-32, B-35: hasSigned follows the database on every request and is never cached in the session', async () => {
    const sessionId = await signIn(1);
    expect(((await agent.get('/whoami')).body as WhoAmI).viewer?.hasSigned).toBe(false);

    harness.users.set(1, { id: 1, firstName: 'Ada', sessionVersion: 0, hasSigned: true }); // signed in another tab
    expect(((await agent.get('/whoami')).body as WhoAmI).viewer?.hasSigned).toBe(true);

    harness.users.set(1, { id: 1, firstName: 'Ada', sessionVersion: 0, hasSigned: false }); // deleted on a phone
    expect(((await agent.get('/whoami')).body as WhoAmI).viewer?.hasSigned).toBe(false);

    const stored = await redis.get(harness.key(sessionId));
    expect(stored).not.toBeNull();
    expect(Object.keys(JSON.parse(stored ?? '{}') as object).sort()).toEqual(['cookie', 'sessionVersion', 'userId']);
  });

  it('F-31, B-05: a deleted account turns the session into a guest; the old store entry is gone', async () => {
    const sessionId = await signIn(1);
    expect(await redis.exists(harness.key(sessionId))).toBe(1);

    harness.users.delete(1); // account deleted on another device
    const response = await agent.get('/whoami').expect(200);

    const body = response.body as WhoAmI;
    expect(body.viewer).toBeNull();
    expect(body.sessionId).not.toBe(sessionId);
    expect(await redis.exists(harness.key(sessionId))).toBe(0);
    await agent.get('/profile').expect(302).expect('location', '/login?returnTo=%2Fprofile');
  });

  it('ADR 0002 item 9: a session_version bumped elsewhere (password change) ends this session', async () => {
    const sessionId = await signIn(1);
    harness.users.set(1, { id: 1, firstName: 'Ada', sessionVersion: 1, hasSigned: false });

    const body = (await agent.get('/whoami').expect(200)).body as WhoAmI;

    expect(body.viewer).toBeNull();
    expect(await redis.exists(harness.key(sessionId))).toBe(0);
  });

  it('F-09, F-31: a stale cookie on GET /login gives the 200 guest page, never a redirect loop or a 500', async () => {
    await signIn(1);
    await agent.get('/login').expect(302).expect('location', '/signature');

    harness.users.delete(1);
    await agent.get('/login').expect(200, 'login page');
    await agent.get('/login').expect(200, 'login page');
  });

  it('F-09, ADR 0002: after the regeneration the same request can still write the session (no destroy)', async () => {
    const oldSessionId = await signIn(1);
    harness.users.delete(1);

    const response = await agent.post('/remember').expect(200);
    const body = response.body as WhoAmI;
    expect(body.viewer).toBeNull();
    expect(body.sessionId).not.toBe(oldSessionId);

    // The new anonymous session was saved with the flash and is the one the browser now holds.
    const flash = await agent.get('/flash').expect(200);
    expect(flash.body).toEqual({ flash: { message: 'remembered' }, viewer: null });
    const stored = await redis.get(harness.key(body.sessionId));
    expect(JSON.parse(stored ?? '{}')).not.toHaveProperty('userId');
  });

  it('B-05: unexpected session content (an id that cannot be a users.id) is a ghost session, never a lookup', async () => {
    for (const invalid of [0, -3, 3_000_000_000, 1.5]) {
      const sessionId = await signIn(invalid);
      const body = (await agent.get('/whoami').expect(200)).body as WhoAmI;

      expect(body.viewer).toBeNull();
      expect(await redis.exists(harness.key(sessionId))).toBe(0);
    }
    expect(harness.findViewer).not.toHaveBeenCalled();
  });

  it('F-09: a failing lookup (database down) reaches the error handler instead of hanging', async () => {
    await signIn(1);
    harness.findViewer.mockRejectedValueOnce(new Error('connection refused'));

    await agent.get('/whoami').expect(500, 'error page');
  });
});
