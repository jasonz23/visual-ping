/**
 * Encoding-layer extractors.
 *
 * Passwords are "not always stored the way you'd first expect", so every artifact
 * gets its embedded encodings peeled: base64 (standard and URL-safe), long hex runs,
 * percent-encoding, HTML entities, ROT13, and any compressed stream (gzip / zlib /
 * raw deflate / brotli) that appears either as the whole body or inside a data: URI.
 */
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from 'node:zlib';
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

const BASE64_RUN = /[A-Za-z0-9+/=]{24,}/g;
const BASE64URL_RUN = /[A-Za-z0-9_-]{24,}={0,2}/g;
const HEX_RUN = /(?:[0-9a-fA-F]{2}){14,}/g;
const DATA_URI = /data:([\w./+-]+)?(;charset=[\w-]+)?(;base64)?,([A-Za-z0-9+/=%_.~-]+)/g;

export const base64Extractor: Extractor = {
  id: 'base64',
  description: 'decodes base64 / base64url runs found in any textual artifact and rescans',
  appliesTo: (_record, body) => body.length > 0,
  extract: (ctx) => {
    const text = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];
    const seen = new Set<string>();

    const tryDecode = (run: string, urlSafe: boolean): void => {
      if (seen.has(run)) return;
      seen.add(run);
      const normalized = urlSafe ? run.replace(/-/g, '+').replace(/_/g, '/') : run;
      const decoded = Buffer.from(normalized, 'base64');
      if (decoded.length < 8) return;
      // Guard against coincidental matches: require the decode to round-trip.
      const reencoded = decoded.toString('base64').replace(/=+$/, '');
      if (reencoded !== normalized.replace(/=+$/, '')) return;
      const method = urlSafe ? 'base64url-decoded run' : 'base64-decoded run';
      hits.push(
        ...scanText(decoded.toString('utf8'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'base64',
          method: `${method} (${run.slice(0, 24)}…)`,
        }),
      );
      // A base64 payload can itself be compressed.
      hits.push(...scanDecompressed(decoded, ctx, 'base64', `${method} then decompressed`));
      // …or base64 again.
      const inner = decoded.toString('utf8');
      if (/^[A-Za-z0-9+/=\s]{24,}$/.test(inner)) {
        const twice = Buffer.from(inner, 'base64');
        if (twice.length >= 8) {
          hits.push(
            ...scanText(twice.toString('utf8'), {
              record: ctx.record,
              artifactPath: ctx.bodyPath,
              extractor: 'base64',
              method: 'double base64-decoded run',
            }),
          );
        }
      }
    };

    for (const match of text.matchAll(BASE64_RUN)) tryDecode(match[0], false);
    for (const match of text.matchAll(BASE64URL_RUN)) tryDecode(match[0], true);
    return hits;
  },
};

export const hexExtractor: Extractor = {
  id: 'hex',
  description: 'decodes long hex runs (a password stored as its own hex bytes)',
  appliesTo: (_record, body) => body.length > 0,
  extract: (ctx) => {
    const text = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];
    for (const match of text.matchAll(HEX_RUN)) {
      const run = match[0];
      if (run.length % 2 !== 0) continue;
      const decoded = Buffer.from(run, 'hex').toString('utf8');
      hits.push(
        ...scanText(decoded, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'hex',
          method: `hex-decoded run (${run.slice(0, 24)}…)`,
        }),
      );
    }
    return hits;
  },
};

export const percentAndEntityExtractor: Extractor = {
  id: 'escapes',
  description: 'percent-encoding, HTML entities, and JS \\u / \\x escapes',
  appliesTo: (_record, body) => body.length > 0,
  extract: (ctx) => {
    const text = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];

    const variants: Array<[string, string]> = [];
    if (text.includes('%')) {
      try {
        variants.push([
          'percent-decoded',
          decodeURIComponent(text.replace(/%(?![0-9a-fA-F]{2})/g, '%25')),
        ]);
      } catch {
        /* malformed sequences: fall through to the other variants */
      }
    }
    if (/&[#a-zA-Z0-9]+;/.test(text)) variants.push(['HTML-entity-decoded', decodeEntities(text)]);
    if (/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/.test(text)) {
      variants.push(['JS-escape-decoded', decodeJsEscapes(text)]);
    }
    variants.push(['ROT13-decoded', rot13(text)]);

    for (const [label, decoded] of variants) {
      if (decoded === text) continue;
      hits.push(
        ...scanText(decoded, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'escapes',
          method: `${label} body`,
        }),
      );
    }
    return hits;
  },
};

