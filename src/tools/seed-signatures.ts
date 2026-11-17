/**
 * Generated "drawn" signatures for the seed (DATA-MODEL.md section 6): abstract, deterministic pen strokes instead of
 * photos or real signatures, so no attribution is needed and every run produces the same bytes for the same name.
 *
 * The seed passes every PNG from here through the production `validateDrawnSignature` before it is stored, exactly
 * like an upload from the signature pad, so the seed also proves that the validator accepts realistic input.
 */
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

import { SIGNATURE_HEIGHT as HEIGHT, SIGNATURE_WIDTH as WIDTH } from '../features/signature/index.js';

/** The pad's pen (ADR 0004): 3 px, round caps and joins, black on transparent. */
const LINE_WIDTH = 3;
const INK = '#000';
/** Keeps every stroke well inside the canvas, also with the pen width. */
const MARGIN = 16;

interface Point {
  x: number;
  y: number;
}

/** FNV-1a (32 bit) over the UTF-16 code units: a stable seed for the PRNG, the same name always draws the same. */
function hashName(name: string): number {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < name.length; index += 1) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93) >>> 0;
  }
  return hash;
}

/** mulberry32: a small, fast PRNG with a 32-bit state; plenty for picking stroke shapes. */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

function strokePolyline(context: SKRSContext2D, points: readonly Point[]): void {
  const [first, ...rest] = points;
  if (first === undefined) return;
  context.beginPath();
  context.moveTo(first.x, first.y);
  for (const point of rest) context.lineTo(point.x, point.y);
  context.stroke();
}

/**
 * The main stroke: a baseline-hugging cursive wave with 3 to 6 loops, like a run of joined `l` and `e` letters. The
 * curve is a prolate trochoid: the pen moves right while it circles and turns back at the top of each turn, which draws
 * one loop above the baseline per turn. Loop height, width and slant vary per name and per loop, so the waves do not
 * look stamped.
 */
function cursiveWave(random: () => number, startX: number, baseline: number): Point[] {
  const loops = 3 + Math.floor(random() * 4);
  // At most 140 + 480 px from the left edge, so the last loop and an underline still fit the 720 px canvas.
  const length = 340 + random() * 140;
  const advance = length / (2 * Math.PI * loops);
  const loopWidth = advance * (1.4 + random() * 0.8);
  const loopHeight = 50 + random() * 30;
  const slant = 0.15 + random() * 0.25;
  // Tall and short loops mixed, like ascenders next to small letters.
  const heights = Array.from({ length: loops + 1 }, () => 0.55 + random() * 0.7);
  const steps = loops * 48;

  return Array.from({ length: steps + 1 }, (_, step) => {
    const turn = (step / steps) * 2 * Math.PI * loops;
    const loop = Math.min(loops, Math.floor(turn / (2 * Math.PI)));
    const height = loopHeight * (heights[loop] ?? 1);
    // On the baseline at the start of every turn (cos 0 = 1), at `height` in its middle, where the pen turns back.
    const lift = (height * (1 - Math.cos(turn))) / 2;
    const x = startX + advance * turn + loopWidth * Math.sin(turn) + slant * lift;
    return { x: clamp(x, MARGIN, WIDTH - MARGIN), y: clamp(baseline - lift, MARGIN, HEIGHT - MARGIN) };
  });
}

/** A rising initial stroke, like a capital letter: up from below the baseline, a round turn, back down to the wave. */
function initialStroke(context: SKRSContext2D, random: () => number, startX: number, baseline: number): void {
  const top = clamp(baseline - 100 - random() * 40, MARGIN, baseline - 60);
  const foot = baseline + 10 + random() * 14;
  const reach = 14 + random() * 12;
  context.beginPath();
  context.moveTo(startX - 40, foot);
  context.bezierCurveTo(startX - 30, baseline - 40, startX - reach, top, startX, top);
  context.bezierCurveTo(startX + reach, top, startX + 8, baseline - 30, startX, baseline);
  context.stroke();
}

/** An underline flourish under the wave, slightly sagging, ending in a small upward flick. */
function underline(context: SKRSContext2D, random: () => number, from: number, to: number, baseline: number): void {
  const y = clamp(baseline + 24 + random() * 18, baseline + 20, HEIGHT - MARGIN - 8);
  const sag = 6 + random() * 10;
  const end = clamp(to + 20, from + 100, WIDTH - MARGIN);
  context.beginPath();
  context.moveTo(from, y);
  context.quadraticCurveTo((from + end) / 2, y + sag, end, y - 4);
  context.lineTo(end + 10, y - 12);
  context.stroke();
}

/**
 * A 720 x 240 PNG with 1 to 3 pen strokes for `fullName`: always the cursive wave, usually a rising initial stroke
 * before it and sometimes an underline flourish. Deterministic: the PRNG is seeded by a hash of the name.
 */
export async function renderGeneratedSignature(fullName: string): Promise<Buffer> {
  const random = createRandom(hashName(fullName));
  const canvas = createCanvas(WIDTH, HEIGHT);
  const context = canvas.getContext('2d');
  context.strokeStyle = INK;
  context.lineWidth = LINE_WIDTH;
  context.lineCap = 'round';
  context.lineJoin = 'round';

  const baseline = 150 + random() * 30;
  const startX = 80 + random() * 60;
  const withInitial = random() < 0.7;
  const withUnderline = random() < 0.4;

  const wave = cursiveWave(random, startX, baseline);
  if (withInitial) initialStroke(context, random, startX, baseline);
  strokePolyline(context, wave);
  if (withUnderline) {
    const waveEnd = wave.reduce((max, point) => Math.max(max, point.x), startX);
    underline(context, random, startX - 20, waveEnd, baseline);
  }

  return canvas.encode('png');
}
