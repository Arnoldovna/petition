# ADR 0013: Deletion flows with confirmation pages and database cascades

- Status: Accepted (reviewed in the architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-34, B-47, B-54, F-06, F-49, F-50, F-66, F-67, F-68, F-69

## Context

Legacy deleted the account with three nested, unreturned deletes and no cascade (B-34), with one click and no
re-authentication. "Delete signature" was shown to users who had not signed (B-47).

## Decision

- Foreign keys `profiles.user_id` and `signatures.user_id` reference `users.id` **ON DELETE CASCADE**. Account
  deletion is one `DELETE FROM users WHERE id = $1` inside `db.transaction` (F-06, F-68). No manual child deletes.
- **Delete signature:** the thank-you and edit pages link to `GET /signature/delete` (requireAuth, requireSigned), a
  confirmation page explaining that the signature will be removed and the count goes down by one, with a POST form
  (CSRF) and a "keep my signature" link back. `POST /signature/delete` deletes only `WHERE user_id = viewer.userId`,
  then 303 to `/signature` with the flash "Your signature was removed" (F-49, F-50). The link is only rendered when
  `viewer.hasSigned` (B-47). Works without JavaScript; no `<dialog>` needed.
- **Delete account:** `GET /account/delete` (requireAuth) lists what is deleted (account, profile, signature) and asks
  for the current password (`autocomplete="current-password"`). `POST /account/delete`: rate-limited (ADR 0012),
  verifies the password with `credentials.verifyCurrentPassword` (ADR 0009; wrong: 422 with field error), deletes in one transaction, ends the session with the flash
  "Your account was deleted" and 303 to `/` (F-67, F-68). The same email can register again afterwards (F-69).
- Repository methods return `boolean` from `rowCount` (B-54).
- **Erasure without the password** (lost password, no reset flow): handled manually on request through the contact
  channel named on the privacy page. The operator runs `pnpm admin:erase -- --email <address> --confirm`
  (`src/tools/erase-user.ts`), which looks the user up by `lower(email)`, prints the user id and what will be deleted,
  and deletes with the same transaction as `POST /account/delete` (cascade). Sessions of that user become guests on
  their next request (ADR 0002). Details and the reasoning for not building a reset flow: ADR 0016.

## Alternatives considered

- **Native `<dialog>` with JS.** F-50 accepts either; the confirmation page works without JavaScript and needs no
  extra script or focus management.
- **Soft delete.** Rejected: no product need, and GDPR erasure is simpler with a hard delete.

## Consequences

- Two extra GET routes (`/signature/delete`, `/account/delete`), listed in ROUTES.md.
- Integration test: deleting a user leaves zero rows in `profiles` and `signatures` for that id; `erase-user.int.test.ts`
  proves the tool refuses without `--confirm`, matches case-insensitively and cascades.
