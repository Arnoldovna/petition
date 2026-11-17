import { describe, expect, it } from 'vitest';

import {
  backingStoreSize,
  BLANK_MESSAGE,
  clippedLength,
  createStrokeRecorder,
  drawDot,
  drawSegment,
  inkLength,
  isBlank,
  lineWidthFor,
  MIN_INK_LENGTH,
  normalisePoint,
  parseDimension,
  replay,
  type PenContext,
  type Point,
  type Stroke,
} from '../signature-pad.core.ts';

/** The fixed export size (ADR 0004 item 1); the browser reads it from the canvas data attributes. */
const EXPORT = { width: 720, height: 240 };

type PenCall = readonly [string, ...number[]];

/** A `PenContext` that records every call, with the line width at the time of each stroke or fill. */
function recordingContext(): PenContext & { calls: PenCall[] } {
  const calls: PenCall[] = [];
  return {
    calls,
    lineWidth: 1,
    beginPath: () => calls.push(['beginPath']),
    moveTo: (x, y) => calls.push(['moveTo', x, y]),
    lineTo: (x, y) => calls.push(['lineTo', x, y]),
    arc: (x, y, radius, start, end) => calls.push(['arc', x, y, radius, start, end]),
    stroke() {
      calls.push(['stroke', this.lineWidth]);
    },
    fill() {
      calls.push(['fill', this.lineWidth]);
    },
  };
}

/** A horizontal stroke at mid height from x0 to x1 (normalised), in `steps` segments. */
function horizontal(x0: number, x1: number, steps = 4): Stroke {
  return Array.from({ length: steps + 1 }, (_, index) => ({ x: x0 + ((x1 - x0) * index) / steps, y: 0.5 }));
}

