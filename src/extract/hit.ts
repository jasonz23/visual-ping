/** Helpers every extractor uses to turn raw text into `PasswordHit`s. */
import type { ArtifactRecord, PasswordHit } from '../types.js';
import { findPasswords } from '../util/password.js';

export interface ScanOptions {
  record: ArtifactRecord;
  artifactPath: string;
  extractor: string;
  /** Human-readable description of the channel, e.g. `EXIF UserComment`. */
  method: string;
  /** Overrides the source URL when the hit came from a nested resource. */
  sourceUrl?: string;
}

/** Scan `text` and turn every match into a hit, minus the published example. */
export function scanText(text: string, options: ScanOptions): PasswordHit[] {
  if (!text) return [];
  return findPasswords(text).map((match) => ({
    password: match.password,
    sourceUrl: options.sourceUrl ?? (options.record.finalUrl || options.record.url),
    artifactPath: options.artifactPath,
    extractor: options.extractor,
    method: options.method,
    context: match.context,
    mimeType: options.record.mimeType,
  }));
}

/** Deduplicate hits, keeping the first (most specific) description of each. */
export function dedupeHits(hits: readonly PasswordHit[]): PasswordHit[] {
  const seen = new Map<string, PasswordHit>();
  for (const hit of hits) {
    const key = `${hit.password}|${hit.sourceUrl}|${hit.method}`;
    if (!seen.has(key)) seen.set(key, hit);
  }
  return [...seen.values()];
}
