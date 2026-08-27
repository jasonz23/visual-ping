/**
 * Fixture builders.
 *
 * Fixtures are *built*, not committed as binaries: a reviewer can read exactly what
 * bytes each test feeds an extractor, and there is no opaque blob in the repo.
 */
import { deflateSync, gzipSync } from 'node:zlib';
import { zipSync } from 'fflate';
import type { ArtifactRecord } from '../../src/types.js';

/** Distinct fake passwords so a test can prove *which* channel produced a hit. */
export const FAKE = {
  header: 'VISUALPING{1111111111111111}',
  cookie: 'VISUALPING{2222222222222222}',
  hiddenDiv: 'VISUALPING{3333333333333333}',
  htmlComment: 'VISUALPING{4444444444444444}',
  cssComment: 'VISUALPING{5555555555555555}',
  cssContent: 'VISUALPING{6666666666666666}',
  jsComment: 'VISUALPING{7777777777777777}',
  base64: 'VISUALPING{8888888888888888}',
  pngText: 'VISUALPING{9999999999999999}',
  pngTrailer: 'VISUALPING{aaaaaaaaaaaaaaaa}',
  jpegComment: 'VISUALPING{bbbbbbbbbbbbbbbb}',
  exif: 'VISUALPING{cccccccccccccccc}',
  zipMember: 'VISUALPING{dddddddddddddddd}',
  gzip: 'VISUALPING{eeeeeeeeeeeeeeee}',
  sourceMap: 'VISUALPING{ffffffffffffffff}',
  jsonValue: 'VISUALPING{0123456789abcdef}',
  svgText: 'VISUALPING{fedcba9876543210}',
  id3: 'VISUALPING{0a0a0a0a0a0a0a0a}',
  fontName: 'VISUALPING{0b0b0b0b0b0b0b0b}',
  wasmSection: 'VISUALPING{0c0c0c0c0c0c0c0c}',
  attribute: 'VISUALPING{0d0d0d0d0d0d0d0d}',
  hex: 'VISUALPING{0e0e0e0e0e0e0e0e}',
  dataUri: 'VISUALPING{0f0f0f0f0f0f0f0f}',
  pdfText: 'VISUALPING{1a2b3c4d5e6f7080}',
} as const;

export const EXAMPLE = 'VISUALPING{0000deadbeef0000}';

export function record(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    sha256: 'deadbeef',
    bodyPath: 'bodies/de/deadbeef.bin',
    url: 'http://example.test/resource',
    finalUrl: 'http://example.test/resource',
    status: 200,
    statusText: 'OK',
    method: 'GET',
    contentType: 'application/octet-stream',
    mimeType: 'application/octet-stream',
    byteLength: 0,
    headers: {},
    requestHeaders: {},
    resourceType: 'other',
    fromCache: false,
    fetchedAt: '2026-01-01T00:00:00.000Z',
    kind: 'response',
    ...overrides,
  };
}

/* ------------------------------------------------------------------ PNG --- */

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

export interface PngOptions {
  tEXt?: { keyword: string; value: string };
  zTXt?: { keyword: string; value: string };
  iTXt?: { keyword: string; value: string };
  trailer?: string;
}

