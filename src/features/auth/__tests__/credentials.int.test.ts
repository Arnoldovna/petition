import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import express, { type Express } from 'express';
import { MemoryStore } from 'express-rate-limit';
import session from 'express-session';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentDatabaseUrl } from '../../../../test/database.js';
import { createDatabase, type Database, type DatabaseHandle } from '../../../db/client.js';
import { signatures, users } from '../../../db/schema/index.js';
import { createHasher, createTimingDummy } from '../../../shared/auth/password.js';
import { loadViewer } from '../../../shared/auth/viewer.js';
import { createRateLimiters, productionRateLimits } from '../../../shared/security/security.js';
import { sessionPolicyFromEnv } from '../../../shared/security/session.js';
import { createAuthModule, createCredentials, createViewerRepository, type Credentials } from '../index.js';

/** A fresh random secret per run: tests never commit secret-shaped literals (gitleaks, ADR 0011). */
const testSecret = (): string => randomBytes(32).toString('base64url');

/**
 * The phase-1b auth kernel against the file's own PostgreSQL database (ADR 0001, 0002, 0009): the viewer query,
 * the credentials service and, end to end, `loadViewer` with the real repository.
 */

const PASSWORD = 'correct horse battery staple';
/** The smallest row the signatures CHECKs accept: the PNG magic number padded to 67 bytes. */
const PNG_STUB = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(59)]);

let database: DatabaseHandle;
let db: Database;
let credentials: Credentials;
/** One real argon2id hash of PASSWORD with the pinned parameters, shared by the users of this file. */
let currentHash: string;

beforeAll(async () => {
  database = createDatabase(currentDatabaseUrl());
  db = database.db;
  const hasher = createHasher();
  credentials = createCredentials({ db, hasher });
  currentHash = await hasher.hash(PASSWORD);
});

afterAll(async () => {
  await database.close();
});

let emailCounter = 0;

async function createUser(overrides: { email?: string; passwordHash?: string; firstName?: string } = {}) {
  emailCounter++;
  const [row] = await db
    .insert(users)
    .values({
      firstName: overrides.firstName ?? 'Ada',
      lastName: 'Lovelace',
      email: overrides.email ?? `user${String(emailCounter)}@petition.test`,
      passwordHash: overrides.passwordHash ?? currentHash,
    })
    .returning();
  if (row === undefined) throw new Error('insert returned no row');
  return row;
}

async function storedUser(id: number) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  if (row === undefined) throw new Error(`user ${String(id)} is gone`);
  return row;
}

const MISSING_USER_ID = 2_000_000_000;

describe('viewer repository', () => {
  // `db` exists only once beforeAll has run, so the repository is created per call.
  const findViewer = (userId: number) => createViewerRepository(db).findViewer(userId);

  it('F-32, ADR 0002: returns id, first name and session version; hasSigned is false without a signature', async () => {
    const user = await createUser({ firstName: 'Grace' });

    await expect(findViewer(user.id)).resolves.toEqual({
      id: user.id,
      firstName: 'Grace',
      sessionVersion: 0,
      hasSigned: false,
    });
  });

  it('F-32, B-35: hasSigned is derived from the signatures table on every call', async () => {
    const user = await createUser();
    await db.insert(signatures).values({ userId: user.id, method: 'drawn', image: PNG_STUB });

    await expect(findViewer(user.id)).resolves.toMatchObject({ hasSigned: true });

    await db.delete(signatures).where(eq(signatures.userId, user.id));
    await expect(findViewer(user.id)).resolves.toMatchObject({ hasSigned: false });
  });

  it('F-31, B-05: an unknown or deleted user gives undefined', async () => {
    const user = await createUser();
    await db.delete(users).where(eq(users.id, user.id));

    await expect(findViewer(user.id)).resolves.toBeUndefined();
    await expect(findViewer(MISSING_USER_ID)).resolves.toBeUndefined();
  });
});

