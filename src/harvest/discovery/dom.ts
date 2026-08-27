/**
 * In-page link discovery.
 *
 * `collectFromDom` is serialized into the page by Playwright, so it must be a
 * self-contained function using only browser globals. It deliberately goes well
 * past `<a href>`: element URL attributes, srcset candidate lists, CSS `url()` in
 * both stylesheets and computed styles, `@import`, meta refresh, inline event
 * handlers, and elements that merely *look* clickable.
 */
import type { DiscoverySource } from '../../types.js';

export interface DomCandidate {
  url: string;
  source: DiscoverySource;
  detail: string;
}

export interface ClickableCandidate {
  /** Stable index into the page's clickable-candidate list. */
  index: number;
  description: string;
}

export interface DomSnapshot {
  candidates: DomCandidate[];
  clickables: ClickableCandidate[];
  cookies: string;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  /** Every text node in the DOM, including nodes hidden from sighted users. */
  allText: string;
  /** Only the text the browser actually paints. The difference is where things hide. */
  visibleText: string;
  /** `content` values of ::before/::after pseudo-elements. */
  pseudoContent: string[];
  title: string;
}

/** Attribute names that can hold a URL, mapped to their discovery source. */
const URL_ATTRIBUTES: ReadonlyArray<[selector: string, attribute: string, source: DiscoverySource]> =
  [
    ['a[href]', 'href', 'anchor'],
    ['area[href]', 'href', 'area'],
    ['link[href]', 'href', 'link-rel'],
    ['base[href]', 'href', 'base'],
    ['img[src]', 'src', 'img'],
    ['img[data-src]', 'data-src', 'data-attribute'],
    ['script[src]', 'src', 'script-src'],
    ['iframe[src]', 'src', 'iframe'],
    ['frame[src]', 'src', 'frame'],
    ['embed[src]', 'src', 'embed'],
    ['object[data]', 'data', 'object'],
    ['source[src]', 'src', 'source'],
    ['track[src]', 'src', 'track'],
    ['audio[src]', 'src', 'source'],
    ['video[src]', 'src', 'source'],
    ['video[poster]', 'poster', 'poster'],
    ['form[action]', 'action', 'form-action'],
    ['button[formaction]', 'formaction', 'formaction'],
    ['input[formaction]', 'formaction', 'formaction'],
    ['use[href]', 'href', 'svg-href'],
    ['image[href]', 'href', 'svg-href'],
  ];

/**
 * Runs inside the page. Exported as a plain function so Playwright can serialize
 * it and so unit tests can exercise it against a DOM implementation.
 */
