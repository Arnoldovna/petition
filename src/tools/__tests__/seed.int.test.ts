import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { loadImage } from '@napi-rs/canvas';
import * as argon2 from 'argon2';
import { asc, eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { currentDatabaseUrl } from '../../../test/database.js';
import { createUser } from '../../../test/factories.js';
import { createFakeHasher } from '../../../test/fakes.js';
import { testSignatureFontPaths } from '../../../test/fonts.js';
import { createDatabase, type Database, type DatabaseHandle } from '../../db/client.js';
import { profiles, signatures, users } from '../../db/schema/index.js';
import { createSignatureImages, type SignatureImages } from '../../features/signature/index.js';
import { createLogger } from '../../shared/logging/logger.js';
import {
  firstName as firstNameField,
  lastName as lastNameField,
  optionalAge,
  optionalCity,
  optionalHomepage,
} from '../../shared/validation/fields.js';
import { asciiFold, DEMO_ACCOUNT, DEMO_EMAIL, SEED_ACCOUNTS, SEED_SUPPORTERS, type SeedAccount } from '../seed-data.js';
import { renderGeneratedSignature } from '../seed-signatures.js';
import { assertSeedAllowed, parseSeedEnv, runSeed, seedDatabase, type SeedDeps } from '../seed.js';

/**
 * `pnpm db:seed` (F-01, B-60, DATA-MODEL.md section 6, ADR 0016, ADR 0019 §7) against the file's own database. Every
 * test starts from an empty `users` table (the cascade empties profiles and signatures), so each one seeds the state
 * it needs. The other integration files never use the seed (ADR 0017).
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ENTRY = 'src/tools/seed.ts';
const DEMO_PASSWORD = 'demo password for tests';
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let database: DatabaseHandle;
let db: Database;
let images: SignatureImages;

beforeAll(() => {
  database = createDatabase(currentDatabaseUrl());
  db = database.db;
  // The real image service with the shipped fonts, as in the image (ADR 0005).
  images = createSignatureImages({ fontPaths: testSignatureFontPaths() });
});

afterAll(async () => {
  await database.close();
});

beforeEach(async () => {
  await db.delete(users);
});

interface CapturedLog {
  logger: Logger;
  lines: Record<string, unknown>[];
  /** The raw output, to assert that no personal data appears anywhere. */
  text: () => string;
}

function captureLog(): CapturedLog {
  const raw: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      raw.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  return {
    logger: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' }, destination),
    get lines() {
      return raw.map((line) => JSON.parse(line) as Record<string, unknown>);
    },
    text: () => raw.join('\n'),
  };
}

/** Counts how often the seed asked for the image service. */
function countingImages(service: SignatureImages = images): { load: () => SignatureImages; calls: () => number } {
  let calls = 0;
  return {
    load: () => {
      calls += 1;
      return service;
    },
    calls: () => calls,
  };
}

/** `seedDatabase` with the fake hasher (no argon2 cost) and the real image service unless overridden. */
function seedDeps(overrides: Partial<SeedDeps> = {}): SeedDeps {
  return {
    db,
    hasher: createFakeHasher(),
    demoPassword: DEMO_PASSWORD,
    loadSignatureImages: () => images,
    logger: captureLog().logger,
    ...overrides,
  };
}

/** Every column of every row, images included, in a stable order: two equal snapshots mean nothing changed. */
async function snapshot() {
  return {
    users: await db.select().from(users).orderBy(asc(users.id)),
    profiles: await db.select().from(profiles).orderBy(asc(profiles.userId)),
    signatures: (await db.select().from(signatures).orderBy(asc(signatures.id))).map((row) => ({
      ...row,
      image: row.image.toString('base64'),
    })),
  };
}

