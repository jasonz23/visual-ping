import { describe, expect, it } from 'vitest';
import {
  DECORATIVE_PARAMS,
  canonicalKey,
  findUrlLiterals,
  isSameHost,
  normalizeUrl,
  resolveUrl,
} from '../src/util/url.js';
import { parseProxy } from '../src/config.js';

const BASE = 'http://54.214.7.161/docs/';

describe('normalizeUrl', () => {
  it('drops the fragment but keeps the query', () => {
    expect(normalizeUrl('http://h/a?b=1#frag')).toBe('http://h/a?b=1');
  });

  it('drops default ports and lower-cases the host', () => {
    expect(normalizeUrl('http://EXAMPLE.test:80/a')).toBe('http://example.test/a');
    expect(normalizeUrl('https://example.test:443/a')).toBe('https://example.test/a');
  });

  it('keeps a non-default port', () => {
    expect(normalizeUrl('http://example.test:8080/a')).toBe('http://example.test:8080/a');
  });

  it('sorts query parameters so ordering does not create a second URL', () => {
    expect(normalizeUrl('http://h/a?b=2&a=1')).toBe(normalizeUrl('http://h/a?a=1&b=2'));
  });

  it('resolves dot segments and collapses duplicate slashes', () => {
    expect(normalizeUrl('../wiki//page/', BASE)).toBe('http://54.214.7.161/wiki/page/');
  });

  it('decodes percent-escapes that never needed escaping', () => {
    expect(normalizeUrl('http://h/%61%62c')).toBe('http://h/abc');
  });

  it('treats a trailing slash as significant', () => {
    expect(normalizeUrl('http://h/a')).not.toBe(normalizeUrl('http://h/a/'));
  });

  it('rejects non-HTTP schemes and unparseable input', () => {
    expect(normalizeUrl('ftp://h/a')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('canonicalKey', () => {
  it('collapses decorative query parameters', () => {
    const bare = canonicalKey('http://h/wiki/');
    expect(canonicalKey('http://h/wiki/?v=7')).toBe(bare);
    expect(canonicalKey('http://h/wiki/?utm_source=internal')).toBe(bare);
    expect(canonicalKey('http://h/wiki/?ref=related&hl=en')).toBe(bare);
  });

  it('keeps parameters that select content', () => {
    expect(canonicalKey('http://h/report/?page=2')).toBe('http://h/report/?page=2');
    expect(canonicalKey('http://h/report/?page=2')).not.toBe(
      canonicalKey('http://h/report/?page=3'),
    );
  });

  it('keeps a meaningful parameter even when a decorative one rides along', () => {
    expect(canonicalKey('http://h/report/?page=2&utm_source=x')).toBe('http://h/report/?page=2');
  });

  it('lists the parameters it considers decorative', () => {
    expect(DECORATIVE_PARAMS.has('utm_source')).toBe(true);
    expect(DECORATIVE_PARAMS.has('page')).toBe(false);
  });
});

describe('resolveUrl', () => {
  it('resolves relative references against the page URL', () => {
    expect(resolveUrl('sub/page/', BASE)).toBe('http://54.214.7.161/docs/sub/page/');
    expect(resolveUrl('/other/', BASE)).toBe('http://54.214.7.161/other/');
  });

  it('refuses schemes a crawler must not follow', () => {
    for (const raw of [
      'javascript:void(0)',
      'mailto:a@b.c',
      'tel:+1',
      '#anchor',
      'data:text/plain,x',
    ]) {
      expect(resolveUrl(raw, BASE)).toBeNull();
    }
  });
});

describe('isSameHost', () => {
  it('compares hosts case-insensitively and rejects other hosts', () => {
    expect(isSameHost('http://54.214.7.161/a', '54.214.7.161')).toBe(true);
    expect(isSameHost('http://EXAMPLE.test/a', 'example.test')).toBe(true);
    expect(isSameHost('http://elsewhere.test/a', 'example.test')).toBe(false);
  });
});

describe('findUrlLiterals', () => {
  it('finds absolute URLs, quoted paths, css url() and @import targets', () => {
    const text = `
      var a = "https://54.214.7.161/abs/page";
      var b = '/root/path.json';
      body { background: url(../img/bg.png); }
      @import "theme.css";
    `;
    const found = findUrlLiterals(text, BASE);
    expect(found).toContain('https://54.214.7.161/abs/page');
    expect(found).toContain('http://54.214.7.161/root/path.json');
    expect(found).toContain('http://54.214.7.161/img/bg.png');
    expect(found).toContain('http://54.214.7.161/docs/theme.css');
  });

  it('unescapes JSON-style escaped slashes', () => {
    expect(findUrlLiterals('{"u":"\\/a\\/b.json"}', BASE)).toContain(
      'http://54.214.7.161/a/b.json',
    );
  });

  it('returns nothing for text with no references', () => {
    expect(findUrlLiterals('just some prose, 42% of it', BASE)).toEqual([]);
  });
});

describe('parseProxy', () => {
  it('returns undefined when unset', () => {
    expect(parseProxy(undefined)).toBeUndefined();
    expect(parseProxy('')).toBeUndefined();
  });

  it('parses a bare host:port proxy', () => {
    expect(parseProxy('http://de-exit.example.net:8080')).toEqual({
      server: 'http://de-exit.example.net:8080',
    });
  });

  it('lifts credentials out of the URL so they are not duplicated in server', () => {
    expect(parseProxy('http://user:p%40ss@de.example.net:3128')).toEqual({
      server: 'http://de.example.net:3128',
      username: 'user',
      password: 'p@ss',
    });
  });

  it('supports socks5 schemes', () => {
    expect(parseProxy('socks5://127.0.0.1:9050')).toEqual({ server: 'socks5://127.0.0.1:9050' });
  });

  it('throws on input that is not a URL', () => {
    expect(() => parseProxy('://nonsense')).toThrow(/VP_PROXY/);
    expect(() => parseProxy('http://')).toThrow(/VP_PROXY/);
  });
});
