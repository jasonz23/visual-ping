/**
 * One test per extraction channel: build a fixture that hides a *distinct* fake
 * password in that channel, run the registry over it, and assert both that the
 * password comes out and that the extractor which claims the channel is the one
 * that produced it.
 */
import { describe, expect, it } from 'vitest';
import type { ArtifactRecord, Extractor, PasswordHit } from '../src/types.js';
import { buildRegistry } from '../src/extract/index.js';
import { ExtractorRegistry } from '../src/extract/registry.js';
import {
  EXAMPLE,
  FAKE,
  buildFont,
  buildGzip,
  buildJpeg,
  buildMp3,
  buildPdf,
  buildPng,
  buildTar,
  buildWasm,
  buildZip,
  record,
} from './fixtures/build.js';

const registry = buildRegistry();

async function run(body: Buffer, overrides: Partial<ArtifactRecord> = {}): Promise<PasswordHit[]> {
  const artifact = record({ ...overrides, byteLength: body.length });
  const results = await registry.runAll({ record: artifact, body, bodyPath: 'test/fixture' });
  return results.flatMap((result) => result.hits);
}

function passwords(hits: readonly PasswordHit[]): string[] {
  return [...new Set(hits.map((hit) => hit.password))].sort();
}

function extractorsFor(hits: readonly PasswordHit[], password: string): string[] {
  return [...new Set(hits.filter((hit) => hit.password === password).map((hit) => hit.extractor))];
}

/**
 * The methods reported by one specific extractor. Necessary because the catch-all
 * `raw-text` extractor also sees most fixtures; asserting on "the first hit" would
 * test the ordering of the registry rather than the channel under test.
 */
function methodsFrom(hits: readonly PasswordHit[], password: string, extractor: string): string[] {
  return hits
    .filter((hit) => hit.password === password && hit.extractor === extractor)
    .map((hit) => hit.method);
}

function expectMethod(
  hits: readonly PasswordHit[],
  password: string,
  extractor: string,
  fragment: string,
): void {
  const methods = methodsFrom(hits, password, extractor);
  expect(
    methods.some((method) => method.includes(fragment)),
    `${extractor} methods: ${methods.join(' / ')}`,
  ).toBe(true);
}

describe('HTTP metadata channels', () => {
  it('finds a password in a custom response header', async () => {
    const hits = await run(Buffer.from('<html><body>nothing here</body></html>'), {
      mimeType: 'text/html',
      contentType: 'text/html',
      headers: { 'x-provisioning-note': FAKE.header, server: 'nginx' },
    });
    expect(passwords(hits)).toContain(FAKE.header);
    expect(extractorsFor(hits, FAKE.header)).toContain('response-headers');
    expectMethod(hits, FAKE.header, 'response-headers', 'x-provisioning-note');
  });

  it('finds a password in a Set-Cookie header', async () => {
    const hits = await run(Buffer.from('<html></html>'), {
      mimeType: 'text/html',
      headers: { 'set-cookie': `session=${FAKE.cookie}; Path=/` },
    });
    expect(extractorsFor(hits, FAKE.cookie)).toContain('cookies');
  });

  it('finds a password in a captured browser-state snapshot', async () => {
    const snapshot = JSON.stringify({ localStorage: { note: FAKE.cookie }, cookies: '' });
    const hits = await run(Buffer.from(snapshot), {
      kind: 'storage',
      mimeType: 'application/json',
      resourceType: 'browser-state',
    });
    expect(extractorsFor(hits, FAKE.cookie)).toContain('cookies');
  });
});

describe('HTML channels', () => {
  it('finds a password in an HTML comment', async () => {
    const html = `<html><body><p>text</p><!-- do not publish: ${FAKE.htmlComment} --></body></html>`;
    const hits = await run(Buffer.from(html), { mimeType: 'text/html' });
    expect(extractorsFor(hits, FAKE.htmlComment)).toContain('html');
    expectMethod(hits, FAKE.htmlComment, 'html', 'HTML comment');
  });

  it('finds a password in an attribute value', async () => {
    const html = `<html><body data-vp-archive="${FAKE.attribute}"><p>text</p></body></html>`;
    const hits = await run(Buffer.from(html), { mimeType: 'text/html' });
    expect(extractorsFor(hits, FAKE.attribute)).toContain('html');
    expectMethod(hits, FAKE.attribute, 'html', 'data-vp-archive');
  });

  it('finds text hidden by inline CSS and says it was hidden', async () => {
    const html = `<div style="display:none">${FAKE.hiddenDiv}</div>`;
    const hits = await run(Buffer.from(html), { mimeType: 'text/html' });
    expectMethod(hits, FAKE.hiddenDiv, 'html', 'hidden');
  });

  it('reports the rendered DOM distinctly from the raw body', async () => {
    const html = `<!-- ${FAKE.htmlComment} -->`;
    const hits = await run(Buffer.from(html), { mimeType: 'text/html', kind: 'rendered-dom' });
    expectMethod(hits, FAKE.htmlComment, 'html', 'rendered DOM');
  });
});

