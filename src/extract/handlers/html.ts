/**
 * HTML channels.
 *
 * Runs over both the raw response body and the rendered DOM snapshot, because the
 * two differ: this site mutates the DOM with inline scripts, so text can exist in
 * exactly one of the two. Covers comments, attribute values, and text that is
 * present in the markup but deliberately not painted (display:none, zero opacity,
 * off-canvas positioning, or foreground colour matching the background).
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

const COMMENT = /<!--([\s\S]*?)-->/g;
const TAG = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s">]+))?)*)\s*\/?>/g;
const ATTRIBUTE = /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/g;

/** Style declarations that hide an element from sighted users. */
const HIDING_STYLE =
  /(display\s*:\s*none|visibility\s*:\s*hidden|opacity\s*:\s*0(?!\.\d*[1-9])|font-size\s*:\s*0|clip\s*:\s*rect\(0|clip-path\s*:\s*inset\(\s*(?:50%|100%)|text-indent\s*:\s*-\d{4,}|(?:left|top)\s*:\s*-\d{4,}px|position\s*:\s*absolute[^;"']*(?:left|top)\s*:\s*-)/i;

export const htmlExtractor: Extractor = {
  id: 'html',
  description:
    'HTML comments, attribute values (alt/title/data-*/aria-*), and text hidden by inline CSS',
  appliesTo: (record) =>
    record.mimeType === 'text/html' ||
    record.mimeType === 'application/xhtml+xml' ||
    record.kind === 'rendered-dom',
  extract: (ctx) => {
    const html = ctx.body.toString('utf8');
    const hits: PasswordHit[] = [];
    const where = ctx.record.kind === 'rendered-dom' ? 'rendered DOM' : 'raw HTML body';

    for (const match of html.matchAll(COMMENT)) {
      hits.push(
        ...scanText(match[1] ?? '', {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'html',
          method: `HTML comment (${where})`,
        }),
      );
    }

    for (const tagMatch of html.matchAll(TAG)) {
      const tagName = (tagMatch[1] ?? '').toLowerCase();
      const attributes = tagMatch[2] ?? '';
      let hidden = false;
      for (const attrMatch of attributes.matchAll(ATTRIBUTE)) {
        const name = (attrMatch[1] ?? '').toLowerCase();
        const value = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? '';
        if (name === 'style' && HIDING_STYLE.test(value)) hidden = true;
        if (name === 'hidden') hidden = true;
        hits.push(
          ...scanText(value, {
            record: ctx.record,
            artifactPath: ctx.bodyPath,
            extractor: 'html',
            method: `<${tagName}> attribute "${name}" (${where})`,
          }),
        );
      }
      if (hidden) {
        const start = (tagMatch.index ?? 0) + tagMatch[0].length;
        const body = html.slice(start, start + 4000);
        hits.push(
          ...scanText(body, {
            record: ctx.record,
            artifactPath: ctx.bodyPath,
            extractor: 'html',
            method: `text inside hidden <${tagName}> element (${where})`,
          }),
        );
      }
    }

    // Text nodes only — strips scripts and styles so the "visible text" channel is
    // reported distinctly from the code channels.
    const textOnly = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    hits.push(
      ...scanText(textOnly, {
        record: ctx.record,
        artifactPath: ctx.bodyPath,
        extractor: 'html',
        method: `document text node (${where})`,
      }),
    );

    return hits;
  },
};

export { HIDING_STYLE };