/** A structurally valid 1×1 PNG with optional text chunks and appended bytes. */
export function buildPng(options: PngOptions = {}): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  const parts = [signature, pngChunk('IHDR', ihdr)];

  if (options.tEXt) {
    parts.push(
      pngChunk(
        'tEXt',
        Buffer.concat([
          Buffer.from(options.tEXt.keyword, 'latin1'),
          Buffer.from([0]),
          Buffer.from(options.tEXt.value, 'latin1'),
        ]),
      ),
    );
  }
  if (options.zTXt) {
    parts.push(
      pngChunk(
        'zTXt',
        Buffer.concat([
          Buffer.from(options.zTXt.keyword, 'latin1'),
          Buffer.from([0, 0]),
          deflateSync(Buffer.from(options.zTXt.value, 'utf8')),
        ]),
      ),
    );
  }
  if (options.iTXt) {
    parts.push(
      pngChunk(
        'iTXt',
        Buffer.concat([
          Buffer.from(options.iTXt.keyword, 'latin1'),
          Buffer.from([0, 0, 0]), // compression flag + method
          Buffer.from([0]), // empty language tag
          Buffer.from([0]), // empty translated keyword
          Buffer.from(options.iTXt.value, 'utf8'),
        ]),
      ),
    );
  }

  parts.push(pngChunk('IDAT', deflateSync(Buffer.from([0, 0]))));
  parts.push(pngChunk('IEND', Buffer.alloc(0)));
  if (options.trailer) parts.push(Buffer.from(options.trailer, 'utf8'));
  return Buffer.concat(parts);
}

/* ----------------------------------------------------------------- JPEG --- */

/** A minimal JPEG carrying a COM marker and an EXIF UserComment. */
export function buildJpeg(comment: string, exifComment?: string): Buffer {
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];

  if (exifComment) parts.push(buildExifApp1(exifComment));

  const commentBytes = Buffer.from(comment, 'utf8');
  const comHeader = Buffer.alloc(4);
  comHeader.writeUInt16BE(0xfffe, 0);
  comHeader.writeUInt16BE(commentBytes.length + 2, 2);
  parts.push(comHeader, commentBytes);

  parts.push(Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

/**
 * APP1/Exif segment with a single UserComment (tag 0x9286) in the Exif IFD,
 * encoded the way the target site encodes it: an `UNICODE\0` character-set marker
 * followed by UTF-16LE — the case a naive `String(value)` renders as `[object Object]`.
 */
function buildExifApp1(comment: string): Buffer {
  const commentBytes = Buffer.concat([
    Buffer.from('UNICODE\0', 'latin1'),
    Buffer.from(comment, 'utf16le'),
  ]);

  // TIFF header (little-endian) + IFD0 with one entry pointing at the Exif IFD.
  const tiff: Buffer[] = [];
  const header = Buffer.alloc(8);
  header.write('II', 0, 'latin1');
  header.writeUInt16LE(42, 2);
  header.writeUInt32LE(8, 4); // IFD0 offset
  tiff.push(header);

  const ifd0 = Buffer.alloc(2 + 12 + 4);
  ifd0.writeUInt16LE(1, 0); // one entry
  ifd0.writeUInt16LE(0x8769, 2); // ExifIFDPointer
  ifd0.writeUInt16LE(4, 4); // LONG
  ifd0.writeUInt32LE(1, 6);
  ifd0.writeUInt32LE(8 + ifd0.length, 10); // offset of the Exif IFD
  ifd0.writeUInt32LE(0, 14); // no next IFD
  tiff.push(ifd0);

  const exifIfd = Buffer.alloc(2 + 12 + 4);
  const exifIfdOffset = 8 + ifd0.length;
  exifIfd.writeUInt16LE(1, 0);
  exifIfd.writeUInt16LE(0x9286, 2); // UserComment
  exifIfd.writeUInt16LE(7, 4); // UNDEFINED
  exifIfd.writeUInt32LE(commentBytes.length, 6);
  exifIfd.writeUInt32LE(exifIfdOffset + exifIfd.length, 10);
  exifIfd.writeUInt32LE(0, 14);
  tiff.push(exifIfd, commentBytes);

  const tiffBuffer = Buffer.concat(tiff);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiffBuffer]);
  const marker = Buffer.alloc(4);
  marker.writeUInt16BE(0xffe1, 0);
  marker.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([marker, payload]);
}

/* ------------------------------------------------------------- archives --- */

export function buildZip(files: Record<string, string | Buffer>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [name, content] of Object.entries(files)) {
    entries[name] = new Uint8Array(Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8'));
  }
  return Buffer.from(zipSync(entries));
}

