# ADR 0010: Progressive-enhancement client code, self-hosted assets and a hashed asset pipeline

- Status: Accepted (reviewed in the architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-16, B-36, B-37, B-38, B-39, B-40, B-41, B-49, B-63, B-70, B-73, B-82, F-38, F-39, F-40, F-41, F-45,
  F-75, F-76, F-83, F-86

## Context

Legacy loaded jQuery twice from a CDN without integrity (B-16, B-73), drew with mouse events only (B-37), lost strokes
released outside the canvas (B-36), used `offsetLeft` coordinates without DPR scaling (B-38), redrew everything on
every move (B-39), shipped a cursor-following hint that threw errors (B-40) and four unbuilt stylesheets (B-82).

## Decision

**Client code (TypeScript, no framework, no jQuery)** in `src/client/`, bundled by esbuild 0.28 to ES2022 modules,
loaded with `<script type="module" src="...">` (deferred by default). CSP `script-src 'self'`; no inline script.

1. `form-guard.ts` (every page): on `submit` of `form[data-guard]`, sets `aria-busy="true"` and `disabled` on the
   submitter after the event has been dispatched, so the first submission goes through and a double click does not
   (F-75). Re-enables on `pageshow` with `persisted` (back/forward cache).
2. `signature-pad.ts` (only `/signature`): finds `[data-signature-pad]`, removes `hidden` from the drawing form (the
   typed-name form is always visible; without JS the page shows only it plus the `<noscript>` note, F-45).
   - Pointer Events for mouse, touch and pen; `touch-action: none` on the canvas; `setPointerCapture` on
     `pointerdown`; strokes end on `pointerup`, `pointercancel` and `lostpointercapture` (F-38, B-36, B-37).
   - Coordinates from `getBoundingClientRect()` and normalised to 0..1, using `getCoalescedEvents()` when present
     (F-39, B-38).
   - Backing store = CSS size x `devicePixelRatio`, recomputed by a `ResizeObserver`; on resize the stored normalised
     strokes are replayed once. During drawing only the newest segment is drawn (B-39).
   - Export: replay strokes onto an offscreen 720 x 240 canvas, `toDataURL('image/png')`, write the hidden input on
     every stroke end **and** in the `submit` handler (B-36).
   - "clear" button empties strokes, canvas and input (F-40).
   - Blank check on submit: no stroke or total normalised path length below a threshold blocks submit, writes
     "Please sign before submitting" into the form's `role="alert"` message and focuses it (F-41).
   - Pure geometry lives in `signature-pad.core.ts` (no DOM), unit-tested in Node.
3. The error summary needs no JavaScript (`autofocus`, ADR 0008). There is no theme toggle (it would need an inline
   script); dark mode follows `prefers-color-scheme` (maw-design-system section 5).

**Signature on an accent field.** The pad surface and the thank-you signature frame are flat vermilion fields
(`--color-accent`) with ink `#000` strokes (`--color-on-accent`, 6.60:1, never swaps). The stored PNG is black on
transparent and stays visible in light and dark mode without inverting images.

**Asset pipeline** (revised after critique: the first draft hashed files in place in `public/assets/`, the folder the
dev watchers also write to, so a manifest left by `pnpm build` made `pnpm dev` serve stale files, the renamed JS broke
its `sourceMappingURL`, and stale hashed files entered the Docker build context)

- **Separate output folders.** Committed static files stay in `public/` (icons, `site.webmanifest`, `robots.txt`).
  Generated files never go there:
  - production build: `dist/public/{assets,fonts}/` and `dist/signature-fonts/` (ADR 0005);
  - development: `.dev/public/{assets,fonts}/` and `.dev/signature-fonts/`.
    Both folders are gitignored and dockerignored (the image builds its own `dist/`). `pnpm build:assets` deletes
    `dist/public/` and `dist/signature-fonts/` first, so no stale hashed file survives.
- `pnpm build:css`: Tailwind CLI 4.3.5, `src/styles/main.css` to `dist/public/assets/app.css` (minified); then
  `scripts/hash-css.mjs` renames it to `app-<sha256-10>.css`. CSS has no source map, so renaming is safe.
- `pnpm build:client`: `scripts/build-client.mjs` (esbuild API) bundles `src/client/form-guard.ts` and
  `src/client/signature-pad.ts` with `entryNames: '[name]-[hash]'`, `sourcemap: 'linked'` and `metafile: true`.
  esbuild names the `.js` and `.js.map` consistently and writes a correct `//# sourceMappingURL`.
- `scripts/write-manifest.mjs` builds `dist/public/assets/manifest.json` (`{ "app.css": "app-<h>.css",
"form-guard.js": "form-guard-<h>.js", ... }`) from the esbuild metafile and the CSS hash step.
- `pnpm assets:fonts`: `scripts/copy-fonts.mjs <outDir>` copies `schibsted-grotesk-latin{,-ext}-{400,500}-normal.woff2`
  to `<outDir>/public/fonts/` and the signature fonts to `<outDir>/signature-fonts/`.
- `src/shared/view/assets.ts` (`createAssetResolver({ mode, manifestPath })`): in `development` it **never reads a
  manifest** and returns plain paths served from `.dev/public/assets`; in `production` it requires the manifest
  (fail fast at startup if missing); tests inject a resolver that returns plain paths. The Handlebars helper
  `{{asset "app.css"}}` uses the injected resolver.
- Static serving: `/assets` from the output folder of the current mode, hashed files with `Cache-Control: public,
max-age=31536000, immutable`; `/fonts` with 30 days; root icons and `site.webmanifest` from `public/` with 1 day.
- **Compression only for static text assets.** `compression()` is mounted only on the `/assets` and `/fonts` static
  routers. Dynamic HTML is sent uncompressed, because it contains the session-wide CSRF token next to reflected input
  (city heading, `returnTo`, re-rendered form values), which is the BREACH precondition. A reverse proxy in production
  must not compress `text/html` either (noted in the deploy job). Pages are a few kilobytes, so the cost is small.
- Fonts are self-hosted, only weights 400 and 500, `font-display: swap`, `unicode-range` from fontsource, latin 400
  preloaded. No third-party request on any page (F-86). OFL licence copied to `LICENSES/OFL-SchibstedGrotesk.txt`.
- Icons: `public/favicon.svg` (wordmark "p" on a vermilion field), `public/apple-touch-icon.png` (180 px) and
  `public/icon-512.png`, generated once by `scripts/generate-icons.mjs` (@napi-rs/canvas) and committed;
  `public/site.webmanifest`; `public/robots.txt`.

## Alternatives considered

- **signature_pad (npm).** Good library, but the required behaviour is small, needs a fixed export size and normalised
  replay, and the pure core is easy to unit-test. One less runtime dependency in the browser.
- **Vite for the client.** Overkill for two entry files; esbuild is already in the tree through tsx.
- **Query-string cache busting (`app.css?v=sha`).** Some proxies ignore query strings; hashed filenames are robust.
- **Mint a new CSRF token per render instead of not compressing HTML.** Rejected: more moving parts than a filter on
  two static routes.

## Consequences

- `src/client/` has its own `tsconfig.json` (`lib: ["ES2024", "DOM", "DOM.Iterable"]`) and an ESLint block with
  browser globals; the server `tsconfig.json` excludes it. `pnpm typecheck` runs both.
- E2E tests draw with `page.mouse` and touch emulation (mobile project), release outside the canvas, and check the
  stored image via the thank-you page. `signature-pad.spec.ts` also runs in a WebKit iPhone project, because the
  pointer-capture and touch fixes (B-36, B-37) matter most on iOS Safari (ADR 0015).
- `assets.test.ts` asserts: development mode ignores a manifest that exists; production mode fails without one; the
  manifest maps every entry to a file that exists and whose `.map` reference resolves.
- `.dockerignore` adds `.dev/`, `public/assets/` and `public/fonts/` (the latter two only guard against leftovers from
  older checkouts).
