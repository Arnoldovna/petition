import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { beforeAll, describe, expect, it } from 'vitest';

import { testSignatureFontPaths } from '../../../../../test/fonts.js';
import {
  buildPng,
  drawnSignature,
  inkOf,
  pngChunk,
  scanlineLength,
  toDataUrl,
  withChunkAfterHeader,
} from '../../__tests__/fakes.js';
import { SIGNATURE_FONTS } from '../constants.js';
import { loadSignatureFonts, type SignatureFonts } from '../fonts.js';
import { createSignatureImages, type SignatureImageResult, type SignatureImages } from '../index.js';
import { inspectPngHeader } from '../png.js';
import { renderTypedSignature, validateDrawnSignature } from '../signature-image.js';

/**
 * The real ADR 0004 pipeline and the ADR 0005 renderer on @napi-rs/canvas, with the shipped fonts from node_modules
 * (`test/fonts.ts`). Every rejection reason has its own fixture, generated here.
 */

const UNREADABLE = 'The signature could not be read. Clear the pad and sign again.';
const BLANK = 'Please sign before submitting';

let images: SignatureImages;
let fonts: SignatureFonts;

beforeAll(() => {
  images = createSignatureImages({ fontPaths: testSignatureFontPaths() });
  fonts = loadSignatureFonts(testSignatureFontPaths());
});

async function pixelsOf(png: Buffer): Promise<Uint8ClampedArray> {
  const image = await loadImage(png);
  const context = createCanvas(image.width, image.height).getContext('2d');
  context.drawImage(image, 0, 0);
  return context.getImageData(0, 0, image.width, image.height).data;
}

/** Inclusive bounding box of the inked pixels of a 720 x 240 RGBA buffer. */
function inkBox(data: Uint8ClampedArray): { left: number; right: number; top: number; bottom: number } {
  const box = { left: 720, right: -1, top: 240, bottom: -1 };
  for (let index = 3; index < data.length; index += 4) {
    if ((data[index] ?? 0) === 0) continue;
    const pixel = (index - 3) / 4;
    const x = pixel % 720;
    const y = Math.floor(pixel / 720);
    box.left = Math.min(box.left, x);
    box.right = Math.max(box.right, x);
    box.top = Math.min(box.top, y);
    box.bottom = Math.max(box.bottom, y);
  }
  return box;
}

function expectRejected(result: SignatureImageResult, reason: string, message: string): void {
  expect(result).toEqual({ ok: false, reason, message });
}

describe('validateDrawnSignature: accepted drawings', () => {
  it('F-42, ADR 0004: accepts a 720 x 240 drawing and returns a re-encoded PNG of the same size', async () => {
    const upload = await drawnSignature();

    const result = await validateDrawnSignature(toDataUrl(upload));

    if (!result.ok) throw new Error(`rejected: ${result.reason}`);
    expect(inspectPngHeader(result.png)).toEqual({ width: 720, height: 240 });
    expect(result.png.length).toBeLessThanOrEqual(65_536);
    expect(inkOf(await pixelsOf(result.png))).toBe(inkOf(await pixelsOf(upload)));
  });

  it('ADR 0004 item 3.6: stores only re-encoded pixels: a text chunk (polyglot payload) does not survive', async () => {
    const payload = Buffer.from('Comment\0<script>alert(document.cookie)</script>', 'latin1');
    const upload = withChunkAfterHeader(await drawnSignature(), pngChunk('tEXt', payload));

    const result = await validateDrawnSignature(toDataUrl(upload));

    if (!result.ok) throw new Error(`rejected: ${result.reason}`);
    expect(upload.includes('<script>')).toBe(true);
    expect(result.png.includes('<script>')).toBe(false);
    expect(result.png.includes('tEXt')).toBe(false);
  });

  it('F-41, ADR 0004 item 3.5: exactly MIN_INK_PIXELS (150) inked pixels are a signature', async () => {
    const result = await validateDrawnSignature(toDataUrl(await drawnSignature({ inkPixels: 150 })));

    expect(result.ok).toBe(true);
  });
});

