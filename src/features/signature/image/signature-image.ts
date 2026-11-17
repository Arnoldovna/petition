/**
 * Drawn-signature validation (ADR 0004 item 3) and typed-name rendering (ADR 0005), built on @napi-rs/canvas.
 * Every rejection reason and both fonts are covered in `__tests__/signature-image.test.ts`.
 */
import { createCanvas, loadImage, type Image, type SKRSContext2D } from '@napi-rs/canvas';

import {
  MIN_INK_PIXELS,
  SIGNATURE_HEIGHT,
  SIGNATURE_MAX_BYTES,
  SIGNATURE_REJECTIONS,
  SIGNATURE_WIDTH,
  type SignatureImageResult,
  type SignatureRejection,
} from './constants.js';
import type { SignatureFonts } from './fonts.js';
import { inspectPngHeader, isCompletePng } from './png.js';

const DATA_URL_PREFIX = 'data:image/png;base64,';
/**
 * At most 87,400 base64 characters after the prefix (ADR 0004 item 3.1): enough for 65,550 bytes, so an upload just
 * above `SIGNATURE_MAX_BYTES` still decodes and is reported as too large rather than as malformed.
 */
const MAX_BASE64_LENGTH = 87_400;
/**
 * Canonical base64 as `HTMLCanvasElement.toDataURL` writes it: groups of four alphabet characters, padding only at the
 * end. `Buffer.from(..., 'base64')` would silently skip anything else (whitespace, `-`, `_`, stray `=`).
 */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
/**
 * Smallest PNG the database accepts (`signatures_image_size_chk`, DATA-MODEL.md section 3); a rendered signature is
 * always far larger.
 */
const MIN_STORED_BYTES = 67;

/** Ink of a typed signature (ADR 0005); the stored PNG is black on transparent and sits on an accent field. */
const INK = '#000';
const FONT_WEIGHT = 500;
const START_FONT_SIZE = 96;
const MIN_FONT_SIZE = 32;
const FONT_SIZE_STEP = 4;
/** 32 px padding on each side of the 720 px canvas. */
const TEXT_MAX_WIDTH = SIGNATURE_WIDTH - 2 * 32;

const reject = (reason: SignatureRejection): SignatureImageResult => ({
  ok: false,
  reason,
  message: SIGNATURE_REJECTIONS[reason],
});

/** The base64 payload of a well-formed PNG data URL within the length limit, else `undefined` (step 1). */
function base64Payload(dataUrl: string): string | undefined {
  if (!dataUrl.startsWith(DATA_URL_PREFIX)) return undefined;
  const payload = dataUrl.slice(DATA_URL_PREFIX.length);
  return payload.length <= MAX_BASE64_LENGTH && BASE64.test(payload) ? payload : undefined;
}

/** Full decode (step 4). Skia reports undecodable data by rejecting; that is a damaged upload, not a server error. */
async function decode(bytes: Buffer): Promise<Image | undefined> {
  try {
    return await loadImage(bytes);
  } catch {
    return undefined;
  }
}

/** Pixels with alpha > 0 (step 5, ADR 0004 item 3.5). RGBA order, so every fourth byte is alpha. */
function countInk(context: SKRSContext2D): number {
  const { data } = context.getImageData(0, 0, SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
  let inked = 0;
  for (let alpha = 3; alpha < data.length; alpha += 4) {
    if ((data[alpha] ?? 0) > 0) inked += 1;
  }
  return inked;
}

/**
 * The ADR 0004 pipeline for the `signature` form field: data-URL format and length, base64 decode and size, PNG header
 * and dimensions (`inspectPngHeader`), structure (`isCompletePng`) and full decode, ink check, re-encode. Resolves with
 * the canonical re-encoded bytes or a rejection reason; rejects only on an unexpected internal error.
 */
export async function validateDrawnSignature(dataUrl: string): Promise<SignatureImageResult> {
  const payload = base64Payload(dataUrl);
  if (payload === undefined) return reject('format');
  const bytes = Buffer.from(payload, 'base64');
  if (bytes.length === 0) return reject('format');
  if (bytes.length > SIGNATURE_MAX_BYTES) return reject('too-large');

  const size = inspectPngHeader(bytes);
  if (size === null) return reject('not-png');
  if (size.width !== SIGNATURE_WIDTH || size.height !== SIGNATURE_HEIGHT) return reject('dimensions');
  if (!isCompletePng(bytes)) return reject('corrupt');

  const image = await decode(bytes);
  if (image === undefined) return reject('corrupt');
  // The header was checked; a decoder that disagrees about the size means the file lies about itself.
  if (image.width !== SIGNATURE_WIDTH || image.height !== SIGNATURE_HEIGHT) return reject('corrupt');

  const canvas = createCanvas(SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);
  if (countInk(context) < MIN_INK_PIXELS) return reject('blank');

  // Step 6: only these freshly encoded pixels are stored, never the upload (text chunks and polyglot payloads go).
  const png = await canvas.encode('png');
  if (png.length > SIGNATURE_MAX_BYTES) return reject('too-large');
  return { ok: true, png };
}

const fontAt = (size: number, family: string): string => `${String(FONT_WEIGHT)} ${String(size)}px "${family}"`;

/**
 * Draws a name that already passed the `typedName` rule (ADR 0005): one family for the whole name
 * (`fonts.familyFor`), 720 x 240 transparent canvas, ink `#000`, 96 px shrinking in 4 px steps until the text fits
 * 656 px (minimum 32 px), centred horizontally and vertically on its ink. A long name that is still wider at 32 px is
 * condensed to 656 px by `fillText`'s `maxWidth`. The PNG passes the same header and size checks as a drawn signature;
 * failing them is a bug and rejects.
 */
export async function renderTypedSignature(name: string, fonts: SignatureFonts): Promise<Buffer> {
  const family = fonts.familyFor(name);
  const canvas = createCanvas(SIGNATURE_WIDTH, SIGNATURE_HEIGHT);
  const context = canvas.getContext('2d');
  context.fillStyle = INK;
  context.textAlign = 'center';
  context.textBaseline = 'alphabetic';

  let fontSize = START_FONT_SIZE;
  context.font = fontAt(fontSize, family);
  while (fontSize > MIN_FONT_SIZE && context.measureText(name).width > TEXT_MAX_WIDTH) {
    fontSize -= FONT_SIZE_STEP;
    context.font = fontAt(fontSize, family);
  }

  // Centre the ink, not the em box: the baseline sits half the ink height below the middle, shifted by the descent.
  const { actualBoundingBoxAscent, actualBoundingBoxDescent } = context.measureText(name);
  const baseline = (SIGNATURE_HEIGHT + actualBoundingBoxAscent - actualBoundingBoxDescent) / 2;
  context.fillText(name, SIGNATURE_WIDTH / 2, baseline, TEXT_MAX_WIDTH);

  const png = await canvas.encode('png');
  const size = inspectPngHeader(png);
  if (
    size?.width !== SIGNATURE_WIDTH ||
    size.height !== SIGNATURE_HEIGHT ||
    png.length < MIN_STORED_BYTES ||
    png.length > SIGNATURE_MAX_BYTES
  ) {
    throw new Error(`renderTypedSignature produced an invalid PNG (${String(png.length)} bytes)`);
  }
  return png;
}
