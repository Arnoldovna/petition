# ADR 0006: One base query for supporter list and count; numbered offset pagination

- Status: Accepted (reviewed in the architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-30, B-31, B-52, B-55, B-61, F-05, F-47, F-51, F-54, F-56, F-59

## Context

Legacy listed supporters with an inner join on profiles (signers without a profile vanished) and counted all
signature rows, so list and count disagreed (B-30). There was no ordering and no pagination (B-31).

The `express-feature-module` skill prefers keyset pagination and says "never offer offset pagination on growing
tables". F-54 requires numbered pages with `aria-current` on the current page and the total count.

## Decision

- `supporters.repository.ts` builds every supporter query from one base:
  `FROM signatures s JOIN users u ON u.id = s.user_id LEFT JOIN profiles p ON p.user_id = s.user_id`
  with an optional city filter `lower(p.city COLLATE "pg_c_utf8") = lower($city COLLATE "pg_c_utf8")` (ADR 0007).
  `list` and `count` share the same `FROM`/`WHERE` builder, so they cannot disagree (F-47).
- Order: `s.created_at ASC, s.id ASC` (oldest first, F-54) backed by the index
  `signatures_created_at_id_idx (created_at, id)`.
- **Offset pagination with page numbers.** Page size 50. Query `?page=<n>` validated with Zod (integer 1 to 10,000).
  An invalid value or a page beyond the last (when the total is above 0) returns the 404 page. Pagination view model:
  first, last, current plus and minus 2, ellipses, previous and next.
- **Deviation from the skill rule is deliberate:** the list is bounded by real human sign-ups, the total is computed
  anyway for F-46/F-54, and numbered pages are an acceptance criterion. At 100,000 rows an offset scan on the
  covering index stays within single-digit milliseconds. If the table ever grows past that, switch to keyset with
  "older/newer" links in a new ADR.
- `supporters` exposes `countSupporters(): Promise<number>` from its `index.ts`. `app.ts` injects it into the
  signature module for the thank-you page, so signature never imports supporters internals and both use the same
  count query.
- Thank-you page data comes from one `Promise.all([countSupporters(), ...])` (B-52).

## Alternatives considered

- **Keyset pagination with older/newer links only.** Rejected for now: F-54 asks for page numbers and the current
  page.
- **Count from `signatures` alone.** Equivalent today because of `ON DELETE CASCADE`, but sharing the base query
  documents the invariant and protects against future joins with filters.

## Consequences

- `count(*)` runs per page view. Cheap at this size; the city filter uses the expression index.
- Integration tests prove: signers without a profile appear (B-30), count equals list length across pages, order is
  stable with equal timestamps (tie-break by id), page 2 exists with 51 or more signers, out-of-range page is 404.
  Each test file has its own database (ADR 0017), so these global aggregates are exact.
- Because the count is injected, the signature module's tests in parallel phase 2a pass a fake `countSupporters` to
  `createTestApp({ countSupporters })` and assert only that the thank-you page renders what it returns (plural,
  grouping). The cross-module invariant F-47 (thank-you count equals the supporters list total, and goes down by one
  after a signature or account deletion) is asserted with the real modules in
  `src/__tests__/supporter-count.int.test.ts` in the sequential step 2b, after both modules have merged.