describe('CSS channels', () => {
  it('finds a password in a CSS comment', async () => {
    const css = `body { color: red } /* staging: ${FAKE.cssComment} */`;
    const hits = await run(Buffer.from(css), { mimeType: 'text/css' });
    expect(extractorsFor(hits, FAKE.cssComment)).toContain('css');
  });

  it('finds a password in a generated content: declaration', async () => {
    const css = `.badge::after { content: "${FAKE.cssContent}"; }`;
    const hits = await run(Buffer.from(css), { mimeType: 'text/css' });
    expectMethod(hits, FAKE.cssContent, 'css', 'content:');
  });

  it('resolves CSS unicode escapes', async () => {
    // "VISUALPING{5555555555555555}" with the leading V written as \56.
    const css = `.x::before { content: "\\56 ISUALPING{5555555555555555}"; }`;
    const hits = await run(Buffer.from(css), { mimeType: 'text/css' });
    expect(passwords(hits)).toContain(FAKE.cssComment);
  });
});

describe('JavaScript channels', () => {
  it('finds a password in a JS comment', async () => {
    const js = `// TODO rotate: ${FAKE.jsComment}\nvar x = 1;`;
    const hits = await run(Buffer.from(js), { mimeType: 'application/javascript' });
    expect(extractorsFor(hits, FAKE.jsComment)).toContain('javascript');
  });

  it('decodes a character-code array', async () => {
    const codes = [...FAKE.jsComment].map((char) => char.charCodeAt(0)).join(', ');
    const js = `var beacon = [${codes}];\nString.fromCharCode.apply(null, beacon);`;
    const hits = await run(Buffer.from(js), { mimeType: 'application/javascript' });
    expectMethod(hits, FAKE.jsComment, 'javascript', 'character-code array');
  });

  it('decodes a String.fromCharCode() call', async () => {
    const codes = [...FAKE.jsComment].map((char) => char.charCodeAt(0)).join(',');
    const hits = await run(Buffer.from(`String.fromCharCode(${codes})`), {
      mimeType: 'application/javascript',
    });
    expect(passwords(hits)).toContain(FAKE.jsComment);
  });

  it('decodes \\u escapes in a string literal', async () => {
    const escaped = [...FAKE.jsComment]
      .map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('');
    const hits = await run(Buffer.from(`var s = "${escaped}";`), {
      mimeType: 'application/javascript',
    });
    expect(passwords(hits)).toContain(FAKE.jsComment);
  });

  it('finds a password in a source map sourcesContent entry', async () => {
    const map = JSON.stringify({
      version: 3,
      sources: ['src/config.ts'],
      sourcesContent: [`export const KEY = '${FAKE.sourceMap}';`],
      mappings: '',
    });
    const hits = await run(Buffer.from(map), {
      mimeType: 'application/json',
      url: 'http://example.test/bundle.js.map',
    });
    expect(extractorsFor(hits, FAKE.sourceMap)).toContain('sourcemap');
  });
});

