import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

/** Far longer than any finite animation or transition of the design (`--duration-*` in tokens.css: 400 ms at most). */
const SETTLE_TIMEOUT_MS = 5000;

/**
 * Waits until no finite CSS animation or transition runs any more: the flash fades in (F-85), and a hover or
 * colour-scheme change transitions colours, so axe would otherwise measure contrast on half-blended colours. Checked
 * again after two frames, because a transition can start one frame after the input that caused it. Bounded: an
 * animation that keeps restarting fails with its name instead of hanging until the test timeout.
 */
async function settleAnimations(page: Page): Promise<void> {
  const stillRunning = await page.evaluate(async (timeoutMs) => {
    const twoFrames = (): Promise<void> =>
      new Promise((resolve) => {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            resolve();
          });
        });
      });
    const nameOf = (animation: Animation): string =>
      animation instanceof CSSAnimation
        ? `animation ${animation.animationName}`
        : animation instanceof CSSTransition
          ? `transition ${animation.transitionProperty}`
          : 'script animation';
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      await twoFrames();
      const running = document
        .getAnimations()
        .filter(
          (animation) =>
            animation.playState === 'running' && animation.effect?.getComputedTiming().endTime !== Infinity,
        );
      if (running.length === 0) return [];
      const remaining = deadline - performance.now();
      if (remaining <= 0) return running.map(nameOf);
      await Promise.race([
        Promise.all(running.map((animation) => animation.finished.catch(() => undefined))),
        new Promise((resolve) => setTimeout(resolve, remaining)),
      ]);
    }
  }, SETTLE_TIMEOUT_MS);
  if (stillRunning.length > 0) {
    throw new Error(
      `settleAnimations: still running after ${String(SETTLE_TIMEOUT_MS)} ms: ${stillRunning.join(', ')}`,
    );
  }
}

/**
 * Fails on serious and critical WCAG 2.2 A/AA violations (Definition of Done: no critical axe findings), measured on
 * the settled page. Needs JavaScript in the page (axe-core runs there).
 */
export async function expectNoA11yViolations(page: Page): Promise<void> {
  await settleAnimations(page);
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const blocking = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(blocking, blocking.map((v) => `${v.id}: ${v.help} (${String(v.nodes.length)} nodes)`).join('\n')).toEqual([]);
}
