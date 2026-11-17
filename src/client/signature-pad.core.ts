/**
 * Pure geometry and stroke state of the signature pad (ADR 0010, F-38 to F-41, B-36 to B-39). No DOM access: the
 * browser entry `signature-pad.ts` feeds pointer positions in and hands a 2D context to the drawing functions, so
 * everything here runs and is unit-tested in Node.
 *
 * Points are normalised to 0..1 of the pad (x to the right, y downwards). The same strokes are drawn on the visible
 * canvas at any size and pixel ratio and replayed onto the fixed 720 x 240 export (ADR 0004 item 1), so a resize never
 * loses or distorts a signature.
 */

/** A pointer position relative to the pad, 0..1 on both axes; values outside mean the pointer left the pad. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One continuous line from pointer down to pointer up. */
export type Stroke = readonly Point[];

/** The part of `DOMRect` that `normalisePoint` reads. */
export interface PadRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** A drawing surface in device pixels: the visible backing store or the export canvas. */
export interface Surface {
  readonly width: number;
  readonly height: number;
}

/** The part of `CanvasRenderingContext2D` the pad draws with, so tests can record the calls. */
export interface PenContext {
  lineWidth: number;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arc(x: number, y: number, radius: number, startAngle: number, endAngle: number): void;
  stroke(): void;
  fill(): void;
}

/** Line width as a share of the surface width: 5 px on the 720 px export, so screen and stored image look alike. */
const LINE_WIDTH_RATIO = 5 / 720;

/**
 * Below this total path length (in export pixels, inside the pad) a drawing counts as blank on the client (F-41): an
 * empty pad, taps and stray marks are blocked without a round trip. With the 5 px line, 60 px of path that does not
 * retrace itself ink about 300 pixels, twice the server's `MIN_INK_PIXELS` (150). Path length is not ink area, though:
 * a scribble that goes back and forth over the same few pixels passes here and is still rejected by the server, with
 * the same message (HTTP 422). The server's pixel count stays the authority (ADR 0004 item 3.5).
 */
export const MIN_INK_LENGTH = 60;

/** The backing store never exceeds three device pixels per CSS pixel (memory on very dense screens). */
const MAX_PIXEL_RATIO = 3;

/** The copy of the client blank check; identical to the server's `blank` rejection (ROUTES.md section 1). */
export const BLANK_MESSAGE = 'Please sign before submitting';

/** The export ink: black on transparent, visible on the accent field in light and dark mode (ADR 0010). */
export const EXPORT_INK = '#000';

/**
 * A pointer position in viewport coordinates (`clientX`, `clientY`) relative to the pad's
 * `getBoundingClientRect()`, so it matches the cursor at any scroll position, border or layout (F-39, B-38).
 * A rect without area (pad not laid out) maps everything to the origin instead of dividing by zero.
 */
export function normalisePoint(clientX: number, clientY: number, rect: PadRect): Point {
  if (rect.width <= 0 || rect.height <= 0) return { x: 0, y: 0 };
  return { x: (clientX - rect.left) / rect.width, y: (clientY - rect.top) / rect.height };
}

/**
 * Backing-store size for a pad of `cssWidth` x `cssHeight` CSS pixels at `pixelRatio`, so lines stay crisp on HiDPI
 * screens (F-39). The ratio is clamped to 1..`MAX_PIXEL_RATIO`; the result is at least 1 x 1 device pixels.
 */
export function backingStoreSize(cssWidth: number, cssHeight: number, pixelRatio: number): Surface {
  const ratio = Number.isFinite(pixelRatio) ? Math.min(Math.max(pixelRatio, 1), MAX_PIXEL_RATIO) : 1;
  return {
    width: Math.max(1, Math.round(cssWidth * ratio)),
    height: Math.max(1, Math.round(cssHeight * ratio)),
  };
}

/** The line width for a surface, proportional to its width (`LINE_WIDTH_RATIO`). */
export function lineWidthFor(surface: Surface): number {
  return surface.width * LINE_WIDTH_RATIO;
}

/**
 * Length of the segment `from` to `to` that lies inside the `width` x `height` rectangle at the origin
 * (Liang-Barsky clipping). Pointer capture keeps a stroke going outside the pad (F-38), but only the visible part
 * counts as ink.
 */
export function clippedLength(from: Point, to: Point, width: number, height: number): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  let enter = 0;
  let exit = 1;
  // Each pair is (p, q) for the edges left, right, top, bottom: the segment is inside where p * t <= q.
  const edges: readonly (readonly [number, number])[] = [
    [-dx, from.x],
    [dx, width - from.x],
    [-dy, from.y],
    [dy, height - from.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return 0;
      continue;
    }
    const t = q / p;
    if (p < 0) enter = Math.max(enter, t);
    else exit = Math.min(exit, t);
    if (enter > exit) return 0;
  }
  return (exit - enter) * Math.hypot(dx, dy);
}

