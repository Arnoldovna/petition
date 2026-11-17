/** PostgreSQL unique_violation; services translate it into a Result value (ADR 0008). */
const UNIQUE_VIOLATION = '23505';

/** Drizzle wraps driver errors (DrizzleQueryError -> pg DatabaseError), so the code sits somewhere on the cause chain. */
const MAX_CAUSE_DEPTH = 5;

interface PgErrorFields {
  code: string;
  constraint: string | undefined;
}

/** The first error on the cause chain that carries a PostgreSQL SQLSTATE, as plain fields. */
function findPgError(error: unknown): PgErrorFields | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth++) {
    if ('code' in current && typeof current.code === 'string' && /^[0-9A-Z]{5}$/.test(current.code)) {
      const constraint =
        'constraint' in current && typeof current.constraint === 'string' ? current.constraint : undefined;
      return { code: current.code, constraint };
    }
    current = 'cause' in current ? current.cause : undefined;
  }
  return undefined;
}

/**
 * Postgres unique_violation (23505), optionally only for one named constraint or unique index. Services pass the
 * name (`users_email_lower_idx`), so an unexpected duplicate elsewhere stays a 500 instead of becoming a misleading
 * "email taken" (B-24, ADR 0008).
 */
export function isUniqueViolation(error: unknown, constraint?: string): boolean {
  const found = findPgError(error);
  return found?.code === UNIQUE_VIOLATION && (constraint === undefined || found.constraint === constraint);
}
