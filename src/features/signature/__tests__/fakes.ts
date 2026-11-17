import { crc32, deflateSync } from 'node:zlib';

import { createCanvas } from '@napi-rs/canvas';

import type { SignatureImageResult, SignatureImages } from '../image/index.js';
import { SIGNATURE_HEIGHT, SIGNATURE_REJECTIONS, SIGNATURE_WIDTH, type SignatureRejection } from '../image/index.js';
import type { SignatureRecord, SignatureRepository } from '../signature.repository.js';

/**
 * Fakes and fixtures of the signature feature (BUILD-ORDER.md rule 4): an in-memory repository and a scripted image
 * service for the service unit tests, and PNG builders for the image tests. The fixtures are generated here, never
 * copied from anywhere (ADR 0004 consequences).
 */

// ---------------------------------------------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------------------------------------------

export interface FakeSignatureRepository extends SignatureRepository {
  /** The "table": one record per user id, like `signatures_user_id_key`. */
  readonly rows: Map<number, SignatureRecord>;
  /** User ids whose account is gone: inserting for them is `not-found`, like `SIGNATURES_USER_FK`. */
  readonly deletedUsers: Set<number>;
}

export function createFakeSignatureRepository(): FakeSignatureRepository {
  const rows = new Map<number, SignatureRecord>();
  const deletedUsers = new Set<number>();
  return {
    rows,
    deletedUsers,
    insertIfAbsent: (record) => {
      if (deletedUsers.has(record.userId)) return Promise.resolve('not-found');
      if (rows.has(record.userId)) return Promise.resolve('already-signed');
      rows.set(record.userId, { ...record, image: Buffer.from(record.image) });
      return Promise.resolve('inserted');
    },
    findImage: (userId) => Promise.resolve(rows.get(userId)?.image),
    deleteByUser: (userId) => Promise.resolve(rows.delete(userId)),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Image service
// ---------------------------------------------------------------------------------------------------------------

export interface ScriptedSignatureImages extends SignatureImages {
  /** Every data URL `validateDrawnSignature` received. */
  readonly validated: string[];
  /** Every name `renderTypedSignature` received. */
  readonly rendered: string[];
}

export const rejectionOf = (reason: SignatureRejection): SignatureImageResult => ({
  ok: false,
  reason,
  message: SIGNATURE_REJECTIONS[reason],
});

/**
 * An image service whose answers the test decides: `drawn` is the result of every validation, `typed` the bytes of
 * every typed rendering. It records its calls, so a test can prove which bytes reach the repository.
 */
export function createScriptedSignatureImages(script: {
  drawn: SignatureImageResult;
  typed: Buffer;
}): ScriptedSignatureImages {
  const validated: string[] = [];
  const rendered: string[] = [];
  return {
    validated,
    rendered,
    validateDrawnSignature: (dataUrl) => {
      validated.push(dataUrl);
      return Promise.resolve(script.drawn);
    },
    renderTypedSignature: (name) => {
      rendered.push(name);
      return Promise.resolve(script.typed);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// PNG fixtures
// ---------------------------------------------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** One chunk: length, type, data, CRC over type and data. */
export function pngChunk(type: string, data: Buffer = Buffer.alloc(0)): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData));
  return Buffer.concat([length, typeAndData, crc]);
}

interface PngSpec {
  width: number;
  height: number;
  /** Default 8. */
  bitDepth?: number;
  /** PNG colour type: 0 grey, 2 RGB, 3 palette, 4 grey + alpha, 6 RGBA (default). */
  colorType?: number;
  /** Filtered scanlines (each row starts with its filter byte); default: all zero, a fully transparent image. */
  scanlines?: Buffer;
  /** Chunks between IHDR and IDAT (PLTE, tRNS, tEXt, ...). */
  extraChunks?: readonly Buffer[];
}

const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Bytes per scanline including the filter byte. */
export function scanlineLength(width: number, colorType = 6, bitDepth = 8): number {
  return 1 + Math.ceil((width * (CHANNELS[colorType] ?? 4) * bitDepth) / 8);
}

/** A hand-built, valid PNG: signature, IHDR, the extra chunks, one IDAT and IEND. */
export function buildPng({ width, height, bitDepth = 8, colorType = 6, scanlines, extraChunks = [] }: PngSpec): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.writeUInt8(bitDepth, 8);
  header.writeUInt8(colorType, 9);
  // compression 0, filter 0, interlace 0
  const raw = scanlines ?? Buffer.alloc(height * scanlineLength(width, colorType, bitDepth));
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    ...extraChunks,
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND'),
  ]);
}

/** `png` with `chunk` inserted right after IHDR (signature 8 bytes + IHDR chunk 25 bytes). */
export function withChunkAfterHeader(png: Buffer, chunk: Buffer): Buffer {
  const afterHeader = 8 + 25;
  return Buffer.concat([png.subarray(0, afterHeader), chunk, png.subarray(afterHeader)]);
}

export const toDataUrl = (bytes: Buffer): string => `data:image/png;base64,${bytes.toString('base64')}`;

/**
 * A realistic drawn signature as the browser exports it: 720 x 240 (or another size), transparent, black strokes.
 * `inkPixels` draws exactly that many single opaque pixels instead, for the ink threshold.
 */
export function drawnSignature({
  width = SIGNATURE_WIDTH,
  height = SIGNATURE_HEIGHT,
  inkPixels,
}: { width?: number; height?: number; inkPixels?: number } = {}): Promise<Buffer> {
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.strokeStyle = '#000';
  if (inkPixels === undefined) {
    context.lineWidth = 5;
    context.lineCap = 'round';
    context.beginPath();
    context.moveTo(50, 160);
    context.bezierCurveTo(150, 30, 230, 210, 330, 120);
    context.bezierCurveTo(410, 40, 510, 190, 650, 100);
    context.stroke();
  } else {
    // One pixel per cell of a 10 px grid: no anti-aliasing, so the count is exact.
    for (let index = 0; index < inkPixels; index += 1) {
      const x = (index * 10) % width;
      const y = Math.floor((index * 10) / width) * 10;
      context.fillRect(x, y, 1, 1);
    }
  }
  return canvas.encode('png');
}

/** Pixels with alpha > 0 in a 720 x 240 RGBA buffer. */
export function inkOf(data: Uint8ClampedArray): number {
  let inked = 0;
  for (let alpha = 3; alpha < data.length; alpha += 4) if ((data[alpha] ?? 0) > 0) inked += 1;
  return inked;
}