export function buildGzip(content: string): Buffer {
  return gzipSync(Buffer.from(content, 'utf8'));
}

export function buildTar(files: Record<string, string>): Buffer {
  const blocks: Buffer[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 'latin1');
    header.write('0000644\0', 100, 'latin1');
    header.write('0000000\0', 108, 'latin1');
    header.write('0000000\0', 116, 'latin1');
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 'latin1');
    header.write('00000000000\0', 136, 'latin1');
    header.write('        ', 148, 'latin1'); // checksum placeholder
    header.write('0', 156, 'latin1');
    header.write('ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 'latin1');
    const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
    data.copy(padded);
    blocks.push(header, padded);
  }
  blocks.push(Buffer.alloc(1024)); // end-of-archive
  return Buffer.concat(blocks);
}

/* ----------------------------------------------------------------- misc --- */

/** ID3v2.3 tag with a single COMM-style text frame, followed by fake audio bytes. */
export function buildMp3(comment: string): Buffer {
  const payload = Buffer.concat([Buffer.from([0x00]), Buffer.from(comment, 'latin1')]);
  const frameHeader = Buffer.alloc(10);
  frameHeader.write('TXXX', 0, 'latin1');
  frameHeader.writeUInt32BE(payload.length, 4);
  const frame = Buffer.concat([frameHeader, payload]);

  const header = Buffer.alloc(10);
  header.write('ID3', 0, 'latin1');
  header[3] = 3;
  const size = frame.length;
  header[6] = (size >> 21) & 0x7f;
  header[7] = (size >> 14) & 0x7f;
  header[8] = (size >> 7) & 0x7f;
  header[9] = size & 0x7f;
  return Buffer.concat([header, frame, Buffer.from([0xff, 0xfb, 0x90, 0x00])]);
}

/** An sfnt font whose `name` table holds one record. */
export function buildFont(nameId: number, value: string): Buffer {
  const text = Buffer.from(value, 'utf16le');
  text.swap16(); // name tables are UTF-16BE
  const nameRecords = Buffer.alloc(12);
  nameRecords.writeUInt16BE(3, 0); // platform: Windows
  nameRecords.writeUInt16BE(1, 2); // encoding
  nameRecords.writeUInt16BE(0x0409, 4); // language
  nameRecords.writeUInt16BE(nameId, 6);
  nameRecords.writeUInt16BE(text.length, 8);
  nameRecords.writeUInt16BE(0, 10);

  const nameHeader = Buffer.alloc(6);
  nameHeader.writeUInt16BE(0, 0); // format
  nameHeader.writeUInt16BE(1, 2); // count
  nameHeader.writeUInt16BE(6 + 12, 4); // string storage offset
  const nameTable = Buffer.concat([nameHeader, nameRecords, text]);

  const sfnt = Buffer.alloc(12 + 16);
  sfnt.writeUInt32BE(0x00010000, 0);
  sfnt.writeUInt16BE(1, 4);
  sfnt.write('name', 12, 'latin1');
  sfnt.writeUInt32BE(0, 16);
  sfnt.writeUInt32BE(28, 20);
  sfnt.writeUInt32BE(nameTable.length, 24);
  return Buffer.concat([sfnt, nameTable]);
}

/** A wasm module with a single custom section. */
export function buildWasm(sectionName: string, payload: string): Buffer {
  const name = Buffer.from(sectionName, 'utf8');
  const data = Buffer.from(payload, 'utf8');
  const body = Buffer.concat([Buffer.from([name.length]), name, data]);
  return Buffer.concat([
    Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
    Buffer.from([0x00, body.length]),
    body,
  ]);
}

/** A tiny uncompressed PDF whose page content stream shows `text`. */
export function buildPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const objects = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj',
    `4 0 obj << /Length ${content.length} >> stream\n${content}\nendstream endobj`,
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join('\n')}\ntrailer << /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}
