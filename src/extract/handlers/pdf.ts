/**
 * PDF channels: page text, document info metadata, XMP, annotations, embedded
 * files, and Flate-compressed object streams (where text hides from `strings`).
 */
import { inflateSync } from 'node:zlib';
import type * as PdfJs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

interface PdfTextItem {
  str?: unknown;
}

function isPdf(mimeType: string, url: string, body: Buffer): boolean {
  return (
    mimeType === 'application/pdf' ||
    /\.pdf$/i.test(url) ||
    body.subarray(0, 5).toString('latin1') === '%PDF-'
  );
}

export const pdfExtractor: Extractor = {
  id: 'pdf',
  description: 'PDF page text, Info/XMP metadata, annotations, and inflated object streams',
  appliesTo: (record, body) => body.length > 0 && isPdf(record.mimeType, record.url, body),
  extract: async (ctx) => {
    const hits: PasswordHit[] = [];

    // 1. Object streams: inflate every FlateDecode stream and scan the plain text.
    for (const stream of inflateStreams(ctx.body)) {
      hits.push(
        ...scanText(stream, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'pdf',
          method: 'inflated PDF object stream',
        }),
      );
      hits.push(
        ...scanText(decodePdfTextOperators(stream), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'pdf',
          method: 'text-showing operators in an inflated PDF stream',
        }),
      );
    }

    // 2. Uncompressed literal/hex strings in the raw file.
    const raw = ctx.body.toString('latin1');
    hits.push(
      ...scanText(decodePdfTextOperators(raw), {
        record: ctx.record,
        artifactPath: ctx.bodyPath,
        extractor: 'pdf',
        method: 'text-showing operators in the raw PDF body',
      }),
    );
    for (const match of raw.matchAll(/<([0-9a-fA-F\s]{20,})>/g)) {
      const hex = (match[1] ?? '').replace(/\s+/g, '');
      if (hex.length % 2 !== 0) continue;
      hits.push(
        ...scanText(Buffer.from(hex, 'hex').toString('latin1'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'pdf',
          method: 'hex-encoded PDF string object',
        }),
      );
    }

    // 3. Structured parse: page text, metadata, annotations, attachments.
    hits.push(...(await parseWithPdfjs(ctx)));
    return hits;
  },
};

async function parseWithPdfjs(ctx: {
  body: Buffer;
  bodyPath: string;
  record: Parameters<typeof scanText>[1]['record'];
}): Promise<PasswordHit[]> {
  const hits: PasswordHit[] = [];
  let pdfjs: typeof PdfJs;
  try {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    return hits;
  }
  const task = pdfjs.getDocument({
    data: new Uint8Array(ctx.body),
    useSystemFonts: false,
    isEvalSupported: false,
  });
  let doc: Awaited<typeof task.promise>;
  try {
    doc = await task.promise;
  } catch {
    return hits;
  }
  try {
    const metadata = await doc.getMetadata().catch(() => null);
    if (metadata) {
      const info = JSON.stringify(metadata.info ?? {});
      hits.push(
        ...scanText(info, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'pdf',
          method: 'PDF document Info dictionary',
        }),
      );
      // pdfjs types `getRaw()` loosely; coerce rather than trust it.
      const xmp = String(metadata.metadata?.getRaw() ?? '');
      hits.push(
        ...scanText(xmp, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'pdf',
          method: 'PDF XMP metadata',
        }),
      );
    }

    const attachments: unknown = await doc.getAttachments().catch(() => null);
    if (attachments && typeof attachments === 'object') {
      for (const [name, value] of Object.entries(attachments as Record<string, unknown>)) {
        const content = (value as { content?: Uint8Array }).content;
        if (!content) continue;
        hits.push(
          ...scanText(Buffer.from(content).toString('utf8'), {
            record: ctx.record,
            artifactPath: ctx.bodyPath,
            extractor: 'pdf',
            method: `PDF embedded file "${name}"`,
          }),
        );
      }
    }

    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items
        .map((item: unknown) =>
          typeof (item as PdfTextItem).str === 'string' ? (item as PdfTextItem).str : '',
        )
        .join(' ');
      hits.push(
        ...scanText(String(text), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'pdf',
          method: `PDF page ${pageNumber} text layer`,
        }),
      );
      const annotations: unknown[] = await page.getAnnotations().catch(() => []);
      if (annotations.length > 0) {
        hits.push(
          ...scanText(JSON.stringify(annotations), {
            record: ctx.record,
            artifactPath: ctx.bodyPath,
            extractor: 'pdf',
            method: `PDF page ${pageNumber} annotations`,
          }),
        );
      }
    }
  } finally {
    await doc.destroy().catch(() => undefined);
  }
  return hits;
}

/** Inflate every `stream ... endstream` payload that happens to be zlib data. */
export function inflateStreams(body: Buffer): string[] {
  const out: string[] = [];
  const marker = Buffer.from('stream', 'latin1');
  const endMarker = Buffer.from('endstream', 'latin1');
  let index = body.indexOf(marker);
  while (index !== -1) {
    let start = index + marker.length;
    if (body[start] === 0x0d) start += 1;
    if (body[start] === 0x0a) start += 1;
    const end = body.indexOf(endMarker, start);
    if (end === -1) break;
    const slice = body.subarray(start, end);
    try {
      out.push(inflateSync(slice).toString('latin1'));
    } catch {
      /* not a Flate stream (or corrupt); the raw-text extractor still sees it */
    }
    index = body.indexOf(marker, end + endMarker.length);
  }
  return out;
}

/** Pull the string arguments out of Tj / TJ / ' / " text-showing operators. */
export function decodePdfTextOperators(content: string): string {
  const pieces: string[] = [];
  for (const match of content.matchAll(/\(((?:\\.|[^\\()])*)\)\s*(?:Tj|TJ|'|")/g)) {
    pieces.push(unescapePdfString(match[1] ?? ''));
  }
  for (const match of content.matchAll(/\[((?:[^\][]|\\.)*)\]\s*TJ/g)) {
    const inner = match[1] ?? '';
    for (const part of inner.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
      pieces.push(unescapePdfString(part[1] ?? ''));
    }
    // Kerned arrays split words across elements; join with no separator too.
    pieces.push(
      [...inner.matchAll(/\(((?:\\.|[^\\()])*)\)/g)]
        .map((part) => unescapePdfString(part[1] ?? ''))
        .join(''),
    );
  }
  return pieces.join('\n');
}

function unescapePdfString(value: string): string {
  return value
    .replace(/\\([0-7]{1,3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t')
    .replace(/\\([()\\])/g, '$1');
}
