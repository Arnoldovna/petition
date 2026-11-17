# ADR 0005: Server-side image processing with @napi-rs/canvas (validation and typed-name signatures)

- Status: Accepted (revised after architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-19, B-70, F-41, F-42, F-45, F-01 (seed signatures)

## Context

Two server features need raster work:

- Full PNG decode for the blank check and re-encode (ADR 0004).
- F-45: "Sign by typing your full name". The server renders the typed name into a PNG that is stored like a drawn
  one. This is the keyboard, screen reader and no-JS path (B-70).

The seed also needs realistic signature images without copying any external images.

The first draft allowed `^\p{Script=Latin}[\p{Script=Latin} .'-]*$` and claimed this matched the glyph coverage of
Schibsted Grotesk's latin and latin-ext files. The critique showed it does not. Measured on 2026-11-15 with fontkit
2.0.4 against `@fontsource/schibsted-grotesk` 5.3.0 (latin + latin-ext, weight 500): the files contain 284 letters,
while the regex accepts about 1,076 further Latin-script letters in the BMP, including Vietnamese (`ễ` in "Nguyễn"),
fullwidth Latin and IPA. Those names would be stored as PNGs with empty glyph boxes. The rule also rejected the
typographic apostrophe `’` that iOS smart punctuation inserts ("O’Brien"), and users with Greek or Cyrillic names had
no keyboard or no-JS way to sign.

## Decision

- Use **@napi-rs/canvas 1.1.1** (Skia, prebuilt N-API binaries for darwin-arm64, linux-x64-gnu and linux-arm64-gnu,
  no install script, so nothing to add to `onlyBuiltDependencies`).
- **Two OFL fonts, server side only**, both weight 500:
  - `SignatureFont`: Schibsted Grotesk (the project font), `schibsted-grotesk-{latin,latin-ext}-500-normal.woff2`.
  - `SignatureFallback`: **Noto Sans** (`@fontsource/noto-sans` 5.3.0, OFL), files
    `noto-sans-{latin,latin-ext,vietnamese,greek,greek-ext,cyrillic,cyrillic-ext}-500-normal.woff2` (about 168 KB).
    Measured: 1,971 letters, covering Latin incl. Vietnamese, Greek and Cyrillic. The browser never loads it.
  - The build copies exactly these files to `dist/signature-fonts/` (`scripts/copy-fonts.mjs`), so the runtime image
    does not need the 8 MB Noto package; `@fontsource/*` are devDependencies. Development uses `.dev/signature-fonts/`,
    tests resolve the files from `node_modules` (`test/fonts.ts`). Licence: `LICENSES/OFL-NotoSans.txt` next to the
    Schibsted licence.
- **Allowed characters come from the shipped glyphs, not from a Unicode script property.**
  `scripts/font-glyphs.mjs` (devDependency `fontkit` 2.0.4; 3.0.0 is a four-day-old major) reads the `cmap` of every
  shipped woff2 and writes `src/features/signature/image/glyphs.generated.ts` (committed): two sorted code-point range
  lists, `PRIMARY` (Schibsted) and `FALLBACK` (Noto Sans). The unit test `glyphs.test.ts` re-derives both lists from
  the installed font packages and fails on drift (for example after a fontsource update through Dependabot). Control
  characters (`\p{Cc}`) are left out: the Schibsted and Noto subsets map U+0000 and U+000D, which never draw, and
  `typedName` never accepts them.
- **Typed-name rule (Zod, `typedName` in `fields.ts`)**: NFC; replace `’` (U+2019) and `ʼ` (U+02BC) with `'`; remove
  control characters; trim; collapse inner whitespace; 2 to 60 characters (more than 60 also gets "Type your full
  name"); first character a letter; every character is a space, `.`, `'`, `-`
  or a letter (`\p{L}`) or combining mark (`\p{M}`) contained in `PRIMARY ∪ FALLBACK`. Messages: "Type your full
  name"; "Use letters, spaces, hyphens, apostrophes and full stops only"; for letters outside the glyph set "We cannot
  draw some letters of this name yet. Type it in Latin, Greek or Cyrillic letters, or draw your signature."
- `renderTypedSignature(name)`: chooses **one** font for the whole name: `SignatureFont` when every character is in
  `PRIMARY`, otherwise `SignatureFallback`. No per-glyph mixing, so the result never depends on Skia's font fallback
  (the distroless image has no system fonts). 720 x 240 transparent canvas, ink `#000`, font size starts at 96 px and
  shrinks in 4 px steps until the text fits 656 px (32 px side padding), minimum 32 px, vertically centred. Encoded as
  PNG and passed through the same `inspectPngHeader` and size checks as drawn signatures.
- The signature-image service lives in `src/features/signature/image/` (ADR 0001), is created once in `container.ts`
  (`createSignatureImages({ fontPaths })`, exported from the signature module's `index.ts`) and injected.

Spike on 2026-11-15 (scratchpad, Node 22, @napi-rs/canvas 1.1.1, @fontsource/schibsted-grotesk 5.3.0): registering
the woff2 files works, "Lena Hartmann" at 64 px renders to a 4.7 KB PNG, `loadImage` plus `getImageData` reads it back
(7,566 inked pixels), latin-ext names (`Łukasz Żółć`, `Ğülşen Çağlar`) render, and a dense 600-segment scribble at
720 x 240 encodes to 15 KB, well under the 64 KiB cap.

## Alternatives considered

- **sharp with SVG text.** Needs fontconfig and system fonts; the distroless runtime has none.
- **pngjs plus a hand-written text rasteriser.** Too much custom code.
- **Render the typed name in the browser.** Breaks the no-JS path (F-45).
- **Store the typed text and render it as HTML text.** Would cover every script the visitor's browser can display,
  but F-45 fixes "the server renders the typed name into a signature image (PNG) that is stored like a drawn one".
  Recorded as the next step if names outside Latin, Greek and Cyrillic become a real need.
- **CJK, Arabic, Devanagari and other scripts.** Not covered: the fonts are megabytes each, and Arabic or Indic
  scripts need shaping checks beyond this ADR. Users with such names can draw their signature (JavaScript) or type
  a Latin transliteration; the message says so. This is a known, documented limitation of the no-JS path.

## Consequences

- About 30 MB of native binary plus about 170 KB of server fonts in the runtime image. Acceptable.
- **Image smoke check in both architectures.** `src/tools/smoke-canvas.ts` (compiled to `dist/tools/smoke-canvas.js`)
  registers the shipped fonts, renders `Łukasz Żółć` (primary font) and `Nguyễn Ελένη Пётр` (fallback font), round-trips
  each PNG through the drawn-signature validator and asserts at least 1,000 inked pixels and no rejection. `scripts/run-e2e.mjs`
  runs it in the image the isolated E2E stack just built (`docker run --rm petition-e2e-app dist/tools/smoke-canvas.js`,
  ADR 0017). Because it is part of `test:e2e`, it runs on linux/amd64 in the CI `e2e` job of every pull request (not on
  pushes to `main`, ADR 0018) and on linux/arm64 on Marina's Mac on every local `pnpm verify`. In phase 1 the signature
  module is still a stub, so the phase-1 version of the smoke check drives
  @napi-rs/canvas directly (register fonts, draw text, `encode('png')`, `loadImage`, count pixels); the signature
  module switches it to `renderTypedSignature` plus the validator.
- Fallback if the native module does not work in `gcr.io/distroless/nodejs26-debian13:nonroot`: switch the runtime
  base to `node:26-slim` running as a non-root user, recorded as a follow-up ADR.
- Image work is CPU-bound (a few milliseconds per signature). The sign route has its own rate limit (ADR 0012).
