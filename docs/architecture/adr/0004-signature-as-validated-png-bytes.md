# ADR 0004: Signatures are validated, re-encoded PNG bytes in `bytea`, served by an authenticated route

- Status: Accepted (reviewed in the architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-19, B-36, B-49, B-61, B-07, F-03, F-11, F-41, F-42, F-43, F-48, F-71

## Context

Legacy stored any string from a hidden input as `TEXT` and used it as `<img src>` (B-19): empty strings, external
URLs and up to 100 KB of text were accepted. Base64 inflates storage by a third (B-61).

## Decision

1. **Wire format.** The drawn signature arrives as form field `signature` holding `data:image/png;base64,...` from a
   fixed export size of **720 x 240 px** (3:1). The client always exports at this size, independent of screen size and
   device pixel ratio (ADR 0010).
2. **Body limit.** A dedicated `express.urlencoded({ extended: false, limit: '128kb' })` is mounted for
   `/signature` before the global 16 kb parser. Larger bodies get the 413 page (OVERVIEW.md section 13).
3. **Validation pipeline** (`src/features/signature/image/signature-image.ts`, owned by the signature feature,
   ADR 0001; pure functions plus @napi-rs/canvas):
   1. Zod: string, prefix `data:image/png;base64,`, base64 alphabet only, at most 87,400 characters after the prefix.
   2. Decode; reject if the decoded length is 0 or greater than 65,536 bytes (64 KiB).
   3. `inspectPngHeader(bytes)`: 8-byte PNG signature, first chunk `IHDR`, width 720, height 240.
   4. Full decode with `loadImage` (rejects corrupt or truncated files).
   5. Ink check: at least `MIN_INK_PIXELS` (150) pixels with alpha > 0. Fewer means blank: "Please sign before
      submitting" (F-41).
   6. **Re-encode** the decoded pixels to a new PNG. Only these canonical bytes are stored, which strips text chunks
      and any polyglot payload. The re-encoded size must also be at most 64 KiB.
   Any failure returns a `SignatureImageError` with a user-facing message; the controller re-renders the page with
   HTTP 422 (F-42).
4. **Storage.** `signatures.image bytea NOT NULL` with `CHECK (octet_length(image) BETWEEN 67 AND 65536)` and
   `signatures.method` (`drawn` or `typed`). Drizzle 0.45 has no `bytea` builder, so `src/db/schema/types.ts` defines it
   with `customType<{ data: Buffer; driverData: Buffer }>`.
5. **Idempotent insert.** `INSERT ... ON CONFLICT (user_id) DO NOTHING`, then 303 to `/thank-you` whether a row was
   inserted or not (F-43, B-49).
6. **Delivery.** The image is never inlined. `GET /signature/image.png` (requireAuth, requireSigned) streams the
   current user's own bytes with `Content-Type: image/png`, `Cache-Control: private, no-store`,
   `X-Content-Type-Options: nosniff`. The thank-you page references it with `alt="Your signature"`. Only the owner can
   load it; there is no id in the URL.
7. **CSP.** `img-src 'self'` is enough. This is stricter than the `img-src 'self' data:` allowed by F-71.

## Alternatives considered

- **Store the data URL as text with a length CHECK** (allowed by F-03). Rejected: 33 % larger, and the string would
  be rendered back into HTML.
- **Object storage (S3/MinIO).** Rejected: at most 64 KiB per user, one per user, no public delivery. A bytea column
  keeps deletion atomic with the user row (F-06).
- **SVG of stroke points.** Rejected: SVG is an XSS surface and F-42 requires PNG.
- **`file-type` for sniffing** (as in the skill's upload section). Not needed: the PNG check is 15 lines, fully
  unit-tested, and the full decode plus re-encode is stronger than magic-byte sniffing.

## Consequences

- One extra request per thank-you view (small, private, not cached).
- `@napi-rs/canvas` becomes a runtime dependency (ADR 0005).
- Unit tests cover every rejection reason with fixture PNGs generated in the test (wrong size, blank, truncated,
  JPEG bytes with PNG prefix, 70 KiB noise image, text chunk removed after re-encode).
