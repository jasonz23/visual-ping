/**
 * JavaScript channels: comments, string literals (including concatenated and
 * char-code-built strings), and source maps — where `sourcesContent` holds the
 * *original* source a minified bundle no longer shows.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';
import { decodeJsEscapes } from './encodings.js';

const LINE_COMMENT = /(^|[^:'"\\])\/\/([^\n]*)/g;
const BLOCK_COMMENT = /\/\*([\s\S]*?)\*\//g;
const CHAR_CODE_CALL = /String\.fromCharCode\(([\d\s,]+)\)/g;
/** Any numeric array literal — `String.fromCharCode.apply(null, arr)` is common. */
const NUMERIC_ARRAY = /\[\s*(\d{1,3}(?:\s*,\s*\d{1,3}){9,})\s*\]/g;
const CONCAT_RUN = /(?:['"][^'"\n]{0,40}['"]\s*\+\s*){2,}['"][^'"\n]{0,40}['"]/g;
/** A single quoted string literal, so a hard-coded secret is reported as one. */
const STRING_LITERAL = /(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g;

function isJavaScript(mimeType: string): boolean {
  return /javascript|ecmascript/i.test(mimeType);
}

export const javascriptExtractor: Extractor = {
  id: 'javascript',
  description: 'JS comments, escaped/concatenated string literals, String.fromCharCode payloads',
  appliesTo: (record, body) =>
    isJavaScript(record.mimeType) ||
    ((record.mimeType === 'text/html' || record.kind === 'rendered-dom') &&
      body.includes('<script')),
  extract: (ctx) => {
    const text = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];
    const where = isJavaScript(ctx.record.mimeType) ? 'script file' : 'inline <script>';

    for (const match of text.matchAll(BLOCK_COMMENT)) {
      hits.push(
        ...scanText(match[1] ?? '', {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'javascript',
          method: `JS block comment (${where})`,
        }),
      );
    }
    for (const match of text.matchAll(LINE_COMMENT)) {
      hits.push(
        ...scanText(match[2] ?? '', {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'javascript',
          method: `JS line comment (${where})`,
        }),
      );
    }

    const unescaped = decodeJsEscapes(text);
    if (unescaped !== text) {
      hits.push(
        ...scanText(unescaped, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'javascript',
          method: `JS \\u/\\x-escaped literal (${where})`,
        }),
      );
    }

    for (const match of text.matchAll(CHAR_CODE_CALL)) {
      const codes = (match[1] ?? '')
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((code) => Number.isInteger(code) && code >= 0 && code < 0x110000);
      if (codes.length === 0) continue;
      hits.push(
        ...scanText(String.fromCharCode(...codes), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'javascript',
          method: `String.fromCharCode() payload (${where})`,
        }),
      );
    }

    for (const match of text.matchAll(STRING_LITERAL)) {
      hits.push(
        ...scanText(match[2] ?? '', {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'javascript',
          method: `quoted string literal (${where})`,
        }),
      );
    }

    // Char-code arrays decoded elsewhere, e.g. `String.fromCharCode.apply(null, a)`.
    for (const match of text.matchAll(NUMERIC_ARRAY)) {
      const codes = (match[1] ?? '')
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((code) => Number.isInteger(code) && code >= 0 && code <= 0x10ffff);
      if (codes.length < 10) continue;
      hits.push(
        ...scanText(String.fromCharCode(...codes), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'javascript',
          method: `character-code array literal (${where})`,
        }),
      );
    }

    for (const match of text.matchAll(CONCAT_RUN)) {
      const joined = match[0].replace(/['"]\s*\+\s*['"]/g, '').replace(/^['"]|['"]$/g, '');
      hits.push(
        ...scanText(joined, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'javascript',
          method: `concatenated string literal (${where})`,
        }),
      );
    }

    // Reversed strings are a cheap obfuscation and cost nothing to check.
    const reversed = [...text].reverse().join('');
    hits.push(
      ...scanText(reversed, {
        record: ctx.record,
        artifactPath: ctx.bodyPath,
        extractor: 'javascript',
        method: `reversed string literal (${where})`,
      }),
    );

    return hits;
  },
};

interface SourceMap {
  sources?: unknown;
  sourcesContent?: unknown;
  names?: unknown;
  mappings?: unknown;
  file?: unknown;
}

export const sourceMapExtractor: Extractor = {
  id: 'sourcemap',
  description: 'source map `sourcesContent`, `sources` and `names` arrays',
  appliesTo: (record, body) =>
    /\.map$/i.test(record.url) ||
    (body.length > 0 && body.subarray(0, 2000).includes('sourcesContent')),
  extract: (ctx) => {
    let parsed: SourceMap;
    try {
      parsed = JSON.parse(ctx.body.toString('utf8')) as SourceMap;
    } catch {
      return [];
    }
    const hits: PasswordHit[] = [];
    const contents = Array.isArray(parsed.sourcesContent) ? parsed.sourcesContent : [];
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    contents.forEach((content, index) => {
      if (typeof content !== 'string') return;
      const name = typeof sources[index] === 'string' ? String(sources[index]) : `#${index}`;
      hits.push(
        ...scanText(content, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'sourcemap',
          method: `sourcemap sourcesContent for "${name}"`,
        }),
      );
    });
    for (const key of ['sources', 'names'] as const) {
      const value = parsed[key];
      if (!Array.isArray(value)) continue;
      hits.push(
        ...scanText(value.filter((v) => typeof v === 'string').join('\n'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'sourcemap',
          method: `sourcemap "${key}" array`,
        }),
      );
    }
    return hits;
  },
};
