/** Baseline extractors that apply to (almost) every artifact. */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

/**
 * UTF-8 and latin-1 decodes of the raw bytes. This is the floor: if a password is
 * literally present anywhere in a file, this finds it regardless of content-type.
 */
export const rawTextExtractor: Extractor = {
  id: 'raw-text',
  description: 'UTF-8 and latin-1 decodes of the whole artifact body',
  appliesTo: (_record, body) => body.length > 0,
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    const utf8 = ctx.body.toString('utf8');
    hits.push(
      ...scanText(utf8, {
        record: ctx.record,
        artifactPath: ctx.bodyPath,
        extractor: 'raw-text',
        method: 'literal string in body (utf-8 decode)',
      }),
    );
    const latin1 = ctx.body.toString('latin1');
    if (latin1 !== utf8) {
      hits.push(
        ...scanText(latin1, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'raw-text',
          method: 'literal string in body (latin-1 decode)',
        }),
      );
    }
    return hits;
  },
};

/** UTF-16 (both endiannesses), which a plain utf-8 decode silently mangles. */
export const utf16TextExtractor: Extractor = {
  id: 'utf16-text',
  description: 'UTF-16LE / UTF-16BE decodes, for text stored as wide characters',
  appliesTo: (_record, body) => body.length >= 22 && body.includes(0),
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    const le = ctx.body.toString('utf16le');
    hits.push(
      ...scanText(le, {
        record: ctx.record,
        artifactPath: ctx.bodyPath,
        extractor: 'utf16-text',
        method: 'literal string in body (utf-16le decode)',
      }),
    );
    const swapped = Buffer.from(ctx.body);
    if (swapped.length % 2 === 0) {
      swapped.swap16();
      hits.push(
        ...scanText(swapped.toString('utf16le'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'utf16-text',
          method: 'literal string in body (utf-16be decode)',
        }),
      );
    }
    return hits;
  },
};

/**
 * `strings(1)` equivalent: printable runs pulled out of binary containers, so a
 * password sitting between binary chunks is still found even when the surrounding
 * bytes make a naive decode unreadable.
 */
export const binaryStringsExtractor: Extractor = {
  id: 'binary-strings',
  description: 'printable-run extraction (strings(1) equivalent) from binary bodies',
  appliesTo: (record, body) => body.length > 0 && !isTextual(record.mimeType),
  extract: (ctx) => {
    const runs = printableRuns(ctx.body, 6);
    return scanText(runs.join('\n'), {
      record: ctx.record,
      artifactPath: ctx.bodyPath,
      extractor: 'binary-strings',
      method: 'printable string run inside binary body',
    });
  },
};

export function printableRuns(body: Buffer, minLength: number): string[] {
  const runs: string[] = [];
  let current = '';
  for (const byte of body) {
    if (byte >= 0x20 && byte <= 0x7e) {
      current += String.fromCharCode(byte);
    } else {
      if (current.length >= minLength) runs.push(current);
      current = '';
    }
  }
  if (current.length >= minLength) runs.push(current);
  return runs;
}

export function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    /(json|javascript|ecmascript|xml|svg|yaml|csv|x-sh|sourcemap|urlencoded)/i.test(mimeType)
  );
}
