import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, test } from '@playwright/test';

import { PRIMARY } from '../src/features/signature/image/glyphs.generated.ts';
import { glyphSetFromRanges } from '../src/shared/validation/fields.ts';
import { SEED_SUPPORTERS } from '../src/tools/seed-data.ts';

/**
 * The GitHub social preview (docs/media/social-preview.md), rendered from e2e/social-preview.html by
 * `pnpm media:readme` together with the README screenshots, never in CI. It needs no server: the page is a local file.
 * GitHub has no API for the image, so it is uploaded by hand (docs/OPERATIONS.md section 3).
 *
 * Two guards keep the image honest:
 * - The browser silently draws a character the font lacks in a fallback font, so every character must be one the
 *   shipped Schibsted Grotesk files map to a glyph. `PRIMARY` lists exactly those code points (generated from the
 *   latin and latin-ext files with fontkit, drift-tested; weights 400 and 500 cover the same characters).
 * - The count is the number of supporters the demo seeds, so the image cannot drift from the demo it advertises.
 */
const SOURCE = resolve(import.meta.dirname, 'social-preview.html');
/** Resolved from this file, not the working directory, so the image always lands in the repository's docs/media. */
const OUT = resolve(import.meta.dirname, '..', 'docs', 'media', 'social-preview.png');

const SCHIBSTED_GLYPHS = glyphSetFromRanges(PRIMARY);

test.use({ viewport: { width: 1280, height: 640 }, deviceScaleFactor: 1 });

test('@media social preview: 1280 x 640, Schibsted Grotesk only', async ({ page }) => {
  await page.goto(pathToFileURL(SOURCE).href);
  const { text, loadedFaces } = await page.evaluate(async () => {
    await document.fonts.ready;
    return {
      text: document.body.textContent,
      loadedFaces: [...document.fonts]
        .filter((face) => face.status === 'loaded')
        .map((face) => `${face.family.replaceAll(/["']/g, '')} ${face.weight}`),
    };
  });

  const withoutGlyph = [...new Set(text)].filter(
    (character) => !/\s/.test(character) && !SCHIBSTED_GLYPHS.has(character.codePointAt(0) ?? -1),
  );
  expect(withoutGlyph, 'characters Schibsted Grotesk has no glyph for').toEqual([]);
  expect(new Set(loadedFaces), 'font faces in use').toEqual(
    new Set(['Schibsted Grotesk 400', 'Schibsted Grotesk 500']),
  );
  await expect(page.locator('.preview__count')).toHaveText(String(SEED_SUPPORTERS.length));

  await page.screenshot({ path: OUT });
});
