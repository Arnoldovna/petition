import { resolve } from 'node:path';

import type { Page } from '@playwright/test';

import { expect } from './fixtures.ts';

/**
 * Shared helpers of the media specs (playwright.media.config.ts): the README screenshots (readme-media.spec.ts) and
 * the demo recording (demo-recording.spec.ts). Both run on demand against the seeded `pnpm demo` stack, never in CI.
 */

/** Resolved from this file, not the working directory, so the media always lands in the repository's docs/media. */
export const MEDIA_DIR = resolve(import.meta.dirname, '..', 'docs', 'media');

export const DESKTOP = { width: 1440, height: 900 } as const;
export const MOBILE = { width: 390, height: 844 } as const;

/** Phone emulation (touch, mobile viewport meta) for viewports below the 640px breakpoint. */
export function deviceOptions(viewport: { width: number }): { isMobile?: boolean; hasTouch?: boolean } {
  return viewport.width < 640 ? { isMobile: true, hasTouch: true } : {};
}

/** A point on the pad, 0..1 on both axes. */
type PadPoint = readonly [x: number, y: number];

/** Waits for the web fonts and the main landmark, so a capture never shows the fallback font. */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await expect(page.getByRole('main')).toBeVisible();
}

/** Control points of a cursive "Mara" with a flourish, then an underline: two strokes, smoothed below. */
const SIGNATURE_CONTROL_POINTS: readonly (readonly PadPoint[])[] = [
  [
    [0.08, 0.7],
    [0.11, 0.4],
    [0.135, 0.18],
    [0.155, 0.45],
    [0.175, 0.66],
    [0.2, 0.38],
    [0.225, 0.2],
    [0.245, 0.48],
    [0.265, 0.68],
    [0.3, 0.58],
    [0.335, 0.48],
    [0.315, 0.45],
    [0.29, 0.52],
    [0.295, 0.63],
    [0.32, 0.64],
    [0.34, 0.52],
    [0.345, 0.47],
    [0.35, 0.6],
    [0.365, 0.66],
    [0.385, 0.55],
    [0.4, 0.47],
    [0.415, 0.5],
    [0.43, 0.47],
    [0.445, 0.52],
    [0.455, 0.62],
    [0.48, 0.66],
    [0.51, 0.56],
    [0.53, 0.48],
    [0.515, 0.46],
    [0.49, 0.5],
    [0.49, 0.62],
    [0.515, 0.64],
    [0.535, 0.53],
    [0.54, 0.47],
    [0.545, 0.6],
    [0.56, 0.67],
    [0.62, 0.62],
    [0.72, 0.5],
    [0.8, 0.4],
  ],
  [
    [0.12, 0.84],
    [0.35, 0.8],
    [0.6, 0.79],
    [0.78, 0.76],
  ],
];

/** Catmull-Rom interpolation through `points`, `samples` points per segment, so the strokes curve like a pen line. */
function smooth(points: readonly PadPoint[], samples = 6): PadPoint[] {
  const at = (index: number): PadPoint => points[Math.min(Math.max(index, 0), points.length - 1)] ?? [0, 0];
  const result: PadPoint[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const [p0, p1, p2, p3] = [at(index - 1), at(index), at(index + 1), at(index + 2)];
    for (let step = 0; step < samples; step += 1) {
      const t = step / samples;
      const blend = (a: number, b: number, c: number, d: number): number =>
        0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t ** 2 + (3 * b - a - 3 * c + d) * t ** 3);
      result.push([blend(p0[0], p1[0], p2[0], p3[0]), blend(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  result.push(at(points.length - 1));
  return result;
}

/** Draws the "Mara" signature on the sign page's pad with the mouse (the pad takes mouse, pen and touch alike). */
export async function drawSignature(page: Page): Promise<void> {
  const pad = page.getByRole('img', { name: 'Signature pad' });
  await pad.scrollIntoViewIfNeeded();
  const box = await pad.boundingBox();
  if (!box) throw new Error('the signature pad is not visible');
  const toViewport = ([x, y]: PadPoint): [number, number] => [box.x + x * box.width, box.y + y * box.height];
  for (const stroke of SIGNATURE_CONTROL_POINTS.map((points) => smooth(points))) {
    const [first, ...rest] = stroke;
    if (!first) continue;
    await page.mouse.move(...toViewport(first));
    await page.mouse.down();
    for (const point of rest) await page.mouse.move(...toViewport(point), { steps: 2 });
    await page.mouse.up();
  }
}
