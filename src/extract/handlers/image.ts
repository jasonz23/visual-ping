/**
 * Image channels.
 *
 * Three distinct places a password can live in an image file:
 *  1. Standard metadata — EXIF / IPTC / XMP / JFIF comments (via `exifr`).
 *  2. Container-level text chunks — PNG tEXt/iTXt/zTXt, JPEG COM markers, GIF
 *     comment extensions — which most metadata libraries expose only partially.
 *  3. Bytes appended *after* the format's end marker (IEND / EOI / GIF trailer),
 *     which every decoder ignores and therefore never surfaces.
 */
import { inflateSync } from 'node:zlib';
import exifr from 'exifr';
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

const IMAGE_MIME = /^image\//;

function isImage(mimeType: string, url: string): boolean {
  return IMAGE_MIME.test(mimeType) || /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|ico)$/i.test(url);
}

export const imageMetadataExtractor: Extractor = {
  id: 'image-metadata',
  description: 'EXIF / IPTC / XMP / ICC metadata read with exifr',
  appliesTo: (record, body) => body.length > 0 && isImage(record.mimeType, record.url),
  extract: async (ctx) => {
    const hits: PasswordHit[] = [];
    // `true` asks exifr for every segment it understands. The options-object form
    // returns undefined for some minimal-but-valid files, so it is not equivalent.
    const parsed: unknown = await exifr.parse(ctx.body, true).catch(() => null);
    if (parsed && typeof parsed === 'object') {
      for (const [tag, value] of Object.entries(parsed as Record<string, unknown>)) {
        for (const [encoding, text] of decodeMetadataValue(value)) {
          if (!text) continue;
          hits.push(
            ...scanText(text, {
              record: ctx.record,
              artifactPath: ctx.bodyPath,
              extractor: 'image-metadata',
              method: `image metadata tag "${tag}"${encoding ? ` (${encoding})` : ''}`,
            }),
          );
        }
      }
    }
    // Raw XMP packet, which exifr may hand back unparsed or skip entirely.
    const raw = ctx.body.toString('latin1');
    const xmpStart = raw.indexOf('<x:xmpmeta');
    if (xmpStart !== -1) {
      const xmpEnd = raw.indexOf('</x:xmpmeta>', xmpStart);
      const packet = raw.slice(xmpStart, xmpEnd === -1 ? xmpStart + 65_536 : xmpEnd + 12);
      hits.push(
        ...scanText(packet, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'image-metadata',
          method: 'raw XMP packet',
        }),
      );
    }
    return hits;
  },
};

export const pngChunkExtractor: Extractor = {
  id: 'image-chunks',
  description: 'PNG tEXt/iTXt/zTXt chunks, JPEG COM markers, GIF comment extensions',
  appliesTo: (record, body) => body.length > 8 && isImage(record.mimeType, record.url),
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    for (const chunk of readPngTextChunks(ctx.body)) {
      hits.push(
        ...scanText(`${chunk.keyword} ${chunk.value}`, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'image-chunks',
          method: `PNG ${chunk.type} chunk "${chunk.keyword}"`,
        }),
      );
    }
    for (const comment of readJpegComments(ctx.body)) {
      hits.push(
        ...scanText(comment, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'image-chunks',
          method: 'JPEG COM (comment) marker',
        }),
      );
    }
    for (const comment of readGifComments(ctx.body)) {
      hits.push(
        ...scanText(comment, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'image-chunks',
          method: 'GIF comment extension block',
        }),
      );
    }
    return hits;
  },
};

export const trailingBytesExtractor: Extractor = {
  id: 'trailing-bytes',
  description: 'bytes appended after a container end marker (PNG IEND, JPEG EOI, GIF trailer)',
  appliesTo: (record, body) => body.length > 8 && isImage(record.mimeType, record.url),
  extract: (ctx) => {
    const trailer = findTrailingBytes(ctx.body);
    if (!trailer) return [];
    return scanText(trailer.data.toString('utf8'), {
      record: ctx.record,
      artifactPath: ctx.bodyPath,
      extractor: 'trailing-bytes',
      method: `${trailer.bytes} bytes appended after ${trailer.marker}`,
    });
  },
};

export interface PngTextChunk {
  type: 'tEXt' | 'iTXt' | 'zTXt';
  keyword: string;
  value: string;
}

/** Walk the PNG chunk stream and decode every textual chunk type. */
export function readPngTextChunks(body: Buffer): PngTextChunk[] {
  const chunks: PngTextChunk[] = [];
  if (body.length < 8 || body.readUInt32BE(0) !== 0x89504e47) return chunks;
  let offset = 8;
  while (offset + 8 <= body.length) {
    const length = body.readUInt32BE(offset);
    const type = body.subarray(offset + 4, offset + 8).toString('latin1');
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > body.length) break;
    const data = body.subarray(dataStart, dataEnd);
    if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
      const nul = data.indexOf(0);
      const keyword = nul === -1 ? '' : data.subarray(0, nul).toString('latin1');
      let value = '';
      if (type === 'tEXt') {
        value = data.subarray(nul + 1).toString('latin1');
      } else if (type === 'zTXt') {
        // keyword \0 compressionMethod compressedText
        try {
          value = inflateSync(data.subarray(nul + 2)).toString('utf8');
        } catch {
          value = '';
        }
      } else {
        // iTXt: keyword \0 compressionFlag compressionMethod lang \0 translated \0 text
        const compressionFlag = data[nul + 1] ?? 0;
        let cursor = nul + 3;
        cursor = data.indexOf(0, cursor) + 1;
        cursor = data.indexOf(0, cursor) + 1;
        const payload = data.subarray(cursor);
        if (compressionFlag === 1) {
          try {
            value = inflateSync(payload).toString('utf8');
          } catch {
            value = '';
          }
        } else {
          value = payload.toString('utf8');
        }
      }
      chunks.push({ type, keyword, value });
    }
    if (type === 'IEND') break;
    offset = dataEnd + 4;
  }
  return chunks;
}

