# Visualping crawler challenge

A two-phase crawler that recovers the hidden `VISUALPING{…}` passwords from the
challenge site, and — just as importantly — produces the evidence that it looked
everywhere it claims to have looked.

**Phase 1 (harvest)** drives headless Chromium over a URL frontier and persists
every HTTP response the browser makes, documents and subresources alike, into a
content-addressed store with a full metadata sidecar.
**Phase 2 (extract)** runs a registry of per-channel extractors over every stored
artifact and reports which extractor found what, where.

The two phases are separate commands over a shared on-disk store, so extraction can
be re-run and iterated on without re-crawling — which is how this was actually
built.

---

## Quick start

```bash
npm install
npx playwright install chromium   # ~95 MB, once

cp .env.example .env      # then fill in VP_USERNAME / VP_PASSWORD
npm run run               # crawl, extract, write reports
```

Individual phases:

```bash
npm run crawl     # phase 1 only — fill ./artifacts
npm run extract   # phase 2 only — scan ./artifacts, write ./out
npm run report    # re-render ./out from the existing store
```

The OCR extractor downloads its English model on first use and caches it; that
one step needs outbound network beyond the target host. If it is unavailable the
extractor degrades to a no-op and says so in the coverage matrix rather than
failing the run.

Quality gates:

```bash
npm run check     # eslint + prettier + tsc + vitest
```

### Configuration

Everything comes from the environment; nothing is hardcoded and credentials are
never committed. See `.env.example`.

| Variable                                   | Default                | Meaning                                               |
| ------------------------------------------ | ---------------------- | ----------------------------------------------------- |
| `VP_BASE_URL`                              | `http://54.214.7.161/` | Seed URL; its host is the crawl boundary              |
| `VP_USERNAME` / `VP_PASSWORD`              | _(required)_           | HTTP Basic credentials                                |
| `VP_CONCURRENCY`                           | `3`                    | Parallel browser pages                                |
| `VP_ARTIFACT_DIR`                          | `./artifacts`          | Content-addressed store                               |
| `VP_OUT_DIR`                               | `./out`                | `passwords.json`, `crawl-report.md`                   |
| `VP_MAX_PAGES`                             | `2000`                 | Safety budget; a budget stop is flagged in the report |
| `VP_NAV_TIMEOUT_MS` / `VP_IDLE_TIMEOUT_MS` | `30000` / `8000`       | Navigation and network-idle waits                     |
| `VP_LOG_LEVEL`                             | `info`                 | `debug` \| `info` \| `warn` \| `error`                |
| `VP_HEADLESS`                              | `true`                 | Set `false` to watch the crawl                        |

Credentials are set as **`httpCredentials` on the browser context**, not on
individual navigations, so every subresource request — images, CSS, JS, XHR —
carries them too. A 401 is logged as an error rather than silently treated as a
dead link.

### Outputs

| File                    | Contents                                                                                                                                                                                         |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `out/passwords.json`    | Each password with source URL, artifact path, extraction method, surrounding context, and every other place the same password was seen                                                           |
| `out/crawl-report.md`   | Full URL inventory with discovery provenance, URL-template/trap analysis, artifact counts by content-type and kind, the content-type × extractor coverage matrix, dedupe stats, and error tables |
| `artifacts/index.jsonl` | One record per (URL, body, status) observation: final URL, status, all request/response headers, content-type, sha256, resource type, discovery provenance                                       |
| `artifacts/bodies/…`    | Raw bytes, stored once per sha256                                                                                                                                                                |

The CLI prints a running unique-password count as each new one is found, and exits
non-zero if the count is not the expected 8.

---

## Architecture

```
src/
  cli.ts                     command entry: crawl | extract | report | run
  config.ts                  env-sourced config + a dependency-free .env loader
  logging.ts                 structured JSON-per-line logging on stderr
  types.ts                   shared domain types

  harvest/
    harvester.ts             the crawl loop: navigate, capture, discover
    trapGuard.ts             URL-template saturation detection (crawler traps)
    discovery/dom.ts         in-page link discovery (runs inside the browser)

  store/
    artifactStore.ts         content-addressed body store + JSONL index
    frontier.ts              queue, dedupe key, and the discovery audit trail

  extract/
    registry.ts              one handler per channel; runs all, isolates failures
    pipeline.ts              drives the registry over every artifact
    hit.ts                   text → PasswordHit, minus the published example
    handlers/                text, headers, html, css, javascript, json, svg,
                             image, ocr, pdf, archive, media, font, wasm, encodings

  report/reports.ts          passwords.json + crawl-report.md writers

  util/                      url normalization, hashing, the password grammar
```

