import { describe, expect, it } from 'vitest';
import { Frontier } from '../src/store/frontier.js';
import { TrapGuard, shapeHash, templateKey } from '../src/harvest/trapGuard.js';

const HOST = '54.214.7.161';
const HOME = 'http://54.214.7.161/';

describe('Frontier', () => {
  it('enqueues a URL once and reports repeat discoveries', () => {
    const frontier = new Frontier(HOST);
    expect(
      frontier.add({ rawUrl: '/docs/', discoveredFrom: HOME, source: 'anchor', depth: 0 }),
    ).toBe(true);
    expect(
      frontier.add({
        rawUrl: '/docs/?utm_source=x',
        discoveredFrom: HOME,
        source: 'img',
        depth: 0,
      }),
    ).toBe(false);

    expect(frontier.stats.known).toBe(1);
    // Both discoveries are still recorded, so the report can show every path in.
    expect(frontier.discoveryLog).toHaveLength(2);
    expect(frontier.discoveryLog.map((event) => event.source)).toEqual(['anchor', 'img']);
  });

  it('refuses off-host URLs and counts them', () => {
    const frontier = new Frontier(HOST);
    expect(
      frontier.add({
        rawUrl: 'http://evil.test/x',
        discoveredFrom: HOME,
        source: 'anchor',
        depth: 0,
      }),
    ).toBe(false);
    expect(frontier.stats.offHost).toBe(1);
    expect(frontier.stats.known).toBe(0);
  });

  it('refuses unusable references and counts them separately', () => {
    const frontier = new Frontier(HOST);
    expect(
      frontier.add({
        rawUrl: 'javascript:void(0)',
        discoveredFrom: HOME,
        source: 'anchor',
        depth: 0,
      }),
    ).toBe(false);
    expect(frontier.stats.unusable).toBe(1);
  });

  it('hands out entries in discovery order and marks them visited', () => {
    const frontier = new Frontier(HOST);
    frontier.add({ rawUrl: '/a/', discoveredFrom: HOME, source: 'anchor', depth: 0 });
    frontier.add({ rawUrl: '/b/', discoveredFrom: HOME, source: 'anchor', depth: 0 });

    expect(frontier.next()?.url).toBe('http://54.214.7.161/a/');
    expect(frontier.next()?.url).toBe('http://54.214.7.161/b/');
    expect(frontier.next()).toBeUndefined();
    expect(frontier.stats.visited).toBe(2);
    expect(frontier.stats.pending).toBe(0);
  });

  it('does not re-enqueue a URL marked visited by a resumed run', () => {
    const frontier = new Frontier(HOST);
    frontier.markVisited('http://54.214.7.161/a/');
    expect(frontier.add({ rawUrl: '/a/', discoveredFrom: HOME, source: 'anchor', depth: 0 })).toBe(
      false,
    );
    expect(frontier.stats.pending).toBe(0);
  });

  it('stops enqueuing once the trap guard saturates a template', () => {
    const guard = new TrapGuard({ sampleSize: 3, maxDistinctShapes: 1, maxPerTemplate: 1000 });
    const frontier = new Frontier(HOST, guard);
    const page = (n: number) => `http://54.214.7.161/report/?page=${n}`;

    for (let n = 1; n <= 3; n += 1) {
      expect(
        frontier.add({ rawUrl: page(n), discoveredFrom: HOME, source: 'anchor', depth: 0 }),
      ).toBe(true);
      guard.observe(page(n), Buffer.from(`<table><tr><td>row ${n * 7}</td></tr></table>`), 0);
    }

    expect(
      frontier.add({ rawUrl: page(4), discoveredFrom: HOME, source: 'anchor', depth: 0 }),
    ).toBe(false);
    expect(frontier.stats.trapped).toBe(1);
    // A different template is unaffected.
    expect(
      frontier.add({ rawUrl: '/docs/', discoveredFrom: HOME, source: 'anchor', depth: 0 }),
    ).toBe(true);
  });
});

describe('templateKey', () => {
  it('masks numeric query values so paginated URLs share a template', () => {
    expect(templateKey('http://h/report/?page=1')).toBe(templateKey('http://h/report/?page=99999'));
  });

  it('keeps distinct content pages distinct', () => {
    expect(templateKey('http://h/docs/alpha/')).not.toBe(templateKey('http://h/docs/beta/'));
  });

  it('masks numeric path segments', () => {
    expect(templateKey('http://h/archive/2024/')).toBe(templateKey('http://h/archive/1999/'));
  });
});

describe('shapeHash', () => {
  it('ignores digits and hex runs so paginated pages collapse together', () => {
    const a = Buffer.from('<tr><td>VP-e379ec4265</td><td>9 min ago</td></tr>');
    const b = Buffer.from('<tr><td>VP-aa11bb22cc</td><td>41 min ago</td></tr>');
    expect(shapeHash(a)).toBe(shapeHash(b));
  });

  it('separates structurally different pages', () => {
    expect(shapeHash(Buffer.from('<h1>Docs</h1>'))).not.toBe(
      shapeHash(Buffer.from('<table></table>')),
    );
  });
});

describe('TrapGuard', () => {
  it('does not saturate a template that keeps producing new outbound links', () => {
    const guard = new TrapGuard({ sampleSize: 2, maxDistinctShapes: 1, maxPerTemplate: 100 });
    const url = 'http://h/list/?page=1';
    guard.allow(url);
    guard.observe(url, Buffer.from('<ul></ul>'), 3);
    guard.observe(url, Buffer.from('<ul></ul>'), 2);
    expect(guard.saturated).toHaveLength(0);
  });

  it('does not saturate a template whose pages differ structurally', () => {
    const guard = new TrapGuard({ sampleSize: 2, maxDistinctShapes: 1, maxPerTemplate: 100 });
    guard.allow('http://h/docs/a/');
    guard.observe('http://h/docs/a/', Buffer.from('<h1>a</h1>'), 0);
    guard.observe('http://h/docs/b/', Buffer.from('<table><tr></tr></table>'), 0);
    expect(guard.saturated).toHaveLength(0);
  });

  it('falls back to a hard cap when the novelty heuristic never fires', () => {
    const guard = new TrapGuard({ sampleSize: 1000, maxDistinctShapes: 1, maxPerTemplate: 3 });
    const allowed = [1, 2, 3, 4, 5].map((n) => guard.allow(`http://h/report/?page=${n}`));
    expect(allowed).toEqual([true, true, true, false, false]);
    expect(guard.saturated[0]?.reason).toMatch(/hard cap/);
  });
});