describe('normalisePoint', () => {
  it('F-39, B-38: maps client coordinates through the bounding rect, whatever the scroll or offset', () => {
    // A pad 600 x 200 CSS px whose top left is at (150, 420) in the viewport, e.g. scrolled inside a positioned box.
    const rect = { left: 150, top: 420, width: 600, height: 200 };

    expect(normalisePoint(150, 420, rect)).toEqual({ x: 0, y: 0 });
    expect(normalisePoint(750, 620, rect)).toEqual({ x: 1, y: 1 });
    expect(normalisePoint(450, 470, rect)).toEqual({ x: 0.5, y: 0.25 });
  });

  it('F-38, B-36: keeps positions outside the pad (pointer capture), so the stroke continues past the edge', () => {
    const rect = { left: 0, top: 0, width: 300, height: 100 };

    expect(normalisePoint(-30, 150, rect)).toEqual({ x: -0.1, y: 1.5 });
  });

  it('B-38: a pad without layout size maps to the origin instead of producing NaN or Infinity', () => {
    expect(normalisePoint(10, 10, { left: 0, top: 0, width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
  });
});

describe('backingStoreSize', () => {
  it('F-39, B-38: scales the backing store by devicePixelRatio for crisp HiDPI lines', () => {
    expect(backingStoreSize(600, 200, 1)).toEqual({ width: 600, height: 200 });
    expect(backingStoreSize(600, 200, 2)).toEqual({ width: 1200, height: 400 });
    expect(backingStoreSize(366, 122, 3)).toEqual({ width: 1098, height: 366 });
  });

  it('F-39: rounds fractional sizes and clamps odd ratios to 1..3', () => {
    expect(backingStoreSize(333.4, 111.1, 1.5)).toEqual({ width: 500, height: 167 });
    expect(backingStoreSize(600, 200, 0.5)).toEqual({ width: 600, height: 200 });
    expect(backingStoreSize(600, 200, 4)).toEqual({ width: 1800, height: 600 });
    expect(backingStoreSize(600, 200, Number.NaN)).toEqual({ width: 600, height: 200 });
  });

  it('F-83: never returns an empty surface', () => {
    expect(backingStoreSize(0, 0, 2)).toEqual({ width: 1, height: 1 });
  });
});

describe('lineWidthFor', () => {
  it('F-83, F-39: the line is proportional to the pad width, so screen and export look alike', () => {
    expect(lineWidthFor(EXPORT)).toBe(5);
    expect(lineWidthFor({ width: 1440, height: 480 })).toBe(10);
    expect(lineWidthFor({ width: 360, height: 120 })).toBe(2.5);
  });
});

describe('clippedLength', () => {
  it('counts a segment inside the surface in full', () => {
    expect(clippedLength({ x: 0, y: 0 }, { x: 30, y: 40 }, 720, 240)).toBe(50);
  });

  it('F-38: counts only the part of a segment inside the surface', () => {
    expect(clippedLength({ x: -100, y: 120 }, { x: 100, y: 120 }, 720, 240)).toBe(100);
    expect(clippedLength({ x: 700, y: 10 }, { x: 800, y: 10 }, 720, 240)).toBe(20);
    expect(clippedLength({ x: -72, y: -24 }, { x: 792, y: 264 }, 720, 240)).toBeCloseTo(Math.hypot(720, 240));
  });

  it('F-38: a segment entirely outside the surface has no length', () => {
    expect(clippedLength({ x: -50, y: 10 }, { x: -10, y: 200 }, 720, 240)).toBe(0);
    expect(clippedLength({ x: 10, y: 300 }, { x: 700, y: 300 }, 720, 240)).toBe(0);
    expect(clippedLength({ x: -20, y: 10 }, { x: 10, y: -20 }, 720, 240)).toBe(0);
  });
});

describe('inkLength and isBlank', () => {
  it('F-41: no stroke is blank', () => {
    expect(inkLength([], EXPORT)).toBe(0);
    expect(isBlank([], EXPORT)).toBe(true);
  });

  it('F-41: taps (single points) and a tiny scribble are blank, so the client blocks them like the server', () => {
    const taps: Stroke[] = [[{ x: 0.5, y: 0.5 }], [{ x: 0.2, y: 0.3 }]];
    const scribble = horizontal(0.5, 0.5 + 50 / 720);

    expect(isBlank(taps, EXPORT)).toBe(true);
    expect(inkLength([scribble], EXPORT)).toBeCloseTo(50);
    expect(isBlank([scribble], EXPORT)).toBe(true);
  });

  it('F-41: a real stroke is not blank, and the lengths of several strokes add up', () => {
    const half = horizontal(0.5, 0.5 + MIN_INK_LENGTH / 2 / 720);

    expect(isBlank([horizontal(0.1, 0.9)], EXPORT)).toBe(false);
    expect(isBlank([half], EXPORT)).toBe(true);
    expect(isBlank([half, half], EXPORT)).toBe(false);
  });

  it('F-38, F-41: a stroke drawn mostly outside the pad only counts its visible part', () => {
    const outside = horizontal(-1, 0.05, 10);

    expect(inkLength([outside], EXPORT)).toBeCloseTo(36);
    expect(isBlank([outside], EXPORT)).toBe(true);
  });

  it('F-41: the threshold measures the export size, independent of the screen size', () => {
    const stroke = horizontal(0.4, 0.6);

    expect(inkLength([stroke], { width: 1440, height: 480 })).toBeCloseTo(2 * inkLength([stroke], EXPORT));
    expect(isBlank([stroke], EXPORT)).toBe(false);
  });

  it('F-41: the client message is the one the server uses for a blank pad', () => {
    expect(BLANK_MESSAGE).toBe('Please sign before submitting');
  });
});

describe('createStrokeRecorder', () => {
  const a: Point = { x: 0.1, y: 0.2 };
  const b: Point = { x: 0.2, y: 0.3 };
  const c: Point = { x: 0.3, y: 0.4 };
  const d: Point = { x: 0.4, y: 0.5 };

  it('F-38: records one stroke per pointer down to pointer up', () => {
    const recorder = createStrokeRecorder();

    expect(recorder.begin(1, a)).toBe(true);
    expect(recorder.drawing).toBe(true);
    recorder.extend(1, [b]);
    expect(recorder.end(1)).toBe(true);
    expect(recorder.drawing).toBe(false);
    recorder.begin(1, c);
    recorder.extend(1, [d]);
    recorder.end(1);

    expect(recorder.strokes).toEqual([
      [a, b],
      [c, d],
    ]);
  });

  it('B-39: extend returns only the newest segment (previous point plus the new ones), never the whole stroke', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(7, a);

    expect(recorder.extend(7, [b])).toEqual([a, b]);
    // Coalesced positions of one move arrive together and are drawn as one short path.
    expect(recorder.extend(7, [c, d])).toEqual([b, c, d]);
    expect(recorder.strokes).toEqual([[a, b, c, d]]);
  });

  it('F-38, B-37: a second pointer (another finger) neither starts nor extends a stroke while one is drawing', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(1, a);

    expect(recorder.begin(2, c)).toBe(false);
    expect(recorder.extend(2, [d])).toEqual([]);
    expect(recorder.end(2)).toBe(false);
    expect(recorder.drawing).toBe(true);
    expect(recorder.strokes).toEqual([[a]]);
  });

  it('B-36: ending is idempotent, so pointerup followed by lostpointercapture ends the stroke once', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(1, a);

    expect(recorder.end(1)).toBe(true);
    expect(recorder.end(1)).toBe(false);
  });

  it('F-38: moves without a pressed pointer or without positions record nothing', () => {
    const recorder = createStrokeRecorder();

    expect(recorder.extend(1, [a])).toEqual([]);
    recorder.begin(1, a);
    expect(recorder.extend(1, [])).toEqual([]);
    expect(recorder.strokes).toEqual([[a]]);
  });

  it('F-40: clear removes every stroke and ends a running one', () => {
    const recorder = createStrokeRecorder();
    recorder.begin(1, a);
    recorder.extend(1, [b]);
    recorder.end(1);
    recorder.begin(1, c);

    recorder.clear();

    expect(recorder.strokes).toEqual([]);
    expect(recorder.drawing).toBe(false);
    expect(recorder.extend(1, [d])).toEqual([]);
    expect(recorder.begin(2, d)).toBe(true);
    expect(recorder.strokes).toEqual([[d]]);
  });
});