The module boundaries are the ones that mattered in practice: **discovery** is
separable from **capture** is separable from **decoding**. Adding a new hiding
place means writing one `Extractor` and adding it to `buildRegistry()`; nothing
else changes, and the coverage matrix picks it up automatically.

---

## Crawl approach

### Discovery goes well past `<a href>`

The challenge says so explicitly, and the site backs it up: `/static/js/main.js`
builds a second navigation bar at runtime from a JS array, and those seven pages
appear in no HTML source anywhere. Discovery therefore runs **in the page, after
scripts have run**, and collects:

- every URL-bearing attribute — `href`, `src`, `srcset`, `data`, `poster`,
  `action`, `formaction` — across `<a> <area> <link> <base> <img> <script>
  <iframe> <frame> <embed> <object> <source> <track> <video> <audio> <form>
  <use> <image>`
- any `data-*` attribute whose value is path-shaped
- `<meta http-equiv="refresh">` targets
- CSS `url()` from `document.styleSheets` (so inline `<style>` and linked sheets
  both count), `@import` targets, and computed `background-image` /
  `list-style-image` / `border-image-source`, including on `::before` / `::after`
- path-shaped string literals in inline `on*` handlers and inline `<script>` blocks
- URL literals inside JS bundles, JSON responses and `sourceMappingURL` comments,
  harvested from the response bytes themselves
- `Location` and `Link` response headers
- values sitting in cookies, `localStorage` and `sessionStorage`
- **click probing**: elements that are not anchors but behave like links (an
  `onclick`, `role="link"`, a nav-ish `data-*`, or a `cursor: pointer` computed
  style) are clicked with main-frame navigation intercepted and aborted, so the
  destination is recorded without leaving the page

Forms are submitted only when a real user could do so harmlessly: `GET` forms are
turned into a URL from their default field values; non-`GET` forms are **not**
submitted and are counted in the report instead. `sitemap.xml`, `manifest.json`
and `.well-known` are crawled only if a page actually references them — on this
site nothing does, and all four common paths return 404.

Pages are scrolled to the bottom and waited to network-idle before the DOM is
snapshotted, so lazy-loaded resources are captured.

### Everything is persisted, twice where it differs

For each page the store gets:

- the **raw response body** exactly as sent, plus every subresource response
- the **rendered DOM** (`page.content()`) as a separate artifact

These genuinely differ here, and the difference is load-bearing. The homepage
ships four rules in its markup and an inline script that deletes the fourth
before paint. The deleted rule is the one claiming that _"passwords that appear in
HTTP response headers are staging placeholders and are not qualified"_ — a real
browser never sees that claim, so the header password is treated as qualified.
Reading only the HTML source would have led to discarding a real password;
reading only the rendered DOM would have hidden the trap. The crawler keeps both.

A **browser-state artifact** per page records cookies, `localStorage`,
`sessionStorage`, `::before`/`::after` `content` values, the full text content,
the painted text, and the difference between them — i.e. text that is in the DOM
but never rendered.

Chromium discards redirect bodies, so a 3xx is re-requested with
`maxRedirects: 0` rather than stored as an empty artifact.

### Dedupe, in two layers

1. **URL** — `canonicalKey()`: normalize (drop fragment and default port, resolve
   dot segments, sort query parameters, decode needlessly-escaped octets), then
   drop known-decorative query parameters so `/wiki/`, `/wiki/?v=7` and
   `/wiki/?utm_source=internal` are one frontier entry.
2. **Content** — sha256. Bodies are written once; every (URL, body, status)
   observation is still indexed, so the report can show that two URLs served
   identical bytes rather than silently hiding one.

Stripping query parameters is the risky half, so it was **verified against the
live site rather than assumed**: all 224 distinct parameterized links on the site
were fetched alongside their stripped form, and every pair was byte-identical.
`page` is not on the decorative list, so pagination survives.

Every discovery — including repeat discoveries of an already-queued URL — is
recorded with its source, so the report can show _all_ the ways a page was
reachable, not just the first.

### Crawler traps

