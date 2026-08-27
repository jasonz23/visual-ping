/**
 * Phase 1 — harvest.
 *
 * Drives headless Chromium over a URL frontier and persists *every* response the
 * browser makes, not just the documents. Auth is set at the browser-context level
 * so subresource requests (images, CSS, fonts, XHR) carry Basic credentials too.
 */
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Frame, Page, Request, Response } from 'playwright';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logging.js';
import type { ArtifactRecord, DiscoverySource, FrontierEntry } from '../types.js';
import type { ArtifactStore } from '../store/artifactStore.js';
import { Frontier } from '../store/frontier.js';
import type { FrontierStats } from '../store/frontier.js';
import { canonicalKey, findUrlLiterals, isSameHost, normalizeUrl } from '../util/url.js';
import { URL_ATTRIBUTE_TABLE, collectFromDom } from './discovery/dom.js';
import type { DomSnapshot } from './discovery/dom.js';
import { TrapGuard, templateKey } from './trapGuard.js';
import type { TemplateStats } from './trapGuard.js';

/** MIME types worth loading in a real page rather than just downloading. */
const RENDERABLE = /^(text\/html|application\/xhtml\+xml|text\/xml|application\/xml|image\/svg)/i;

/** Extensions we fetch with the API request context instead of navigating. */
const NON_NAVIGABLE = /\.(pdf|zip|gz|tgz|tar|wasm|woff2?|ttf|otf|mp3|mp4|webm|ogg|wav|bin)$/i;

export interface HarvestSummary {
  visited: number;
  captured: number;
  errors: HarvestError[];
  frontier: FrontierStats;
  discoveryLog: readonly {
    key: string;
    source: DiscoverySource;
    discoveredFrom: string;
    detail?: string;
  }[];
  formsSkipped: { url: string; method: string; action: string }[];
  /** Per-template crawl statistics, including any saturated (trap) templates. */
  templates: TemplateStats[];
}

export interface HarvestError {
  url: string;
  message: string;
  phase: 'navigate' | 'fetch' | 'body' | 'evaluate';
}

interface CaptureMeta {
  discovery?: ArtifactRecord['discovery'];
}

