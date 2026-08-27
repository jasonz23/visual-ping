/** Shared domain types for the harvest and extract phases. */

/** How a URL entered the frontier. Used for the auditable discovery trail. */
export type DiscoverySource =
  | 'seed'
  | 'anchor'
  | 'link-rel'
  | 'img'
  | 'srcset'
  | 'iframe'
  | 'frame'
  | 'embed'
  | 'object'
  | 'source'
  | 'track'
  | 'area'
  | 'base'
  | 'poster'
  | 'form-action'
  | 'formaction'
  | 'data-attribute'
  | 'inline-style-url'
  | 'stylesheet-url'
  | 'css-import'
  | 'meta-refresh'
  | 'script-src'
  | 'js-string-literal'
  | 'json-value'
  | 'sourcemap'
  | 'sourcemap-comment'
  | 'clickable-element'
  | 'network-response'
  | 'redirect'
  | 'manifest'
  | 'sitemap'
  | 'header-link'
  | 'svg-href'
  | 'text-url';

/** A URL waiting to be (or already) fetched, with provenance. */
export interface FrontierEntry {
  /** Normalized URL: the dedupe key. */
  url: string;
  /** URL exactly as discovered, before normalization. */
  rawUrl: string;
  /** Page/artifact the URL was discovered on. */
  discoveredFrom: string;
  source: DiscoverySource;
  /** Extra provenance detail, e.g. the CSS selector or JS snippet. */
  detail?: string;
  depth: number;
}

/** Metadata sidecar persisted next to every raw response body. */
export interface ArtifactRecord {
  /** sha256 of the response body; also the on-disk artifact name. */
  sha256: string;
  /** Path of the raw body relative to the artifact directory. */
  bodyPath: string;
  /** URL requested (normalized). */
  url: string;
  /** URL after redirects, as reported by the browser. */
  finalUrl: string;
  status: number;
  statusText: string;
  method: string;
  contentType: string;
  /** Lower-cased content-type without parameters, e.g. `image/jpeg`. */
  mimeType: string;
  byteLength: number;
  headers: Record<string, string>;
  requestHeaders: Record<string, string>;
  resourceType: string;
  fromCache: boolean;
  /** ISO timestamp of capture. */
  fetchedAt: string;
  /** Set when this artifact is the rendered DOM rather than a network body. */
  kind: ArtifactKind;
  /** Provenance of the URL that produced this artifact. */
  discovery?: { source: DiscoverySource; discoveredFrom: string; detail?: string };
}

export type ArtifactKind =
  | 'response'
  | 'rendered-dom'
  | 'storage'
  | 'derived'
  | 'accessibility-text';

/** A password hit produced by an extractor. */
export interface PasswordHit {
  password: string;
  /** URL of the artifact the password was found in. */
  sourceUrl: string;
  /** Artifact path relative to the repo root. */
  artifactPath: string;
  /** Registry id of the extractor that produced the hit. */
  extractor: string;
  /** Human-readable description of exactly where/how it was found. */
  method: string;
  /** Short surrounding excerpt for auditability. */
  context?: string;
  mimeType: string;
}

/** Result of running one extractor over one artifact. */
export interface ExtractionResult {
  extractor: string;
  applied: boolean;
  hits: PasswordHit[];
  error?: string;
}

/** Everything an extractor needs to inspect one artifact. */
export interface ExtractionContext {
  record: ArtifactRecord;
  body: Buffer;
  /** Absolute path to the raw body on disk. */
  bodyPath: string;
  /** Report a URL found inside an artifact (feeds phase-1 re-crawl suggestions). */
  noteUrl?: (url: string, detail: string) => void;
}

/** One handler in the extractor registry. */
export interface Extractor {
  /** Stable id, used in reports and the coverage matrix. */
  id: string;
  /** One-line description of the channel it covers. */
  description: string;
  /** Decide whether this extractor applies to a given artifact. */
  appliesTo(record: ArtifactRecord, body: Buffer): boolean;
  /** Find password hits. Must return every hit, not just the first. */
  extract(ctx: ExtractionContext): Promise<PasswordHit[]> | PasswordHit[];
}
