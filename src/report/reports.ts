/** Report writers: `passwords.json` and `crawl-report.md`. */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ArtifactStore } from '../store/artifactStore.js';
import type { ExtractionReport } from '../extract/pipeline.js';
import { bestHitPerPassword } from '../extract/pipeline.js';
import type { ExtractorRegistry } from '../extract/registry.js';
import type { HarvestSummary } from '../harvest/harvester.js';
import type { ArtifactRecord, PasswordHit } from '../types.js';

export interface PasswordsFile {
  generatedAt: string;
  baseUrl: string;
  count: number;
  passwords: Array<{
    password: string;
    sourceUrl: string;
    artifactPath: string;
    extractor: string;
    method: string;
    context?: string;
    mimeType: string;
    /** Every other place the same password was observed. */
    alsoSeenIn: Array<{ sourceUrl: string; extractor: string; method: string }>;
  }>;
}

export async function writePasswordsJson(
  outDir: string,
  baseUrl: string,
  report: ExtractionReport,
): Promise<PasswordsFile> {
  await mkdir(outDir, { recursive: true });
  const primary = bestHitPerPassword(report.hits);
  const payload: PasswordsFile = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    count: primary.length,
    passwords: primary.map((hit) => ({
      password: hit.password,
      sourceUrl: hit.sourceUrl,
      artifactPath: hit.artifactPath,
      extractor: hit.extractor,
      method: hit.method,
      context: hit.context,
      mimeType: hit.mimeType,
      alsoSeenIn: report.hits
        .filter((other) => other.password === hit.password && other !== hit)
        .map((other) => ({
          sourceUrl: other.sourceUrl,
          extractor: other.extractor,
          method: other.method,
        })),
    })),
  };
  await writeFile(join(outDir, 'passwords.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return payload;
}

export interface CrawlReportInput {
  baseUrl: string;
  harvest: HarvestSummary | null;
  extraction: ExtractionReport;
  store: ArtifactStore;
  registry: ExtractorRegistry;
}

export async function writeCrawlReport(outDir: string, input: CrawlReportInput): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const markdown = renderCrawlReport(input);
  await writeFile(join(outDir, 'crawl-report.md'), markdown, 'utf8');
  return markdown;
}

