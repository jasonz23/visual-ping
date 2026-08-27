/** Archive channels: zip (incl. nested), gzip, and tar members. */
import { gunzipSync } from 'node:zlib';
import { unzipSync } from 'fflate';
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const MAX_DEPTH = 3;

function isZip(body: Buffer): boolean {
  return body.subarray(0, 4).equals(ZIP_MAGIC);
}

function isGzip(body: Buffer): boolean {
  return body.subarray(0, 2).equals(GZIP_MAGIC);
}

function isTar(body: Buffer): boolean {
  return body.length > 262 && body.subarray(257, 262).toString('latin1') === 'ustar';
}

export const archiveExtractor: Extractor = {
  id: 'archive',
  description: 'zip / gzip / tar members, recursively up to three levels deep',
  appliesTo: (record, body) =>
    isZip(body) ||
    isGzip(body) ||
    isTar(body) ||
    /\.(zip|gz|tgz|tar)$/i.test(record.url) ||
    /(zip|gzip|tar)/i.test(record.mimeType),
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    walk(ctx.body, '', 0, (path, member, containerLabel) => {
      hits.push(
        ...scanText(member.toString('utf8'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'archive',
          method: `${containerLabel} member "${path}"`,
        }),
      );
    });
    return hits;
  },
};

type MemberVisitor = (path: string, data: Buffer, containerLabel: string) => void;

function walk(body: Buffer, prefix: string, depth: number, visit: MemberVisitor): void {
  if (depth > MAX_DEPTH) return;

  if (isZip(body)) {
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(new Uint8Array(body));
    } catch {
      return;
    }
    for (const [name, data] of Object.entries(entries)) {
      const buffer = Buffer.from(data);
      const path = prefix ? `${prefix}!${name}` : name;
      visit(path, buffer, 'zip');
      walk(buffer, path, depth + 1, visit);
    }
    return;
  }

  if (isGzip(body)) {
    let inflated: Buffer;
    try {
      inflated = gunzipSync(body);
    } catch {
      return;
    }
    const path = prefix ? `${prefix}!<gunzipped>` : '<gunzipped>';
    visit(path, inflated, 'gzip');
    walk(inflated, path, depth + 1, visit);
    return;
  }

  if (isTar(body)) {
    for (const member of readTar(body)) {
      const path = prefix ? `${prefix}!${member.name}` : member.name;
      visit(path, member.data, 'tar');
      walk(member.data, path, depth + 1, visit);
    }
  }
}

export interface TarMember {
  name: string;
  data: Buffer;
}

/** Minimal ustar reader: 512-byte headers, 512-byte-aligned payloads. */
export function readTar(body: Buffer): TarMember[] {
  const members: TarMember[] = [];
  let offset = 0;
  while (offset + 512 <= body.length) {
    const header = body.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString('latin1').replace(/\0.*$/, '');
    if (!name) break;
    const sizeField = header.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeField, 8);
    if (!Number.isFinite(size)) break;
    const start = offset + 512;
    const end = start + size;
    if (end > body.length) break;
    members.push({ name, data: body.subarray(start, end) });
    offset = start + Math.ceil(size / 512) * 512;
  }
  return members;
}