/** JPEG COM (0xFFFE) marker payloads. */
export function readJpegComments(body: Buffer): string[] {
  const comments: string[] = [];
  if (body.length < 4 || body[0] !== 0xff || body[1] !== 0xd8) return comments;
  let offset = 2;
  while (offset + 4 <= body.length) {
    if (body[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = body[offset + 1];
    if (marker === undefined) break;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break; // start of scan / end of image
    const length = body.readUInt16BE(offset + 2);
    if (marker === 0xfe) {
      comments.push(body.subarray(offset + 4, offset + 2 + length).toString('utf8'));
    }
    // APPn segments hold Exif/XMP; surface them as text too — cheap and lossless.
    if (marker >= 0xe0 && marker <= 0xef) {
      comments.push(body.subarray(offset + 4, offset + 2 + length).toString('latin1'));
    }
    offset += 2 + length;
  }
  return comments;
}

/** GIF89a comment extension blocks (0x21 0xFE). */
export function readGifComments(body: Buffer): string[] {
  const comments: string[] = [];
  if (body.subarray(0, 3).toString('latin1') !== 'GIF') return comments;
  for (let i = 0; i + 2 < body.length; i += 1) {
    if (body[i] !== 0x21 || body[i + 1] !== 0xfe) continue;
    let cursor = i + 2;
    let text = '';
    while (cursor < body.length) {
      const size = body[cursor];
      if (size === undefined || size === 0) break;
      text += body.subarray(cursor + 1, cursor + 1 + size).toString('latin1');
      cursor += size + 1;
    }
    if (text) comments.push(text);
  }
  return comments;
}

export interface TrailingBytes {
  marker: string;
  bytes: number;
  data: Buffer;
}

/** Bytes after the format's terminator — invisible to every image decoder. */
export function findTrailingBytes(body: Buffer): TrailingBytes | null {
  // PNG: IEND chunk is type(4) + crc(4) after its length field.
  const iend = body.lastIndexOf(Buffer.from('IEND', 'latin1'));
  if (iend !== -1) {
    const end = iend + 8;
    if (end < body.length) {
      return { marker: 'PNG IEND', bytes: body.length - end, data: body.subarray(end) };
    }
    return null;
  }
  // JPEG: EOI marker FF D9.
  if (body[0] === 0xff && body[1] === 0xd8) {
    const eoi = body.lastIndexOf(Buffer.from([0xff, 0xd9]));
    if (eoi !== -1 && eoi + 2 < body.length) {
      return { marker: 'JPEG EOI', bytes: body.length - eoi - 2, data: body.subarray(eoi + 2) };
    }
    return null;
  }
  // GIF: trailer byte 0x3B.
  if (body.subarray(0, 3).toString('latin1') === 'GIF') {
    const trailer = body.lastIndexOf(0x3b);
    if (trailer !== -1 && trailer + 1 < body.length) {
      return { marker: 'GIF trailer', bytes: body.length - trailer - 1, data: body.subarray(trailer + 1) };
    }
  }
  return null;
}

/**
 * Turn one metadata value into every plausible text reading.
 *
 * EXIF `UserComment` is the reason this exists: it is an UNDEFINED-type field whose
 * first eight bytes name a character set, so a UTF-16 comment reaches us as a plain
 * byte bag that a naive `String(value)` renders as `[object Object]`.
 */
export function decodeMetadataValue(value: unknown): Array<[string, string]> {
  const bytes = asBytes(value);
  if (!bytes) return [['', stringify(value)]];

  const readings: Array<[string, string]> = [['raw bytes', bytes.toString('latin1')]];
  let payload = bytes;
  let prefix = '';
  const marker = bytes.subarray(0, 8).toString('latin1').replace(/\0+$/, '');
  if (/^(UNICODE|ASCII|JIS)$/i.test(marker)) {
    payload = bytes.subarray(8);
    prefix = `${marker.toUpperCase()} `;
  }
  readings.push([`${prefix}utf-8`, payload.toString('utf8')]);
  if (payload.length % 2 === 0) {
    readings.push([`${prefix}utf-16le`, payload.toString('utf16le')]);
    const swapped = Buffer.from(payload);
    swapped.swap16();
    readings.push([`${prefix}utf-16be`, swapped.toString('utf16le')]);
  }
  return readings;
}

/** Byte-array-like metadata values: Uint8Array, Buffer, or an index-keyed object. */
function asBytes(value: unknown): Buffer | null {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'number')) {
    return Buffer.from(value as number[]);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (
      entries.length > 0 &&
      entries.every(([key, item]) => /^\d+$/.test(key) && typeof item === 'number')
    ) {
      const bytes = Buffer.alloc(entries.length);
      for (const [key, item] of entries) bytes[Number(key)] = Number(item) & 0xff;
      return bytes;
    }
  }
  return null;
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Uint8Array) return Buffer.from(value).toString('utf8');
  if (Array.isArray(value)) return value.map(stringify).join(' ');
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}
