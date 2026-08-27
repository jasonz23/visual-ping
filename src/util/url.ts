/**
 * URL normalization and dedupe keys.
 *
 * Two tiers, deliberately:
 *  - `normalizeUrl` is *lossless with respect to meaning*: it only removes things
 *    that provably do not change what the server returns (fragment, default port,
 *    dot segments, case of scheme/host, redundant percent-encoding).
 *  - `canonicalKey` is additionally *lossy*: it drops well-known decorative query
 *    parameters so that `/wiki/`, `/wiki/?v=7` and `/wiki/?utm_source=internal`
 *    collapse into one frontier entry. The full first-seen URL is still the one we
 *    request, so nothing about the actual HTTP conversation changes.
 */

/** Query parameters that are decorative on this site (and on the web generally). */
export const DECORATIVE_PARAMS: ReadonlySet<string> = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'ref',
  'referrer',
  'source',
  'hl',
  'lang',
  'v',
  'fbclid',
  'gclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  '_ga',
]);

/** Characters that never need percent-encoding, per RFC 3986 §2.3. */
const UNRESERVED = /%(2D|2E|5F|7E|3[0-9]|4[1-9A-F]|5[0-9A]|6[1-9A-F]|7[0-9A])/gi;

function decodeUnreserved(value: string): string {
  return value.replace(UNRESERVED, (match) =>
    String.fromCharCode(parseInt(match.slice(1), 16)),
  );
}

/** Resolve a possibly-relative URL against a base. Returns null when unusable. */
export function resolveUrl(raw: string, base: string): string | null {
  const candidate = raw.trim();
  if (!candidate) return null;
  if (/^(javascript|mailto|tel|about|blob):/i.test(candidate)) return null;
  // data: URIs are handled by the extractors, not the frontier.
  if (/^data:/i.test(candidate)) return null;
  if (candidate.startsWith('#')) return null;
  try {
    return new URL(candidate, base).toString();
  } catch {
    return null;
  }
}

/** Normalize without changing meaning. Throws nothing; returns null on bad input. */
export function normalizeUrl(raw: string, base?: string): string | null {
  let url: URL;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if (
    (url.protocol === 'http:' && url.port === '80') ||
    (url.protocol === 'https:' && url.port === '443')
  ) {
    url.port = '';
  }
  url.pathname = decodeUnreserved(url.pathname).replace(/\/{2,}/g, '/');

  const params = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  url.search = '';
  for (const [key, value] of params) url.searchParams.append(key, value);
  if (params.length === 0) url.search = '';

  return url.toString();
}

/** Frontier dedupe key: normalized, minus decorative query parameters. */
export function canonicalKey(raw: string, base?: string): string | null {
  const normalized = normalizeUrl(raw, base);
  if (!normalized) return null;
  const url = new URL(normalized);
  const kept = [...url.searchParams.entries()].filter(([key]) => !DECORATIVE_PARAMS.has(key));
  url.search = '';
  for (const [key, value] of kept) url.searchParams.append(key, value);
  // Treat `/path` and `/path/` as distinct: nginx may serve different things.
  return url.toString();
}

/** True when the URL is on the host we are allowed to crawl. */
export function isSameHost(url: string, host: string): boolean {
  try {
    return new URL(url).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Extract URL-shaped literals from arbitrary text (JS bundles, JSON, CSS, plain text). */
export function findUrlLiterals(source: string, base: string): string[] {
  const found = new Set<string>();
  // JSON and JS bundles escape forward slashes; unescape first so `\/a\/b.json`
  // is recognised as the path it represents.
  const text = source.replace(/\\\//g, '/');
  const patterns: RegExp[] = [
    // Absolute URLs.
    /https?:\/\/[^\s"'`<>()\\]+/g,
    // Quoted root-relative or dotted-relative paths with a plausible extension or trailing slash.
    /["'`]((?:\.{0,2}\/)[^"'`\s<>()\\]{1,300})["'`]/g,
    // CSS url(...) including unquoted form.
    /url\(\s*["']?([^"')]+)["']?\s*\)/gi,
    // @import "..." / @import url(...)
    /@import\s+(?:url\()?\s*["']([^"')]+)["']/gi,
    // srcset-ish comma lists are handled by the DOM collector; this covers text copies.
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const candidate = match[1] ?? match[0];
      if (!candidate) continue;
      const cleaned = candidate.replace(/\\\//g, '/').trim();
      if (!cleaned || cleaned.length > 512) continue;
      const resolved = resolveUrl(cleaned, base);
      if (resolved) found.add(resolved);
    }
  }
  return [...found];
}