describe('validateDrawnSignature: rejections', () => {
  it('F-41, B-19: a transparent pad and 149 inked pixels are blank: "Please sign before submitting"', async () => {
    expectRejected(await validateDrawnSignature(toDataUrl(await drawnSignature({ inkPixels: 0 }))), 'blank', BLANK);
    expectRejected(await validateDrawnSignature(toDataUrl(await drawnSignature({ inkPixels: 149 }))), 'blank', BLANK);
  });

  it('F-42, B-19: anything but a canonical data:image/png;base64 URL is a format error', async () => {
    const base64 = (await drawnSignature()).toString('base64');

    for (const value of [
      '',
      'data:image/png;base64,',
      `data:image/jpeg;base64,${base64}`,
      `DATA:image/png;base64,${base64}`,
      `https://tracker.example/pixel.png`,
      `data:image/png,${base64}`,
      `data:image/png;base64,${base64.slice(0, -2)}`, // broken padding
      `data:image/png;base64,${base64.slice(0, 100)} ${base64.slice(100)}`,
      `data:image/png;base64,-_${base64.slice(2)}`, // URL-safe alphabet
      `data:image/png;base64,${'A'.repeat(87_404)}`, // over the 87,400-character limit
    ]) {
      expectRejected(await validateDrawnSignature(value), 'format', UNREADABLE);
    }
  });

  it('F-42, B-19: a decoded upload over 64 KiB is too large', async () => {
    // 87,400 characters are allowed and decode to 65,550 bytes, just above SIGNATURE_MAX_BYTES.
    const result = await validateDrawnSignature(`data:image/png;base64,${'A'.repeat(87_400)}`);

    expectRejected(result, 'too-large', UNREADABLE);
  });

  it('F-42, ADR 0004: a 70 KiB noise image is rejected before any decoding', async () => {
    const noise = Buffer.alloc(70 * 1024);
    for (let index = 0; index < noise.length; index += 1) noise[index] = (index * 7919 + 13) % 251;
    const upload = Buffer.concat([buildPng({ width: 720, height: 240 }).subarray(0, 33), noise]);

    const result = await validateDrawnSignature(toDataUrl(upload));

    expect(result).toMatchObject({ ok: false, message: UNREADABLE });
    expect(['format', 'too-large']).toContain(result.ok ? 'ok' : result.reason);
  });

  it('F-42, ADR 0004 item 3.6: a small upload whose re-encoded PNG exceeds 64 KiB is too large', async () => {
    // 2-bit palette noise in four colours: about 43 KB as uploaded, about 110 KB once re-encoded as 8-bit RGBA.
    const rowLength = scanlineLength(720, 3, 2);
    const scanlines = Buffer.alloc(240 * rowLength);
    let state = 0x2545f491;
    for (let index = 0; index < scanlines.length; index += 1) {
      // xorshift32: deterministic noise without a dependency
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      scanlines[index] = index % rowLength === 0 ? 0 : (state >>> 0) & 0xff;
    }
    const palette = pngChunk('PLTE', Buffer.from([255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0]));
    const transparency = pngChunk('tRNS', Buffer.from([255, 128, 64, 200]));
    const upload = buildPng({
      width: 720,
      height: 240,
      colorType: 3,
      bitDepth: 2,
      scanlines,
      extraChunks: [palette, transparency],
    });

    expect(upload.length).toBeLessThanOrEqual(65_536);
    expectRejected(await validateDrawnSignature(toDataUrl(upload)), 'too-large', UNREADABLE);
  });

  it('B-19, ADR 0004: JPEG bytes behind the PNG prefix are not a PNG', async () => {
    const jpeg = await createCanvas(720, 240).encode('jpeg');

    expectRejected(await validateDrawnSignature(toDataUrl(jpeg)), 'not-png', UNREADABLE);
    expectRejected(
      await validateDrawnSignature(toDataUrl(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))),
      'not-png',
      UNREADABLE,
    );
  });

  it('F-42: a PNG of another size than 720 x 240 is rejected', async () => {
    for (const size of [
      { width: 700, height: 240 },
      { width: 720, height: 241 },
      { width: 1440, height: 480 },
    ]) {
      expectRejected(await validateDrawnSignature(toDataUrl(await drawnSignature(size))), 'dimensions', UNREADABLE);
    }
  });

  it('F-42, B-19: a truncated or damaged PNG is corrupt, although the decoder would draw part of it', async () => {
    const png = await drawnSignature();
    const damaged = Buffer.from(png);
    damaged[png.length - 20] = (damaged[png.length - 20] ?? 0) ^ 0xff;

    for (const upload of [png.subarray(0, Math.floor(png.length / 2)), png.subarray(0, png.length - 12), damaged]) {
      expectRejected(await validateDrawnSignature(toDataUrl(upload)), 'corrupt', UNREADABLE);
    }
  });
});

