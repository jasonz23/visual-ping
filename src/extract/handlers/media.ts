/**
 * Audio/video metadata: ID3v2 and ID3v1 frames, MP4/QuickTime `udta`/`ilst` atoms,
 * WebM/Matroska tag elements, and WAV LIST/INFO chunks — all parsed inline so the
 * pipeline has no external binary dependency.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';
import { printableRuns } from './text.js';

const MEDIA_MIME = /^(audio|video)\//;

function isMedia(mimeType: string, url: string): boolean {
  return MEDIA_MIME.test(mimeType) || /\.(mp3|mp4|m4a|webm|ogg|wav|mov|aac|flac)$/i.test(url);
}

export const mediaMetadataExtractor: Extractor = {
  id: 'media-metadata',
  description: 'ID3 tags, MP4 udta/ilst atoms, Matroska tags, WAV LIST/INFO chunks',
  appliesTo: (record, body) => body.length > 16 && isMedia(record.mimeType, record.url),
  extract: (ctx) => {
    const hits: PasswordHit[] = [];

    for (const frame of readId3(ctx.body)) {
      hits.push(
        ...scanText(frame.value, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'media-metadata',
          method: `ID3 frame "${frame.id}"`,
        }),
      );
    }

    for (const atom of readMp4TextAtoms(ctx.body)) {
      hits.push(
        ...scanText(atom.value, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'media-metadata',
          method: `MP4 metadata atom "${atom.type}"`,
        }),
      );
    }

    // Matroska/WebM tags and WAV INFO chunks are short printable runs near known
    // ASCII keys; a targeted printable sweep is both simpler and more robust than a
    // partial EBML parser, and is reported honestly as such.
    const head = ctx.body.subarray(0, Math.min(ctx.body.length, 1 << 20));
    if (/webm|matroska|wav/i.test(ctx.record.mimeType) || /\.(webm|wav)$/i.test(ctx.record.url)) {
      hits.push(
        ...scanText(printableRuns(head, 8).join('\n'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'media-metadata',
          method: 'printable metadata run in container header',
        }),
      );
    }

    return hits;
  },
};

export interface Id3Frame {
  id: string;
  value: string;
}

/** ID3v2.3/2.4 frames plus the trailing 128-byte ID3v1 tag. */
export function readId3(body: Buffer): Id3Frame[] {
  const frames: Id3Frame[] = [];

  if (body.subarray(0, 3).toString('latin1') === 'ID3' && body.length > 10) {
    const size = syncSafe(body, 6);
    let offset = 10;
    const end = Math.min(10 + size, body.length);
    while (offset + 10 <= end) {
      const id = body.subarray(offset, offset + 4).toString('latin1');
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const frameSize = body.readUInt32BE(offset + 4);
      if (frameSize <= 0 || offset + 10 + frameSize > end) break;
      const payload = body.subarray(offset + 10, offset + 10 + frameSize);
      frames.push({ id, value: decodeId3Text(payload) });
      offset += 10 + frameSize;
    }
  }

  if (body.length >= 128) {
    const tail = body.subarray(body.length - 128);
    if (tail.subarray(0, 3).toString('latin1') === 'TAG') {
      frames.push({ id: 'ID3v1', value: tail.toString('latin1') });
    }
  }
  return frames;
}

function syncSafe(body: Buffer, offset: number): number {
  return (
    ((body[offset] ?? 0) << 21) |
    ((body[offset + 1] ?? 0) << 14) |
    ((body[offset + 2] ?? 0) << 7) |
    (body[offset + 3] ?? 0)
  );
}

function decodeId3Text(payload: Buffer): string {
  const encoding = payload[0] ?? 0;
  const data = payload.subarray(1);
  switch (encoding) {
    case 1:
      return data.toString('utf16le');
    case 2: {
      const swapped = Buffer.from(data);
      if (swapped.length % 2 === 0) swapped.swap16();
      return swapped.toString('utf16le');
    }
    case 3:
      return data.toString('utf8');
    default:
      return data.toString('latin1');
  }
}

export interface Mp4Atom {
  type: string;
  value: string;
}

/** Walk ISO-BMFF boxes and return the text payloads of metadata atoms. */
export function readMp4TextAtoms(body: Buffer): Mp4Atom[] {
  const atoms: Mp4Atom[] = [];
  const interesting = new Set([
    'udta',
    'meta',
    'ilst',
    'data',
    '©nam',
    '©cmt',
    '©too',
    'desc',
    'name',
  ]);

  const walk = (start: number, end: number, depth: number): void => {
    if (depth > 6) return;
    let offset = start;
    while (offset + 8 <= end) {
      const size = body.readUInt32BE(offset);
      const type = body.subarray(offset + 4, offset + 8).toString('latin1');
      if (size < 8 || offset + size > end) break;
      const payloadStart = offset + 8;
      if (interesting.has(type)) {
        const payload = body.subarray(payloadStart, offset + size);
        atoms.push({ type, value: payload.toString('utf8').replace(/\0+/g, ' ') });
      }
      if (['moov', 'udta', 'meta', 'ilst', 'trak', 'mdia', 'minf', 'stbl'].includes(type)) {
        // `meta` carries a 4-byte version/flags prefix before its children.
        const childStart = type === 'meta' ? payloadStart + 4 : payloadStart;
        walk(childStart, offset + size, depth + 1);
      }
      offset += size;
    }
  };

  if (body.length > 12 && /ftyp|moov|mdat/.test(body.subarray(4, 8).toString('latin1'))) {
    walk(0, body.length, 0);
  }
  return atoms;
}
