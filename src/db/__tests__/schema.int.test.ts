import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentDatabaseUrl } from '../../../test/database.js';
import { createDatabase, type Database, type DatabaseHandle } from '../client.js';
import { profiles, signatures, users } from '../schema/index.js';

/**
 * DATA-MODEL.md sections 2, 3 and 5: every named constraint fires on a violating row inserted straight through Drizzle
 * (the database is the backstop behind Zod), cascades remove owned rows, and the city lookup matches across case with
 * `pg_c_utf8`. The file's own database is a clone of the migrated template, so this also proves 0000_init.sql applies.
 */

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Only the magic number and the size are the database's business; the full PNG check is ADR 0004's pipeline. */
const pngBytes = (size: number) => Buffer.concat([PNG_MAGIC, Buffer.alloc(size - PNG_MAGIC.length, 1)]);
const ARGON2ID_HASH = '$argon2id$v=19$m=65536,t=3,p=4$c29tZXNhbHQ$aGFzaGhhc2hoYXNoaGFzaA';

interface PgErrorFields {
  code?: unknown;
  constraint?: unknown;
  column?: unknown;
}

/** The node-postgres error behind Drizzle's wrapper (DrizzleQueryError keeps it as `cause`). */
function pgError(error: unknown): PgErrorFields {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string') return current;
    current = 'cause' in current ? current.cause : undefined;
  }
  throw new Error('no PostgreSQL error in the cause chain', { cause: error });
}

async function violation(statement: PromiseLike<unknown>): Promise<PgErrorFields> {
  try {
    await statement;
  } catch (error) {
    return pgError(error);
  }
  throw new Error('expected the statement to violate a constraint');
}

const CHECK = '23514';
const UNIQUE = '23505';
const FOREIGN_KEY = '23503';
const NOT_NULL = '23502';
const INVALID_ENUM = '22P02';

