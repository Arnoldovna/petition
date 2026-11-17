/**
 * Demo data (`pnpm db:seed`, compose one-shot `seed` in the `demo` and `e2e` profiles; DATA-MODEL.md section 6, F-01,
 * B-60, ADR 0016, ADR 0019 §7): the demo account and 64 supporters of `seed-data.ts`.
 *
 *   SEED_ALLOW=true        required for every invocation, whatever NODE_ENV is; never an .env key
 *   SEED_DEMO_PASSWORD     required, 12 to 128 characters (the password rule of registration); shared by every seed
 *                          account, so `pnpm demo` can print one login
 *   DATABASE_URL           required
 *   NODE_ENV               picks the signature font folder: dist/signature-fonts (production, the image) or
 *                          .dev/signature-fonts (`pnpm assets:fonts .dev`, also run by `pnpm dev`)
 *
 * In a built image there is no pnpm: `node dist/tools/seed.js` with the variables above.
 *
 * Behaviour:
 * - When `users` holds any email outside `@petition.test`, nothing is written: the run logs
 *   `seed.skipped {reason: 'foreign-users'}` and exits 0, so a second `pnpm demo` or `pnpm dev:setup` after a real
 *   registration still succeeds and a real database never gets accounts with a shared password (ADR 0019 §7).
 * - Idempotent and insert-only for accounts: users `ON CONFLICT DO NOTHING` (an existing account keeps its password),
 *   profiles upserted back to the seed values, signatures `ON CONFLICT (user_id) DO NOTHING`. A second run writes
 *   nothing, hashes nothing and renders nothing.
 * - All writes happen in one transaction; a failure leaves the database as it was.
 * - Signature PNGs are generated with the production code paths (typed: `renderTypedSignature`; drawn:
 *   `renderGeneratedSignature`) and every one passes `validateDrawnSignature` before it is stored.
 *
 * Exit codes: 0 seeded or skipped; 1 refused without `SEED_ALLOW=true`, invalid configuration, or a failure. Output
 * names configuration keys and counts only, never a value or an address (ADR 0011).
 */
import { eq, inArray, notLike, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';

import { assetMode, resolvePaths } from '../config/paths.js';
import { createDatabase, type Database, type DatabaseTransaction } from '../db/client.js';
import { profiles, signatures, users } from '../db/schema/index.js';
import { createSignatureImages, signatureFontPaths, type SignatureImages } from '../features/signature/index.js';
import { createHasher, type PasswordHasher } from '../shared/auth/password.js';
import { createLogger } from '../shared/logging/logger.js';
import { newPassword } from '../shared/validation/fields.js';
import { SEED_ACCOUNTS, SEED_EMAIL_DOMAIN, type SeedAccount } from './seed-data.js';
import { renderGeneratedSignature } from './seed-signatures.js';

/**
 * Seeding needs `SEED_ALLOW=true` set explicitly for the invocation, whatever NODE_ENV is (conventions §8): the
 * production image runs the seed with NODE_ENV=production, so NODE_ENV can never be the switch. `SEED_ALLOW` is never
 * an .env key. The message names the variable, never a value.
 */
export function assertSeedAllowed(env: Readonly<Record<string, string | undefined>>): void {
  if (env['SEED_ALLOW'] !== 'true') {
    throw new Error('seeding is disabled: set SEED_ALLOW=true for this invocation (pnpm db:seed does)');
  }
}

/** What the seed reads besides `SEED_ALLOW`. Tools read the environment directly (ADR 0011). */
const SeedEnvSchema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'must be a postgres:// or postgresql:// URL' }),
  // The registration rule: the demo login must be a password the login form accepts.
  SEED_DEMO_PASSWORD: newPassword,
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

type SeedEnv = z.infer<typeof SeedEnvSchema>;

type ParsedSeedEnv = { ok: true; env: SeedEnv } | { ok: false; problems: string[] };

/**
 * Validates the seed's configuration like `loadEnv` does for the app: empty values count as unset, and the problems
 * name keys and rules only, never a value (the password is a secret).
 */
export function parseSeedEnv(source: Readonly<Record<string, string | undefined>>): ParsedSeedEnv {
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const result = SeedEnvSchema.safeParse(present);
  if (result.success) return { ok: true, env: result.data };
  const problems = result.error.issues.map((issue) => {
    const key = issue.path.map(String).join('.') || '(root)';
    const missing = typeof issue.path[0] === 'string' && present[issue.path[0]] === undefined;
    return `${key}: ${missing ? 'is required' : issue.message}`;
  });
  return { ok: false, problems };
}

export interface SeedDeps {
  db: Database;
  hasher: PasswordHasher;
  /** `SEED_DEMO_PASSWORD`, already validated. */
  demoPassword: string;
  /**
   * Builds the signature image service. Called only when a signature has to be rendered, so a run that finds every
   * row in place needs no fonts.
   */
  loadSignatureImages: () => SignatureImages;
  logger: Logger;
}

