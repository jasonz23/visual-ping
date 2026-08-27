/**
 * SVG channels: <text>/<title>/<desc>/<metadata> nodes, XML comments, and any
 * base64 payload embedded in an xlink:href.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

const TEXTUAL_NODES = /<(text|tspan|title|desc|metadata|textPath)\b[^>]*>([\s\S]*?)<\/\1>/gi;
const XML_COMMENT = /<!--([\s\S]*?)-->/g;
const EMBEDDED_BASE64 = /(?:xlink:)?href\s*=\s*["']data:[^;"']*;base64,([A-Za-z0-9+/=]+)["']/gi;

export const svgExtractor: Extractor = {
  id: 'svg',
  description: 'SVG <text>/<title>/<desc>/<metadata>, XML comments, embedded base64 hrefs',
  appliesTo: (record, body) =>
    record.mimeType === 'image/svg+xml' ||
    /\.svg$/i.test(record.url) ||
    body.subarray(0, 512).includes('<svg'),
  extract: (ctx) => {
    const text = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];

    for (const match of text.matchAll(TEXTUAL_NODES)) {
      const tag = (match[1] ?? '').toLowerCase();
      const inner = (match[2] ?? '').replace(/<[^>]+>/g, ' ');
      hits.push(
        ...scanText(inner, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'svg',
          method: `SVG <${tag}> node`,
        }),
      );
    }

    for (const match of text.matchAll(XML_COMMENT)) {
      hits.push(
        ...scanText(match[1] ?? '', {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'svg',
          method: 'SVG/XML comment',
        }),
      );
    }

    for (const match of text.matchAll(EMBEDDED_BASE64)) {
      const decoded = Buffer.from(match[1] ?? '', 'base64').toString('utf8');
      hits.push(
        ...scanText(decoded, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'svg',
          method: 'base64 payload embedded in an SVG href',
        }),
      );
    }

    return hits;
  },
};
