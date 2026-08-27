/**
 * The crawl report is a deliverable, and its whole value is that a reader can
 * trust the numbers. These tests pin the claims that matter: frontier exhaustion
 * is reported honestly, dedupe is counted, and the coverage matrix reflects what
 * actually ran rather than what was declared.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArtifactStore } from '../src/store/artifactStore.js';
import { ExtractorRegistry } from '../src/extract/registry.js';
import { extractAll } from '../src/extract/pipeline.js';
import { renderCrawlReport } from '../src/report/reports.js';
import { createLogger } from '../src/logging.js';
import type { ArtifactRecord, Extractor } from '../src/types.js';
import { FAKE, record } from './fixtures/build.js';

const log = createLogger('error');

const htmlOnly: Extractor = {
  id: 'html-only',
  description: 'applies only to HTML, and always finds the fixture password',
  appliesTo: (r) => r.mimeType === 'text/html',
  extract: (ctx) => [
    {
      password: FAKE.htmlComment,
      sourceUrl: ctx.record.url,
      artifactPath: ctx.bodyPath,
      extractor: 'html-only',
      method: 'test channel',
      mimeType: ctx.record.mimeType,
    },
  ],
};

const neverApplies: Extractor = {
  id: 'never-applies',
  description: 'claims a content-type this run never saw',
  appliesTo: (r) => r.mimeType === 'application/pdf',
  extract: () => [],
};

const appliesButFindsNothing: Extractor = {
  id: 'quiet',
  description: 'runs everywhere and finds nothing',
  appliesTo: () => true,
  extract: () => [],
};

describe('renderCrawlReport', () => {
  let dir: string;
  let store: ArtifactStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vp-report-'));
    store = new ArtifactStore(dir);
    await store.load();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const meta = (
    url: string,
    mimeType: string,
  ): Omit<ArtifactRecord, 'sha256' | 'bodyPath' | 'byteLength'> =>
    record({ url, finalUrl: url, mimeType, contentType: mimeType });

  async function build(): Promise<string> {
    await store.put(Buffer.from('<html>a</html>'), meta('http://h/a', 'text/html'));
    await store.put(Buffer.from('<html>a</html>'), meta('http://h/b', 'text/html')); // same bytes
    await store.put(Buffer.from('body{}'), meta('http://h/s.css', 'text/css'));

    const registry = new ExtractorRegistry().registerAll([
      htmlOnly,
      neverApplies,
      appliesButFindsNothing,
    ]);
    const extraction = await extractAll(store, registry, log);
    return renderCrawlReport({
      baseUrl: 'http://h/',
      harvest: null,
      extraction,
      store,
      registry,
    });
  }

  it('counts observations, unique bodies and collapsed duplicates', async () => {
    const md = await build();
    expect(md).toContain('Stored observations (url × body × status): **3**');
    expect(md).toContain('Unique bodies after sha256 dedupe: **2**');
    expect(md).toContain('Duplicate bodies collapsed: **1**');
  });

  it('shows applied/hits per (content-type, extractor) and — where it did not run', async () => {
    const md = await build();
    // Scope to the matrix: `## 2. Artifacts` has its own per-content-type table.
    const matrix = md.slice(md.indexOf('## 3. Extractor coverage matrix'));
    const htmlRow = matrix.split('\n').find((line) => line.startsWith('| `text/html`'));
    const cssRow = matrix.split('\n').find((line) => line.startsWith('| `text/css`'));
    // html-only ran over both HTML artifacts and found one password in each…
    expect(htmlRow).toContain('2/2');
    // …and did not run over the stylesheet at all.
    expect(cssRow).toContain('—');
  });

  it('lists extractors that found nothing rather than dropping them', async () => {
    const md = await build();
    expect(md).toContain('### Extractors that found nothing');
    expect(md).toContain('`quiet`');
    expect(md).toContain('`never-applies`');
    expect(md).not.toMatch(/found nothing[\s\S]*?- `html-only`/);
  });

  it('reports the passwords it found with their channel', async () => {
    const md = await build();
    expect(md).toContain(FAKE.htmlComment);
    expect(md).toContain('test channel');
    expect(md).toContain('Unique passwords found: **1**');
  });

  it('says plainly when no harvest ran in this invocation', async () => {
    const md = await build();
    expect(md).toContain('No harvest was run in this invocation');
  });
});