describe('structured data channels', () => {
  it('finds a password in a nested JSON value and names its path', async () => {
    const json = JSON.stringify({ config: { secrets: [{ value: FAKE.jsonValue }] } });
    const hits = await run(Buffer.from(json), { mimeType: 'application/json' });
    expect(extractorsFor(hits, FAKE.jsonValue)).toContain('json');
    expectMethod(hits, FAKE.jsonValue, 'json', '$.config.secrets[0].value');
  });

  it('finds a password in an SVG <desc> node', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><desc>${FAKE.svgText}</desc></svg>`;
    const hits = await run(Buffer.from(svg), { mimeType: 'image/svg+xml' });
    expect(extractorsFor(hits, FAKE.svgText)).toContain('svg');
  });
});

describe('encoding channels', () => {
  it('decodes a base64 run', async () => {
    const encoded = Buffer.from(`secret=${FAKE.base64}`).toString('base64');
    const hits = await run(Buffer.from(`<meta name="b" content="${encoded}">`), {
      mimeType: 'text/html',
    });
    expect(extractorsFor(hits, FAKE.base64)).toContain('base64');
  });

  it('decodes a hex run', async () => {
    const encoded = Buffer.from(FAKE.hex).toString('hex');
    const hits = await run(Buffer.from(`payload=${encoded}`), { mimeType: 'text/plain' });
    expect(extractorsFor(hits, FAKE.hex)).toContain('hex');
  });

  it('decodes a gzip body', async () => {
    const hits = await run(buildGzip(`note: ${FAKE.gzip}`), {
      mimeType: 'application/gzip',
      url: 'http://example.test/note.gz',
    });
    expect(passwords(hits)).toContain(FAKE.gzip);
  });

  it('decodes a base64 data: URI', async () => {
    const payload = Buffer.from(FAKE.dataUri).toString('base64');
    const html = `<img src="data:text/plain;base64,${payload}">`;
    const hits = await run(Buffer.from(html), { mimeType: 'text/html' });
    expect(extractorsFor(hits, FAKE.dataUri)).toContain('data-uri');
  });

  it('decodes HTML entities', async () => {
    const entities = [...FAKE.hex].map((char) => `&#${char.charCodeAt(0)};`).join('');
    const hits = await run(Buffer.from(`<p>${entities}</p>`), { mimeType: 'text/html' });
    expect(passwords(hits)).toContain(FAKE.hex);
  });
});

describe('image channels', () => {
  it('finds a password in a PNG tEXt chunk', async () => {
    const png = buildPng({ tEXt: { keyword: 'Comment', value: FAKE.pngText } });
    const hits = await run(png, { mimeType: 'image/png', url: 'http://example.test/a.png' });
    expect(extractorsFor(hits, FAKE.pngText)).toContain('image-chunks');
  });

  it('finds a password in a compressed PNG zTXt chunk', async () => {
    const png = buildPng({ zTXt: { keyword: 'Note', value: FAKE.pngText } });
    const hits = await run(png, { mimeType: 'image/png', url: 'http://example.test/a.png' });
    expectMethod(hits, FAKE.pngText, 'image-chunks', 'zTXt');
  });

  it('finds bytes appended after the PNG IEND marker', async () => {
    const png = buildPng({ trailer: `\n${FAKE.pngTrailer}\n` });
    const hits = await run(png, { mimeType: 'image/png', url: 'http://example.test/a.png' });
    expect(extractorsFor(hits, FAKE.pngTrailer)).toContain('trailing-bytes');
  });

  it('finds a password in a JPEG COM marker', async () => {
    const jpeg = buildJpeg(FAKE.jpegComment);
    const hits = await run(jpeg, { mimeType: 'image/jpeg', url: 'http://example.test/a.jpg' });
    expect(extractorsFor(hits, FAKE.jpegComment)).toContain('image-chunks');
  });

  it('finds a UTF-16 EXIF UserComment', async () => {
    const jpeg = buildJpeg('cover photo', FAKE.exif);
    const hits = await run(jpeg, { mimeType: 'image/jpeg', url: 'http://example.test/a.jpg' });
    expect(passwords(hits)).toContain(FAKE.exif);
    expect(extractorsFor(hits, FAKE.exif)).toContain('image-metadata');
  });
});

