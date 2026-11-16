# ADR 0007: Case-insensitive email and city matching, normalised on write

- Status: Accepted (reviewed in the architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-25, B-32, B-33, B-61, F-02, F-05, F-19, F-35, F-56, F-57, F-58

## Context

Legacy compared emails case-sensitively (B-25), compared cities with `LOWER()` but without trimming (B-32) and had no
index for the city lookup (B-61). Real city names contain umlauts, `ß`, slashes, parentheses and question marks.
`lower()` with the libc provider depends on the operating system's locale tables, which differ between the Alpine
Postgres image, Testcontainers and a managed production database.

## Decision

**Email**
- Zod, normalise **before** validating the format:
  `z.string().trim().toLowerCase().min(1, 'Enter an email address').max(254, ...).pipe(z.email('Enter a valid email address, like name@example.com'))`.
  In Zod 4 a format schema checks first, so `z.email().trim().toLowerCase()` (the skill template's `auth.schema.ts`
  and `references/security.md`) rejects `' Ada@Example.com '` (verified with zod 4.6.7). petition does not copy that
  template line; `fields.test.ts` covers surrounding whitespace, upper case and the combination. Zod 4's default email
  pattern is ASCII, so JavaScript and Postgres lower-casing agree.
- **Skill follow-up (outside this repository):** fix the template to the order above, because imageboard and
  social-network reuse it for JSON APIs where no browser trims input.
- Column `users.email text NOT NULL` with `CHECK (email = lower(email))` and the unique index
  `users_email_lower_idx ON users (lower(email))` (pattern from the skill, no citext extension).
- Lookups use `lower(email) = $1` with the already-lowercased value.

**City**
- Zod normalisation on write: `normalize('NFC')`, trim, collapse inner whitespace to one space, 1 to 100 characters.
  DB backstop: `CHECK (city = btrim(city) AND city !~ '\s{2,}' AND char_length(city) BETWEEN 1 AND 100)`.
- Comparisons use the **explicit collation `pg_c_utf8`** (built into every PostgreSQL 17+ database, independent of
  the database's default locale and the OS): expression index
  `profiles_city_key_idx ON profiles (lower(city COLLATE "pg_c_utf8"))`, and the query uses the identical expression
  on both sides. `München`, `MÜNCHEN` and ` münchen ` therefore match on every environment.
- Route `GET /supporters/city/:city`: Express decodes the parameter; the controller normalises it with the same Zod
  schema. Invalid (empty after trim, longer than 100) returns the 404 page. The heading always uses the requested,
  normalised, HTML-escaped value (B-33).
- Links are built with the Handlebars helper `cityPath city`, which returns `/supporters/city/` plus
  `encodeURIComponent(city)`. `Frankfurt/Main` becomes `Frankfurt%2FMain`, which Express matches as one segment.

## Alternatives considered

- **citext extension.** Works for email, not for the city expression index with a defined Unicode collation; one
  mechanism for both is simpler.
- **App-computed `city_key` column.** Duplicates data and needs a sync rule; the expression index is enough.
- **Database-wide `--locale-provider=builtin`.** Depends on how the production database is created; the explicit
  column collation does not.

## Consequences

- Drizzle cannot express `COLLATE` in the index builder directly, so the index uses `sql` in `index().on(...)` and the
  generated migration is reviewed by hand.
- Integration tests: `München` vs `MÜNCHEN`, `Halle (Saale)`, `Frankfurt/Main`, `St. Gallen?`, `A#B&C`, trailing
  spaces, and the email case variants on register and login.