describe('credentials.verifyCurrentPassword', () => {
  it('F-63, F-67: true for the current password, false for any other and for an unknown user', async () => {
    const user = await createUser();

    await expect(credentials.verifyCurrentPassword(user.id, PASSWORD)).resolves.toBe(true);
    await expect(credentials.verifyCurrentPassword(user.id, `${PASSWORD} `)).resolves.toBe(false);
    await expect(credentials.verifyCurrentPassword(user.id, '')).resolves.toBe(false);
    await expect(credentials.verifyCurrentPassword(MISSING_USER_ID, PASSWORD)).resolves.toBe(false);
    expect((await storedUser(user.id)).passwordHash).toBe(currentHash);
  });

  it('F-27, ADR 0009: a correct password stored with outdated parameters is rehashed, the version stays', async () => {
    const weakHash = await argon2.hash(PASSWORD, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
    const user = await createUser({ passwordHash: weakHash });

    await expect(credentials.verifyCurrentPassword(user.id, 'wrong password!')).resolves.toBe(false);
    expect((await storedUser(user.id)).passwordHash).toBe(weakHash);

    await expect(credentials.verifyCurrentPassword(user.id, PASSWORD)).resolves.toBe(true);
    const stored = await storedUser(user.id);
    expect(stored.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(stored.sessionVersion).toBe(0);
    await expect(argon2.verify(stored.passwordHash, PASSWORD)).resolves.toBe(true);
  });
});

describe('credentials.hashNewPassword', () => {
  it('F-27, ADR 0009: produces an argon2id hash with the pinned parameters that verifies', async () => {
    const hash = await credentials.hashNewPassword('a brand new passphrase');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    await expect(argon2.verify(hash, 'a brand new passphrase')).resolves.toBe(true);
  });
});

describe('credentials.apply', () => {
  it('F-62: an email change alone updates the email and keeps the session version', async () => {
    const user = await createUser();

    const result = await db.transaction((tx) => credentials.apply(tx, user.id, { email: 'new.address@petition.test' }));

    expect(result).toEqual({ ok: true, sessionVersion: 0 });
    const stored = await storedUser(user.id);
    expect(stored.email).toBe('new.address@petition.test');
    expect(stored.passwordHash).toBe(currentHash);
  });

  it('F-63, ADR 0002 item 9: a new password hash is stored and increments session_version', async () => {
    const user = await createUser();
    const newHash = await credentials.hashNewPassword('another passphrase');

    const first = await db.transaction((tx) => credentials.apply(tx, user.id, { passwordHash: newHash }));
    expect(first).toEqual({ ok: true, sessionVersion: 1 });

    const both = await db.transaction((tx) =>
      credentials.apply(tx, user.id, { email: 'both@petition.test', passwordHash: currentHash }),
    );
    expect(both).toEqual({ ok: true, sessionVersion: 2 });

    const stored = await storedUser(user.id);
    expect(stored).toMatchObject({ email: 'both@petition.test', passwordHash: currentHash, sessionVersion: 2 });
  });

  it('F-64, B-25: an email another account has returns email-taken and changes nothing of either account', async () => {
    const owner = await createUser({ email: 'taken@petition.test' });
    const user = await createUser();
    const newHash = await credentials.hashNewPassword('would be the new one');

    const result = await db.transaction((tx) =>
      credentials.apply(tx, user.id, { email: 'taken@petition.test', passwordHash: newHash }),
    );

    expect(result).toEqual({ ok: false, reason: 'email-taken' });
    expect(await storedUser(user.id)).toMatchObject({ passwordHash: currentHash, sessionVersion: 0 });
    expect((await storedUser(owner.id)).email).toBe('taken@petition.test');
  });

  it("ADR 0009: after email-taken the caller's transaction is still usable; rolling it back saves nothing", async () => {
    await createUser({ email: 'occupied@petition.test' });
    const user = await createUser({ firstName: 'Before' });

    // A caller that continues: the savepoint kept the transaction alive, so later statements commit.
    await db.transaction(async (tx) => {
      await expect(credentials.apply(tx, user.id, { email: 'occupied@petition.test' })).resolves.toEqual({
        ok: false,
        reason: 'email-taken',
      });
      await tx.update(users).set({ firstName: 'After' }).where(eq(users.id, user.id));
    });
    expect((await storedUser(user.id)).firstName).toBe('After');

    // The profile edit's way (F-64): roll back the whole transaction, so the name change is not saved either.
    await expect(
      db.transaction(async (tx) => {
        await tx.update(users).set({ firstName: 'Discarded' }).where(eq(users.id, user.id));
        const result = await credentials.apply(tx, user.id, { email: 'occupied@petition.test' });
        if (!result.ok) tx.rollback();
      }),
    ).rejects.toThrow();
    expect((await storedUser(user.id)).firstName).toBe('After');
  });

  it('ADR 0009: no changes is a no-op that reports the current version', async () => {
    const user = await createUser();

    await expect(db.transaction((tx) => credentials.apply(tx, user.id, {}))).resolves.toEqual({
      ok: true,
      sessionVersion: 0,
    });
  });

  it('ADR 0009: a user deleted meanwhile gives not-found instead of a silent success', async () => {
    await expect(
      db.transaction((tx) => credentials.apply(tx, MISSING_USER_ID, { email: 'ghost@petition.test' })),
    ).resolves.toEqual({ ok: false, reason: 'not-found' });
    await expect(db.transaction((tx) => credentials.apply(tx, MISSING_USER_ID, {}))).resolves.toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});

describe('loadViewer with the real viewer repository', () => {
  /** express-session's in-memory store suffices here; the Redis store is covered in shared/auth viewer.int.test.ts. */
  function createApp(): Express {
    const app = express();
    app.use(session({ secret: testSecret(), resave: false, saveUninitialized: false }));
    app.use(loadViewer(createViewerRepository(db).findViewer));
    app.post('/sign-in/:id', async (req, res) => {
      const userId = Number(req.params.id);
      const [row] = await db.select({ sessionVersion: users.sessionVersion }).from(users).where(eq(users.id, userId));
      req.session.userId = userId;
      req.session.sessionVersion = row?.sessionVersion ?? 0;
      res.sendStatus(204);
    });
    app.get('/whoami', (_req, res) => {
      res.json({ viewer: res.locals.viewer ?? null });
    });
    return app;
  }

  it('F-31, ADR 0002 item 9: a password change through credentials.apply signs out the other device', async () => {
    const user = await createUser({ firstName: 'Katherine' });
    const app = createApp();
    const otherDevice = request.agent(app);
    await otherDevice.post(`/sign-in/${String(user.id)}`).expect(204);
    await otherDevice
      .get('/whoami')
      .expect(200, { viewer: { userId: user.id, firstName: 'Katherine', hasSigned: false } });

    const newHash = await credentials.hashNewPassword('changed on the laptop');
    await db.transaction((tx) => credentials.apply(tx, user.id, { passwordHash: newHash }));

    await otherDevice.get('/whoami').expect(200, { viewer: null });
  });

  it('F-31, F-32, B-05, B-35: signing and account deletion show up on the next request of the same session', async () => {
    const user = await createUser({ firstName: 'Dorothy' });
    const agent = request.agent(createApp());
    await agent.post(`/sign-in/${String(user.id)}`).expect(204);

    await db.insert(signatures).values({ userId: user.id, method: 'typed', image: PNG_STUB });
    await agent.get('/whoami').expect(200, { viewer: { userId: user.id, firstName: 'Dorothy', hasSigned: true } });

    await db.delete(users).where(eq(users.id, user.id));
    await agent.get('/whoami').expect(200, { viewer: null });
  });
});

describe('auth module index (phase-1b stub)', () => {
  it('ADR 0001: createAuthModule never throws and returns a router; the kernel exports are real', async () => {
    const hasher = createHasher();
    const module = createAuthModule({
      db,
      hasher,
      timingDummyHash: await createTimingDummy(hasher),
      rateLimits: createRateLimiters({
        config: productionRateLimits,
        stores: () => new MemoryStore(),
        emailKeySecret: Buffer.alloc(32),
        logger: { warn: () => undefined, error: () => undefined },
      }),
      sessionPolicy: sessionPolicyFromEnv({ SESSION_IDLE_MINUTES: 120, SESSION_ABSOLUTE_HOURS: 168 }),
    });

    expect(typeof module.router).toBe('function');
    expect(typeof module.router.use).toBe('function');
    expect(typeof createViewerRepository(db).findViewer).toBe('function');
  });
});
