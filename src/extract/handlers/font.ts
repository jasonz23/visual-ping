/**
 * Font channels: the OpenType/TrueType `name` table, where copyright, description
 * and "sample text" records are free-form strings a designer never sees rendered.
 * WOFF/WOFF2 wrappers are unwrapped where the table is stored uncompressed or with
 * zlib; WOFF2's Brotli-compressed table directory falls through to `binary-strings`.
 */
import { inflateSync } from 'node:zlib';
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

const FONT_MIME = /^(font\/|application\/(font-|x-font-|vnd\.ms-fontobject))/;

function isFont(mimeType: string, url: string): boolean {
  return FONT_MIME.test(mimeType) || /\.(woff2?|ttf|otf|eot)$/i.test(url);
}

const NAME_IDS: Record<number, string> = {
  0: 'copyright',
  1: 'font family',
  2: 'font subfamily',
  3: 'unique id',
  4: 'full name',
  5: 'version',
  6: 'postscript name',
  7: 'trademark',
  8: 'manufacturer',
  9: 'designer',
  10: 'description',
  11: 'vendor url',
  12: 'designer url',
  13: 'license',
  14: 'license url',
  19: 'sample text',
};

export const fontExtractor: Extractor = {
  id: 'font',
  description: 'OpenType/TrueType `name` table records (incl. WOFF-wrapped fonts)',
  appliesTo: (record, body) => body.length > 12 && isFont(record.mimeType, record.url),
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    for (const sfnt of unwrapFont(ctx.body)) {
      for (const record of readNameTable(sfnt)) {
        hits.push(
          ...scanText(record.value, {
            record: ctx.record,
            artifactPath: ctx.bodyPath,
            extractor: 'font',
            method: `font name table record ${record.nameId} (${NAME_IDS[record.nameId] ?? 'reserved'})`,
          }),
        );
      }
    }
    return hits;
  },
};

/** Return candidate sfnt byte streams: the body itself, plus WOFF-decoded tables. */
export function unwrapFont(body: Buffer): Buffer[] {
  const candidates: Buffer[] = [body];
  if (body.subarray(0, 4).toString('latin1') === 'wOFF') {
    const numTables = body.readUInt16BE(12);
    // Rebuild a minimal sfnt so the standard name-table reader can be reused.
    const tables: Array<{ tag: string; data: Buffer }> = [];
    for (let i = 0; i < numTables; i += 1) {
      const entry = 44 + i * 20;
      if (entry + 20 > body.length) break;
      const tag = body.subarray(entry, entry + 4).toString('latin1');
      const offset = body.readUInt32BE(entry + 4);
      const compLength = body.readUInt32BE(entry + 8);
      const origLength = body.readUInt32BE(entry + 12);
      if (offset + compLength > body.length) continue;
      const raw = body.subarray(offset, offset + compLength);
      let data = raw;
      if (compLength !== origLength) {
        try {
          data = inflateSync(raw);
        } catch {
          continue;
        }
      }
      tables.push({ tag, data });
    }
    const name = tables.find((table) => table.tag === 'name');
    if (name) candidates.push(buildSfntWithName(name.data));
  }
  return candidates;
}

function buildSfntWithName(nameTable: Buffer): Buffer {
  const header = Buffer.alloc(12 + 16);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(1, 4); // numTables
  header.write('name', 12, 'latin1');
  header.writeUInt32BE(0, 16); // checksum
  header.writeUInt32BE(28, 20); // offset
  header.writeUInt32BE(nameTable.length, 24);
  return Buffer.concat([header, nameTable]);
}

export interface FontNameRecord {
  nameId: number;
  value: string;
}

export function readNameTable(sfnt: Buffer): FontNameRecord[] {
  const records: FontNameRecord[] = [];
  if (sfnt.length < 12) return records;
  const numTables = sfnt.readUInt16BE(4);
  if (numTables === 0 || numTables > 512) return records;
  for (let i = 0; i < numTables; i += 1) {
    const entry = 12 + i * 16;
    if (entry + 16 > sfnt.length) break;
    if (sfnt.subarray(entry, entry + 4).toString('latin1') !== 'name') continue;
    const offset = sfnt.readUInt32BE(entry + 8);
    const length = sfnt.readUInt32BE(entry + 12);
    if (offset + length > sfnt.length || length < 6) continue;
    const table = sfnt.subarray(offset, offset + length);
    const count = table.readUInt16BE(2);
    const stringOffset = table.readUInt16BE(4);
    for (let r = 0; r < count; r += 1) {
      const rec = 6 + r * 12;
      if (rec + 12 > table.length) break;
      const platformId = table.readUInt16BE(rec);
      const nameId = table.readUInt16BE(rec + 6);
      const strLength = table.readUInt16BE(rec + 8);
      const strOffset = table.readUInt16BE(rec + 10);
      const start = stringOffset + strOffset;
      if (start + strLength > table.length) continue;
      const raw = table.subarray(start, start + strLength);
      const value = platformId === 1 ? raw.toString('latin1') : decodeUtf16Be(raw);
      records.push({ nameId, value });
    }
  }
  return records;
}

function decodeUtf16Be(raw: Buffer): string {
  const copy = Buffer.from(raw);
  if (copy.length % 2 !== 0) return copy.toString('latin1');
  copy.swap16();
  return copy.toString('utf16le');
}
