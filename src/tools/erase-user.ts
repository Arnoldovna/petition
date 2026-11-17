/**
 * Erasure on request without the password (F-91, ADR 0013, ADR 0016): deletes one account together with its profile
 * and signature, with the same single `DELETE FROM users` and foreign-key cascade as `POST /account/delete`.
 *
 *   pnpm admin:erase -- --email <address>             preview: prints the user id and what would be deleted, deletes
 *                                                      nothing and exits 1
 *   pnpm admin:erase -- --email <address> --confirm   deletes in one transaction and logs `account.erased {userId}`
 *
 * In a built image there is no pnpm: `node dist/tools/erase-user.js --email <address> --confirm` with DATABASE_URL set.
 * The operator first verifies that the request comes from the address's owner (ADR 0016). Sessions of the erased user
 * become guests on their next request, because the viewer lookup finds no user (ADR 0002).
 *
 * Exit codes: 0 erased; 1 refused without `--confirm`, no matching account, invalid arguments or a database error.
 * Output never contains the email address or any other personal data, only the user id (ADR 0011).
 */
import { parseArgs } from 'node:util';

import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';

import { createDatabase, type Database, type DatabaseTransaction } from '../db/client.js';
import { profiles, signatures, users } from '../db/schema/index.js';
import { createLogger } from '../shared/logging/logger.js';
import { email as emailField } from '../shared/validation/fields.js';

const USAGE = 'usage: pnpm admin:erase -- --email <address> [--confirm]';

interface EraseRequest {
  /** Normalised like every stored email (trimmed, lower-cased, ADR 0007). */
  email: string;
  confirm: boolean;
}

type ParsedArgs = { ok: true; request: EraseRequest } | { ok: false; message: string };

/**
 * Reads `--email <address>` and `--confirm`. A leading `--` is dropped: `pnpm admin:erase -- --email ...` forwards it,
 * and `parseArgs` would otherwise treat everything after it as positionals. The address goes through the same `email`
 * field rule as registration, so `' Ada@Example.com '` finds `ada@example.com`.
 */
export function parseEraseArgs(argv: readonly string[]): ParsedArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let parsedArgs: { values: { email?: string | undefined; confirm?: boolean | undefined }; positionals: string[] };
  try {
    parsedArgs = parseArgs({
      args,
      options: { email: { type: 'string' }, confirm: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: true,
    });
  } catch {
    // Node's messages quote the offending argument, which may be a mistyped address: report the rule instead.
    return { ok: false, message: 'unknown option or missing value (allowed: --email <address>, --confirm)' };
  }

  const { values, positionals } = parsedArgs;
  if (positionals.length > 0) return { ok: false, message: 'unexpected argument (pass the address with --email)' };
  if (values.email === undefined) return { ok: false, message: '--email <address> is required' };
  const parsed = emailField.safeParse(values.email);
  // The field message, never the value: the address is personal data.
  if (!parsed.success) return { ok: false, message: `--email: ${parsed.error.issues[0]?.message ?? 'invalid'}` };
  return { ok: true, request: { email: parsed.data, confirm: values.confirm === true } };
}

/** What an erasure removes. Ids and flags only, so it can be printed and logged. */
interface AccountSummary {
  userId: number;
  hasProfile: boolean;
  hasSignature: boolean;
}

export type EraseOutcome =
  | { status: 'not-found' }
  | { status: 'unconfirmed'; account: AccountSummary }
  | { status: 'erased'; account: AccountSummary };

/**
 * The account with this (normalised) email and whether it has a profile and a signature. `lower(email)` uses the
 * `users_email_lower_idx` index (ADR 0007). With `lock`, the user row stays locked until the transaction ends, so the
 * summary that is printed is the one that gets deleted.
 */
async function findAccount(
  db: Database | DatabaseTransaction,
  email: string,
  { lock }: { lock: boolean },
): Promise<AccountSummary | undefined> {
  const query = db
    .select({
      userId: users.id,
      hasProfile: sql<boolean>`${profiles.userId} IS NOT NULL`,
      hasSignature: sql<boolean>`${signatures.userId} IS NOT NULL`,
    })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .leftJoin(signatures, eq(signatures.userId, users.id))
    .where(sql`lower(${users.email}) = ${email}`);
  // Only the users row: PostgreSQL refuses FOR UPDATE on the nullable side of an outer join.
  const [row] = lock ? await query.for('update', { of: users }) : await query;
  return row;
}

/**
 * Looks the account up and, only with `confirm`, deletes it: one `DELETE FROM users` inside a transaction, the
 * foreign keys cascade to `profiles` and `signatures` (ADR 0013). Logs `account.erased {userId}` after the commit.
 */
export async function eraseUser(db: Database, request: EraseRequest, logger: Logger): Promise<EraseOutcome> {
  if (!request.confirm) {
    const account = await findAccount(db, request.email, { lock: false });
    return account === undefined ? { status: 'not-found' } : { status: 'unconfirmed', account };
  }

  const outcome = await db.transaction(async (tx): Promise<EraseOutcome> => {
    const account = await findAccount(tx, request.email, { lock: true });
    if (account === undefined) return { status: 'not-found' };
    await tx.delete(users).where(eq(users.id, account.userId));
    return { status: 'erased', account };
  });
  if (outcome.status === 'erased') logger.info({ userId: outcome.account.userId }, 'account.erased');
  return outcome;
}

function describeRows({ hasProfile, hasSignature }: AccountSummary): string {
  return ['account', ...(hasProfile ? ['profile'] : []), ...(hasSignature ? ['signature'] : [])].join(', ');
}

interface CliDeps {
  /** `process.env['DATABASE_URL']`; tools read the environment directly (ADR 0011). */
  databaseUrl: string | undefined;
  logger: Logger;
  /** Human-readable result lines (stdout). */
  out: (line: string) => void;
  /** Errors and refusals (stderr). */
  err: (line: string) => void;
}

/** The command line behaviour; returns the exit code. */
export async function runEraseUser(argv: readonly string[], deps: CliDeps): Promise<number> {
  const parsed = parseEraseArgs(argv);
  if (!parsed.ok) {
    deps.err(`erase-user: ${parsed.message}\n${USAGE}`);
    return 1;
  }
  if (deps.databaseUrl === undefined || deps.databaseUrl === '') {
    deps.err('erase-user: DATABASE_URL is required');
    return 1;
  }

  const database = createDatabase(deps.databaseUrl, { logger: deps.logger });
  try {
    const outcome = await eraseUser(database.db, parsed.request, deps.logger);
    switch (outcome.status) {
      case 'not-found':
        deps.err('erase-user: no account has this email address. Nothing was deleted.');
        return 1;
      case 'unconfirmed':
        deps.out(
          `erase-user: user ${String(outcome.account.userId)} would be erased: ${describeRows(outcome.account)}`,
        );
        deps.err('erase-user: refusing to delete without --confirm. Nothing was deleted.');
        return 1;
      case 'erased':
        deps.out(`erase-user: user ${String(outcome.account.userId)} erased: ${describeRows(outcome.account)}`);
        return 0;
    }
  } catch (error) {
    // The logger strips bound query values from database errors (B-12), so the address never reaches the output.
    deps.logger.error({ err: error }, 'erase-user failed');
    deps.err('erase-user: the database query failed; nothing was deleted.');
    return 1;
  } finally {
    await database.close();
  }
}

if (import.meta.main) {
  process.exitCode = await runEraseUser(process.argv.slice(2), {
    databaseUrl: process.env['DATABASE_URL'],
    // JSON lines whatever NODE_ENV is: the `account.erased` line is the audit record of the erasure.
    logger: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'production' }),
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