/** The stored accounts in the shape of `seed-data.ts`, demo first, then the supporters in signing order. */
async function storedAccounts(): Promise<SeedAccount[]> {
  const rows = await db
    .select({
      firstName: users.firstName,
      lastName: users.lastName,
      email: users.email,
      createdAt: users.createdAt,
      hasProfile: sql<boolean>`${profiles.userId} IS NOT NULL`,
      age: profiles.age,
      city: profiles.city,
      homepageUrl: profiles.homepageUrl,
      method: signatures.method,
      signedAt: signatures.createdAt,
    })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .leftJoin(signatures, eq(signatures.userId, users.id))
    .orderBy(sql`${signatures.createdAt} NULLS FIRST`, asc(users.id));
  return rows.map((row) => ({
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    createdAt: row.createdAt,
    profile: row.hasProfile ? { age: row.age, city: row.city, homepageUrl: row.homepageUrl } : null,
    signature: row.method === null || row.signedAt === null ? null : { method: row.method, signedAt: row.signedAt },
  }));
}

/** The supporters total of one city, with the case-insensitive match of the supporters query (ADR 0006, 0007). */
async function supportersIn(city: string): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(signatures)
    .innerJoin(profiles, eq(profiles.userId, signatures.userId))
    .where(sql`lower(${profiles.city} COLLATE "pg_c_utf8") = lower(${city} COLLATE "pg_c_utf8")`);
  return row?.count ?? 0;
}

async function imageSize(png: Buffer): Promise<{ width: number; height: number }> {
  const image = await loadImage(png);
  return { width: image.width, height: image.height };
}

describe('seed data (DATA-MODEL.md section 6)', () => {
  it('F-01: one unsigned demo account and 64 supporters with unique, ASCII-folded @petition.test addresses', () => {
    expect(SEED_SUPPORTERS).toHaveLength(64);
    expect(SEED_ACCOUNTS).toEqual([DEMO_ACCOUNT, ...SEED_SUPPORTERS]);
    expect(DEMO_ACCOUNT).toMatchObject({
      firstName: 'Mara',
      lastName: 'Lindholm',
      email: 'demo@petition.test',
      profile: { age: 31, city: 'Leipzig', homepageUrl: null },
      signature: null,
    });
    const emails = SEED_ACCOUNTS.map((account) => account.email);
    expect(new Set(emails).size).toBe(emails.length);
    for (const email of emails) expect(email).toMatch(/^[a-z]+(\.[a-z]+)?@petition\.test$/);
    expect(emails).toEqual(
      expect.arrayContaining([
        'lena.hartmann@petition.test',
        'hanna.weiss@petition.test',
        'elif.sahin@petition.test',
        'thanh.nguyen@petition.test',
        'selin.yildiz@petition.test',
        'zofia.wisniewska@petition.test',
        'piotr.zielinski@petition.test',
        'tereza.horakova@petition.test',
      ]),
    );
  });

  it('F-01: ASCII folding refuses a name it cannot fold instead of writing an invalid address', () => {
    expect(asciiFold('Weiß')).toBe('weiss');
    expect(asciiFold('Şahin')).toBe('sahin');
    expect(() => asciiFold('李')).toThrow('cannot fold');
    expect(() => asciiFold('Anne-Marie')).toThrow('cannot fold');
  });

  it('F-01, B-30, F-52: profiles as documented: six supporters without a row, homepages only on .example', () => {
    expect(SEED_SUPPORTERS.filter((account) => account.profile === null).map((account) => account.lastName)).toEqual([
      'Wagner',
      'Schulz',
      'Braun',
      'Klein',
      'Lorenz',
      'Hansen',
    ]);
    const homepages = SEED_ACCOUNTS.flatMap((account) => account.profile?.homepageUrl ?? []);
    expect(homepages).toHaveLength(11);
    for (const homepage of homepages) expect(homepage).toMatch(/^https:\/\/[a-z-]+\.example\/$/);
    const cities = (city: string) => SEED_SUPPORTERS.filter((account) => account.profile?.city === city).length;
    expect(cities('Berlin')).toBe(8);
    expect(cities('Leipzig')).toBe(5);
    expect(SEED_SUPPORTERS.filter((account) => account.signature?.method === 'typed')).toHaveLength(31);
  });

  it('F-01, F-19, F-35: every value is one the app itself would store (the shared field rules keep it unchanged)', () => {
    for (const account of SEED_ACCOUNTS) {
      expect(firstNameField.parse(account.firstName)).toBe(account.firstName);
      expect(lastNameField.parse(account.lastName)).toBe(account.lastName);
      if (account.profile === null) continue;
      const { age, city, homepageUrl } = account.profile;
      expect(optionalAge.parse(age === null ? '' : String(age))).toBe(age);
      expect(optionalCity.parse(city ?? '')).toBe(city);
      expect(optionalHomepage.parse(homepageUrl ?? '')).toBe(homepageUrl);
    }
  });

  it('F-01: fixed signing times from 2 Sep 2026, each account created 5 to 40 minutes before its signature', () => {
    const signedAt = SEED_SUPPORTERS.map((account) => account.signature?.signedAt.toISOString());
    expect(signedAt[0]).toBe('2026-09-02T08:14:00.000Z');
    expect(signedAt[1]).toBe('2026-09-03T09:51:00.000Z');
    // 2 Sep + 63 x 25 h + 171 min, the end date DATA-MODEL.md section 6 names.
    expect(signedAt[63]).toBe('2026-11-07T02:05:00.000Z');
    expect([...signedAt].sort()).toEqual(signedAt);
    for (const account of SEED_SUPPORTERS) {
      const lead = ((account.signature?.signedAt.getTime() ?? 0) - account.createdAt.getTime()) / 60_000;
      expect(lead).toBeGreaterThanOrEqual(5);
      expect(lead).toBeLessThanOrEqual(40);
    }
    expect(DEMO_ACCOUNT.createdAt.getTime()).toBeLessThan(SEED_SUPPORTERS[0]?.createdAt.getTime() ?? 0);
  });
});