export function collectFromDom(
  urlAttributes: ReadonlyArray<[string, string, DiscoverySource]>,
): DomSnapshot {
  const candidates: DomCandidate[] = [];
  const push = (url: string | null | undefined, source: DiscoverySource, detail: string): void => {
    if (typeof url !== 'string') return;
    const trimmed = url.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    candidates.push({ url: trimmed, source, detail });
  };

  for (const [selector, attribute, source] of urlAttributes) {
    for (const element of Array.from(document.querySelectorAll(selector))) {
      push(element.getAttribute(attribute), source, `${selector} [${attribute}]`);
    }
  }

  // srcset: comma-separated "url descriptor" pairs.
  for (const element of Array.from(document.querySelectorAll('[srcset]'))) {
    const value = element.getAttribute('srcset') ?? '';
    for (const part of value.split(',')) {
      const candidate = part.trim().split(/\s+/)[0];
      push(candidate, 'srcset', `${element.tagName.toLowerCase()}[srcset]`);
    }
  }

  // Any data-* attribute whose value looks like a path or URL.
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.name.startsWith('data-')) continue;
      const value = attribute.value.trim();
      if (/^(https?:\/\/|\/|\.\.?\/)\S+$/.test(value)) {
        push(value, 'data-attribute', `${element.tagName.toLowerCase()}[${attribute.name}]`);
      }
    }
  }

  // meta refresh.
  for (const meta of Array.from(document.querySelectorAll('meta[http-equiv]'))) {
    const equiv = (meta.getAttribute('http-equiv') ?? '').toLowerCase();
    if (equiv !== 'refresh') continue;
    const content = meta.getAttribute('content') ?? '';
    const match = /url\s*=\s*['"]?([^'";]+)/i.exec(content);
    if (match?.[1]) push(match[1], 'meta-refresh', `meta[http-equiv=refresh] "${content}"`);
  }

  // CSS: url() in stylesheets, @import, and computed background images.
  const cssUrl = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | null = null;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet; the network capture still saved its bytes
    }
    const href = sheet.href ?? 'inline <style>';
    for (const rule of Array.from(rules ?? [])) {
      const text = rule.cssText;
      if (rule.type === CSSRule.IMPORT_RULE) {
        const importHref = (rule as CSSImportRule).href;
        push(importHref, 'css-import', `@import in ${href}`);
      }
      for (const match of Array.from(text.matchAll(cssUrl))) {
        push(match[1], 'stylesheet-url', `url() in ${href}`);
      }
    }
  }

  const pseudoContent: string[] = [];
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const pseudo of ['::before', '::after']) {
      const style = window.getComputedStyle(element, pseudo);
      const content = style.content;
      if (content && content !== 'none' && content !== 'normal') {
        pseudoContent.push(content);
        for (const match of Array.from(content.matchAll(cssUrl))) {
          push(match[1], 'stylesheet-url', `${pseudo} content url()`);
        }
      }
      const image = style.backgroundImage;
      if (image && image !== 'none') {
        for (const match of Array.from(image.matchAll(cssUrl))) {
          push(match[1], 'stylesheet-url', `${pseudo} background-image`);
        }
      }
    }
    const own = window.getComputedStyle(element);
    for (const property of ['backgroundImage', 'listStyleImage', 'borderImageSource'] as const) {
      const value = own[property];
      if (!value || value === 'none') continue;
      for (const match of Array.from(value.matchAll(cssUrl))) {
        push(match[1], 'inline-style-url', `computed ${property}`);
      }
    }
  }

  // Inline event handlers and inline scripts: pull out anything path-shaped.
  const literal = /['"`]((?:https?:\/\/|\/|\.\.?\/)[^'"`\s]{1,300})['"`]/g;
  for (const element of Array.from(document.querySelectorAll('*'))) {
    for (const attribute of Array.from(element.attributes)) {
      if (!attribute.name.startsWith('on')) continue;
      for (const match of Array.from(attribute.value.matchAll(literal))) {
        push(match[1], 'clickable-element', `${element.tagName.toLowerCase()}[${attribute.name}]`);
      }
    }
  }
  for (const script of Array.from(document.querySelectorAll('script:not([src])'))) {
    const text = script.textContent ?? '';
    for (const match of Array.from(text.matchAll(literal))) {
      push(match[1], 'js-string-literal', 'inline <script>');
    }
  }

  // Elements a user could click that are not anchors.
  const clickables: ClickableCandidate[] = [];
  const clickableElements: Element[] = [];
  for (const element of Array.from(document.querySelectorAll('*'))) {
    if (element.closest('a[href]')) continue;
    const tag = element.tagName.toLowerCase();
    if (tag === 'script' || tag === 'style' || tag === 'head' || tag === 'html') continue;
    const hasHandler = element.hasAttribute('onclick') || Boolean((element as HTMLElement).onclick);
    const role = (element.getAttribute('role') ?? '').toLowerCase();
    const style = window.getComputedStyle(element);
    const pointer = style.cursor === 'pointer';
    const dataNav = Array.from(element.attributes).some((a) =>
      /^data-(href|url|link|target|page|nav|goto)$/i.test(a.name),
    );
    if (!hasHandler && !pointer && !dataNav && role !== 'link' && role !== 'button') continue;
    if (element.children.length > 3 && !hasHandler && !dataNav) continue;
    const index = clickableElements.length;
    clickableElements.push(element);
    const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
    clickables.push({
      index,
      description: `${tag}${role ? `[role=${role}]` : ''} "${text}"`,
    });
  }
  (window as unknown as { __vpClickables?: Element[] }).__vpClickables = clickableElements;

  const readStorage = (storage: Storage): Record<string, string> => {
    const out: Record<string, string> = {};
    try {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i);
        if (key !== null) out[key] = storage.getItem(key) ?? '';
      }
    } catch {
      /* storage may be unavailable; not fatal */
    }
    return out;
  };

  return {
    candidates,
    clickables,
    cookies: document.cookie,
    localStorage: readStorage(window.localStorage),
    sessionStorage: readStorage(window.sessionStorage),
    allText: document.documentElement.textContent ?? '',
    visibleText: (document.body as HTMLElement | null)?.innerText ?? '',
    pseudoContent,
    title: document.title,
  };
}

export const URL_ATTRIBUTE_TABLE = URL_ATTRIBUTES;
