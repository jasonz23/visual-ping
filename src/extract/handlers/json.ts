/**
 * JSON channels: every key and every string value, walked recursively, plus a
 * second pass that parses string values which are themselves JSON.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export const jsonExtractor: Extractor = {
  id: 'json',
  description: 'recursive walk over JSON keys, string values, and nested JSON-in-string values',
  appliesTo: (record, body) =>
    /json/i.test(record.mimeType) ||
    /\.(json|webmanifest|map)$/i.test(record.url) ||
    looksLikeJson(body),
  extract: (ctx) => {
    let root: Json;
    try {
      root = JSON.parse(ctx.body.toString('utf8')) as Json;
    } catch {
      return [];
    }
    const hits: PasswordHit[] = [];
    walk(root, '$', (path, value) => {
      hits.push(
        ...scanText(value, {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'json',
          method: `JSON value at ${path}`,
        }),
      );
      // A string value may itself be an encoded JSON document.
      if (value.trim().startsWith('{') || value.trim().startsWith('[')) {
        try {
          const nested = JSON.parse(value) as Json;
          walk(nested, `${path} (nested)`, (nestedPath, nestedValue) => {
            hits.push(
              ...scanText(nestedValue, {
                record: ctx.record,
                artifactPath: ctx.bodyPath,
                extractor: 'json',
                method: `JSON value at ${nestedPath}`,
              }),
            );
          });
        } catch {
          /* not nested JSON */
        }
      }
    });
    return hits;
  },
};

function looksLikeJson(body: Buffer): boolean {
  const head = body.subarray(0, 64).toString('utf8').trimStart();
  return head.startsWith('{') || head.startsWith('[');
}

function walk(node: Json, path: string, visit: (path: string, value: string) => void): void {
  if (typeof node === 'string') {
    visit(path, node);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, visit));
    return;
  }
  if (node && typeof node === 'object') {
    for (const [key, child] of Object.entries(node)) {
      visit(`${path}.${key} (key)`, key);
      walk(child, `${path}.${key}`, visit);
    }
  }
}