describe('renderGeneratedSignature', () => {
  it('F-42, ADR 0004: draws a 720 x 240 PNG that the production validator accepts', async () => {
    const png = await renderGeneratedSignature('Jonas Becker');

    expect(png.subarray(0, 8)).toEqual(PNG_MAGIC);
    expect(await imageSize(png)).toEqual({ width: 720, height: 240 });
    const result = await images.validateDrawnSignature(`data:image/png;base64,${png.toString('base64')}`);
    expect(result.ok).toBe(true);
  });

  it('F-01: is deterministic per name and differs between names', async () => {
    const first = await renderGeneratedSignature('Aylin Demir');
    const again = await renderGeneratedSignature('Aylin Demir');
    const other = await renderGeneratedSignature('Giulia Romano');

    expect(again.equals(first)).toBe(true);
    expect(other.equals(first)).toBe(false);
  });
});

describe('assertSeedAllowed', () => {
  it.each([undefined, '', 'TRUE', 'True', '1', 'yes', ' true', 'true '])(
    'F-01, ADR 0016: refuses with SEED_ALLOW=%j',
    (value) => {
      expect(() => {
        assertSeedAllowed({ SEED_ALLOW: value, NODE_ENV: 'development' });
      }).toThrow('seeding is disabled: set SEED_ALLOW=true');
    },
  );

  it('F-01, ADR 0019 §7: allows exactly SEED_ALLOW=true, whatever NODE_ENV is', () => {
    for (const NODE_ENV of ['production', 'development', 'test', undefined]) {
      expect(() => {
        assertSeedAllowed({ SEED_ALLOW: 'true', NODE_ENV });
      }).not.toThrow();
    }
  });
});

