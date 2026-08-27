/**
 * Phase 2 — extract.
 *
 * Every artifact is passed through every applicable extractor. Nothing short-
 * circuits: the point of the coverage matrix in the crawl report is that we can
 * show which (content-type × extractor) cells actually ran.
 */
import type { Logger } from '../logging.js';
import type { ArtifactStore } from '../store/artifactStore.js';
import type { PasswordHit } from '../types.js';
import type { ExtractorRegistry } from './registry.js';
import { dedupeHits } from './hit.js';

export interface CoverageCell {
  applied: number;
  hits: number;
  errors: number;
}

export interface ExtractionReport {
  hits: PasswordHit[];
  uniquePasswords: string[];
  /** mimeType -> extractorId -> counts. */
  coverage: Record<string, Record<string, CoverageCell>>;
  artifactsScanned: number;
  bodiesScanned: number;
  errors: { artifact: string; extractor: string; message: string }[];
  extractorsWithNoHits: string[];
}

export interface ExtractOptions {
  /** Called whenever the unique-password count increases. */
  onNewPassword?: (password: string, hit: PasswordHit, total: number) => void;
}

export async function extractAll(
  store: ArtifactStore,
  registry: ExtractorRegistry,
  log: Logger,
  options: ExtractOptions = {},
): Promise<ExtractionReport> {
  await store.load();

  const hits: PasswordHit[] = [];
  const coverage: Record<string, Record<string, CoverageCell>> = {};
  const errors: ExtractionReport['errors'] = [];
  const unique = new Set<string>();
  const extractorHitCounts = new Map<string, number>();
  const scannedBodies = new Set<string>();

  // One pass per (url, body) observation so header-channel hits are attributed to
  // the URL that served them; bodies are re-read from the content-addressed store.
  const records = [...store.all];
  let index = 0;
  for (const record of records) {
    index += 1;
    let body: Buffer;
    try {
      body = await store.readBody(record);
    } catch (error) {
      errors.push({ artifact: record.bodyPath, extractor: '(read)', message: message(error) });
      continue;
    }
    scannedBodies.add(record.sha256);

    const results = await registry.runAll({
      record,
      body,
      bodyPath: store.relativeToCwd(record),
    });

    const byMime = (coverage[record.mimeType] ??= {});
    for (const result of results) {
      const cell = (byMime[result.extractor] ??= { applied: 0, hits: 0, errors: 0 });
      if (!result.applied) continue;
      cell.applied += 1;
      cell.hits += result.hits.length;
      if (result.error) {
        cell.errors += 1;
        errors.push({
          artifact: record.bodyPath,
          extractor: result.extractor,
          message: result.error,
        });
      }
      for (const hit of result.hits) {
        hits.push(hit);
        extractorHitCounts.set(
          result.extractor,
          (extractorHitCounts.get(result.extractor) ?? 0) + 1,
        );
        if (!unique.has(hit.password)) {
          unique.add(hit.password);
          log.info('password found', {
            password: hit.password,
            total: unique.size,
            url: hit.sourceUrl,
            extractor: hit.extractor,
            method: hit.method,
          });
          options.onNewPassword?.(hit.password, hit, unique.size);
        }
      }
    }

    if (index % 50 === 0) {
      log.debug('extraction progress', { scanned: index, of: records.length, unique: unique.size });
    }
  }

  const extractorsWithNoHits = registry.all
    .map((extractor) => extractor.id)
    .filter((id) => (extractorHitCounts.get(id) ?? 0) === 0);

  return {
    hits: dedupeHits(hits),
    uniquePasswords: [...unique].sort(),
    coverage,
    artifactsScanned: records.length,
    bodiesScanned: scannedBodies.size,
    errors,
    extractorsWithNoHits,
  };
}

/** Best (most specific) hit per password, for `passwords.json`. */
export function bestHitPerPassword(hits: readonly PasswordHit[]): PasswordHit[] {
  const best = new Map<string, PasswordHit>();
  for (const hit of hits) {
    const existing = best.get(hit.password);
    if (!existing || specificity(hit) > specificity(existing)) best.set(hit.password, hit);
  }
  return [...best.values()].sort((a, b) => a.password.localeCompare(b.password));
}

/**
 * Prefer the extractor that explains *how* the password was hidden over the
 * catch-all decoders that merely prove it is present in the bytes.
 */
function specificity(hit: PasswordHit): number {
  const rank: Record<string, number> = {
    'raw-text': 0,
    'binary-strings': 1,
    'utf16-text': 1,
    hex: 2,
    escapes: 2,
    base64: 3,
    compression: 3,
    'data-uri': 3,
    json: 4,
    html: 5,
    css: 5,
    javascript: 5,
    svg: 5,
    sourcemap: 6,
    archive: 6,
    'response-headers': 6,
    'request-headers': 6,
    cookies: 6,
    pdf: 7,
    'media-metadata': 7,
    font: 7,
    wasm: 7,
    'image-metadata': 8,
    'image-chunks': 8,
    'trailing-bytes': 8,
    ocr: 9,
  };
  return rank[hit.extractor] ?? 5;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