describe('database schema (0000_init)', () => {
  let handle: DatabaseHandle;
  let db: Database;
  let emailCounter = 0;

  const validUser = (overrides: Partial<typeof users.$inferInsert> = {}): typeof users.$inferInsert => ({
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: `user${String(++emailCounter)}@petition.test`,
    passwordHash: ARGON2ID_HASH,
    ...overrides,
  });

  async function insertUser(overrides: Partial<typeof users.$inferInsert> = {}): Promise<number> {
    const [row] = await db.insert(users).values(validUser(overrides)).returning({ id: users.id });
    if (row === undefined) throw new Error('insert returned no row');
    return row.id;
  }

  beforeAll(() => {
    handle = createDatabase(currentDatabaseUrl());
    db = handle.db;
  });

  afterAll(async () => {
    await handle.close();
  });

  describe('users', () => {
    it('F-02, F-27: stores a valid account with defaults for session version and timestamps', async () => {
      const id = await insertUser({ firstName: 'Thanh', lastName: 'Nguyễn' });

      const [row] = await db.select().from(users).where(eq(users.id, id));

      expect(row).toMatchObject({ firstName: 'Thanh', lastName: 'Nguyễn', sessionVersion: 0 });
      expect(row?.createdAt).toBeInstanceOf(Date);
      expect(row?.updatedAt).toBeInstanceOf(Date);
    });

    it.each([
      ['leading space', ' Ada'],
      ['trailing space', 'Ada '],
      ['empty', ''],
      ['longer than 100 characters', 'A'.repeat(101)],
      ['a control character', 'Ada\u0007'],
      ['a newline', 'Ada\nLovelace'],
    ])('F-02, F-19, B-61: users_first_name_chk rejects a first name with %s', async (_case, firstName) => {
      const error = await violation(db.insert(users).values(validUser({ firstName })));

      expect(error).toMatchObject({ code: CHECK, constraint: 'users_first_name_chk' });
    });

    it.each([
      ['leading space', ' Lovelace'],
      ['empty', ''],
      ['longer than 100 characters', 'L'.repeat(101)],
      ['a control character', 'Love\u001blace'],
    ])('F-02, F-19, B-61: users_last_name_chk rejects a last name with %s', async (_case, lastName) => {
      const error = await violation(db.insert(users).values(validUser({ lastName })));

      expect(error).toMatchObject({ code: CHECK, constraint: 'users_last_name_chk' });
    });

    it('F-02, B-61: accepts names of exactly 1 and 100 characters', async () => {
      await expect(insertUser({ firstName: 'A', lastName: 'L'.repeat(100) })).resolves.toBeTypeOf('number');
    });

    it.each([
      ['upper case', 'Ada@Example.com'],
      ['surrounding whitespace', ' ada@example.com'],
      ['no @', 'ada.example.com'],
      ['@ as the first character', '@example.com'],
      ['fewer than 3 characters', 'a@'],
      ['more than 254 characters', `${'a'.repeat(243)}@example.com`],
    ])('F-19, B-25, B-61: users_email_chk rejects an email with %s', async (_case, email) => {
      const error = await violation(db.insert(users).values(validUser({ email })));

      expect(error).toMatchObject({ code: CHECK, constraint: 'users_email_chk' });
    });

    it('F-02, F-20, B-25: users_email_lower_idx allows one account per email', async () => {
      await insertUser({ email: 'twice@petition.test' });

      const error = await violation(db.insert(users).values(validUser({ email: 'twice@petition.test' })));

      expect(error).toMatchObject({ code: UNIQUE, constraint: 'users_email_lower_idx' });
    });

    it('F-02, B-25: the unique index is on lower(email), so uniqueness never depends on the stored case', async () => {
      const [index] = await db
        .execute<{ indexdef: string }>(
          sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'users_email_lower_idx'`,
        )
        .then((result) => result.rows);

      expect(index?.indexdef).toMatch(
        /^CREATE UNIQUE INDEX users_email_lower_idx ON public\.users .*\(lower\(email\)\)$/,
      );
    });

    it.each([
      ['a bcrypt hash', '$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDE'],
      ['an argon2i hash', '$argon2i$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA'],
      ['a plain-text password', 'correct horse battery staple'],
    ])('F-27, B-11: users_password_hash_chk rejects %s', async (_case, passwordHash) => {
      const error = await violation(db.insert(users).values(validUser({ passwordHash })));

      expect(error).toMatchObject({ code: CHECK, constraint: 'users_password_hash_chk' });
    });

    it('ADR 0002: users_session_version_chk rejects a negative session version', async () => {
      const error = await violation(db.insert(users).values(validUser({ sessionVersion: -1 })));

      expect(error).toMatchObject({ code: CHECK, constraint: 'users_session_version_chk' });
    });

    it.each(['first_name', 'last_name', 'email', 'password_hash'])('F-02, B-61: %s is NOT NULL', async (column) => {
      const values = {
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: `null-${column}@petition.test`,
        password_hash: ARGON2ID_HASH,
        [column]: null,
      };

      const error = await violation(
        db.execute(
          sql`INSERT INTO users (first_name, last_name, email, password_hash)
                VALUES (${values.first_name}, ${values.last_name}, ${values.email}, ${values.password_hash})`,
        ),
      );

      expect(error).toMatchObject({ code: NOT_NULL, column });
    });

    it('B-61: the id is generated always; a client-chosen id is refused', async () => {
      const error = await violation(
        db.execute(
          sql`INSERT INTO users (id, first_name, last_name, email, password_hash)
              VALUES (424242, 'Ada', 'Lovelace', 'chosen-id@petition.test', ${ARGON2ID_HASH})`,
        ),
      );

      expect(error).toMatchObject({ code: '428C9' });
    });

    it('F-62: an update through Drizzle sets updated_at to the time of the update', async () => {
      const id = await insertUser();

      // $onUpdate stamps the row from the app clock; comparing with the app clock avoids host/container clock skew.
      const started = Date.now();
      await db.update(users).set({ firstName: 'Augusta' }).where(eq(users.id, id));
      const finished = Date.now();
      const [after] = await db.select({ updatedAt: users.updatedAt }).from(users).where(eq(users.id, id));

      expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(started);
      expect(after?.updatedAt.getTime()).toBeLessThanOrEqual(finished);
    });
  });

  describe('profiles', () => {
    it('F-04, F-34: a profile with every optional field NULL is valid, and so is a complete one', async () => {
      const empty = await insertUser();
      const complete = await insertUser();

      await db.insert(profiles).values({ userId: empty });
      await db
        .insert(profiles)
        .values({ userId: complete, age: 120, city: 'Halle (Saale)', homepageUrl: 'https://lena-hartmann.example' });

      const rows = await db
        .select()
        .from(profiles)
        .where(sql`${profiles.userId} IN (${empty}, ${complete})`);
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.userId === empty)).toMatchObject({ age: null, city: null, homepageUrl: null });
    });

    it.each([0, 121, -5])('F-35, B-27: profiles_age_chk rejects age %i', async (age) => {
      const userId = await insertUser();

      const error = await violation(db.insert(profiles).values({ userId, age }));

      expect(error).toMatchObject({ code: CHECK, constraint: 'profiles_age_chk' });
    });

    it.each([
      ['leading space', ' Berlin'],
      ['trailing space', 'Berlin '],
      ['two inner spaces', 'Bad  Homburg'],
      ['an inner tab and space', 'Bad\t Homburg'],
      ['empty', ''],
      ['longer than 100 characters', 'X'.repeat(101)],
    ])('F-35, B-32: profiles_city_chk rejects a city with %s', async (_case, city) => {
      const userId = await insertUser();

      const error = await violation(db.insert(profiles).values({ userId, city }));

      expect(error).toMatchObject({ code: CHECK, constraint: 'profiles_city_chk' });
    });

    it.each([
      ['javascript:', 'javascript:alert(1)'],
      ['ftp:', 'ftp://files.example'],
      ['no scheme', 'example.com'],
      ['whitespace', 'https://exa mple.com'],
      ['more than 300 characters', `https://${'a'.repeat(286)}.example`],
    ])('F-35, B-18: profiles_homepage_url_chk rejects a homepage with %s', async (_case, homepageUrl) => {
      const userId = await insertUser();

      const error = await violation(db.insert(profiles).values({ userId, homepageUrl }));

      expect(error).toMatchObject({ code: CHECK, constraint: 'profiles_homepage_url_chk' });
    });

    it('F-04, B-61: a user has at most one profile (user_id is the primary key)', async () => {
      const userId = await insertUser();
      await db.insert(profiles).values({ userId, age: 30 });

      const error = await violation(db.insert(profiles).values({ userId, age: 31 }));

      expect(error).toMatchObject({ code: UNIQUE, constraint: 'profiles_pkey' });
    });

    it('F-04, B-61: a profile needs an existing user', async () => {
      const error = await violation(db.insert(profiles).values({ userId: 2_000_000_000, age: 30 }));

      expect(error).toMatchObject({ code: FOREIGN_KEY, constraint: 'profiles_user_id_users_id_fk' });
    });
  });

  describe('signatures', () => {
    it('F-03, F-42: stores and returns the PNG bytes unchanged (bytea round trip)', async () => {
      const userId = await insertUser();
      const image = pngBytes(512);

      await db.insert(signatures).values({ userId, method: 'drawn', image });
      const [row] = await db.select().from(signatures).where(eq(signatures.userId, userId));

      expect(row?.method).toBe('drawn');
      expect(Buffer.isBuffer(row?.image)).toBe(true);
      expect(row?.image.equals(image)).toBe(true);
    });

    it('F-03, F-43, B-07, B-49: signatures_user_id_key allows one signature per user', async () => {
      const userId = await insertUser();
      await db.insert(signatures).values({ userId, method: 'typed', image: pngBytes(100) });

      const error = await violation(db.insert(signatures).values({ userId, method: 'drawn', image: pngBytes(100) }));

      expect(error).toMatchObject({ code: UNIQUE, constraint: 'signatures_user_id_key' });
    });

    it('F-43, B-49: the unique user_id supports an idempotent ON CONFLICT (user_id) DO NOTHING insert', async () => {
      const userId = await insertUser();
      const insert = () =>
        db
          .insert(signatures)
          .values({ userId, method: 'drawn', image: pngBytes(100) })
          .onConflictDoNothing({ target: signatures.userId })
          .returning({ id: signatures.id });

      const [first, second] = [await insert(), await insert()];

      expect(first).toHaveLength(1);
      expect(second).toHaveLength(0);
    });

    it('F-03, B-61: a signature needs an existing user', async () => {
      const error = await violation(
        db.insert(signatures).values({ userId: 2_000_000_000, method: 'drawn', image: pngBytes(100) }),
      );

      expect(error).toMatchObject({ code: FOREIGN_KEY, constraint: 'signatures_user_id_users_id_fk' });
    });

    it.each([66, 65_537])('F-42, B-19: signatures_image_size_chk rejects %i bytes', async (size) => {
      const userId = await insertUser();

      const error = await violation(db.insert(signatures).values({ userId, method: 'drawn', image: pngBytes(size) }));

      expect(error).toMatchObject({ code: CHECK, constraint: 'signatures_image_size_chk' });
    });

    it.each([67, 65_536])('F-42: accepts the size limits of %i bytes', async (size) => {
      const userId = await insertUser();

      await expect(
        db.insert(signatures).values({ userId, method: 'drawn', image: pngBytes(size) }),
      ).resolves.toBeDefined();
    });

    it('F-42, B-19: signatures_image_png_chk rejects bytes without the PNG magic number', async () => {
      const userId = await insertUser();
      const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200)]);

      const error = await violation(db.insert(signatures).values({ userId, method: 'drawn', image: jpeg }));

      expect(error).toMatchObject({ code: CHECK, constraint: 'signatures_image_png_chk' });
    });

    it('F-45: the method is the signature_method enum (drawn or typed only)', async () => {
      const userId = await insertUser();

      const error = await violation(
        db.execute(
          sql`INSERT INTO signatures (user_id, method, image) VALUES (${userId}, 'uploaded', ${pngBytes(100)})`,
        ),
      );

      expect(error).toMatchObject({ code: INVALID_ENUM });
    });

    it('F-54, B-31: signatures_created_at_id_idx backs the supporters order (created_at, id)', async () => {
      const [index] = await db
        .execute<{ indexdef: string }>(
          sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'signatures_created_at_id_idx'`,
        )
        .then((result) => result.rows);

      expect(index?.indexdef).toMatch(/\(created_at, id\)$/);
    });
  });

  describe('cascades', () => {
    it('F-06, F-68, B-34: deleting a user deletes their profile and signature, and nothing of other users', async () => {
      const leaving = await insertUser();
      const staying = await insertUser();
      for (const userId of [leaving, staying]) {
        await db.insert(profiles).values({ userId, city: 'Leipzig' });
        await db.insert(signatures).values({ userId, method: 'typed', image: pngBytes(100) });
      }

      const deleted = await db.delete(users).where(eq(users.id, leaving)).returning({ id: users.id });

      expect(deleted).toEqual([{ id: leaving }]);
      expect(await db.select().from(profiles).where(eq(profiles.userId, leaving))).toEqual([]);
      expect(await db.select().from(signatures).where(eq(signatures.userId, leaving))).toEqual([]);
      expect(await db.select().from(profiles).where(eq(profiles.userId, staying))).toHaveLength(1);
      expect(await db.select().from(signatures).where(eq(signatures.userId, staying))).toHaveLength(1);
    });

    it('F-49: deleting a signature leaves the user and the profile in place', async () => {
      const userId = await insertUser();
      await db.insert(profiles).values({ userId, age: 40 });
      await db.insert(signatures).values({ userId, method: 'drawn', image: pngBytes(100) });

      await db.delete(signatures).where(eq(signatures.userId, userId));

      expect(await db.select().from(users).where(eq(users.id, userId))).toHaveLength(1);
      expect(await db.select().from(profiles).where(eq(profiles.userId, userId))).toHaveLength(1);
    });
  });

  describe('city matching with pg_c_utf8 (ADR 0007)', () => {
    /** The supporters lookup expression (DATA-MODEL.md section 4), on both sides of the comparison. */
    const cityMatches = (city: string) =>
      sql`lower(${profiles.city} COLLATE "pg_c_utf8") = lower(${city} COLLATE "pg_c_utf8")`;

    it.each(['München', 'MÜNCHEN', 'münchen', 'mÜnChEn'])(
      'F-05, F-56, F-57, B-32: %s matches the stored city München',
      async (requested) => {
        const userId = await insertUser();
        await db.insert(profiles).values({ userId, city: 'München' });

        const rows = await db
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(sql`${profiles.userId} = ${userId} AND ${cityMatches(requested)}`);

        expect(rows).toEqual([{ userId }]);
      },
    );

    it('F-57, B-32: matching is exact apart from case (no prefix, accent or ß folding)', async () => {
      const userId = await insertUser();
      await db.insert(profiles).values({ userId, city: 'Halle (Saale)' });

      for (const requested of ['Halle', 'Hälle (Saale)', 'Halle (Saale) ']) {
        const rows = await db
          .select({ userId: profiles.userId })
          .from(profiles)
          .where(sql`${profiles.userId} = ${userId} AND ${cityMatches(requested)}`);
        expect(rows, requested).toEqual([]);
      }
    });

    it('F-05, B-61: the lookup uses profiles_city_key_idx (the query expression equals the index expression)', async () => {
      const [index] = await db
        .execute<{ indexdef: string }>(
          sql`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'profiles_city_key_idx'`,
        )
        .then((result) => result.rows);
      expect(index?.indexdef).toContain('lower((city COLLATE pg_c_utf8))');

      const plan = await db.transaction(async (tx) => {
        // Small tables are scanned sequentially; forbid that so the planner shows whether the index applies at all.
        await tx.execute(sql`SET LOCAL enable_seqscan = off`);
        const result = await tx.execute<{ 'QUERY PLAN': string }>(
          sql`EXPLAIN SELECT user_id FROM profiles WHERE ${cityMatches('MÜNCHEN')}`,
        );
        return result.rows.map((row) => row['QUERY PLAN']).join('\n');
      });

      expect(plan).toContain('profiles_city_key_idx');
    });
  });

  describe('migrations', () => {
    const drizzleDir = fileURLToPath(new URL('../../../drizzle', import.meta.url));

    it('B-60: no committed migration drops or truncates anything', () => {
      const files = readdirSync(drizzleDir).filter((name) => name.endsWith('.sql'));

      expect(files).toContain('0000_init.sql');
      for (const file of files) {
        expect(readFileSync(`${drizzleDir}/${file}`, 'utf8'), file).not.toMatch(/\b(DROP|TRUNCATE)\b/i);
      }
    });
  });
});
