/**
 * Content-addressed artifact store.
 *
 * Bodies are stored once per sha256 under `bodies/<aa>/<sha256><ext>`; every
 * (url, body) observation appends one `ArtifactRecord` to `index.jsonl`. That
 * split is what makes runs resumable and dedupe auditable: re-running the crawl
 * re-writes nothing that already hashes the same, and the index still records
 * that a second URL served identical bytes.
 */
import { createReadStream, existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { dirname, join, relative } from 'node:path';
import type { ArtifactRecord } from '../types.js';
import { sha256 } from '../util/hash.js';

const EXTENSION_BY_MIME: Record<string, string> = {
  'text/html': '.html',
  'text/css': '.css',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/xml': '.xml',
  'text/javascript': '.js',
  'application/javascript': '.js',
  'application/x-javascript': '.js',
  'application/json': '.json',
  'application/manifest+json': '.webmanifest',
  'application/xml': '.xml',
  'application/rss+xml': '.xml',
  'application/atom+xml': '.xml',
  'application/pdf': '.pdf',
  'application/zip': '.zip',
  'application/gzip': '.gz',
  'application/wasm': '.wasm',
  'application/octet-stream': '.bin',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/svg+xml': '.svg',
  'image/x-icon': '.ico',
  'image/vnd.microsoft.icon': '.ico',
  'image/bmp': '.bmp',
  'image/tiff': '.tif',
  'audio/mpeg': '.mp3',
  'audio/ogg': '.ogg',
  'audio/wav': '.wav',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'font/woff': '.woff',
  'font/woff2': '.woff2',
  'font/ttf': '.ttf',
  'font/otf': '.otf',
  'application/font-woff': '.woff',
  'application/x-font-ttf': '.ttf',
};

export function extensionForMime(mimeType: string, url: string): string {
  const known = EXTENSION_BY_MIME[mimeType];
  if (known) return known;
  let pathname = url;
  try {
    pathname = new URL(url).pathname;
  } catch {
    /* keep the raw string; it is only used to guess an extension */
  }
  const match = /\.([a-z0-9]{1,6})$/i.exec(pathname);
  return match?.[1] ? `.${match[1].toLowerCase()}` : '.bin';
}

export interface StoreWriteResult {
  record: ArtifactRecord;
  /** False when an identical body was already on disk (dedupe hit). */
  bodyWritten: boolean;
  /** True when this exact (kind, url, sha256, status) tuple was already indexed. */
  duplicateObservation: boolean;
}

export class ArtifactStore {
  private readonly bodiesDir: string;
  private readonly indexPath: string;
  private readonly knownBodies = new Set<string>();
  private readonly observations = new Set<string>();
  private readonly records: ArtifactRecord[] = [];
  private loaded = false;

  constructor(private readonly rootDir: string) {
    this.bodiesDir = join(rootDir, 'bodies');
    this.indexPath = join(rootDir, 'index.jsonl');
  }

  /** Load the existing index so a re-run skips work it already did. */
  async load(): Promise<void> {
    if (this.loaded) return;
    await mkdir(this.bodiesDir, { recursive: true });
    this.loaded = true;
    if (!existsSync(this.indexPath)) return;
    const stream = createInterface({
      input: createReadStream(this.indexPath, 'utf8'),
      crlfDelay: Infinity,
    });
    for await (const line of stream) {
      if (!line.trim()) continue;
      const record = JSON.parse(line) as ArtifactRecord;
      this.records.push(record);
      this.knownBodies.add(record.sha256);
      this.observations.add(observationKey(record));
    }
  }

  get all(): readonly ArtifactRecord[] {
    return this.records;
  }

  absolutePath(record: ArtifactRecord): string {
    return join(this.rootDir, record.bodyPath);
  }

  relativeToCwd(record: ArtifactRecord): string {
    return relative(process.cwd(), this.absolutePath(record));
  }

  async readBody(record: ArtifactRecord): Promise<Buffer> {
    return readFile(this.absolutePath(record));
  }

  /** Persist a body plus its sidecar record. Idempotent per (kind, url, sha256, status). */
  async put(
    body: Buffer,
    meta: Omit<ArtifactRecord, 'sha256' | 'bodyPath' | 'byteLength'>,
  ): Promise<StoreWriteResult> {
    await this.load();
    const digest = sha256(body);
    const ext = extensionForMime(meta.mimeType, meta.finalUrl || meta.url);
    const bodyPath = join('bodies', digest.slice(0, 2), `${digest}${ext}`);
    const absolute = join(this.rootDir, bodyPath);

    let bodyWritten = false;
    if (!this.knownBodies.has(digest) || !existsSync(absolute)) {
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, body);
      this.knownBodies.add(digest);
      bodyWritten = true;
    }

    const record: ArtifactRecord = { ...meta, sha256: digest, bodyPath, byteLength: body.length };
    const key = observationKey(record);
    if (this.observations.has(key)) {
      return { record, bodyWritten, duplicateObservation: true };
    }
    this.observations.add(key);
    this.records.push(record);
    await appendFile(this.indexPath, JSON.stringify(record) + '\n', 'utf8');
    return { record, bodyWritten, duplicateObservation: false };
  }

  /** Distinct body count (the dedupe denominator). */
  get uniqueBodyCount(): number {
    return this.knownBodies.size;
  }
}

function observationKey(record: ArtifactRecord): string {
  return [record.kind, record.url, record.sha256, record.status].join(' ');
}