/** Rows written by one run: inserted users and signatures, inserted or restored profiles. */
interface SeedCounts {
  users: number;
  profiles: number;
  signatures: number;
}

export type SeedResult = { status: 'skipped'; reason: 'foreign-users' } | { status: 'seeded'; written: SeedCounts };

const SEED_EMAILS = SEED_ACCOUNTS.map((account) => account.email);
const MINUTE_MS = 60_000;

/**
 * True when any account uses an address outside the seed domain. Emails are stored lower-case (`users_email_chk`), so
 * a case-sensitive match is exact; `sub.petition.test` addresses count as foreign.
 */
async function hasForeignUsers(db: Database | DatabaseTransaction): Promise<boolean> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(notLike(users.email, `%@${SEED_EMAIL_DOMAIN}`))
    .limit(1);
  return rows.length > 0;
}

/** The seed accounts that already exist, by email, and whether each has a signature. */
async function findSeedAccounts(
  db: Database | DatabaseTransaction,
): Promise<Map<string, { id: number; signed: boolean }>> {
  const rows = await db
    .select({ id: users.id, email: users.email, signed: sql<boolean>`${signatures.userId} IS NOT NULL` })
    .from(users)
    .leftJoin(signatures, eq(signatures.userId, users.id))
    .where(inArray(users.email, SEED_EMAILS));
  return new Map(rows.map(({ id, email, signed }) => [email, { id, signed }]));
}

const toDataUrl = (png: Buffer): string => `data:image/png;base64,${png.toString('base64')}`;

/**
 * The PNG to store for one supporter: rendered with the production code path for its method, then validated exactly
 * like an upload from the pad (ADR 0004), which also re-encodes it. A rejection is a bug in the generator and stops
 * the seed. `index` is the position in `SEED_ACCOUNTS` (the demo account is 0), so supporter #n of the DATA-MODEL.md
 * table is account #n; the name stays out of the message.
 */
async function signatureImage(images: SignatureImages, account: SeedAccount, index: number): Promise<Buffer> {
  const fullName = `${account.firstName} ${account.lastName}`;
  const rendered =
    account.signature?.method === 'typed'
      ? await images.renderTypedSignature(fullName)
      : await renderGeneratedSignature(fullName);
  const result = await images.validateDrawnSignature(toDataUrl(rendered));
  if (!result.ok) {
    throw new Error(`seed: the generated signature of account #${String(index)} was rejected (${result.reason})`);
  }
  return result.png;
}

/**
 * The PNG of every account in `unsigned`, by email. The renderings are independent, so they run concurrently (PNG
 * encoding and decoding happen on the libuv pool). Every one settles before anything is reported, so a rejection
 * names the first failing account in seed order, whatever finished first, and no later rejection goes unhandled.
 */
async function renderSignatures(
  images: SignatureImages,
  unsigned: readonly { account: SeedAccount; index: number }[],
): Promise<Map<string, Buffer>> {
  const results = await Promise.allSettled(
    unsigned.map(({ account, index }) => signatureImage(images, account, index)),
  );
  const rendered = new Map<string, Buffer>();
  for (const [position, result] of results.entries()) {
    if (result.status === 'rejected') throw result.reason;
    const entry = unsigned[position];
    if (entry !== undefined) rendered.set(entry.account.email, result.value);
  }
  return rendered;
}

/** Profiles are created two minutes after the account, always before its signature (at least five minutes later). */
const profileCreatedAt = (account: SeedAccount): Date => new Date(account.createdAt.getTime() + 2 * MINUTE_MS);

/**
 * Writes the seed content (see the file comment). Expensive work (argon2id hashes, rendering) happens before the
 * transaction and only for rows that are missing; the transaction checks for foreign users again and then inserts.
 */
