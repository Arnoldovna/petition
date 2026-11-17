import type { SupporterFilter, SupporterRow, SupportersRepository } from '../supporters.repository.js';

/** A stored supporter of the fake: the repository row plus the signature id for the tie-break (ADR 0006). */
export interface FakeSupporter extends SupporterRow {
  signatureId: number;
}

export interface FakeSupportersRepository extends SupportersRepository {
  /** The "table": tests push rows in any order; `list` sorts like the real query. */
  readonly rows: FakeSupporter[];
  /** Every call in order, to assert which filter, limit and offset the service asked for. */
  readonly calls: RepositoryCall[];
}

type RepositoryCall =
  (SupporterFilter & { method: 'list'; limit: number; offset: number }) | (SupporterFilter & { method: 'count' });

/**
 * Case-insensitive city match. JavaScript lower-casing stands in for `lower(... COLLATE "pg_c_utf8")`; the real
 * collation is covered by city.int.test.ts and schema.int.test.ts.
 */
function matches({ city }: SupporterFilter, row: FakeSupporter): boolean {
  return city === undefined || (row.city !== null && row.city.toLowerCase() === city.toLowerCase());
}

const byCreatedAtThenId = (a: FakeSupporter, b: FakeSupporter): number =>
  a.signedAt.getTime() - b.signedAt.getTime() || a.signatureId - b.signatureId;

/** In-memory `SupportersRepository` with the ordering and filter semantics of the Drizzle implementation. */
export function createFakeSupportersRepository(initial: readonly FakeSupporter[] = []): FakeSupportersRepository {
  const rows = [...initial];
  const calls: RepositoryCall[] = [];
  const select = (filter: SupporterFilter): FakeSupporter[] =>
    rows.filter((row) => matches(filter, row)).sort(byCreatedAtThenId);
  const toRow = ({ signatureId: _signatureId, ...row }: FakeSupporter): SupporterRow => row;

  return {
    rows,
    calls,
    list({ limit, offset, ...filter }) {
      calls.push({ method: 'list', limit, offset, ...filter });
      return Promise.resolve(
        select(filter)
          .slice(offset, offset + limit)
          .map(toRow),
      );
    },
    count(filter) {
      calls.push({ method: 'count', ...filter });
      return Promise.resolve(select(filter).length);
    },
  };
}

let nextSignatureId = 1;

/** A supporter row with defaults: no profile, signed at `signedAt` (default: a fixed date plus the id in seconds). */
export function fakeSupporter(overrides: Partial<FakeSupporter> = {}): FakeSupporter {
  const signatureId = overrides.signatureId ?? nextSignatureId++;
  return {
    firstName: 'Ada',
    lastName: 'Lovelace',
    age: null,
    city: null,
    homepageUrl: null,
    signedAt: new Date(Date.UTC(2026, 10, 1, 12, 0, signatureId)),
    ...overrides,
    signatureId,
  };
}