describe('loadSignatureFonts', () => {
  it('ADR 0005: picks Schibsted Grotesk for Latin names and Noto Sans as soon as one letter needs it', () => {
    expect(fonts.familyFor("Łukasz Żółć O'Brien-Smith Jr.")).toBe(SIGNATURE_FONTS.primary.family);
    for (const name of ['Thanh Nguyễn', 'Ελένη Παπαδοπούλου', 'Пётр Ильич', 'Ada Ελένη']) {
      expect(fonts.familyFor(name), name).toBe(SIGNATURE_FONTS.fallback.family);
    }
  });

  it('ADR 0005: every glyph comes from the shipped subset files, never from a system font', () => {
    // Reference families registered from exactly one subset file each: if the signature family drew a letter from a
    // system font (Skia's fallback), its pixels would differ from the subset that holds the letter.
    const { primary, fallback } = testSignatureFontPaths();
    const references = [
      { family: SIGNATURE_FONTS.primary.family, file: primary[1], letters: ['Ł', 'ż', 'ğ'] },
      { family: SIGNATURE_FONTS.primary.family, file: primary[0], letters: ['a', 'é'] },
      { family: SIGNATURE_FONTS.fallback.family, file: fallback[2], letters: ['ễ'] },
      { family: SIGNATURE_FONTS.fallback.family, file: fallback[3], letters: ['Ε', 'λ'] },
      { family: SIGNATURE_FONTS.fallback.family, file: fallback[5], letters: ['П', 'ё'] },
    ];
    const draw = (family: string, letter: string): Buffer => {
      const context = createCanvas(160, 160).getContext('2d');
      context.font = `500 96px "${family}"`;
      context.fillText(letter, 20, 120);
      return Buffer.from(context.getImageData(0, 0, 160, 160).data);
    };

    references.forEach(({ family, file, letters }, index) => {
      if (file === undefined) throw new Error('missing font file');
      const alias = `SignatureSubsetReference${String(index)}`;
      expect(GlobalFonts.registerFromPath(file, alias)).not.toBeNull();
      for (const letter of letters) {
        const drawn = draw(family, letter);
        expect(inkOf(new Uint8ClampedArray(drawn)), letter).toBeGreaterThan(100);
        expect(drawn.equals(draw(alias, letter)), `${letter} in ${family}`).toBe(true);
      }
    });
  });
});

describe('renderTypedSignature', () => {
  it('F-45, ADR 0005: draws a Latin name as a valid 720 x 240 PNG that the drawn pipeline accepts', async () => {
    const png = await renderTypedSignature('Łukasz Żółć', fonts);

    expect(inspectPngHeader(png)).toEqual({ width: 720, height: 240 });
    expect(inkOf(await pixelsOf(png))).toBeGreaterThan(1000);
    expect((await validateDrawnSignature(toDataUrl(png))).ok).toBe(true);
  });

  it('F-45, ADR 0005: draws Vietnamese, Greek and Cyrillic names with the fallback font', async () => {
    for (const name of ['Thanh Nguyễn', 'Ελένη Παπαδοπούλου', 'Пётр Ильич']) {
      const png = await renderTypedSignature(name, fonts);

      expect(inkOf(await pixelsOf(png)), name).toBeGreaterThan(1000);
      expect((await validateDrawnSignature(toDataUrl(png))).ok, name).toBe(true);
    }
  });

  it('ADR 0005: the font choice shows: "Nguyen" (Schibsted Grotesk) and "Nguyễn" (Noto Sans) differ beyond the ễ', async () => {
    const latin = inkBox(await pixelsOf(await renderTypedSignature('Nguyen', fonts)));
    const vietnamese = inkBox(await pixelsOf(await renderTypedSignature('Nguyễn', fonts)));

    expect(vietnamese).not.toEqual(latin);
  });

  it('ADR 0005: centres the name and keeps the 32 px side padding, also for a 60-character name', async () => {
    for (const name of ['Jo', 'Ada Lovelace', `${'Maximiliane '.repeat(5).trim()}s`]) {
      const box = inkBox(await pixelsOf(await renderTypedSignature(name, fonts)));

      expect(box.left, name).toBeGreaterThanOrEqual(30);
      expect(box.right, name).toBeLessThanOrEqual(690);
      expect(Math.abs(box.left + box.right - 719), name).toBeLessThanOrEqual(8);
      expect(Math.abs(box.top + box.bottom - 239), name).toBeLessThanOrEqual(8);
    }
  });

  it('ADR 0005: is deterministic, and different names give different images', async () => {
    const first = await renderTypedSignature('Lena Hartmann', fonts);

    expect((await renderTypedSignature('Lena Hartmann', fonts)).equals(first)).toBe(true);
    expect((await renderTypedSignature('Lena Hartman', fonts)).equals(first)).toBe(false);
  });

  it('ADR 0005: the service wires the renderer to the fonts it registered', async () => {
    const png = await images.renderTypedSignature('Mara Lindholm');

    expect(png.equals(await renderTypedSignature('Mara Lindholm', fonts))).toBe(true);
  });
});
