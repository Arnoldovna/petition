import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';

import { isUniqueViolation } from '../db-errors.js';

/** A node-postgres DatabaseError as far as the services care: SQLSTATE and constraint name. */
const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error('duplicate key value violates unique constraint'), { code, constraint });

/** Drizzle 0.45 wraps every driver error: DrizzleQueryError -> pg DatabaseError (`cause`). */
const wrapped = (cause: Error) => new DrizzleQueryError('insert into "users" ...', ['x'], cause);

describe('isUniqueViolation', () => {
  it('F-20, B-24: finds 23505 on the driver error behind the Drizzle wrapper', () => {
    expect(isUniqueViolation(wrapped(pgError('23505', 'users_email_lower_idx')))).toBe(true);
    expect(isUniqueViolation(pgError('23505'))).toBe(true);
  });

  it('F-20, B-24: matches only the named constraint when one is given', () => {
    const emailTaken = wrapped(pgError('23505', 'users_email_lower_idx'));
    const otherDuplicate = wrapped(pgError('23505', 'signatures_user_id_key'));

    expect(isUniqueViolation(emailTaken, 'users_email_lower_idx')).toBe(true);
    expect(isUniqueViolation(otherDuplicate, 'users_email_lower_idx')).toBe(false);
  });

  it('B-24: other SQLSTATEs, non-database errors and non-errors are not unique violations', () => {
    expect(isUniqueViolation(wrapped(pgError('23514', 'users_email_chk')))).toBe(false);
    expect(isUniqueViolation(wrapped(pgError('23503')))).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error('socket'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isUniqueViolation(new Error('plain'))).toBe(false);
    for (const value of [undefined, null, '23505', 23505, { code: 23505 }])
      expect(isUniqueViolation(value)).toBe(false);
  });

  it('B-20: stops at the first SQLSTATE and does not walk an endless cause chain', () => {
    const loop: Error & { cause?: unknown } = new Error('loop');
    loop.cause = loop;

    expect(isUniqueViolation(loop)).toBe(false);
  });
});
