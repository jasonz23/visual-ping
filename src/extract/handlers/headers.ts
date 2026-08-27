/**
 * HTTP metadata channels: response headers, request headers and cookies.
 *
 * The challenge page claims header passwords are "staging placeholders" — but that
 * bullet is removed from the DOM by an inline script before a real browser ever
 * paints it, so the rendered page never makes that claim. We therefore collect
 * header hits like any other, and let the report show where each one came from.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

export const responseHeaderExtractor: Extractor = {
  id: 'response-headers',
  description: 'the status line and every response header, including custom X-*, ETag, Link, Server',
  appliesTo: (record) => Object.keys(record.headers).length > 0 || record.statusText.length > 0,
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    // The reason phrase is server-controlled text that no body-oriented extractor
    // would ever see, so it gets its own pass.
    hits.push(
      ...scanText(`${ctx.record.status} ${ctx.record.statusText}`, {
        record: ctx.record,
        artifactPath: ctx.bodyPath,
        extractor: 'response-headers',
        method: 'HTTP status line (reason phrase)',
      }),
    );
    for (const [name, value] of Object.entries(ctx.record.headers)) {
      hits.push(
        ...scanText(value, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'response-headers',
          method: `HTTP response header "${name}"`,
        }),
      );
    }
    return hits;
  },
};

export const requestHeaderExtractor: Extractor = {
  id: 'request-headers',
  description: 'request headers echoed back by the browser (e.g. server-set cookies replayed)',
  appliesTo: (record) => Object.keys(record.requestHeaders).length > 0,
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    for (const [name, value] of Object.entries(ctx.record.requestHeaders)) {
      hits.push(
        ...scanText(value, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'request-headers',
          method: `HTTP request header "${name}"`,
        }),
      );
    }
    return hits;
  },
};

export const cookieExtractor: Extractor = {
  id: 'cookies',
  description: 'Set-Cookie values and the browser cookie jar / localStorage / sessionStorage',
  appliesTo: (record) =>
    record.kind === 'storage' ||
    Object.keys(record.headers).some((name) => name.toLowerCase() === 'set-cookie'),
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    for (const [name, value] of Object.entries(ctx.record.headers)) {
      if (name.toLowerCase() !== 'set-cookie') continue;
      hits.push(
        ...scanText(value, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'cookies',
          method: 'Set-Cookie response header',
        }),
      );
    }
    if (ctx.record.kind === 'storage') {
      hits.push(
        ...scanText(ctx.body.toString('utf8'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'cookies',
          method: `browser state snapshot (${ctx.record.resourceType})`,
        }),
      );
    }
    return hits;
  },
};