export class Harvester {
  private readonly frontier: Frontier;
  private readonly trapGuard: TrapGuard;
  private readonly errors: HarvestError[] = [];
  private readonly capturedUrls = new Map<string, string>();
  private readonly formsSkipped: { url: string; method: string; action: string }[] = [];
  private browser?: Browser;
  private context?: BrowserContext;
  private pagesProcessed = 0;
  private saveChain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly config: AppConfig,
    private readonly store: ArtifactStore,
    private readonly log: Logger,
  ) {
    this.trapGuard = new TrapGuard();
    this.frontier = new Frontier(config.host, this.trapGuard);
  }

  async run(seeds: string[]): Promise<HarvestSummary> {
    await this.store.load();
    for (const record of this.store.all) {
      if (record.kind === 'response' && record.status < 400) {
        this.capturedUrls.set(record.url, record.mimeType);
      }
    }
    if (this.capturedUrls.size > 0) {
      this.log.info('resuming from existing artifact index', {
        knownResponses: this.capturedUrls.size,
        uniqueBodies: this.store.uniqueBodyCount,
      });
    }

    for (const seed of seeds) {
      this.frontier.add({ rawUrl: seed, discoveredFrom: seed, source: 'seed', depth: 0 });
    }

    this.browser = await chromium.launch({ headless: this.config.headless });
    this.context = await this.browser.newContext({
      httpCredentials: { username: this.config.username, password: this.config.password },
      ignoreHTTPSErrors: true,
      userAgent:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/126.0.0.0 Safari/537.36 VisualpingChallengeCrawler/1.0',
      viewport: { width: 1280, height: 960 },
    });
    this.context.setDefaultNavigationTimeout(this.config.navTimeoutMs);
    this.context.setDefaultTimeout(this.config.navTimeoutMs);

    // Playwright ships our collector functions into the page as source text. The
    // TypeScript loader compiles them with esbuild's `keepNames`, which rewrites
    // declarations to call a `__name` helper that only exists in the Node bundle —
    // so provide an identity shim inside every document. Injected as a string
    // rather than a function so the shim itself cannot be rewritten the same way.
    await this.context.addInitScript({
      content: 'globalThis.__name = globalThis.__name || function (fn) { return fn; };',
    });

    try {
      const workers = Array.from({ length: this.config.concurrency }, (_, i) => this.worker(i));
      await Promise.all(workers);
      await this.saveChain;
    } finally {
      await this.context?.close();
      await this.browser?.close();
    }

    return {
      visited: this.pagesProcessed,
      captured: this.capturedUrls.size,
      errors: this.errors,
      frontier: this.frontier.stats,
      discoveryLog: this.frontier.discoveryLog,
      formsSkipped: this.formsSkipped,
      templates: this.trapGuard.report,
    };
  }

  private async worker(id: number): Promise<void> {
    const log = this.log.child({ worker: id });
    const page = await this.mustContext().newPage();
    this.attachResponseListener(page);
    try {
      for (;;) {
        const entry = this.frontier.next();
        if (!entry) {
          // Another worker may still be discovering URLs; give it a beat.
          if (this.activeWork > 0) {
            await delay(150);
            continue;
          }
          break;
        }
        if (this.pagesProcessed >= this.config.maxPages) {
          log.warn('max page budget reached, stopping', { maxPages: this.config.maxPages });
          break;
        }
        this.activeWork += 1;
        try {
          await this.processEntry(page, entry, log);
        } catch (error) {
          this.errors.push({ url: entry.url, message: errorMessage(error), phase: 'navigate' });
          log.error('entry failed', { url: entry.url, error: errorMessage(error) });
        } finally {
          this.activeWork -= 1;
          this.pagesProcessed += 1;
        }
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private activeWork = 0;

  private async processEntry(page: Page, entry: FrontierEntry, log: Logger): Promise<void> {
    const alreadyMime = this.capturedUrls.get(entry.url);
    const navigable = !NON_NAVIGABLE.test(new URL(entry.url).pathname);

    if (alreadyMime !== undefined && !RENDERABLE.test(alreadyMime)) {
      log.debug('already captured, no rendering needed', { url: entry.url, mime: alreadyMime });
      return;
    }
    if (!navigable) {
      await this.fetchViaApi(entry.url, entry);
      return;
    }

    log.info('navigating', { url: entry.url, source: entry.source, depth: entry.depth });
    let response: Response | null = null;
    try {
      response = await page.goto(entry.url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.navTimeoutMs,
      });
    } catch (error) {
      const message = errorMessage(error);
      this.errors.push({ url: entry.url, message, phase: 'navigate' });
      log.warn('navigation failed; falling back to direct fetch', {
        url: entry.url,
        error: message,
      });
      await this.fetchViaApi(entry.url, entry);
      return;
    }

    if (response && response.status() === 401) {
      log.error('auth rejected — check VP_USERNAME / VP_PASSWORD', { url: entry.url });
    }

    const contentType = (response?.headers()['content-type'] ?? '').toLowerCase();
    if (contentType && !RENDERABLE.test(contentType)) {
      // The response listener already stored the bytes; nothing to render.
      log.debug('non-renderable document captured', { url: entry.url, contentType });
      return;
    }

    await page.waitForLoadState('networkidle', { timeout: this.config.idleTimeoutMs }).catch(() => {
      log.debug('network did not go idle in time', { url: entry.url });
    });
    await this.autoScroll(page);
    await page
      .waitForLoadState('networkidle', { timeout: this.config.idleTimeoutMs })
      .catch(() => undefined);

    let snapshot: DomSnapshot | undefined;
    try {
      snapshot = await page.evaluate(collectFromDom, URL_ATTRIBUTE_TABLE);
    } catch (error) {
      this.errors.push({ url: entry.url, message: errorMessage(error), phase: 'evaluate' });
    }

    const pageUrl = page.url();
    const renderedHtml = await page.content().catch(() => '');
    if (renderedHtml) {
      await this.persist(Buffer.from(renderedHtml, 'utf8'), {
        url: entry.url,
        finalUrl: pageUrl,
        status: response?.status() ?? 200,
        statusText: response?.statusText() ?? '',
        method: 'GET',
        contentType: 'text/html; charset=utf-8',
        mimeType: 'text/html',
        headers: {},
        requestHeaders: {},
        resourceType: 'document',
        fromCache: false,
        fetchedAt: new Date().toISOString(),
        kind: 'rendered-dom',
        discovery: {
          source: entry.source,
          discoveredFrom: entry.discoveredFrom,
          detail: entry.detail,
        },
      });
    }

    if (snapshot) {
      await this.persistSnapshotSidecar(entry, pageUrl, snapshot);
      const novelty = this.enqueueCandidates(snapshot, pageUrl, entry);
      this.trapGuard.observe(pageUrl, Buffer.from(renderedHtml, 'utf8'), novelty);
      await this.probeClickables(page, snapshot, pageUrl, entry, log);
    }
    await this.enqueueCookies(pageUrl);
    await this.enqueueForms(page, pageUrl, entry);
  }

  /** Store the non-HTML browser state: cookies, storage, pseudo-element content, text. */
  private async persistSnapshotSidecar(
    entry: FrontierEntry,
    pageUrl: string,
    snapshot: DomSnapshot,
  ): Promise<void> {
    const payload = {
      url: pageUrl,
      title: snapshot.title,
      cookies: snapshot.cookies,
      localStorage: snapshot.localStorage,
      sessionStorage: snapshot.sessionStorage,
      pseudoElementContent: snapshot.pseudoContent,
      allText: snapshot.allText,
      visibleText: snapshot.visibleText,
      /** Text present in the DOM but never painted — a classic hiding place. */
      nonVisibleText: diffText(snapshot.allText, snapshot.visibleText),
    };
    await this.persist(Buffer.from(JSON.stringify(payload, null, 2), 'utf8'), {
      url: `${entry.url}#browser-state`,
      finalUrl: pageUrl,
      status: 200,
      statusText: 'OK',
      method: 'GET',
      contentType: 'application/json',
      mimeType: 'application/json',
      headers: {},
      requestHeaders: {},
      resourceType: 'browser-state',
      fromCache: false,
      fetchedAt: new Date().toISOString(),
      kind: 'storage',
      discovery: { source: entry.source, discoveredFrom: entry.discoveredFrom },
    });
  }

  /** Returns how many *new* URLs this page contributed outside its own template. */
  private enqueueCandidates(snapshot: DomSnapshot, pageUrl: string, entry: FrontierEntry): number {
    const ownTemplate = templateKey(pageUrl);
    let outboundNovelty = 0;
    for (const candidate of snapshot.candidates) {
      const added = this.frontier.add({
        rawUrl: candidate.url,
        discoveredFrom: pageUrl,
        source: candidate.source,
        detail: candidate.detail,
        depth: entry.depth + 1,
      });
      if (added && templateKey(resolveAgainst(candidate.url, pageUrl)) !== ownTemplate) {
        outboundNovelty += 1;
      }
    }
    // Storage values sometimes hold paths the DOM never mentions.
    const storageBlobs = [
      JSON.stringify(snapshot.localStorage),
      JSON.stringify(snapshot.sessionStorage),
      snapshot.cookies,
    ].join('\n');
    for (const url of findUrlLiterals(storageBlobs, pageUrl)) {
      const added = this.frontier.add({
        rawUrl: url,
        discoveredFrom: pageUrl,
        source: 'js-string-literal',
        detail: 'cookie/localStorage/sessionStorage value',
        depth: entry.depth + 1,
      });
      if (added && templateKey(resolveAgainst(url, pageUrl)) !== ownTemplate) outboundNovelty += 1;
    }
    return outboundNovelty;
  }

  /**
   * Click elements that are not anchors but behave like links. Navigations are
   * intercepted and aborted: we want the destination URL, not a page transition.
   */
  private async probeClickables(
    page: Page,
    snapshot: DomSnapshot,
    pageUrl: string,
    entry: FrontierEntry,
    log: Logger,
  ): Promise<void> {
    if (snapshot.clickables.length === 0) return;
    const discovered = new Set<string>();

    const onRequest = (request: Request): void => {
      if (!request.isNavigationRequest()) return;
      const url = request.url();
      if (url !== pageUrl) discovered.add(url);
    };
    const onPopup = (popup: Page): void => {
      discovered.add(popup.url());
      void popup.close().catch(() => undefined);
    };
    const onFrameNavigated = (frame: Frame): void => {
      if (frame === page.mainFrame() && frame.url() !== pageUrl) discovered.add(frame.url());
    };

    await page.route('**/*', async (route, request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        discovered.add(request.url());
        await route.abort('aborted');
        return;
      }
      await route.continue();
    });
    page.on('request', onRequest);
    page.on('popup', onPopup);
    page.on('framenavigated', onFrameNavigated);

    try {
      const limit = Math.min(snapshot.clickables.length, 60);
      for (let i = 0; i < limit; i += 1) {
        const candidate = snapshot.clickables[i];
        if (!candidate) continue;
        try {
          await page.evaluate((index: number) => {
            const list = (window as unknown as { __vpClickables?: Element[] }).__vpClickables ?? [];
            const element = list[index] as HTMLElement | undefined;
            element?.click();
          }, candidate.index);
          await page.waitForTimeout(30);
        } catch (error) {
          log.debug('click probe failed', {
            url: pageUrl,
            candidate: candidate.description,
            error: errorMessage(error),
          });
        }
      }
    } finally {
      page.off('request', onRequest);
      page.off('popup', onPopup);
      page.off('framenavigated', onFrameNavigated);
      await page.unroute('**/*').catch(() => undefined);
    }

    for (const url of discovered) {
      const added = this.frontier.add({
        rawUrl: url,
        discoveredFrom: pageUrl,
        source: 'clickable-element',
        detail: 'navigation triggered by clicking a non-anchor element',
        depth: entry.depth + 1,
      });
      if (added) log.info('click probe found a link', { from: pageUrl, url });
    }
  }

  /** Enqueue GET forms the way a user submitting them would. POSTs are logged, not sent. */
  private async enqueueForms(page: Page, pageUrl: string, entry: FrontierEntry): Promise<void> {
    interface FormInfo {
      method: string;
      action: string;
      query: string;
    }
    const forms = await page
      .evaluate((): FormInfo[] => {
        return Array.from(document.querySelectorAll('form')).map((form) => {
          const data = new URLSearchParams();
          for (const element of Array.from(form.elements)) {
            const field = element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
            if (!field.name || field.disabled) continue;
            if (field instanceof HTMLInputElement) {
              if ((field.type === 'checkbox' || field.type === 'radio') && !field.checked) {
                continue;
              }
              if (field.type === 'submit' || field.type === 'button' || field.type === 'file') {
                continue;
              }
            }
            data.append(field.name, field.value ?? '');
          }
          return {
            method: (form.getAttribute('method') ?? 'get').toLowerCase(),
            action: form.getAttribute('action') ?? window.location.href,
            query: data.toString(),
          };
        });
      })
      .catch((): FormInfo[] => []);

    for (const form of forms) {
      if (form.method !== 'get') {
        this.formsSkipped.push({ url: pageUrl, method: form.method, action: form.action });
        continue;
      }
      const resolved = normalizeUrl(form.action || pageUrl, pageUrl);
      if (!resolved) continue;
      const target = new URL(resolved);
      if (form.query) target.search = form.query;
      this.frontier.add({
        rawUrl: target.toString(),
        discoveredFrom: pageUrl,
        source: 'form-action',
        detail: `GET form submission (${form.query || 'no fields'})`,
        depth: entry.depth + 1,
      });
    }
  }

  private async enqueueCookies(pageUrl: string): Promise<void> {
    const cookies = await this.mustContext()
      .cookies(pageUrl)
      .catch(() => []);
    if (cookies.length === 0) return;
    await this.persist(Buffer.from(JSON.stringify(cookies, null, 2), 'utf8'), {
      url: `${pageUrl}#cookies`,
      finalUrl: pageUrl,
      status: 200,
      statusText: 'OK',
      method: 'GET',
      contentType: 'application/json',
      mimeType: 'application/json',
      headers: {},
      requestHeaders: {},
      resourceType: 'cookies',
      fromCache: false,
      fetchedAt: new Date().toISOString(),
      kind: 'storage',
    });
  }

  /**
   * Read a body the browser refused to expose (redirects). `maxRedirects: 0` keeps
   * the 3xx itself rather than following through to the target.
   */
  private async fetchBodyWithoutRedirects(url: string): Promise<Buffer> {
    try {
      const response = await this.mustContext().request.get(url, {
        timeout: this.config.navTimeoutMs,
        failOnStatusCode: false,
        maxRedirects: 0,
      });
      return Buffer.from(await response.body());
    } catch (error) {
      this.log.debug('redirect body fetch failed', { url, error: errorMessage(error) });
      return Buffer.alloc(0);
    }
  }

  /** Fetch through the context's API request (shares credentials and cookies). */
  private async fetchViaApi(url: string, entry?: FrontierEntry): Promise<void> {
    try {
      const response = await this.mustContext().request.get(url, {
        timeout: this.config.navTimeoutMs,
        failOnStatusCode: false,
      });
      const body = Buffer.from(await response.body());
      const headers = response.headers();
      const contentType = headers['content-type'] ?? 'application/octet-stream';
      await this.persist(body, {
        url: canonicalKey(url) ?? url,
        finalUrl: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        method: 'GET',
        contentType,
        mimeType: mimeOf(contentType),
        headers,
        requestHeaders: {},
        resourceType: 'fetch',
        fromCache: false,
        fetchedAt: new Date().toISOString(),
        kind: 'response',
        discovery: entry
          ? { source: entry.source, discoveredFrom: entry.discoveredFrom, detail: entry.detail }
          : undefined,
      });
      this.capturedUrls.set(canonicalKey(url) ?? url, mimeOf(contentType));
    } catch (error) {
      this.errors.push({ url, message: errorMessage(error), phase: 'fetch' });
      this.log.warn('direct fetch failed', { url, error: errorMessage(error) });
    }
  }

  /**
   * Persist every response the browser receives. Attached before any navigation so
   * nothing that loads during the very first document is missed.
   */
  private attachResponseListener(page: Page): void {
    page.on('response', (response) => {
      this.saveChain = this.saveChain
        .then(() => this.saveResponse(response))
        .catch(() => undefined);
    });
  }

  private async saveResponse(response: Response): Promise<void> {
    const url = response.url();
    if (!isSameHost(url, this.config.host)) return;
    const key = canonicalKey(url) ?? url;
    const request = response.request();
    const headers = response.headers();
    const contentType = headers['content-type'] ?? '';
    const status = response.status();

    let body: Buffer;
    try {
      body = Buffer.from(await response.body());
    } catch (error) {
      // Chromium discards redirect bodies, and a redirect body is still content the
      // server chose to send. Re-request it with redirects disabled so nothing the
      // server produced goes unexamined.
      this.log.debug('response body unavailable', { url, status, error: errorMessage(error) });
      body =
        status >= 300 && status < 400 ? await this.fetchBodyWithoutRedirects(url) : Buffer.alloc(0);
    }

    await this.persist(body, {
      url: key,
      finalUrl: url,
      status,
      statusText: response.statusText(),
      method: request.method(),
      contentType,
      mimeType: mimeOf(contentType),
      headers,
      requestHeaders: await request.allHeaders().catch(() => ({})),
      resourceType: request.resourceType(),
      fromCache: false,
      fetchedAt: new Date().toISOString(),
      kind: 'response',
    });

    if (status < 400 && body.length > 0) this.capturedUrls.set(key, mimeOf(contentType));

    // Follow redirect targets and Link: headers — both are browser-visible edges.
    const location = headers['location'];
    if (location) {
      this.frontier.add({
        rawUrl: location,
        discoveredFrom: url,
        source: 'redirect',
        detail: `HTTP ${status} Location header`,
        depth: 0,
      });
    }
    const link = headers['link'];
    if (link) {
      for (const match of link.matchAll(/<([^>]+)>/g)) {
        if (match[1]) {
          this.frontier.add({
            rawUrl: match[1],
            discoveredFrom: url,
            source: 'header-link',
            detail: 'Link response header',
            depth: 0,
          });
        }
      }
    }

    // Text-ish bodies can name URLs the DOM never links (JS bundles, JSON, sourcemaps).
    if (body.length > 0 && isTextual(mimeOf(contentType))) {
      const text = body.toString('utf8');
      const source: DiscoverySource = /json/i.test(contentType)
        ? 'json-value'
        : /javascript|ecmascript/i.test(contentType)
          ? 'js-string-literal'
          : 'text-url';
      for (const found of findUrlLiterals(text, url)) {
        this.frontier.add({
          rawUrl: found,
          discoveredFrom: url,
          source,
          detail: `URL literal inside ${mimeOf(contentType)}`,
          depth: 0,
        });
      }
      const sourceMap = /[#@]\s*sourceMappingURL=(\S+)/.exec(text);
      if (sourceMap?.[1]) {
        this.frontier.add({
          rawUrl: sourceMap[1],
          discoveredFrom: url,
          source: 'sourcemap-comment',
          detail: 'sourceMappingURL comment',
          depth: 0,
        });
      }
    }
  }

  private async persist(
    body: Buffer,
    meta: Omit<ArtifactRecord, 'sha256' | 'bodyPath' | 'byteLength'> & CaptureMeta,
  ): Promise<void> {
    try {
      const result = await this.store.put(body, meta);
      if (!result.duplicateObservation) {
        this.log.debug('artifact stored', {
          url: meta.url,
          mime: meta.mimeType,
          bytes: body.length,
          dedupedBody: !result.bodyWritten,
        });
      }
    } catch (error) {
      this.errors.push({ url: meta.url, message: errorMessage(error), phase: 'body' });
    }
  }

  private async autoScroll(page: Page): Promise<void> {
    await page
      .evaluate(async () => {
        await new Promise<void>((resolve) => {
          let total = 0;
          const step = 400;
          const timer = window.setInterval(() => {
            window.scrollBy(0, step);
            total += step;
            if (total >= document.body.scrollHeight + 1000) {
              window.clearInterval(timer);
              window.scrollTo(0, 0);
              resolve();
            }
          }, 40);
        });
      })
      .catch(() => undefined);
  }

  private mustContext(): BrowserContext {
    if (!this.context) throw new Error('browser context not initialized');
    return this.context;
  }
}

export function mimeOf(contentType: string): string {
  return (contentType.split(';')[0] ?? '').trim().toLowerCase() || 'application/octet-stream';
}

export function isTextual(mimeType: string): boolean {
  return (
    mimeType.startsWith('text/') ||
    /(json|javascript|ecmascript|xml|svg|yaml|csv|x-sh|sourcemap)/i.test(mimeType)
  );
}

/** Words present in `all` but absent from `visible` — i.e. rendered-but-not-painted text. */
export function diffText(all: string, visible: string): string {
  const visibleNormalized = visible.replace(/\s+/g, ' ');
  return all
    .split(/\n+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length > 0 && !visibleNormalized.includes(line))
    .join('\n');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Resolve a discovered reference so it can be compared against a template key. */
function resolveAgainst(raw: string, base: string): string {
  try {
    return new URL(raw, base).toString();
  } catch {
    return raw;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