export const compressionExtractor: Extractor = {
  id: 'compression',
  description: 'gzip / zlib / raw-deflate / brotli streams, whole-body or embedded',
  appliesTo: (_record, body) => body.length > 2,
  extract: (ctx) => scanDecompressed(ctx.body, ctx, 'compression', 'decompressed body'),
};

export const dataUriExtractor: Extractor = {
  id: 'data-uri',
  description: 'inline data: URIs (base64 or percent-encoded payloads)',
  appliesTo: (_record, body) => body.includes('data:'),
  extract: (ctx) => {
    const text = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];
    for (const match of text.matchAll(DATA_URI)) {
      const mediaType = match[1] ?? 'text/plain';
      const isBase64 = Boolean(match[3]);
      const payload = match[4] ?? '';
      let decoded: Buffer;
      try {
        decoded = isBase64
          ? Buffer.from(payload, 'base64')
          : Buffer.from(decodeURIComponent(payload));
      } catch {
        continue;
      }
      hits.push(
        ...scanText(decoded.toString('utf8'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'data-uri',
          method: `data: URI payload (${mediaType}${isBase64 ? ';base64' : ''})`,
        }),
      );
      hits.push(
        ...scanDecompressed(
          decoded,
          ctx,
          'data-uri',
          `data: URI payload (${mediaType}) decompressed`,
        ),
      );
    }
    return hits;
  },
};

/** Try every common compression container over `buffer`, at every plausible offset. */
export function scanDecompressed(
  buffer: Buffer,
  ctx: { record: Parameters<typeof scanText>[1]['record']; bodyPath: string },
  extractor: string,
  method: string,
): PasswordHit[] {
  const hits: PasswordHit[] = [];
  const decoders: Array<[string, (input: Buffer) => Buffer]> = [
    ['gzip', gunzipSync],
    ['zlib', inflateSync],
    ['raw deflate', inflateRawSync],
    ['brotli', brotliDecompressSync],
  ];
  const offsets = new Map<number, 'gzip' | 'zlib' | 'all'>([[0, 'all']]);
  // Compressed members can be embedded at any offset — a gzip member appended
  // after other data, or a bare zlib stream such as a PNG IDAT payload, whose
  // contents are invisible to every text-oriented extractor.
  const limit = Math.min(buffer.length - 2, 4_000_000);
  for (let i = 1; i < limit; i += 1) {
    const b0 = buffer[i];
    const b1 = buffer[i + 1];
    if (b0 === 0x1f && b1 === 0x8b && buffer[i + 2] === 0x08) {
      offsets.set(i, 'gzip');
    } else if (b0 === 0x78 && (b1 === 0x01 || b1 === 0x9c || b1 === 0xda || b1 === 0x5e)) {
      offsets.set(i, 'zlib');
    }
  }
  for (const [offset, kind] of offsets) {
    const slice = offset === 0 ? buffer : buffer.subarray(offset);
    for (const [label, decode] of decoders) {
      if (kind === 'gzip' && label !== 'gzip') continue;
      if (kind === 'zlib' && label !== 'zlib') continue;
      let decoded: Buffer;
      try {
        decoded = decode(slice);
      } catch {
        continue;
      }
      if (decoded.length === 0) continue;
      hits.push(
        ...scanText(decoded.toString('utf8'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor,
          method: `${method} [${label}${offset ? ` @ +${offset}` : ''}]`,
        }),
      );
    }
  }
  return hits;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lbrace: '{',
  rbrace: '}',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return String.fromCodePoint(parseInt(entity.slice(2), 16));
    }
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

export function decodeJsEscapes(text: string): string {
  return text
    .replace(/\\u\{([0-9a-fA-F]+)\}/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\x([0-9a-fA-F]{2})/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

export function rot13(text: string): string {
  return text.replace(/[a-zA-Z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}