`/report/?page=N` renders for every N tried, up to at least 1,000,000. A frontier
that follows it never terminates, which would make "frontier exhausted" an
unprovable claim. `TrapGuard` groups URLs into templates (numbers in the path and
query masked to `{n}`) and closes a template once it has demonstrably stopped
producing novelty:

- its pages all reduce to the same **shape hash** (the body with digits and hex
  runs masked out), **and**
- its pages have stopped contributing URLs **outside** the template

Both conditions must hold across a sample, and a hard per-template cap is the
backstop for shapes the heuristic does not model. Every closure is recorded in the
report with the reason, so nothing is dropped silently.

This is the one place the crawl deliberately stops short of literal exhaustion, so
it was checked by hand: report pages 1–60,000 plus a coarse sweep to page
2,000,000 contain no password, and the 10,000 table rows captured are perfectly
uniform in shape (every check id is exactly 13 characters; no cell deviates from
its column's format). Report pages link only to `/`, to `page ± 1`, and to the
stylesheet — so nothing else is reachable only through them.

Runs are **resumable and deterministic**: the artifact index is reloaded on start,
already-hashed bodies are not rewritten, and non-renderable resources that were
already captured are not re-fetched.

---

## Extraction approach

One handler per channel, all of them run over every applicable artifact. Nothing
short-circuits on the first hit — a single file can carry a password in more than
one channel, and knowing _which_ channels a password appears in is part of the
evidence.

| Extractor          | Channel                                                                                                                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `raw-text`         | UTF-8 and latin-1 decodes of the whole body                                                                                                                                   |
| `utf16-text`       | UTF-16LE / UTF-16BE decodes                                                                                                                                                   |
| `binary-strings`   | printable-run extraction (`strings(1)`) from binary bodies                                                                                                                    |
| `response-headers` | the status line and every response header (`X-*`, `ETag`, `Link`, `Server`, …)                                                                                                |
| `request-headers`  | request headers the browser sent                                                                                                                                              |
| `cookies`          | `Set-Cookie`, the cookie jar, `localStorage`, `sessionStorage`                                                                                                                |
| `html`             | comments, attribute values (`alt`/`title`/`data-*`/`aria-*`), text inside elements hidden by inline CSS, document text; run over the raw body and the rendered DOM separately |
| `css`              | comments, generated `content:` strings, CSS unicode escapes                                                                                                                   |
| `javascript`       | comments, `\u`/`\x` escapes, concatenated literals, `String.fromCharCode()` payloads, character-code array literals, reversed strings                                         |
| `sourcemap`        | `sourcesContent`, `sources`, `names`                                                                                                                                          |
| `json`             | recursive walk over keys, string values, and JSON-inside-a-string                                                                                                             |
| `svg`              | `<text>`/`<tspan>`/`<title>`/`<desc>`/`<metadata>`, XML comments, base64 in `href`                                                                                            |
| `image-metadata`   | EXIF / IPTC / XMP / ICC, including byte-bag values decoded through their character-set marker                                                                                 |
| `image-chunks`     | PNG `tEXt`/`iTXt`/`zTXt`, JPEG `COM` and `APPn`, GIF comment extensions                                                                                                       |
| `trailing-bytes`   | bytes appended after `IEND` / `EOI` / GIF trailer                                                                                                                             |
| `ocr`              | text drawn into image pixels (tesseract.js)                                                                                                                                   |
| `pdf`              | page text, Info/XMP metadata, annotations, embedded files, inflated object streams                                                                                            |
| `archive`          | zip / gzip / tar members, nested up to three levels                                                                                                                           |
| `media-metadata`   | ID3v1/v2, MP4 `udta`/`ilst` atoms, Matroska/WAV container text                                                                                                                |
| `font`             | OpenType/TrueType `name` table records, including WOFF-wrapped                                                                                                                |
| `wasm`             | custom sections and data-segment constants                                                                                                                                    |
| `base64`           | base64 / base64url runs, double-encoded and compressed-inside-base64                                                                                                          |
| `hex`              | long hex runs decoded back to bytes                                                                                                                                           |
| `escapes`          | percent-encoding, HTML entities, JS escapes, ROT13                                                                                                                            |
| `compression`      | gzip / zlib / raw-deflate / brotli, whole-body or embedded at any offset (this is what reaches a PNG `IDAT` payload)                                                          |
| `data-uri`         | inline `data:` URIs, base64 or percent-encoded                                                                                                                                |

Two details worth calling out:

- **The example is excluded structurally.** `VISUALPING{0000deadbeef0000}` is
  filtered in `findPasswords()`, so no handler can accidentally report it, and a
  test asserts that it is dropped from every channel at once.
- **OCR cannot invent a password.** Tesseract is constrained to the password
  alphabet, and if the recognised text is not already a valid password, a
  confusable-glyph repair (`l`/`I` → `1`, `O` → `0`, …) is attempted and accepted
  _only_ if the repaired string satisfies the grammar. A repair can never produce
  a password the image does not contain.

### Tests

`npm test` — 80 tests. The extractor suite builds a fixture per channel that
hides a **distinct** fake password in that channel, then asserts both that the
password comes out and that the handler owning that channel is the one that
produced it (rather than the catch-all `raw-text` pass). Fixtures are _built in
code_ — a real PNG chunk stream with a correct CRC, a real EXIF IFD, a real zip,
tar, ID3 tag, sfnt `name` table, wasm section, PDF content stream — so a reviewer
can read exactly what bytes each test feeds, and the repo carries no opaque
binaries. There are also tests for URL normalization and dedupe, frontier
provenance, trap-guard saturation, and artifact-store dedupe/resume.

---

## Results

**All eight passwords were recovered.** They are in `out/passwords.json`; the
channel each was hidden in:

| #   | Where                             | Channel                                                    |
| --- | --------------------------------- | ---------------------------------------------------------- |
| 1   | `/notes/diff-socket-socket/`      | HTML comment                                               |
| 2   | `/wiki/detect-embed/`             | `data-vp-archive` attribute on `<body>`                    |
| 3   | `/products/filter-gateway/`       | `X-Provisioning-Note` response header                      |
| 4   | `/static/js/analytics.js`         | hard-coded JS string literal                               |
| 5   | `/static/js/theme-switcher.js`    | character-code array passed to `String.fromCharCode.apply` |
| 6   | `/static/img/field-visit.jpg`     | EXIF `UserComment`, UTF-16 behind a `UNICODE` marker       |
| 7   | `/static/img/whiteboard-scan.png` | text drawn into the pixels — OCR only                      |
| 8   | `/status/eu-region/`              | page body, unlocked only from a Germany-region source IP   |

### The eighth: a server-side geo gate

`/status/eu-region/` is linked from the homepage ("regional availability
status"), but returns a static `403` — _"only visible to Germany region. Your IP
is from Canada."_ — to any request not originating in Germany. The gate is keyed
to the **real TCP source IP**: a live server-side GeoIP lookup on the connection,
not on anything the client sends. This was established by exhausting the
client-controlled surface — ~20 forwarded-IP and country headers
(`X-Forwarded-For` with a genuine German IP, `CF-IPCountry: DE`, `X-Real-IP`,
`True-Client-IP`, `Forwarded`, …), cookies, query params, and alternate region
slugs — none of which moved the detected country off the crawler's real egress.

So the page is not "hidden" in any byte a crawler can decode; it is gated on
_where the request comes from_, and the only way through is to actually originate
from the required region. Running the crawl from a Germany-region egress returns:

```
Regional status: Germany
Access confirmed from the Germany (DE) region. This region's provisioning password:
VISUALPING{5488187886a5755a}
```

The crawler routes through a proxy via **`VP_PROXY`** (set on the browser context,
so navigations and subresources share the exit) for exactly this case — point it
at an exit node in the required region. A host-level VPN on the crawl machine
works identically and needs no configuration.

---

## Completeness

### The frontier was exhausted

The crawl ends with **592 URLs discovered, 592 processed, 0 pending** and 0
navigation errors — it stopped because there was nothing left, not because it hit
a budget. The one deliberate exception is the `/report/?page={n}` template, which
the trap guard closed after 31 pages ("25 pages sampled reduced to 2 distinct
page shapes and contributed no URLs outside the template") and which was
separately swept by hand (above).

This was verified independently of the crawler: re-parsing every stored HTML, CSS,
JS and JSON body for `href` / `src` / `action` / `data` / `poster` / `srcset` /
`url()` / quoted paths, resolving each against its containing document and
canonicalizing it, yields **exactly one** referenced-but-unfetched URL —
`/report/?page=32`, the trap boundary. The link graph is closed.

### Every discovered URL was fetched and hashed

592 URLs, 592 response artifacts, **no empty 200s** — 1,744 stored observations
over 1,261 unique bodies once sha256 dedupe collapses the duplicates. Every
observation has a sha256 and a sidecar recording its status, final URL and
complete headers.

Routing through a proxy surfaced a Playwright quirk worth noting: for a proxied
request, `response.body()` can return _empty_ for a 200 instead of throwing, so a
naive capture silently stores 0 bytes. The harvester now detects any
should-have-had-a-body response that came back empty and re-fetches it through the
API request context (which shares the same proxy and credentials) — the same
recovery path already used for redirect bodies. With it, the proxied run captures
every body and finds all eight; without it, two subresource-borne passwords
(`theme-switcher.js`, `whiteboard-scan.png`) were lost to empty captures.

### Every artifact went through every applicable extractor

The coverage matrix in `crawl-report.md` is generated from the run itself, not
written by hand: rows are content-types as served, columns are extractors, and a
cell shows how many artifacts that extractor ran over and how many hits it
produced. `—` means the extractor does not claim that type. Because the cells are
counted at execution time, a gap would be visible as an unexpected `—` rather
than being invisible.

Extractors that found nothing are listed explicitly rather than quietly dropped:
on this site that is most of them, which is the expected result for a site with
no PDFs, archives, fonts, media, wasm, SVG or source maps.

### The site's whole HTTP surface was swept, not just its bodies

- **Headers**: all 563 non-report URLs were re-requested and their full header
  sets collected, with failures detected rather than silently skipped. The
  complete set of header names the site ever emits is `Server`, `Date`,
  `Content-Type`, `Content-Length`, `Connection`, `Last-Modified`, `ETag`,
  `Accept-Ranges`, `Location` and exactly one `X-Provisioning-Note`. Report pages
  were swept separately; they add nothing.
- **Status lines**: only `200 OK`, `301 Moved Permanently`, `403 Forbidden` —
  no password smuggled into a reason phrase.
- **Redirect bodies**: all 114 are nginx's stock 301 page.
- **The 401 challenge**: `WWW-Authenticate: Basic realm="Visualping Crawler
Challenge"`, nothing more.
- **Request-shape sensitivity**: content is identical with and without a
  `Referer`, between the browser and plain `curl`, across `index.html` and its
  directory form (81 pairs), and across `Accept:` values. `HEAD`, conditional
  `If-None-Match`, and `OPTIONS` reveal nothing extra. There is no autoindex, no
  HTTPS listener, and `robots.txt`, `sitemap.xml`, `manifest.json` and
  `favicon.ico` all 404.

### The bytes were searched beyond what the extractors do

As an independent cross-check of the extractor registry, every stored body was
searched for the _transformed_ password prefix rather than relying on the
decoders: reversed, hex, UTF-16 (both endiannesses), percent-encoded, base64 at
all three byte alignments, base32, all 25 Caesar shifts, Atbash, bit-reversed
bytes, and single-byte XOR and add for all 255 keys. The only match is the known
UTF-16 EXIF comment. Additionally the four remaining PNGs were checked for LSB
steganography across both scan orders, six channel selections, one and two bit
planes, and both bit orders; their inflated `IDAT` streams and unfiltered pixel
data were searched directly; and every image was OCR'd regardless of size. All
negative.

### Deliberately not chased down rabbit holes

Two things look like passwords and are not, so they are named here rather than
force-fit into the count:

- **`/report/?page=N` beyond the swept range.** Pages 1–60,000 and a coarse sweep
  to 2,000,000 are clean, and the pages are structurally uniform and link
  nowhere new, so this is a pure crawler trap. It is unbounded, but nothing in it
  is a password.
- **Three bare 16-hex strings** sit in JPEG `COM` markers
  (`field-visit.jpg`, `office-plants.jpg`, `team-offsite.jpg`). They are _not_ in
  the password format, and `field-visit.jpg` carries both one of these and a
  properly-formatted password in its EXIF, which is what marks them as decoys.
  They are reported as-is rather than silently wrapped in `VISUALPING{…}`,
  because guessing the format onto them would be inventing an answer.

All eight real passwords were found in a single clean run from a Germany-region
egress. Seven are decodable from any vantage point; the eighth additionally
requires originating the request from the gated region (see
[The eighth](#the-eighth-a-server-side-geo-gate) above) — a property of the
network path, not of any byte on the page.