export async function seedDatabase(deps: SeedDeps): Promise<SeedResult> {
  const { db, hasher, logger } = deps;
  const skipped = (): SeedResult => {
    logger.warn({ reason: 'foreign-users' }, 'seed.skipped');
    return { status: 'skipped', reason: 'foreign-users' };
  };
  if (await hasForeignUsers(db)) return skipped();

  const existing = await findSeedAccounts(db);
  const newAccounts = SEED_ACCOUNTS.filter((account) => !existing.has(account.email));
  // One hash per account, each with its own salt. The bounded hasher queues them (ADR 0009).
  const newUserRows = await Promise.all(
    newAccounts.map(async (account) => ({
      firstName: account.firstName,
      lastName: account.lastName,
      email: account.email,
      passwordHash: await hasher.hash(deps.demoPassword),
      createdAt: account.createdAt,
      updatedAt: account.createdAt,
    })),
  );

  const unsigned = SEED_ACCOUNTS.flatMap((account, index) =>
    account.signature !== null && existing.get(account.email)?.signed !== true ? [{ account, index }] : [],
  );
  const images =
    unsigned.length === 0 ? new Map<string, Buffer>() : await renderSignatures(deps.loadSignatureImages(), unsigned);

  const outcome = await db.transaction(async (tx): Promise<SeedCounts | undefined> => {
    // Someone may have registered while the images rendered; checked again before the first write.
    if (await hasForeignUsers(tx)) return undefined;

    const insertedUsers =
      newUserRows.length === 0
        ? []
        : await tx
            .insert(users)
            .values(newUserRows)
            // The unique index on lower(email): an account created since the lookup keeps its row and password.
            .onConflictDoNothing()
            .returning({ id: users.id });

    const ids = await findSeedAccounts(tx);
    const withId = <T extends { account: SeedAccount }>(entries: T[]) =>
      entries.flatMap((entry) => {
        const id = ids.get(entry.account.email)?.id;
        return id === undefined ? [] : [{ ...entry, userId: id }];
      });

    const profileRows = withId(SEED_ACCOUNTS.map((account) => ({ account }))).flatMap(({ account, userId }) => {
      if (account.profile === null) return [];
      const createdAt = profileCreatedAt(account);
      return [{ userId, ...account.profile, createdAt, updatedAt: createdAt }];
    });
    const writtenProfiles =
      profileRows.length === 0
        ? []
        : await tx
            .insert(profiles)
            .values(profileRows)
            .onConflictDoUpdate({
              target: profiles.userId,
              // `excluded` holds the proposed row; its columns are the snake_case names of the migration.
              set: {
                age: sql`excluded.age`,
                city: sql`excluded.city`,
                homepageUrl: sql`excluded.homepage_url`,
                updatedAt: sql`now()`,
              },
              // Only a profile that differs from the seed is restored, so a second run updates nothing.
              setWhere: sql`(${profiles.age}, ${profiles.city}, ${profiles.homepageUrl}) IS DISTINCT FROM (excluded.age, excluded.city, excluded.homepage_url)`,
            })
            .returning({ userId: profiles.userId });

    const signatureRows = withId(unsigned).flatMap(({ account, userId }) => {
      const image = images.get(account.email);
      return image === undefined || account.signature === null
        ? []
        : [{ userId, method: account.signature.method, image, createdAt: account.signature.signedAt }];
    });
    const insertedSignatures =
      signatureRows.length === 0
        ? []
        : await tx
            .insert(signatures)
            .values(signatureRows)
            .onConflictDoNothing({ target: signatures.userId })
            .returning({ id: signatures.id });

    return {
      users: insertedUsers.length,
      profiles: writtenProfiles.length,
      signatures: insertedSignatures.length,
    };
  });

  if (outcome === undefined) return skipped();
  logger.info({ written: outcome }, 'seed.done');
  return { status: 'seeded', written: outcome };
}

/** The image service for the font folder of `nodeEnv`, with a hint when the fonts have not been copied yet. */
function signatureImagesFor(nodeEnv: SeedEnv['NODE_ENV']): () => SignatureImages {
  return () => {
    const directory = resolvePaths(assetMode(nodeEnv)).signatureFontsDir;
    try {
      return createSignatureImages({ fontPaths: signatureFontPaths(directory) });
    } catch (error) {
      throw new Error(
        `cannot load the signature fonts from ${directory}: run \`pnpm assets:fonts .dev\` (development) or ` +
          '`pnpm build` (production) first',
        { cause: error },
      );
    }
  };
}

interface CliDeps {
  logger: Logger;
  /** Refusals and errors (stderr). Results are log lines (stdout). */
  err: (line: string) => void;
  /** Replaces the font folder of NODE_ENV (tests resolve the fonts from node_modules). */
  loadSignatureImages?: () => SignatureImages;
}

/** The command line behaviour; returns the exit code. */
export async function runSeed(source: Readonly<Record<string, string | undefined>>, deps: CliDeps): Promise<number> {
  try {
    assertSeedAllowed(source);
  } catch (error) {
    deps.err(`seed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const parsed = parseSeedEnv(source);
  if (!parsed.ok) {
    deps.err(`seed: invalid configuration:\n  - ${parsed.problems.join('\n  - ')}`);
    return 1;
  }

  const { env } = parsed;
  const database = createDatabase(env.DATABASE_URL, { logger: deps.logger });
  try {
    await seedDatabase({
      db: database.db,
      // Two argon2id hashes at a time as in the app (ADR 0009), and a queue that holds every seed account.
      hasher: createHasher({ maxConcurrent: 2, maxQueue: SEED_ACCOUNTS.length }),
      demoPassword: env.SEED_DEMO_PASSWORD,
      loadSignatureImages: deps.loadSignatureImages ?? signatureImagesFor(env.NODE_ENV),
      logger: deps.logger,
    });
    return 0;
  } catch (error) {
    // The logger strips bound query values from database errors (B-12), so no seed row reaches the output.
    deps.logger.error({ err: error }, 'seed failed');
    deps.err('seed: failed; nothing was written (the log line above has the cause).');
    return 1;
  } finally {
    await database.close();
  }
}

if (import.meta.main) {
  process.exitCode = await runSeed(process.env, {
    // JSON lines whatever NODE_ENV is: `seed.done` and `seed.skipped` are what `pnpm demo` and CI logs show.
    logger: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'production' }),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
