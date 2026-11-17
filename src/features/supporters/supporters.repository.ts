import { asc, count, eq, sql, type SQL } from 'drizzle-orm';

import type { Database } from '../../db/client.js';
import { profiles, signatures, users } from '../../db/schema/index.js';

/** What the repository returns per supporter: columns only, the service builds the view (OVERVIEW.md section 8). */
export interface SupporterRow {
  firstName: string;
  lastName: string;
  age: number | null;
  city: string | null;
  homepageUrl: string | null;
  signedAt: Date;
}

/** Optional city filter shared by list and count; the value is already normalised by `cityParam` (ADR 0007). */
export interface SupporterFilter {
  city?: string;
}

export interface SupportersRepository {
  /** One page, oldest signature first, tie-break by signature id (ADR 0006, F-54, B-31). */
  list(params: SupporterFilter & { limit: number; offset: number }): Promise<SupporterRow[]>;
  /** The number of rows `list` can return for the same filter (F-47, B-30). */
  count(filter: SupporterFilter): Promise<number>;
}

/**
 * Case-insensitive city match with the explicit `pg_c_utf8` collation on both sides, the exact expression of the
 * index `profiles_city_key_idx` (ADR 0007), so `MÜNCHEN` finds `München` on every database locale. The city is a bound
 * parameter (`::text` gives the parameter a collatable type); no filter means every supporter.
 */
function cityFilter({ city }: SupporterFilter): SQL | undefined {
  if (city === undefined) return undefined;
  return sql`lower(${profiles.city} COLLATE "pg_c_utf8") = lower(${city}::text COLLATE "pg_c_utf8")`;
}

/**
 * The one base query of every supporter read (ADR 0006): every signature, its user, and the profile when there is
 * one, as a subquery that `list` and `count` both select from, so they cannot disagree (F-47). The LEFT JOIN keeps
 * signers who skipped the profile (B-30). PostgreSQL flattens the subquery, so the city filter still uses
 * `profiles_city_key_idx` and the ordering `signatures_created_at_id_idx`.
 */
function supporterBase(db: Database, filter: SupporterFilter) {
  return db
    .select({
      signatureId: signatures.id,
      firstName: users.firstName,
      lastName: users.lastName,
      age: profiles.age,
      city: profiles.city,
      homepageUrl: profiles.homepageUrl,
      signedAt: signatures.createdAt,
    })
    .from(signatures)
    .innerJoin(users, eq(users.id, signatures.userId))
    .leftJoin(profiles, eq(profiles.userId, signatures.userId))
    .where(cityFilter(filter))
    .as('supporter');
}

export function createSupportersRepository(db: Database): SupportersRepository {
  return {
    async list({ limit, offset, ...filter }) {
      const base = supporterBase(db, filter);
      return (
        db
          .select({
            firstName: base.firstName,
            lastName: base.lastName,
            age: base.age,
            city: base.city,
            homepageUrl: base.homepageUrl,
            signedAt: base.signedAt,
          })
          .from(base)
          // Oldest first, tie-break by signature id (F-54, B-31).
          .orderBy(asc(base.signedAt), asc(base.signatureId))
          .limit(limit)
          .offset(offset)
      );
    },

    async count(filter) {
      const [row] = await db.select({ total: count() }).from(supporterBase(db, filter));
      return row?.total ?? 0;
    },
  };
}
