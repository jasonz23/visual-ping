/**
 * Pure-function tests for helpers that would otherwise only be exercised through
 * a browser or an OCR model: glyph repair, image headers, text diffing, and the
 * password grammar itself.
 */
import { describe, expect, it } from 'vitest';
import { imageSize, repairConfusables } from '../src/extract/handlers/ocr.js';
import { diffText, isTextual, mimeOf, shouldHaveBody } from '../src/harvest/harvester.js';
import { EXAMPLE_PASSWORD, findPasswords, isExample } from '../src/util/password.js';
import { decodeCssEscapes } from '../src/extract/handlers/css.js';
import { decodeEntities, decodeJsEscapes, rot13 } from '../src/extract/handlers/encodings.js';
import { printableRuns } from '../src/extract/handlers/text.js';
import { buildJpeg, buildPng } from './fixtures/build.js';

describe('findPasswords', () => {
  it('returns every match in a string, not just the first', () => {
    const text = 'a VISUALPING{1111111111111111} b VISUALPING{2222222222222222} c';
    expect(findPasswords(text).map((m) => m.password)).toEqual([
      'VISUALPING{1111111111111111}',
      'VISUALPING{2222222222222222}',
    ]);
  });

  it('accepts upper-case hex and rejects the wrong length or characters', () => {
    expect(findPasswords('VISUALPING{ABCDEF0123456789}')).toHaveLength(1);
    expect(findPasswords('VISUALPING{123456789abcdef}')).toHaveLength(0); // 15
    expect(findPasswords('VISUALPING{123456789abcdef01}')).toHaveLength(0); // 17
    expect(findPasswords('VISUALPING{g23456789abcdef0}')).toHaveLength(0); // non-hex
    expect(findPasswords('visualping{0123456789abcdef}')).toHaveLength(0); // wrong case
  });

  it('never returns the published example', () => {
    expect(isExample(EXAMPLE_PASSWORD)).toBe(true);
    expect(findPasswords(`before ${EXAMPLE_PASSWORD} after`)).toHaveLength(0);
  });

  it('carries a single-line excerpt for auditing', () => {
    const [hit] = findPasswords('note:\n  VISUALPING{1111111111111111}\n  end');
    expect(hit?.context).toContain('note:');
    expect(hit?.context).not.toContain('\n');
  });
});

describe('repairConfusables', () => {
  it('repairs the glyphs OCR reliably confuses in a sans-serif hex string', () => {
    expect(repairConfusables('VISUALPING{elc2e40cf0lcl7cc}')).toEqual([
      'VISUALPING{e1c2e40cf01c17cc}',
    ]);
  });

  it('refuses to invent a password when the repair is still not valid hex', () => {
    expect(repairConfusables('VISUALPING{this is not hex xx}')).toEqual([]);
    expect(repairConfusables('VISUALPING{abc}')).toEqual([]);
  });

  it('leaves an already-valid password alone', () => {
    expect(repairConfusables('VISUALPING{0123456789abcdef}')).toEqual([
      'VISUALPING{0123456789abcdef}',
    ]);
  });
});

describe('imageSize', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(imageSize(buildPng())).toEqual({ width: 1, height: 1 });
  });

  it('returns null for a JPEG with no frame header', () => {
    // The fixture carries markers but no SOFn, so there is nothing to report.
    expect(imageSize(buildJpeg('caption'))).toBeNull();
  });

  it('returns null for bytes that are not an image', () => {
    expect(imageSize(Buffer.from('<html></html>'))).toBeNull();
  });
});

describe('mimeOf / isTextual', () => {
  it('strips content-type parameters and lower-cases', () => {
    expect(mimeOf('Text/HTML; charset=UTF-8')).toBe('text/html');
    expect(mimeOf('')).toBe('application/octet-stream');
  });

  it('classifies the types worth scanning for URL literals', () => {
    expect(isTextual('text/css')).toBe(true);
    expect(isTextual('application/json')).toBe(true);
    expect(isTextual('image/svg+xml')).toBe(true);
    expect(isTextual('image/png')).toBe(false);
    expect(isTextual('application/pdf')).toBe(false);
  });
});

describe('diffText', () => {
  it('returns the lines present in the DOM but never painted', () => {
    const all = 'visible line\nhidden line\nanother visible';
    const visible = 'visible line another visible';
    expect(diffText(all, visible)).toBe('hidden line');
  });

  it('returns nothing when everything is painted', () => {
    expect(diffText('a\nb', 'a b')).toBe('');
  });
});

describe('decoders', () => {
  it('resolves CSS unicode escapes with and without a trailing space', () => {
    expect(decodeCssEscapes('\\56 ISUAL')).toBe('VISUAL');
    expect(decodeCssEscapes('\\000056ISUAL')).toBe('VISUAL');
  });

  it('decodes numeric and named HTML entities', () => {
    expect(decodeEntities('&#86;&#x49;&amp;')).toBe('VI&');
    expect(decodeEntities('&unknownentity;')).toBe('&unknownentity;');
  });

  it('decodes JS escapes', () => {
    expect(decodeJsEscapes('\\u0056\\x49')).toBe('VI');
  });

  it('round-trips ROT13', () => {
    expect(rot13(rot13('VISUALPING{abc}'))).toBe('VISUALPING{abc}');
  });

  it('pulls printable runs out of binary noise', () => {
    const body = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x01]),
      Buffer.from('findable'),
      Buffer.from([0x00]),
      Buffer.from('tiny'),
    ]);
    expect(printableRuns(body, 6)).toEqual(['findable']);
  });
});

describe('shouldHaveBody', () => {
  it('expects a body for a normal 200 GET', () => {
    expect(shouldHaveBody(200, 'GET', {})).toBe(true);
  });

  it('does not expect a body for 204/304 or an explicit zero length', () => {
    expect(shouldHaveBody(204, 'GET', {})).toBe(false);
    expect(shouldHaveBody(304, 'GET', {})).toBe(false);
    expect(shouldHaveBody(200, 'GET', { 'content-length': '0' })).toBe(false);
  });

  it('does not expect a body for HEAD, redirects, or errors', () => {
    expect(shouldHaveBody(200, 'HEAD', {})).toBe(false);
    expect(shouldHaveBody(301, 'GET', {})).toBe(false);
    expect(shouldHaveBody(404, 'GET', {})).toBe(false);
  });
});
