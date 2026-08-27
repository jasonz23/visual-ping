/**
 * CSS channels: comments, `content:` strings on ::before/::after, and declarations
 * that paint text the same colour as its background.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';
import { decodeJsEscapes } from './encodings.js';

const CSS_COMMENT = /\/\*([\s\S]*?)\*\//g;
const CONTENT_DECLARATION = /content\s*:\s*((?:"[^"]*"|'[^']*'|\\[0-9a-fA-F]{1,6}\s?|[^;}])+)/gi;

export const cssExtractor: Extractor = {
  id: 'css',
  description: 'CSS comments, generated `content:` strings, and CSS unicode escapes',
  appliesTo: (record, body) =>
    record.mimeType === 'text/css' ||
    ((record.mimeType === 'text/html' || record.kind === 'rendered-dom') &&
      body.includes('<style')),
  extract: (ctx) => {
    const text = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];
    const where = ctx.record.mimeType === 'text/css' ? 'stylesheet' : 'inline <style>';

    for (const match of text.matchAll(CSS_COMMENT)) {
      hits.push(
        ...scanText(match[1] ?? '', {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'css',
          method: `CSS comment (${where})`,
        }),
      );
    }

    for (const match of text.matchAll(CONTENT_DECLARATION)) {
      const raw = match[1] ?? '';
      const decoded = decodeCssEscapes(decodeJsEscapes(raw));
      hits.push(
        ...scanText(decoded, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'css',
          method: `CSS \`content:\` declaration (${where})`,
        }),
      );
    }

    // Whole-sheet pass with CSS escapes resolved, so `\56 ISUALPING{…}` is caught.
    const unescaped = decodeCssEscapes(text);
    if (unescaped !== text) {
      hits.push(
        ...scanText(unescaped, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'css',
          method: `CSS unicode-escaped text (${where})`,
        }),
      );
    }

    return hits;
  },
};

/** Resolve CSS escapes: `\41` / `\000041` / `\41 ` all mean `A`. */
export function decodeCssEscapes(text: string): string {
  return text.replace(/\\([0-9a-fA-F]{1,6})[ \t\n]?/g, (_match, hex: string) =>
    String.fromCodePoint(parseInt(hex, 16)),
  );
}