describe('drawing', () => {
  it('F-38: drawDot marks the start of a stroke with a filled circle of the line width', () => {
    const context = recordingContext();
    context.lineWidth = 6;

    drawDot(context, { x: 0.5, y: 0.25 }, { width: 600, height: 200 });

    expect(context.calls).toEqual([['beginPath'], ['arc', 300, 50, 3, 0, Math.PI * 2], ['fill', 6]]);
  });

  it('B-39, F-39: drawSegment draws one path in device pixels of the surface', () => {
    const context = recordingContext();

    drawSegment(
      context,
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 0.5 },
        { x: 1, y: 1 },
      ],
      { width: 1200, height: 400 },
    );

    expect(context.calls).toEqual([
      ['beginPath'],
      ['moveTo', 0, 0],
      ['lineTo', 600, 200],
      ['lineTo', 1200, 400],
      ['stroke', 1],
    ]);
  });

  it('B-39: drawSegment ignores fewer than two points', () => {
    const context = recordingContext();

    drawSegment(context, [], EXPORT);
    drawSegment(context, [{ x: 0.5, y: 0.5 }], EXPORT);

    expect(context.calls).toEqual([]);
  });

  it('F-39, ADR 0004: replay draws every stroke at the surface size with its proportional line width', () => {
    const context = recordingContext();
    const strokes: Stroke[] = [
      [{ x: 0.5, y: 0.5 }],
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      [],
    ];

    replay(context, strokes, EXPORT);

    expect(context.lineWidth).toBe(5);
    expect(context.calls).toEqual([
      ['beginPath'],
      ['arc', 360, 120, 2.5, 0, Math.PI * 2],
      ['fill', 5],
      ['beginPath'],
      ['arc', 0, 0, 2.5, 0, Math.PI * 2],
      ['fill', 5],
      ['beginPath'],
      ['moveTo', 0, 0],
      ['lineTo', 720, 240],
      ['stroke', 5],
    ]);
  });

  it('F-83: replaying the same strokes on a resized pad scales positions and line width together', () => {
    const strokes: Stroke[] = [
      [
        { x: 0.25, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ],
    ];
    const small = recordingContext();
    const large = recordingContext();

    replay(small, strokes, { width: 360, height: 120 });
    replay(large, strokes, { width: 1440, height: 480 });

    expect(small.calls).toContainEqual(['lineTo', 270, 60]);
    expect(large.calls).toContainEqual(['lineTo', 1080, 240]);
    expect([small.lineWidth, large.lineWidth]).toEqual([2.5, 10]);
  });
});

describe('parseDimension', () => {
  it('ADR 0004: reads the export size from the data attributes', () => {
    expect(parseDimension('720')).toBe(720);
    expect(parseDimension('240')).toBe(240);
  });

  it('rejects missing, empty, zero, negative, fractional and oversized values', () => {
    for (const value of [undefined, '', '0', '-720', '720.5', '720px', ' 720', '100000']) {
      expect(parseDimension(value)).toBeUndefined();
    }
  });
});