export function renderCrawlReport(input: CrawlReportInput): string {
  const { harvest, extraction, store, registry } = input;
  const records = [...store.all];
  const lines: string[] = [];

  lines.push('# Crawl report');
  lines.push('');
  lines.push(`- Base URL: \`${input.baseUrl}\``);
  lines.push(`- Generated: ${new Date().toISOString()}`);
  lines.push(`- Unique passwords found: **${extraction.uniquePasswords.length}**`);
  lines.push('');

  lines.push('## 1. Frontier');
  lines.push('');
  if (harvest) {
    const stats = harvest.frontier;
    lines.push(`- URLs discovered (unique, canonicalized): **${stats.known}**`);
    lines.push(`- URLs dequeued and processed: **${stats.visited}**`);
    lines.push(`- URLs left pending at exit: **${stats.pending}** ${stats.pending === 0 ? '(frontier exhausted)' : '(BUDGET STOP — not exhausted)'}`);
    lines.push(`- Discovery events recorded (incl. repeat discoveries): ${stats.discoveries}`);
    lines.push(`- Off-host links skipped: ${stats.offHost}`);
    lines.push(`- Unusable / non-HTTP links skipped: ${stats.unusable}`);
    lines.push(`- Navigation or fetch errors: ${harvest.errors.length}`);
    lines.push(`- URLs refused by the trap guard: ${stats.trapped}`);
    if (harvest.formsSkipped.length > 0) {
      lines.push(`- Non-GET forms deliberately not submitted: ${harvest.formsSkipped.length}`);
    }
  } else {
    lines.push('_No harvest was run in this invocation; the report describes the stored artifacts._');
  }
  lines.push('');

  if (harvest) {
    lines.push('### Discovery sources');
    lines.push('');
    const bySource = countBy(harvest.discoveryLog, (event) => event.source);
    lines.push('| Discovery source | URLs discovered |');
    lines.push('| --- | ---: |');
    for (const [source, count] of sortedEntries(bySource)) {
      lines.push(`| \`${source}\` | ${count} |`);
    }
    lines.push('');

    const saturated = harvest.templates.filter((template) => template.saturated);
    lines.push('### URL templates');
    lines.push('');
    lines.push(
      'URLs are grouped by template (numbers in the path and query masked to `{n}`). ' +
        'A template is *saturated* when its pages stopped producing new page shapes ' +
        'and stopped linking outside themselves — an unbounded generator, not a frontier.',
    );
    lines.push('');
    lines.push('| Template | Enqueued | Fetched | Distinct shapes | Outbound novelty | Saturated |');
    lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
    for (const template of harvest.templates.slice(0, 40)) {
      lines.push(
        `| \`${short(template.template)}\` | ${template.enqueued} | ${template.fetched} | ` +
          `${template.distinctShapes} | ${template.outboundNovelty} | ` +
          `${template.saturated ? `yes — ${escapePipes(template.reason ?? '')}` : 'no'} |`,
      );
    }
    lines.push('');
    if (saturated.length > 0) {
      lines.push(
        `**${saturated.length} template(s) were closed by the trap guard.** Everything ` +
          'else in the frontier was crawled to exhaustion.',
      );
      lines.push('');
    }

    lines.push('### URL inventory');
    lines.push('');
    lines.push('Every URL that entered the frontier, with the first way it was discovered.');
    lines.push('');
    lines.push('| # | URL | Discovered via | First seen on |');
    lines.push('| ---: | --- | --- | --- |');
    const firstSeen = new Map<string, (typeof harvest.discoveryLog)[number]>();
    const allSources = new Map<string, Set<string>>();
    for (const event of harvest.discoveryLog) {
      if (!firstSeen.has(event.key)) firstSeen.set(event.key, event);
      const sources = allSources.get(event.key) ?? new Set<string>();
      sources.add(event.source);
      allSources.set(event.key, sources);
    }
    let index = 0;
    for (const [url, event] of firstSeen) {
      index += 1;
      const sources = [...(allSources.get(url) ?? [])].map((source) => `\`${source}\``).join(', ');
      lines.push(`| ${index} | \`${url}\` | ${sources} | \`${short(event.discoveredFrom)}\` |`);
    }
    lines.push('');
  }

  lines.push('## 2. Artifacts');
  lines.push('');
  lines.push(`- Stored observations (url × body × status): **${records.length}**`);
  lines.push(`- Unique bodies after sha256 dedupe: **${store.uniqueBodyCount}**`);
  const dedupeSaving = records.length - store.uniqueBodyCount;
  lines.push(
    `- Duplicate bodies collapsed: **${dedupeSaving}** (${percent(dedupeSaving, records.length)} of observations)`,
  );
  lines.push('');
  lines.push('### By content-type');
  lines.push('');
  lines.push('| Content-type | Observations | Unique bodies | Bytes |');
  lines.push('| --- | ---: | ---: | ---: |');
  const byMime = new Map<string, { count: number; bodies: Set<string>; bytes: number }>();
  for (const record of records) {
    const entry = byMime.get(record.mimeType) ?? { count: 0, bodies: new Set<string>(), bytes: 0 };
    entry.count += 1;
    entry.bodies.add(record.sha256);
    entry.bytes += record.byteLength;
    byMime.set(record.mimeType, entry);
  }
  for (const [mime, entry] of [...byMime.entries()].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`| \`${mime}\` | ${entry.count} | ${entry.bodies.size} | ${entry.bytes.toLocaleString('en-US')} |`);
  }
  lines.push('');

  lines.push('### By artifact kind');
  lines.push('');
  lines.push('| Kind | Count | Meaning |');
  lines.push('| --- | ---: | --- |');
  const kindMeaning: Record<string, string> = {
    response: 'raw bytes of an HTTP response (documents and every subresource)',
    'rendered-dom': 'the DOM after scripts ran — differs from the raw HTML body',
    storage: 'cookies, localStorage, sessionStorage, pseudo-element content, hidden text',
    derived: 'artifact synthesised from another artifact',
    'accessibility-text': 'text exposed only through the accessibility tree',
  };
  for (const [kind, count] of sortedEntries(countBy(records, (record) => record.kind))) {
    lines.push(`| \`${kind}\` | ${count} | ${kindMeaning[kind] ?? ''} |`);
  }
  lines.push('');

  lines.push('### HTTP status codes');
  lines.push('');
  lines.push('| Status | Count |');
  lines.push('| ---: | ---: |');
  for (const [status, count] of sortedEntries(countBy(records, (record) => String(record.status)))) {
    lines.push(`| ${status} | ${count} |`);
  }
  lines.push('');

  lines.push('## 3. Extractor coverage matrix');
  lines.push('');
  lines.push(
    'Rows are content-types as served; columns are extractors. A cell shows ' +
      '`applied/hits` — how many artifacts of that type the extractor ran over, and how ' +
      'many password hits it produced. `—` means the extractor does not claim that type.',
  );
  lines.push('');
  const extractorIds = registry.all.map((extractor) => extractor.id);
  lines.push(`| Content-type | ${extractorIds.map((id) => `\`${id}\``).join(' | ')} |`);
  lines.push(`| --- | ${extractorIds.map(() => '---').join(' | ')} |`);
  for (const mime of [...Object.keys(extraction.coverage)].sort()) {
    const row = extraction.coverage[mime] ?? {};
    const cells = extractorIds.map((id) => {
      const cell = row[id];
      if (!cell || cell.applied === 0) return '—';
      return `${cell.applied}/${cell.hits}${cell.errors ? ` ⚠${cell.errors}` : ''}`;
    });
    lines.push(`| \`${mime}\` | ${cells.join(' | ')} |`);
  }
  lines.push('');

  lines.push('### Extractors that found nothing');
  lines.push('');
  if (extraction.extractorsWithNoHits.length === 0) {
    lines.push('_None — every registered extractor produced at least one hit._');
  } else {
    lines.push(
      'These ran (where applicable) and produced no hits. They are kept because a ' +
        'negative result is part of the completeness argument.',
    );
    lines.push('');
    for (const id of extraction.extractorsWithNoHits) {
      const extractor = registry.all.find((candidate) => candidate.id === id);
      lines.push(`- \`${id}\` — ${extractor?.description ?? ''}`);
    }
  }
  lines.push('');

  lines.push('## 4. Passwords');
  lines.push('');
  const primary = bestHitPerPassword(extraction.hits);
  if (primary.length === 0) {
    lines.push('_None found._');
  } else {
    lines.push('| # | Password | Where | How |');
    lines.push('| ---: | --- | --- | --- |');
    primary.forEach((hit, i) => {
      lines.push(
        `| ${i + 1} | \`${hit.password}\` | \`${short(hit.sourceUrl)}\` | ${escapePipes(hit.method)} (\`${hit.extractor}\`) |`,
      );
    });
  }
  lines.push('');

  if (extraction.errors.length > 0) {
    lines.push('## 5. Extraction errors');
    lines.push('');
    lines.push('| Artifact | Extractor | Message |');
    lines.push('| --- | --- | --- |');
    for (const error of extraction.errors.slice(0, 100)) {
      lines.push(`| \`${error.artifact}\` | \`${error.extractor}\` | ${escapePipes(error.message)} |`);
    }
    lines.push('');
  }

  if (harvest && harvest.errors.length > 0) {
    lines.push('## 6. Harvest errors');
    lines.push('');
    lines.push('| URL | Phase | Message |');
    lines.push('| --- | --- | --- |');
    for (const error of harvest.errors.slice(0, 100)) {
      lines.push(`| \`${short(error.url)}\` | ${error.phase} | ${escapePipes(error.message)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  return counts;
}

function sortedEntries(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function percent(part: number, total: number): string {
  if (total === 0) return '0%';
  return `${((part / total) * 100).toFixed(1)}%`;
}

function short(url: string): string {
  return url.length > 90 ? `${url.slice(0, 87)}…` : url;
}

function escapePipes(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function summarizeArtifacts(records: readonly ArtifactRecord[]): Map<string, number> {
  return countBy(records, (record) => record.mimeType);
}

export type { PasswordHit };
