import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore, extensionForMime } from '../src/store/artifactStore.js';
import { sha256 } from '../src/util/hash.js';
import type { ArtifactRecord } from '../src/types.js';
import { record } from './fixtures/build.js';

describe('extensionForMime', () => {
  it('maps known content-types', () => {
    expect(extensionForMime('text/html', 'http://h/a')).toBe('.html');
    expect(extensionForMime('image/jpeg', 'http://h/a')).toBe('.jpg');
    expect(extensionForMime('application/wasm', 'http://h/a')).toBe('.wasm');
  });

  it('falls back to the URL path extension, then to .bin', () => {
    expect(extensionForMime('application/x-unknown', 'http://h/a/thing.woff2')).toBe('.woff2');
    expect(extensionForMime('application/x-unknown', 'http://h/a/thing')).toBe('.bin');
  });

  it('ignores a query string when guessing from the path', () => {
    expect(extensionForMime('application/x-unknown', 'http://h/a.map?v=2')).toBe('.map');
    expect(extensionForMime('application/x-unknown', 'http://h/dir?x=a.png')).toBe('.bin');
  });
});

describe('ArtifactStore', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vp-store-'));
    store = new ArtifactStore(dir);
    await store.load();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** `ArtifactStore.put` derives sha256, bodyPath and byteLength itself. */
  const meta = (url: string): Omit<ArtifactRecord, 'sha256' | 'bodyPath' | 'byteLength'> => {
    const base = record({ url, finalUrl: url, mimeType: 'text/html', contentType: 'text/html' });
    return base;
  };

  it('writes a body once and addresses it by sha256', async () => {
    const body = Buffer.from('<html>one</html>');
    const result = await store.put(body, meta('http://h/a'));
    expect(result.bodyWritten).toBe(true);
    expect(result.record.sha256).toBe(sha256(body));
    expect(await readFile(join(dir, result.record.bodyPath))).toEqual(body);
  });

  it('does not rewrite an identical body served from a second URL', async () => {
    const body = Buffer.from('<html>same</html>');
    const first = await store.put(body, meta('http://h/a'));
    const second = await store.put(body, meta('http://h/b'));

    expect(first.bodyWritten).toBe(true);
    expect(second.bodyWritten).toBe(false);
    expect(second.record.bodyPath).toBe(first.record.bodyPath);
    // …but both observations are indexed, so the report can show the duplication.
    expect(store.all).toHaveLength(2);
    expect(store.uniqueBodyCount).toBe(1);
  });

  it('is idempotent for the same (kind, url, sha256, status)', async () => {
    const body = Buffer.from('<html>same</html>');
    await store.put(body, meta('http://h/a'));
    const again = await store.put(body, meta('http://h/a'));
    expect(again.duplicateObservation).toBe(true);
    expect(store.all).toHaveLength(1);
  });

  it('indexes a changed body for the same URL as a new observation', async () => {
    await store.put(Buffer.from('v1'), meta('http://h/a'));
    await store.put(Buffer.from('v2'), meta('http://h/a'));
    expect(store.all).toHaveLength(2);
    expect(store.uniqueBodyCount).toBe(2);
  });

  it('reloads its index so a resumed run skips work it already did', async () => {
    const body = Buffer.from('<html>persisted</html>');
    await store.put(body, meta('http://h/a'));

    const reopened = new ArtifactStore(dir);
    await reopened.load();
    expect(reopened.all).toHaveLength(1);
    expect(reopened.uniqueBodyCount).toBe(1);
    expect(await reopened.readBody(reopened.all[0]!)).toEqual(body);

    const again = await reopened.put(body, meta('http://h/a'));
    expect(again.duplicateObservation).toBe(true);
    expect(again.bodyWritten).toBe(false);
  });
});
