/**
 * OCR: text baked into image pixels, which no metadata channel exposes.
 *
 * Tesseract is constrained to the alphabet the password grammar allows, and the
 * result still passes through a confusable-glyph repair step — `l`/`I` for `1`,
 * `O` for `0` and so on are the classic failure mode for a 16-hex string in a
 * sans-serif face. A repair is only accepted when it yields a *valid* password,
 * so the step can never invent one that the image does not contain.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

/** Only images at least this wide are worth an OCR pass (icons are not text). */
const MIN_OCR_PIXELS = 64;

/** Tesseract is heavy; one worker is created lazily and shared for the whole run. */
let workerPromise: Promise<OcrWorker | null> | null = null;

interface OcrWorker {
  recognize(image: Buffer): Promise<{ data: { text: string } }>;
  terminate(): Promise<unknown>;
}

async function getWorker(): Promise<OcrWorker | null> {
  workerPromise ??= (async (): Promise<OcrWorker | null> => {
    try {
      const { createWorker } = await import('tesseract.js');
      const worker = await createWorker('eng');
      await worker.setParameters({
        // Everything the password grammar can contain, plus the literal prefix.
        tessedit_char_whitelist: 'VISUALPING{}0123456789abcdefABCDEF',
      });
      return worker as unknown as OcrWorker;
    } catch {
      return null;
    }
  })();
  return workerPromise;
}

/** Release the shared worker. Called by the CLI once extraction finishes. */
export async function shutdownOcr(): Promise<void> {
  const worker = await workerPromise?.catch(() => null);
  await worker?.terminate().catch(() => undefined);
  workerPromise = null;
}

export const ocrExtractor: Extractor = {
  id: 'ocr',
  description: 'optical character recognition over raster images (text drawn into pixels)',
  appliesTo: (record, body) => {
    if (!/^image\/(png|jpeg|gif|bmp|webp)$/.test(record.mimeType)) return false;
    const size = imageSize(body);
    return size !== null && size.width >= MIN_OCR_PIXELS && size.height >= 16;
  },
  extract: async (ctx) => {
    const worker = await getWorker();
    if (!worker) return [];
    const { data } = await worker.recognize(ctx.body);
    const text = data.text ?? '';
    const hits: PasswordHit[] = scanText(text, {
      record: ctx.record,
      artifactPath: ctx.bodyPath,
      extractor: 'ocr',
      method: 'text recognised in image pixels (OCR)',
    });
    if (hits.length > 0) return hits;

    for (const repaired of repairConfusables(text)) {
      hits.push(
        ...scanText(repaired, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'ocr',
          method: 'text recognised in image pixels (OCR + confusable-glyph repair)',
        }),
      );
    }
    return hits;
  },
};

/** Glyphs a sans-serif face renders near-identically to a hex digit. */
const CONFUSABLES: Record<string, string> = {
  l: '1',
  I: '1',
  i: '1',
  '|': '1',
  O: '0',
  o: '0',
  Q: '0',
  D: '0',
  S: '5',
  s: '5',
  Z: '2',
  z: '2',
  B: '8',
  G: '6',
  g: '9',
  q: '9',
  T: '7',
  '/': '7',
  '(': 'c',
  '[': 'c',
};

/**
 * Yield candidate repairs of every `VISUALPING{…}`-shaped run whose body is not
 * already valid hex. Only substitutions inside the braces are attempted.
 */
export function repairConfusables(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/VISUALPING\s*\{\s*([^}]{10,32})\s*\}/g)) {
    const inner = (match[1] ?? '').replace(/\s+/g, '');
    const repaired = [...inner].map((char) => CONFUSABLES[char] ?? char).join('');
    if (/^[0-9a-fA-F]{16}$/.test(repaired)) out.push(`VISUALPING{${repaired}}`);
  }
  return out;
}

export interface ImageSize {
  width: number;
  height: number;
}

/** Header-only dimension read for the formats worth OCR-ing. */
export function imageSize(body: Buffer): ImageSize | null {
  if (body.length > 24 && body.readUInt32BE(0) === 0x89504e47) {
    return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
  }
  if (body.length > 4 && body[0] === 0xff && body[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < body.length) {
      if (body[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = body[offset + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: body.readUInt16BE(offset + 5), width: body.readUInt16BE(offset + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xd9 || marker === 0xda) break;
      offset += 2 + body.readUInt16BE(offset + 2);
    }
    return null;
  }
  if (body.subarray(0, 3).toString('latin1') === 'GIF' && body.length > 10) {
    return { width: body.readUInt16LE(6), height: body.readUInt16LE(8) };
  }
  if (body.subarray(0, 2).toString('latin1') === 'BM' && body.length > 26) {
    return { width: body.readInt32LE(18), height: Math.abs(body.readInt32LE(22)) };
  }
  if (body.subarray(0, 4).toString('latin1') === 'RIFF' && body.subarray(8, 12).toString('latin1') === 'WEBP') {
    // Only VP8X carries dimensions at a fixed offset; other variants are skipped.
    if (body.subarray(12, 16).toString('latin1') === 'VP8X' && body.length > 30) {
      return {
        width: 1 + (body.readUIntLE(24, 3) & 0xffffff),
        height: 1 + (body.readUIntLE(27, 3) & 0xffffff),
      };
    }
  }
  return null;
}
