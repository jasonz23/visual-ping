/**
 * Crawl frontier with provenance.
 *
 * Dedupe is on `canonicalKey` (normalized URL minus decorative query params), but
 * every discovery of an already-known URL is still recorded so the crawl report can
 * show *all* the ways a page was reachable — that audit trail is what the
 * completeness argument rests on.
 */
import type { DiscoverySource, FrontierEntry } from '../types.js';
import type { TrapGuard } from '../harvest/trapGuard.js';
import { canonicalKey, isSameHost } from '../util/url.js';

export interface DiscoveryEvent {
  key: string;
  rawUrl: string;
  discoveredFrom: string;
  source: DiscoverySource;
  detail?: string;
}

export interface AddOptions {
  rawUrl: string;
  discoveredFrom: string;
  source: DiscoverySource;
  detail?: string;
  depth: number;
}

export interface FrontierStats {
  known: number;
  visited: number;
  pending: number;
  offHost: number;
  unusable: number;
  discoveries: number;
  /** URLs refused because their template was saturated (see `TrapGuard`). */
  trapped: number;
}

export class Frontier {
  private readonly queue: FrontierEntry[] = [];
  private readonly known = new Set<string>();
  private readonly visited = new Set<string>();
  private readonly discoveries: DiscoveryEvent[] = [];
  private skippedOffHost = 0;
  private skippedUnusable = 0;
  private skippedTrapped = 0;

  constructor(
    private readonly host: string,
    private readonly trapGuard?: TrapGuard,
  ) {}

  /** Returns true when the URL was newly enqueued. */
  add(options: AddOptions): boolean {
    const key = canonicalKey(options.rawUrl, options.discoveredFrom);
    if (!key) {
      this.skippedUnusable += 1;
      return false;
    }
    if (!isSameHost(key, this.host)) {
      this.skippedOffHost += 1;
      return false;
    }
    this.discoveries.push({
      key,
      rawUrl: options.rawUrl,
      discoveredFrom: options.discoveredFrom,
      source: options.source,
      detail: options.detail,
    });
    if (this.known.has(key)) return false;
    // Only new URLs are charged against a template's budget; a repeat discovery
    // of something already queued is free.
    if (this.trapGuard && !this.trapGuard.allow(key)) {
      this.skippedTrapped += 1;
      return false;
    }
    this.known.add(key);
    this.queue.push({
      url: key,
      rawUrl: options.rawUrl,
      discoveredFrom: options.discoveredFrom,
      source: options.source,
      detail: options.detail,
      depth: options.depth,
    });
    return true;
  }

  next(): FrontierEntry | undefined {
    const entry = this.queue.shift();
    if (entry) this.visited.add(entry.url);
    return entry;
  }

  /** Mark a URL known+visited without enqueuing it (used when resuming a run). */
  markVisited(key: string): void {
    this.known.add(key);
    this.visited.add(key);
  }

  get pending(): number {
    return this.queue.length;
  }

  get knownUrls(): string[] {
    return [...this.known];
  }

  get discoveryLog(): readonly DiscoveryEvent[] {
    return this.discoveries;
  }

  get stats(): FrontierStats {
    return {
      known: this.known.size,
      visited: this.visited.size,
      pending: this.queue.length,
      offHost: this.skippedOffHost,
      unusable: this.skippedUnusable,
      discoveries: this.discoveries.length,
      trapped: this.skippedTrapped,
    };
  }
}
