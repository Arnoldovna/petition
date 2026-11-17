# ADR 0014: Handlebars view architecture and modular CSS (Tailwind 4, BEM, maw tokens)

- Status: Accepted (reviewed in the architecture critique, 2026-11-15)
- Date: 2026-11-15
- Covers: B-01, B-17, B-41, B-45, B-46, B-63, B-64, B-65, B-66, B-67, B-69, B-72, B-73, B-74, B-75, B-76, B-77, B-78,
  B-79, B-80, B-81, B-82, B-83, F-12 to F-16, F-52, F-53, F-77 to F-85

## Context

Legacy built HTML in JavaScript template literals and printed it with triple-stash (B-01, stored XSS), had six
copy-pasted navigation partials (B-46), no layout landmarks (B-67), malformed HTML (B-73) and CSS with hard-coded
colours, magic numbers, IDs and duplicated blocks (B-76 to B-81).

## Decision

**Views**

- express-handlebars 9, extension `.hbs`, default layout `main` configured once (B-45), directories
  `src/views/{layouts,partials,pages}` resolved through `src/config/paths.ts`
  (`new URL('../../src/views', import.meta.url)`, valid from both `src/config` and `dist/config`).
- **Triple-stash `{{{ }}}` is forbidden** in every view. Helpers return plain strings, never HTML.
  `scripts/check-views.mjs` (part of `pnpm lint`) fails on `{{{`, on `target="_blank"`, on `style=` attributes and on
  inline `<script>` without `src`.
- One layout with fixed slots: `<meta charset="utf-8">` first (B-64), viewport meta (B-63), `<title>{{title}} ·
Nonsense Petition</title>` (F-16), skip link, `site-header` partial, `<main id="main" tabindex="-1">`, flash region
  `role="status"`, `site-footer` partial, then module scripts.
- One navigation partial driven by `viewer` and `currentPath` with `aria-current="page"` (F-14, B-46). Logout is a
  POST form button in the nav (B-08). The maw header pattern allows 1 to 3 links, so the nav never has more than three
  entries: guest "about, log in, register"; signed in "supporters, profile, log out". "about" moves to the footer for
  signed-in users (FEATURES F-14 amended, OVERVIEW.md section 2.2). No hamburger.
- Every page is rendered through `renderPage` (ADR 0003, 0008); `res.render` is banned elsewhere.
- **Partial parameter contracts are phase-1 API.** The parameter names and meanings in OVERVIEW.md section 15.2 are
  fixed in phase 1. Later phases may change a partial's markup and CSS, but adding, renaming or removing a parameter is
  a shared-file change request (BUILD-ORDER.md rule 2), because pages owned by other modules render these partials.
- Controllers pass a typed view model (`title`, page data, `form` with `values`, `errors`, `errorList`). Never DB rows.
- Handlebars helpers (registered once in `src/shared/view/engine.ts`): `asset`, `eq`, `plural count singular plural`,
  `formatCount` (en-GB grouping), `formatDate` (en-GB `15 Nov 2026`, zone `APP_TIME_ZONE`), `cityPath`,
  `pagePath basePath page`, `fieldId form name`, `currentAttr path` (returns `page` or empty).
- External user links (`homepage_url`) open in the **same tab** with `rel="noopener noreferrer nofollow ugc"`;
  internal links never use `_blank` (B-17, F-52).
- **Accent button once per view.** `button--primary` appears at most once per page (maw rule). On the sign page the
  drawing form's "sign the petition" is primary; the typed-name form's "sign with my typed name" is always
  `button--outlined`, with and without JavaScript. Confirmation pages use primary for the destructive action and a
  text link for "keep ...".
- Copy is reviewed against FEATURES F-77 and the maw copy rules (lowercase navigation and buttons, sentence case for
  content, no exclamation marks). `design-taste-frontend`'s `copy-lint.mjs` runs as a review lens in Phase 4.

**CSS** (skills `modular-css-tailwind4` and `maw-design-system`, binding)

- `src/styles/main.css`: `@import "tailwindcss" source(none);` then `fonts.css`, `tokens.css`, `base.css`,
  `utilities.css`, then every `components/*.css` listed alphabetically. Built by the Tailwind CLI to one minified,
  hashed file (B-82).
- `tokens.css` copied verbatim from `maw-design-system/templates/tokens.css`; only `--color-accent:
var(--color-vermilion)` changes (`#F85D33`). Default palette, shadows and radii are reset.
- One partial (or page-level block) = one BEM block = one file in `src/styles/components/`. No `@reference` in these
  files (recursion with main.css). `@layer components`, logical properties, container queries for components,
  `motion-safe` for every transition, global `:focus-visible` ring in `base.css` (B-66, B-83).
- `scripts/check-no-utilities.mjs` (copied verbatim) and `stylelint.config.mjs` (copied) enforce: no utility classes
  in markup, every class defined, no hex outside tokens, no IDs, no `!important`, no physical properties, nesting at
  most 2, no duplicate or overridden declarations (B-76 to B-80).
- Layout: one 1280 px column, gutters 12/20 px, sticky header from 640 px with `scroll-padding-top` from a token,
  `width: 100%` never `100vw` (B-78, B-81). Body text 16 px, contrast per maw section 4 (B-74).
- The full block inventory and file list is in OVERVIEW.md section 15.

## Consequences

- The scaffold must create `main.css` with imports for **all** planned component files plus a stub for each, so
  modules in later phases only edit files they own (BUILD-ORDER.md).
- Any markup class must exist in CSS before `pnpm verify` passes. Phases 2 and 3 add structural rules for the blocks
  they introduce; Phase 4 does the visual design.
