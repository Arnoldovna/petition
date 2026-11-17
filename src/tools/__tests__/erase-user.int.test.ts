import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { currentDatabaseUrl } from '../../../test/database.js';
import { createSignature, createUser } from '../../../test/factories.js';
import { createDatabase, type Database, type DatabaseHandle } from '../../db/client.js';
import { profiles, signatures, users } from '../../db/schema/index.js';
import { createLogger } from '../../shared/logging/logger.js';
import { parseEraseArgs, runEraseUser } from '../erase-user.js';

/**
 * `pnpm admin:erase` (F-91, ADR 0013, ADR 0016) against the file's own database: it refuses without `--confirm`,
 * matches the email case-insensitively, deletes account, profile and signature in one cascade, touches no other
 * account, and never prints or logs the address.
 */

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const ENTRY = 'src/tools/erase-user.ts';

let database: DatabaseHandle;
let db: Database;

beforeAll(() => {
  database = createDatabase(currentDatabaseUrl());
  db = database.db;
});

afterAll(async () => {
  await database.close();
});

interface Run {
  code: number;
  out: string[];
  err: string[];
  logs: Record<string, unknown>[];
  /** Everything the run wrote, to assert that no personal data appears anywhere. */
  all: string;
}

/** Runs the command line behaviour in-process with captured output and JSON log lines. */
async function erase(...argv: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const logLines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logLines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  const logger: Logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' }, destination);
  const code = await runEraseUser(argv, {
    databaseUrl: currentDatabaseUrl(),
    logger,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return {
    code,
    out,
    err,
    logs: logLines.map((line) => JSON.parse(line) as Record<string, unknown>),
    all: [...out, ...err, ...logLines].join('\n'),
  };
}

/** A user with a profile and a signature, as left behind by the full sign-up journey. */
async function createSupporter(email: string) {
  const user = await createUser(db, { email });
  await db.insert(profiles).values({ userId: user.id, age: 42, city: 'Leipzig', homepageUrl: 'https://example.com' });
  await createSignature(db, user.id);
  return user;
}

async function rowsOf(userId: number) {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  const profileRows = await db.select({ userId: profiles.userId }).from(profiles).where(eq(profiles.userId, userId));
  const signatureRows = await db
    .select({ userId: signatures.userId })
    .from(signatures)
    .where(eq(signatures.userId, userId));
  return { user: user !== undefined, profiles: profileRows.length, signatures: signatureRows.length };
}

describe('parseEraseArgs', () => {
  it('F-91: accepts --email with or without --confirm and drops the -- that pnpm forwards', () => {
    expect(parseEraseArgs(['--', '--email', 'ada@petition.test', '--confirm'])).toEqual({
      ok: true,
      request: { email: 'ada@petition.test', confirm: true },
    });
    expect(parseEraseArgs(['--email=ada@petition.test'])).toEqual({
      ok: true,
      request: { email: 'ada@petition.test', confirm: false },
    });
  });

  it('F-91, ADR 0007: normalises the address like registration does (trim, lower case)', () => {
    expect(parseEraseArgs(['--email', '  Ada.Lovelace@Example.COM ', '--confirm'])).toEqual({
      ok: true,
      request: { email: 'ada.lovelace@example.com', confirm: true },
    });
  });

  it.each([
    { argv: [], message: '--email <address> is required' },
    { argv: ['--confirm'], message: '--email <address> is required' },
    { argv: ['--email', 'not-an-address'], message: '--email: Enter a valid email address, like name@example.com' },
    { argv: ['--email', '   '], message: '--email: Enter an email address' },
    { argv: ['--email'], message: 'unknown option or missing value (allowed: --email <address>, --confirm)' },
    {
      argv: ['--email', 'ada@petition.test', '--force'],
      message: 'unknown option or missing value (allowed: --email <address>, --confirm)',
    },
    { argv: ['ada@petition.test'], message: 'unexpected argument (pass the address with --email)' },
  ])('F-91: rejects $argv', ({ argv, message }) => {
    expect(parseEraseArgs(argv)).toEqual({ ok: false, message });
  });

  it.each([
    ['--email', 'private-name-without-at-sign'],
    ['--private.name@petition.test'],
    ['private.name@petition.test'],
  ])('F-91, B-12: a mistyped address is never echoed (%s)', (...argv) => {
    const parsed = parseEraseArgs(argv);
    expect(parsed.ok).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain('private');
  });
});

describe('pnpm admin:erase', () => {
  it('F-91: without --confirm it prints the user id and what would be deleted, deletes nothing and exits 1', async () => {
    const user = await createSupporter('preview@petition.test');

    const run = await erase('--email', 'preview@petition.test');

    expect(run.code).toBe(1);
    expect(run.out).toEqual([`erase-user: user ${String(user.id)} would be erased: account, profile, signature`]);
    expect(run.err).toEqual(['erase-user: refusing to delete without --confirm. Nothing was deleted.']);
    expect(run.logs).toEqual([]);
    expect(await rowsOf(user.id)).toEqual({ user: true, profiles: 1, signatures: 1 });
  });

  it('F-91, F-68: with --confirm it deletes account, profile and signature and logs account.erased with the id only', async () => {
    const user = await createSupporter('erase-me@petition.test');

    const run = await erase('--email', 'erase-me@petition.test', '--confirm');

    expect(run.code).toBe(0);
    expect(run.out).toEqual([`erase-user: user ${String(user.id)} erased: account, profile, signature`]);
    expect(run.err).toEqual([]);
    expect(await rowsOf(user.id)).toEqual({ user: false, profiles: 0, signatures: 0 });
    expect(run.logs).toHaveLength(1);
    expect(run.logs[0]).toMatchObject({ level: 30, msg: 'account.erased', userId: user.id });
    expect(run.all).not.toContain('erase-me');
  });

  it('F-91, ADR 0007: the lookup ignores case and surrounding whitespace', async () => {
    const user = await createSupporter('mixed.case@petition.test');

    const run = await erase('--email', '  Mixed.Case@Petition.TEST ', '--confirm');

    expect(run.code).toBe(0);
    expect(await rowsOf(user.id)).toEqual({ user: false, profiles: 0, signatures: 0 });
    expect(run.all.toLowerCase()).not.toContain('mixed.case');
  });

  it('F-91: lists only the rows that exist and leaves every other account untouched', async () => {
    const bystander = await createSupporter('bystander@petition.test');
    const target = await createUser(db, { email: 'no-profile@petition.test' });

    const run = await erase('--email', 'no-profile@petition.test', '--confirm');

    expect(run.code).toBe(0);
    expect(run.out).toEqual([`erase-user: user ${String(target.id)} erased: account`]);
    expect(await rowsOf(target.id)).toEqual({ user: false, profiles: 0, signatures: 0 });
    expect(await rowsOf(bystander.id)).toEqual({ user: true, profiles: 1, signatures: 1 });
  });

  it('F-91, F-69: the same address can register again after the erasure', async () => {
    await createSupporter('comes-back@petition.test');
    expect((await erase('--email', 'comes-back@petition.test', '--confirm')).code).toBe(0);

    const again = await createUser(db, { email: 'comes-back@petition.test' });

    expect(await rowsOf(again.id)).toEqual({ user: true, profiles: 0, signatures: 0 });
  });

  it('F-91: an unknown address deletes nothing and exits 1 without echoing it', async () => {
    const bystander = await createSupporter('still-here@petition.test');

    const run = await erase('--email', 'nobody@petition.test', '--confirm');

    expect(run.code).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err).toEqual(['erase-user: no account has this email address. Nothing was deleted.']);
    expect(run.logs).toEqual([]);
    expect(run.all).not.toContain('nobody');
    expect(await rowsOf(bystander.id)).toEqual({ user: true, profiles: 1, signatures: 1 });
  });

  it('F-91: invalid arguments exit 1 with the usage and delete nothing', async () => {
    const user = await createSupporter('args@petition.test');

    const run = await erase('--email', 'args@petition.test', '--confirm', '--yes');

    expect(run.code).toBe(1);
    expect(run.err.join('\n')).toContain('usage: pnpm admin:erase -- --email <address> [--confirm]');
    expect(await rowsOf(user.id)).toEqual({ user: true, profiles: 1, signatures: 1 });
  });

  it('F-91: refuses to run without DATABASE_URL', async () => {
    const err: string[] = [];
    const code = await runEraseUser(['--email', 'ada@petition.test', '--confirm'], {
      databaseUrl: undefined,
      logger: createLogger({ LOG_LEVEL: 'silent', NODE_ENV: 'test' }),
      out: () => undefined,
      err: (line) => err.push(line),
    });

    expect(code).toBe(1);
    expect(err).toEqual(['erase-user: DATABASE_URL is required']);
  });

  it('F-91, B-12: a database failure exits 1 and logs the error without the address', async () => {
    const logLines: string[] = [];
    const err: string[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        logLines.push(chunk.toString('utf8'));
        callback();
      },
    });
    // A database that does not exist on the test server: the connection fails on the first query.
    const missing = new URL(currentDatabaseUrl());
    missing.pathname = '/no_such_database';

    const code = await runEraseUser(['--email', 'secret-address@petition.test', '--confirm'], {
      databaseUrl: missing.toString(),
      logger: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' }, destination),
      out: () => undefined,
      err: (line) => err.push(line),
    });

    expect(code).toBe(1);
    expect(err).toEqual(['erase-user: the database query failed; nothing was deleted.']);
    expect(logLines.join('')).toContain('erase-user failed');
    expect([...logLines, ...err].join('\n')).not.toContain('secret-address');
  });

  it('F-91: the entry point erases through the command line exactly as `pnpm admin:erase -- ...` calls it', async () => {
    const user = await createSupporter('cli@petition.test');

    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', ENTRY, '--', '--email', 'CLI@petition.test', '--confirm'],
        {
          cwd: REPO_ROOT,
          env: { PATH: process.env['PATH'], DATABASE_URL: currentDatabaseUrl() },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('error', reject);
      child.on('close', (code) => {
        resolve({ code, stdout, stderr });
      });
    });

    expect(result.stderr).toBe('');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`erase-user: user ${String(user.id)} erased: account, profile, signature`);
    const auditLine = result.stdout.split('\n').find((line) => line.startsWith('{'));
    expect(JSON.parse(auditLine ?? '{}')).toMatchObject({ msg: 'account.erased', userId: user.id });
    expect(result.stdout.toLowerCase()).not.toContain('cli@');
    expect(await rowsOf(user.id)).toEqual({ user: false, profiles: 0, signatures: 0 });
  }, 30_000);
});