/** Total path length of all strokes inside the pad, measured on a `surface` (normally the export size). */
export function inkLength(strokes: readonly Stroke[], surface: Surface): number {
  let total = 0;
  for (const stroke of strokes) {
    for (let index = 1; index < stroke.length; index += 1) {
      const from = stroke[index - 1];
      const to = stroke[index];
      if (from === undefined || to === undefined) continue;
      total += clippedLength(
        { x: from.x * surface.width, y: from.y * surface.height },
        { x: to.x * surface.width, y: to.y * surface.height },
        surface.width,
        surface.height,
      );
    }
  }
  return total;
}

/** The client blank check (F-41): no stroke, or less than `MIN_INK_LENGTH` export pixels of path inside the pad. */
export function isBlank(strokes: readonly Stroke[], exportSize: Surface): boolean {
  return inkLength(strokes, exportSize) < MIN_INK_LENGTH;
}

/** A dot where a stroke starts, so a tap leaves a mark (the line cap alone draws nothing for zero length). */
export function drawDot(context: PenContext, point: Point, surface: Surface): void {
  const radius = context.lineWidth / 2;
  context.beginPath();
  context.arc(point.x * surface.width, point.y * surface.height, radius, 0, Math.PI * 2);
  context.fill();
}

/**
 * Draws the polyline through `points` (at least two) as one path. While drawing, the pad calls it with only the
 * newest points plus the one before them, so the cost per pointer move stays constant (B-39).
 */
export function drawSegment(context: PenContext, points: readonly Point[], surface: Surface): void {
  const [first, ...rest] = points;
  if (first === undefined || rest.length === 0) return;
  context.beginPath();
  context.moveTo(first.x * surface.width, first.y * surface.height);
  for (const point of rest) context.lineTo(point.x * surface.width, point.y * surface.height);
  context.stroke();
}

/**
 * Draws all strokes onto a cleared surface: after a resize of the visible pad, and onto the export canvas. Sets the
 * line width for the surface; colour, caps and joins are the caller's.
 */
export function replay(context: PenContext, strokes: readonly Stroke[], surface: Surface): void {
  context.lineWidth = lineWidthFor(surface);
  for (const stroke of strokes) {
    const [first] = stroke;
    if (first === undefined) continue;
    drawDot(context, first, surface);
    drawSegment(context, stroke, surface);
  }
}

/** The stroke state of one pad: which pointer draws, and every finished or running stroke. */
export interface StrokeRecorder {
  /** All strokes, the running one included. */
  readonly strokes: readonly Stroke[];
  /** True while a pointer is down on the pad. */
  readonly drawing: boolean;
  /**
   * Starts a stroke for `pointerId` at `point`. Returns false (and records nothing) while another pointer draws, so a
   * second finger never starts a parallel line.
   */
  begin(pointerId: number, point: Point): boolean;
  /**
   * Adds `points` (the coalesced positions of one move) to the running stroke of `pointerId`. Returns the points to
   * draw now (the previous last point plus the new ones), or an empty list for any other pointer or no points.
   */
  extend(pointerId: number, points: readonly Point[]): readonly Point[];
  /** Ends the stroke of `pointerId`. Returns true when a stroke ended, false if it was not drawing (idempotent). */
  end(pointerId: number): boolean;
  /** Removes every stroke and ends a running one (F-40). */
  clear(): void;
}

export function createStrokeRecorder(): StrokeRecorder {
  let strokes: Point[][] = [];
  let current: Point[] | undefined;
  let activePointer: number | undefined;

  return {
    get strokes() {
      return strokes;
    },
    get drawing() {
      return activePointer !== undefined;
    },
    begin(pointerId, point) {
      if (activePointer !== undefined) return false;
      activePointer = pointerId;
      current = [point];
      strokes.push(current);
      return true;
    },
    extend(pointerId, points) {
      if (pointerId !== activePointer || current === undefined || points.length === 0) return [];
      const previous = current.at(-1);
      current.push(...points);
      return previous === undefined ? [...points] : [previous, ...points];
    },
    end(pointerId) {
      if (pointerId !== activePointer) return false;
      activePointer = undefined;
      current = undefined;
      return true;
    },
    clear() {
      strokes = [];
      current = undefined;
      activePointer = undefined;
    },
  };
}

/** Reads a positive integer from a data attribute value (the export size), or undefined when it is not one. */
export function parseDimension(value: string | undefined): number | undefined {
  if (value === undefined || !/^[1-9]\d{0,4}$/.test(value)) return undefined;
  return Number(value);
}
