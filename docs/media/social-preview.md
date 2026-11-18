# Social preview

`social-preview.png` (1280 × 640) is the image GitHub shows when someone links the repository. It is not a screenshot:
it is a small poster in the same visual language as the app, black and white with petition's vermilion as one flat
field, 1px rules instead of boxes and Schibsted Grotesk as the only typeface. No shadows, rounded corners or gradients.

The source is [e2e/social-preview.html](../../e2e/social-preview.html), rendered by
[e2e/social-preview.spec.ts](../../e2e/social-preview.spec.ts).

## The idea

Signing is a line: a name above a rule, a count that grows by one. The image is cut once, vertically. The paper on the
left names the project and lists two things it does; the vermilion field on the right counts the supporters and leaves
an empty line to sign on. Both halves share their baselines and row geometry, so they read as one sentence.

## Composition

- **The cut:** paper from 0 to 832px, vermilion `#f85d33` (`--color-vermilion`, petition's accent in
  [src/styles/tokens.css](../../src/styles/tokens.css)) from 832px to the right edge, full height.
- **Shared baselines:** the repository name "petition" (168px, weight 500) and the count "64" (168px, weight 400) sit
  on one baseline; "A petition for absolutely nothing." and "supporters" (31px) sit on the next. 64 is the number of
  supporters the demo seeds; the generator fails when the seed and the image disagree.
- **Rows:** two list rows in the app's pattern, title left (21px), muted meta right (15px, slightly tracked), a 1px
  `#a8a8a8` rule below. The field repeats the row geometry: its first rule, in black, is the signature line with a
  small "×", and the label "signature" sits on the second row's baseline. The signature pad in the app is vermilion
  too.
- **Header:** "Arnoldovna/petition" left, "2018, rebuilt in 2026" right in muted grey, closed by a 1px black rule.
- **Type:** four sizes (168, 31, 21 and 15px) and two weights (400 and 500).
- **Safe area:** all text and rules sit inside a 96px horizontal and 64px vertical inset (x 96–1184, y 64–576). Only
  the colour field bleeds to the edge, so a social platform's crop loses nothing that carries meaning.
- **Contrast:** black on paper 21:1, the muted grey `#606060` on paper 6.29:1, black on vermilion 6.60:1. There is no
  white or grey text on the field.

## Typeface and licence

Only Schibsted Grotesk 400 and 500 (SIL Open Font License 1.1), loaded from the repository's own
`@fontsource/schibsted-grotesk` package; the licence is in
[LICENSES/OFL-SchibstedGrotesk.txt](../../LICENSES/OFL-SchibstedGrotesk.txt). A browser draws a character the font
lacks in a fallback font without any warning, so the generator checks every character against the code points the
shipped font files cover and fails on a gap. That is why the header has no arrow: the font has no "→".

## Regenerate and upload

The image is rendered with the README media, against the running demo:

```bash
pnpm demo
E2E_BASE_URL=http://127.0.0.1:3000 pnpm media:readme                  # all README media
E2E_BASE_URL=http://127.0.0.1:3000 pnpm media:readme social-preview   # only this image
```

Use the URL `pnpm demo` prints. The social preview itself needs no server, but the media config requires the URL.

GitHub has no API for the social preview: upload `docs/media/social-preview.png` in the repository settings under
General → Social preview. The step is on the checklist in [docs/OPERATIONS.md](../OPERATIONS.md) section 3.