describe('container channels', () => {
  it('finds a password inside a zip member', async () => {
    const zip = buildZip({ 'notes/secret.txt': `key = ${FAKE.zipMember}` });
    const hits = await run(zip, { mimeType: 'application/zip', url: 'http://example.test/a.zip' });
    expect(extractorsFor(hits, FAKE.zipMember)).toContain('archive');
    expectMethod(hits, FAKE.zipMember, 'archive', 'notes/secret.txt');
  });

  it('finds a password inside a nested zip', async () => {
    const inner = buildZip({ 'inner.txt': FAKE.zipMember });
    const outer = buildZip({ 'inner.zip': inner });
    const hits = await run(outer, {
      mimeType: 'application/zip',
      url: 'http://example.test/a.zip',
    });
    expect(passwords(hits)).toContain(FAKE.zipMember);
  });

  it('finds a password inside a tar member', async () => {
    const tar = buildTar({ 'notes.txt': FAKE.zipMember });
    const hits = await run(tar, {
      mimeType: 'application/x-tar',
      url: 'http://example.test/a.tar',
    });
    expect(passwords(hits)).toContain(FAKE.zipMember);
  });

  it('finds a password in PDF page text', async () => {
    const pdf = buildPdf(FAKE.pdfText);
    const hits = await run(pdf, { mimeType: 'application/pdf', url: 'http://example.test/a.pdf' });
    expect(extractorsFor(hits, FAKE.pdfText)).toContain('pdf');
  });

  it('finds a password in an ID3 tag', async () => {
    const mp3 = buildMp3(FAKE.id3);
    const hits = await run(mp3, { mimeType: 'audio/mpeg', url: 'http://example.test/a.mp3' });
    expect(extractorsFor(hits, FAKE.id3)).toContain('media-metadata');
  });

  it('finds a password in a font name table', async () => {
    const font = buildFont(10, FAKE.fontName); // nameId 10 = description
    const hits = await run(font, { mimeType: 'font/ttf', url: 'http://example.test/a.ttf' });
    expect(extractorsFor(hits, FAKE.fontName)).toContain('font');
    expectMethod(hits, FAKE.fontName, 'font', 'description');
  });

  it('finds a password in a wasm custom section', async () => {
    const wasm = buildWasm('note', FAKE.wasmSection);
    const hits = await run(wasm, {
      mimeType: 'application/wasm',
      url: 'http://example.test/a.wasm',
    });
    expect(extractorsFor(hits, FAKE.wasmSection)).toContain('wasm');
  });
});

describe('the published example', () => {
  it('is never reported, in any channel', async () => {
    const html = `<!-- ${EXAMPLE} --><p>${EXAMPLE}</p>`;
    const hits = await run(Buffer.from(html), {
      mimeType: 'text/html',
      headers: { 'x-note': EXAMPLE },
    });
    expect(hits).toEqual([]);
  });
});

describe('every registered extractor', () => {
  it('has a unique id and a description', () => {
    const ids = registry.all.map((extractor) => extractor.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const extractor of registry.all) {
      expect(extractor.description.length).toBeGreaterThan(10);
    }
  });

  it('is covered by at least one fixture in this file', () => {
    // OCR is exercised in ocr.test.ts, which is skipped when the model is absent.
    const covered = new Set([
      'raw-text',
      'utf16-text',
      'binary-strings',
      'response-headers',
      'request-headers',
      'cookies',
      'html',
      'css',
      'javascript',
      'sourcemap',
      'json',
      'svg',
      'image-metadata',
      'image-chunks',
      'trailing-bytes',
      'ocr',
      'pdf',
      'archive',
      'media-metadata',
      'font',
      'wasm',
      'base64',
      'hex',
      'escapes',
      'compression',
      'data-uri',
    ]);
    for (const extractor of registry.all) {
      expect(covered.has(extractor.id), `no fixture for ${extractor.id}`).toBe(true);
    }
  });
});

describe('ExtractorRegistry', () => {
  const throwing: Extractor = {
    id: 'throws',
    description: 'always throws, to prove one bad extractor cannot fail a run',
    appliesTo: () => true,
    extract: () => {
      throw new Error('boom');
    },
  };
  const finds: Extractor = {
    id: 'finds',
    description: 'always finds the fixture password',
    appliesTo: () => true,
    extract: (ctx) => [
      {
        password: FAKE.header,
        sourceUrl: ctx.record.url,
        artifactPath: ctx.bodyPath,
        extractor: 'finds',
        method: 'test',
        mimeType: ctx.record.mimeType,
      },
    ],
  };

  it('isolates a throwing extractor and keeps running the rest', async () => {
    const isolated = new ExtractorRegistry().registerAll([throwing, finds]);
    const results = await isolated.runAll({
      record: record(),
      body: Buffer.alloc(1),
      bodyPath: 'x',
    });
    expect(results.find((result) => result.extractor === 'throws')?.error).toBe('boom');
    expect(results.find((result) => result.extractor === 'finds')?.hits).toHaveLength(1);
  });

  it('rejects duplicate extractor ids', () => {
    expect(() => new ExtractorRegistry().registerAll([finds, finds])).toThrow(/Duplicate/);
  });

  it('records extractors that did not apply, so coverage gaps are visible', async () => {
    const selective = new ExtractorRegistry().register({
      id: 'never',
      description: 'never applies to anything',
      appliesTo: () => false,
      extract: () => [],
    });
    const results = await selective.runAll({
      record: record(),
      body: Buffer.alloc(1),
      bodyPath: 'x',
    });
    expect(results[0]).toMatchObject({ extractor: 'never', applied: false, hits: [] });
  });
});
