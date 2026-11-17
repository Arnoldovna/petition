import { deflateSync } from 'node:zlib';

import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';

import { buildPng, drawnSignature, pngChunk, scanlineLength, withChunkAfterHeader } from '../../__tests__/fakes.js';
import { inspectPngHeader, isCompletePng } from '../png.js';

/** The PNG checks in front of the decoder (ADR 0004 item 3.3; the structure check closes the truncation gap). */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** `png` without its last chunk (IEND, 12 bytes). */
const withoutEnd = (png: Buffer): Buffer => png.subarray(0, png.length - 12);

describe('inspectPngHeader', () => {
  it('ADR 0004, F-42: reads width and height from the IHDR of a canvas PNG', async () => {
    expect(inspectPngHeader(await drawnSignature())).toEqual({ width: 720, height: 240 });
    expect(inspectPngHeader(await drawnSignature({ width: 700, height: 241 }))).toEqual({ width: 700, height: 241 });
  });

  it('ADR 0004, B-19: JPEG bytes behind a PNG data-URL prefix have no PNG header', async () => {
    const jpeg = await createCanvas(720, 240).encode('jpeg');

    expect(inspectPngHeader(jpeg)).toBeNull();
  });

  it('ADR 0004, B-19: rejects data that is too short, has another signature, or does not start with IHDR', async () => {
    const png = await drawnSignature();
    const otherFirstChunk = Buffer.concat([PNG_SIGNATURE, pngChunk('tEXt', Buffer.alloc(13)), png.subarray(8)]);
    const wrongIhdrLength = Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', Buffer.alloc(14)), png.subarray(33)]);
    const damagedSignature = Buffer.from(png);
    damagedSignature[1] = 0x51;

    expect(inspectPngHeader(Buffer.alloc(0))).toBeNull();
    expect(inspectPngHeader(png.subarray(0, 32))).toBeNull();
    expect(inspectPngHeader(Buffer.from('GIF89a, then anything at all'))).toBeNull();
    expect(inspectPngHeader(damagedSignature)).toBeNull();
    expect(inspectPngHeader(otherFirstChunk)).toBeNull();
    expect(inspectPngHeader(wrongIhdrLength)).toBeNull();
  });
});

describe('isCompletePng', () => {
  it('ADR 0004: accepts canvas output and a hand-built PNG with extra chunks', async () => {
    expect(isCompletePng(await drawnSignature())).toBe(true);
    expect(
      isCompletePng(
        buildPng({ width: 720, height: 240, extraChunks: [pngChunk('tEXt', Buffer.from('Comment\0hello'))] }),
      ),
    ).toBe(true);
  });

  it('ADR 0004, B-19: rejects a truncated file, which the decoder would accept partly drawn', async () => {
    const png = await drawnSignature();

    expect(isCompletePng(png.subarray(0, Math.floor(png.length / 2)))).toBe(false);
    expect(isCompletePng(png.subarray(0, png.length - 1))).toBe(false);
    expect(isCompletePng(withoutEnd(png))).toBe(false);
  });

  it('ADR 0004, B-19: rejects a damaged chunk (CRC mismatch) and an unknown chunk-type shape', async () => {
    const png = await drawnSignature();
    const damaged = Buffer.from(png);
    damaged[png.length - 20] = (damaged[png.length - 20] ?? 0) ^ 0xff;
    const badType = withChunkAfterHeader(png, pngChunk('t3Xt', Buffer.from('x')));

    expect(isCompletePng(damaged)).toBe(false);
    expect(isCompletePng(badType)).toBe(false);
  });

  it('ADR 0004: rejects bytes after IEND (a polyglot carrier) and a non-empty IEND', async () => {
    const png = await drawnSignature();

    expect(isCompletePng(Buffer.concat([png, Buffer.from('<script>alert(1)</script>')]))).toBe(false);
    expect(isCompletePng(Buffer.concat([withoutEnd(png), pngChunk('IEND', Buffer.from('x'))]))).toBe(false);
  });

  it('ADR 0004: rejects a file without image data', () => {
    const header = buildPng({ width: 720, height: 240 }).subarray(0, 33);

    expect(isCompletePng(Buffer.concat([header, pngChunk('IEND')]))).toBe(false);
  });

  it('ADR 0004, B-19: rejects image data whose zlib stream is cut off, even with valid CRCs', () => {
    const compressed = deflateSync(Buffer.alloc(240 * scanlineLength(720)));
    const header = buildPng({ width: 720, height: 240 }).subarray(0, 33);
    const cut = Buffer.concat([
      header,
      pngChunk('IDAT', compressed.subarray(0, compressed.length - 6)),
      pngChunk('IEND'),
    ]);

    expect(isCompletePng(cut)).toBe(false);
  });

  it('ADR 0004: rejects a deflate bomb that inflates beyond the bound for a 720 x 240 image', () => {
    const bomb = deflateSync(Buffer.alloc(3 * 1024 * 1024));
    const header = buildPng({ width: 720, height: 240 }).subarray(0, 33);

    expect(bomb.length).toBeLessThan(65_536);
    expect(isCompletePng(Buffer.concat([header, pngChunk('IDAT', bomb), pngChunk('IEND')]))).toBe(false);
  });
});
