/**
 * Crawler-trap detection.
 *
 * This site serves `/report/?page=N` for every N up to at least 1,000,000: each
 * page is a fresh slice of generated rows that links only to N±1. A frontier that
 * follows it never terminates, so "frontier exhausted" would become an unprovable
 * claim.
 *
 * The guard groups URLs into *templates* (path and query shape with numbers
 * normalised away) and saturates a template once it has demonstrably stopped
 * producing novelty:
 *
 *  - structural novelty — pages of the template all reduce to the same shape hash
 *    (the body with digits and hex runs masked), and
 *  - link novelty — the template's pages have stopped linking anywhere outside it.
 *
 * Both must hold across a sample before a template is closed, and a hard per-
 * template cap acts as a backstop for shapes the heuristic does not model. Every
 * decision is recorded so the crawl report can state exactly what was skipped.
 */
import { sha256 } from '../util/hash.js';

export interface TrapGuardOptions {
  /** Pages of one template to observe before saturation may be declared. */
  sampleSize: number;
  /** Distinct shape hashes at or below which a template counts as repetitive. */
  maxDistinctShapes: number;
  /** Absolute cap on URLs enqueued per template, regardless of novelty. */
  maxPerTemplate: number;
}

export const DEFAULT_TRAP_OPTIONS: TrapGuardOptions = {
  sampleSize: 25,
  maxDistinctShapes: 2,
  maxPerTemplate: 500,
};

export interface TemplateStats {
  template: string;
  enqueued: number;
  fetched: number;
  distinctShapes: number;
  outboundNovelty: number;
  saturated: boolean;
  reason?: string;
  /** A representative URL, for the report. */
  example: string;
}

export class TrapGuard {
  private readonly templates = new Map<string, TemplateStats>();
  private readonly shapes = new Map<string, Set<string>>();
  private readonly options: TrapGuardOptions;

  constructor(options: Partial<TrapGuardOptions> = {}) {
    this.options = { ...DEFAULT_TRAP_OPTIONS, ...options };
  }

  /** Called before enqueuing. Returns false when the URL's template is closed. */
  allow(url: string): boolean {
    const template = templateKey(url);
    const stats = this.statsFor(template, url);
    if (stats.saturated) return false;
    if (stats.enqueued >= this.options.maxPerTemplate) {
      stats.saturated = true;
      stats.reason =
        `hard cap: ${this.options.maxPerTemplate} URLs enqueued for this template ` +
        'without the novelty heuristic closing it';
      return false;
    }
    stats.enqueued += 1;
    return true;
  }

  /**
   * Record what a fetched page of a template contained.
   *
   * @param outboundNovelty count of URLs this page contributed that fall outside
   *        its own template — the signal that the template is still a real crawl
   *        frontier rather than a self-referential loop.
   */
  observe(url: string, body: Buffer, outboundNovelty: number): void {
    const template = templateKey(url);
    const stats = this.statsFor(template, url);
    stats.fetched += 1;
    stats.outboundNovelty += outboundNovelty;

    const set = this.shapes.get(template) ?? new Set<string>();
    set.add(shapeHash(body));
    this.shapes.set(template, set);
    stats.distinctShapes = set.size;

    if (stats.saturated) return;
    if (stats.fetched < this.options.sampleSize) return;
    if (set.size > this.options.maxDistinctShapes) return;
    if (stats.outboundNovelty > 0) return;

    stats.saturated = true;
    stats.reason =
      `${stats.fetched} pages sampled reduced to ${set.size} distinct page shape(s) ` +
      'and contributed no URLs outside the template';
  }

  get report(): TemplateStats[] {
    return [...this.templates.values()].sort((a, b) => b.enqueued - a.enqueued);
  }

  get saturated(): TemplateStats[] {
    return this.report.filter((stats) => stats.saturated);
  }

  private statsFor(template: string, url: string): TemplateStats {
    let stats = this.templates.get(template);
    if (!stats) {
      stats = {
        template,
        enqueued: 0,
        fetched: 0,
        distinctShapes: 0,
        outboundNovelty: 0,
        saturated: false,
        example: url,
      };
      this.templates.set(template, stats);
    }
    return stats;
  }
}

/**
 * Collapse a URL to its template: numeric-ish path segments and query values
 * become `{n}`, so `/report/?page=1` and `/report/?page=2424` share a key while
 * `/docs/upstream-sample-channel/` keeps its identity.
 */
export function templateKey(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const path = parsed.pathname
    .split('/')
    .map((segment) => (/^\d+$/.test(segment) || /^p?\d+$/i.test(segment) ? '{n}' : segment))
    .join('/');
  const query = [...parsed.searchParams.entries()]
    .map(([key, value]) => `${key}=${/^\d+$/.test(value) ? '{n}' : value}`)
    .sort()
    .join('&');
  return query ? `${path}?${query}` : path;
}

/**
 * Fingerprint a page's *structure* rather than its content: mask digits and long
 * hex runs, drop whitespace, and hash. Two paginated pages of the same table
 * collapse to the same value; two genuinely different articles do not.
 */
export function shapeHash(body: Buffer): string {
  const text = body
    .toString('utf8')
    .replace(/[0-9a-f]{6,}/gi, '#')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
  return sha256(text);
}