describe('parseSeedEnv', () => {
  const valid = { DATABASE_URL: 'postgres://user:pass@127.0.0.1:5432/petition', SEED_DEMO_PASSWORD: DEMO_PASSWORD };

  it('ADR 0019 §7: accepts a database URL and a 12+ character password; NODE_ENV defaults to development', () => {
    expect(parseSeedEnv(valid)).toEqual({ ok: true, env: { ...valid, NODE_ENV: 'development' } });
  });

  it('F-72, ADR 0011: names the failing keys and rules, never a value', () => {
    const parsed = parseSeedEnv({
      DATABASE_URL: 'mysql://secret-host/db',
      SEED_DEMO_PASSWORD: 'short-pw',
      NODE_ENV: '',
    });

    expect(parsed).toEqual({
      ok: false,
      problems: [
        'DATABASE_URL: must be a postgres:// or postgresql:// URL',
        'SEED_DEMO_PASSWORD: Password must be at least 12 characters',
      ],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/secret-host|short-pw/);
  });

  it('ADR 0019 §7: an empty SEED_DEMO_PASSWORD counts as missing', () => {
    expect(parseSeedEnv({ ...valid, SEED_DEMO_PASSWORD: '' })).toEqual({
      ok: false,
      problems: ['SEED_DEMO_PASSWORD: is required'],
    });
  });
});

describe('seedDatabase', () => {
  it('F-01, B-60: writes the demo account and the 64 supporters exactly as DATA-MODEL.md section 6 lists them', async () => {
    const log = captureLog();

    const result = await seedDatabase(seedDeps({ logger: log.logger }));

    expect(result).toEqual({ status: 'seeded', written: { users: 65, profiles: 59, signatures: 64 } });
    expect(await storedAccounts()).toEqual([DEMO_ACCOUNT, ...SEED_SUPPORTERS]);
    expect(await supportersIn('berlin')).toBe(8);
    expect(await supportersIn('LEIPZIG')).toBe(5);
    expect(await supportersIn('MÜNCHEN')).toBe(4);
    expect(log.lines).toEqual([
      expect.objectContaining({ level: 30, msg: 'seed.done', written: { users: 65, profiles: 59, signatures: 64 } }),
    ]);
    expect(log.text()).not.toContain('@petition.test');
  });

  it('F-01, F-27: every account logs in with SEED_DEMO_PASSWORD, each hash with its own salt', async () => {
    const hasher = createFakeHasher();

    await seedDatabase(seedDeps({ hasher }));

    const rows = await db.select({ passwordHash: users.passwordHash }).from(users);
    expect(rows).toHaveLength(65);
    expect(hasher.hashCount).toBe(65);
    expect(new Set(rows.map((row) => row.passwordHash)).size).toBe(65);
    for (const { passwordHash } of rows) expect(await hasher.verify(passwordHash, DEMO_PASSWORD)).toBe(true);
  });

  it('F-42, ADR 0004: every stored image is a 720 x 240 PNG that passes the drawn-signature validator', async () => {
    await seedDatabase(seedDeps());

    const rows = await db.select({ image: signatures.image }).from(signatures);
    expect(rows).toHaveLength(64);
    for (const { image } of rows) {
      expect(image.subarray(0, 8)).toEqual(PNG_MAGIC);
      expect(await imageSize(image)).toEqual({ width: 720, height: 240 });
      const revalidated = await images.validateDrawnSignature(`data:image/png;base64,${image.toString('base64')}`);
      expect(revalidated.ok).toBe(true);
    }
  });

  it('F-01: a second run changes nothing and neither hashes nor renders', async () => {
    await seedDatabase(seedDeps());
    const before = await snapshot();
    const hasher = createFakeHasher();
    const loader = countingImages();
    const log = captureLog();

    const result = await seedDatabase(seedDeps({ hasher, loadSignatureImages: loader.load, logger: log.logger }));

    expect(result).toEqual({ status: 'seeded', written: { users: 0, profiles: 0, signatures: 0 } });
    expect(await snapshot()).toEqual(before);
    expect(hasher.hashCount).toBe(0);
    expect(loader.calls()).toBe(0);
    expect(log.lines).toEqual([
      expect.objectContaining({ msg: 'seed.done', written: { users: 0, profiles: 0, signatures: 0 } }),
    ]);
  });

  it('F-01: restores missing rows and edited profiles, and leaves every other row alone', async () => {
    await seedDatabase(seedDeps());
    const lena = 'lena.hartmann@petition.test';
    const jonas = 'jonas.becker@petition.test';
    const [lenaRow] = await db.select().from(users).where(eq(users.email, lena));
    const [jonasRow] = await db.select().from(users).where(eq(users.email, jonas));
    if (lenaRow === undefined || jonasRow === undefined) throw new Error('seed rows missing');
    await db.delete(users).where(eq(users.email, DEMO_EMAIL));
    await db.delete(signatures).where(eq(signatures.userId, jonasRow.id));
    await db.update(profiles).set({ city: 'Bonn', age: 99 }).where(eq(profiles.userId, lenaRow.id));
    const hasher = createFakeHasher();

    const result = await seedDatabase(seedDeps({ hasher }));

    expect(result).toEqual({ status: 'seeded', written: { users: 1, profiles: 2, signatures: 1 } });
    expect(hasher.hashCount).toBe(1);
    expect(await storedAccounts()).toEqual([DEMO_ACCOUNT, ...SEED_SUPPORTERS]);
    const [lenaAfter] = await db.select().from(users).where(eq(users.email, lena));
    expect(lenaAfter).toEqual(lenaRow);
  });

  it('ADR 0019 consequences: an existing seed account keeps its password (the seed only inserts accounts)', async () => {
    const existing = await createUser(db, {
      firstName: 'Lena',
      lastName: 'Hartmann',
      email: 'lena.hartmann@petition.test',
      password: 'an older demo password',
    });

    const result = await seedDatabase(seedDeps());

    expect(result).toMatchObject({ status: 'seeded', written: { users: 64 } });
    const [after] = await db.select().from(users).where(eq(users.id, existing.id));
    expect(after?.passwordHash).toBe(existing.passwordHash);
  });

  it('F-01: other @petition.test accounts (e2e registrations) do not stop the seed', async () => {
    await createUser(db, { email: 'e2e-someone@petition.test' });

    const result = await seedDatabase(seedDeps());

    expect(result).toMatchObject({ status: 'seeded', written: { users: 65 } });
  });

  it.each(['someone@example.com', 'someone@sub.petition.test', 'someone@petition.test.example'])(
    'ADR 0019 §7, B-60: skips, writes nothing and logs seed.skipped when %s exists',
    async (email) => {
      const foreign = await createUser(db, { email });
      const before = await snapshot();
      const hasher = createFakeHasher();
      const loader = countingImages();
      const log = captureLog();

      const result = await seedDatabase(seedDeps({ hasher, loadSignatureImages: loader.load, logger: log.logger }));

      expect(result).toEqual({ status: 'skipped', reason: 'foreign-users' });
      expect(await snapshot()).toEqual(before);
      expect(before.users.map((row) => row.id)).toEqual([foreign.id]);
      expect(hasher.hashCount).toBe(0);
      expect(loader.calls()).toBe(0);
      expect(log.lines).toEqual([expect.objectContaining({ level: 40, msg: 'seed.skipped', reason: 'foreign-users' })]);
      expect(log.text()).not.toContain(email);
    },
  );

  it('ADR 0019 §7: a registration after the first seed makes the next run skip without touching the demo data', async () => {
    await seedDatabase(seedDeps());
    await createUser(db, { email: 'reviewer@example.org' });
    const before = await snapshot();

    const result = await seedDatabase(seedDeps());

    expect(result).toEqual({ status: 'skipped', reason: 'foreign-users' });
    expect(await snapshot()).toEqual(before);
  });

  it('F-01: one transaction: a failing insert leaves the database as it was', async () => {
    // A validator that accepts but hands back bytes the signatures_image_png_chk constraint rejects: the users and
    // profiles inserted before it in the same transaction must be rolled back.
    const broken: SignatureImages = {
      ...images,
      validateDrawnSignature: () => Promise.resolve({ ok: true, png: Buffer.alloc(100, 1) }),
    };

    await expect(seedDatabase(seedDeps({ loadSignatureImages: () => broken }))).rejects.toThrow();

    expect(await snapshot()).toEqual({ users: [], profiles: [], signatures: [] });
  });

  it('F-42: a generated image the validator rejects stops the seed before anything is written', async () => {
    const rejecting: SignatureImages = {
      ...images,
      validateDrawnSignature: () =>
        Promise.resolve({ ok: false, reason: 'blank', message: 'Please sign before submitting' }),
    };

    await expect(seedDatabase(seedDeps({ loadSignatureImages: () => rejecting }))).rejects.toThrow(
      'the generated signature of account #1 was rejected (blank)',
    );
    expect(await snapshot()).toEqual({ users: [], profiles: [], signatures: [] });
  });
});

describe('runSeed', () => {
  const env = () => ({
    SEED_ALLOW: 'true',
    DATABASE_URL: currentDatabaseUrl(),
    SEED_DEMO_PASSWORD: DEMO_PASSWORD,
    NODE_ENV: 'production',
  });

  async function run(source: Record<string, string | undefined>) {
    const err: string[] = [];
    const log = captureLog();
    const code = await runSeed(source, {
      logger: log.logger,
      err: (line) => err.push(line),
      loadSignatureImages: () => images,
    });
    return { code, err, log };
  }

  it('F-01, ADR 0016: refuses without SEED_ALLOW=true and writes nothing', async () => {
    const { code, err } = await run({ ...env(), SEED_ALLOW: undefined });

    expect(code).toBe(1);
    expect(err).toEqual(['seed: seeding is disabled: set SEED_ALLOW=true for this invocation (pnpm db:seed does)']);
    expect(await snapshot()).toEqual({ users: [], profiles: [], signatures: [] });
  });

  it('ADR 0019 §7: refuses an invalid configuration, naming keys only', async () => {
    const { code, err } = await run({ ...env(), SEED_DEMO_PASSWORD: 'tooshort' });

    expect(code).toBe(1);
    expect(err).toEqual([
      'seed: invalid configuration:\n  - SEED_DEMO_PASSWORD: Password must be at least 12 characters',
    ]);
    expect(err.join('\n')).not.toContain('tooshort');
    expect(await snapshot()).toEqual({ users: [], profiles: [], signatures: [] });
  });

  it('F-01, F-27, ADR 0009: seeds with real argon2id hashes, so the demo login works with SEED_DEMO_PASSWORD', async () => {
    const { code, err } = await run(env());

    expect(err).toEqual([]);
    expect(code).toBe(0);
    const [demo] = await db.select().from(users).where(eq(users.email, DEMO_EMAIL));
    expect(demo?.passwordHash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(await argon2.verify(demo?.passwordHash ?? '', DEMO_PASSWORD)).toBe(true);
    expect(await argon2.verify(demo?.passwordHash ?? '', 'another password')).toBe(false);
    expect(await db.$count(signatures)).toBe(64);
  }, 120_000);

  it('F-01, B-12: a database failure exits 1 with a generic message and logs no seed data', async () => {
    const missing = new URL(currentDatabaseUrl());
    missing.pathname = '/no_such_database';

    const { code, err, log } = await run({ ...env(), DATABASE_URL: missing.toString() });

    expect(code).toBe(1);
    expect(err).toEqual(['seed: failed; nothing was written (the log line above has the cause).']);
    expect(log.lines).toEqual([expect.objectContaining({ level: 50, msg: 'seed failed' })]);
    expect(log.text()).not.toContain(DEMO_PASSWORD);
  });
});

describe('entry point (`pnpm db:seed`, `node dist/tools/seed.js`)', () => {
  /** Runs the entry exactly as the compose service does, with only the given variables. */
  function runEntry(env: Record<string, string>) {
    return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', ENTRY], {
        cwd: REPO_ROOT,
        env: { PATH: process.env['PATH'] ?? '', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });
  }

  it('F-01, ADR 0016: without SEED_ALLOW the process exits 1 and writes nothing', async () => {
    const result = await runEntry({
      DATABASE_URL: currentDatabaseUrl(),
      SEED_DEMO_PASSWORD: DEMO_PASSWORD,
      NODE_ENV: 'production',
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      'seed: seeding is disabled: set SEED_ALLOW=true for this invocation (pnpm db:seed does)\n',
    );
    expect(await snapshot()).toEqual({ users: [], profiles: [], signatures: [] });
  }, 30_000);

  it('ADR 0019 §7: with a foreign user the process logs seed.skipped and exits 0, so `pnpm demo` can start again', async () => {
    await createUser(db, { email: 'registered@example.com' });

    const result = await runEntry({
      SEED_ALLOW: 'true',
      DATABASE_URL: currentDatabaseUrl(),
      SEED_DEMO_PASSWORD: DEMO_PASSWORD,
      NODE_ENV: 'production',
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    const lines = result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toEqual([expect.objectContaining({ level: 40, msg: 'seed.skipped', reason: 'foreign-users' })]);
    expect(await db.$count(users)).toBe(1);
  }, 30_000);
});
