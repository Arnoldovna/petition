/**
 * PNG structure checks for the drawn-signature pipeline (ADR 0004 item 3). Pure functions on bytes; the pixel work is
 * done by @napi-rs/canvas in `signature-image.ts`.
 *
 * Two steps, because Skia's decoder is lenient: `loadImage` decodes a truncated file (or one without `IEND`) without
 * an error and fills the missing rows with transparent pixels (measured with @napi-rs/canvas 1.1.1). So the full
 * decode alone cannot reject damaged uploads as ADR 0004 item 3.4 requires; `isCompletePng` does that before it.
 */
import { crc32, inflateSync } from 'node:zlib';

/** The 8-byte PNG signature (ISO/IEC 15948, section 5.2). */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A chunk is length (4), type (4), data (length) and CRC (4). */
const CHUNK_OVERHEAD = 12;
const IHDR_DATA_LENGTH = 13;
/** Signature, the IHDR chunk header, its 13 data bytes and its CRC: the smallest prefix that holds the size. */
const IHDR_END = PNG_SIGNATURE.length + CHUNK_OVERHEAD + IHDR_DATA_LENGTH;
/** Chunk lengths are at most 2^31 - 1 (section 5.3). */
const MAX_CHUNK_LENGTH = 0x7fff_ffff;
/** Chunk types are four ASCII letters (section 5.4). */
const CHUNK_TYPE = /^[A-Za-z]{4}$/;

/**
 * Upper bound for the inflated image data. A 720 x 240 PNG needs at most 240 * (1 + 720 * 8) = 1,382,640 bytes (16-bit
 * RGBA, the largest pixel format); 2 MiB leaves room for interlacing and stops a deflate bomb, which could otherwise
 * expand 64 KiB of upload to about 66 MB.
 */
const MAX_INFLATED_BYTES = 2 * 1024 * 1024;

export interface PngSize {
  width: number;
  height: number;
}

/**
 * Reads the size from the header: the PNG signature, then an `IHDR` chunk with 13 data bytes as the first chunk
 * (ADR 0004 item 3.3). Anything else, such as JPEG bytes behind a PNG data-URL prefix, is `null`. The pixel data is
 * not looked at; `isCompletePng` and the decoder do that.
 */
export function inspectPngHeader(bytes: Buffer): PngSize | null {
  if (bytes.length < IHDR_END) return null;
  if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  const lengthOffset = PNG_SIGNATURE.length;
  if (bytes.readUInt32BE(lengthOffset) !== IHDR_DATA_LENGTH) return null;
  if (bytes.toString('latin1', lengthOffset + 4, lengthOffset + 8) !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(lengthOffset + 8), height: bytes.readUInt32BE(lengthOffset + 12) };
}

/**
 * True when the file is structurally whole: every chunk lies inside the data and has a valid CRC, the first chunk is
 * `IHDR`, there is at least one `IDAT`, `IEND` is the last chunk with nothing after it, and the concatenated `IDAT`
 * data is one complete zlib stream that inflates to at most `MAX_INFLATED_BYTES`. Rejects truncated, damaged and
 * padded files (trailing bytes after `IEND` are a classic polyglot carrier) before the lenient decoder sees them.
 */
export function isCompletePng(bytes: Buffer): boolean {
  if (inspectPngHeader(bytes) === null) return false;

  const imageData: Buffer[] = [];
  let offset = PNG_SIGNATURE.length;
  while (offset + CHUNK_OVERHEAD <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (length > MAX_CHUNK_LENGTH || dataEnd + 4 > bytes.length) return false;

    const type = bytes.toString('latin1', offset + 4, dataStart);
    if (!CHUNK_TYPE.test(type)) return false;
    // The CRC covers the type and the data, not the length (section 5.3).
    if (crc32(bytes.subarray(offset + 4, dataEnd)) !== bytes.readUInt32BE(dataEnd)) return false;
    if (offset === PNG_SIGNATURE.length && type !== 'IHDR') return false;

    if (type === 'IDAT') imageData.push(bytes.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === 'IEND') return offset === bytes.length && length === 0 && inflatesCompletely(imageData);
  }
  return false;
}

/** One complete zlib stream within the size bound; a truncated stream throws "unexpected end of file". */
function inflatesCompletely(chunks: readonly Buffer[]): boolean {
  if (chunks.length === 0) return false;
  try {
    inflateSync(Buffer.concat(chunks), { maxOutputLength: MAX_INFLATED_BYTES });
    return true;
  } catch {
    // zlib reports damaged, truncated and oversized streams as errors; each one means the file is not whole.
    return false;
  }
}
