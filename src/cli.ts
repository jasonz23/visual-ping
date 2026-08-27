#!/usr/bin/env node
/**
 * CLI entry point.
 *
 *   crawl    phase 1 only — drive the browser and fill the artifact store
 *   extract  phase 2 only — run every extractor over the stored artifacts
 *   report   re-render the reports from what is already stored
 *   run      crawl, then extract, then report (the default)
 */
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';
import { ArtifactStore } from './store/artifactStore.js';
import { Harvester } from './harvest/harvester.js';
import type { HarvestSummary } from './harvest/harvester.js';
import { buildRegistry } from './extract/index.js';
import { extractAll } from './extract/pipeline.js';
import { shutdownOcr } from './extract/handlers/ocr.js';
import { writeCrawlReport, writePasswordsJson } from './report/reports.js';
import { EXAMPLE_PASSWORD } from './util/password.js';

const TARGET_PASSWORD_COUNT = 8;

type Command = 'crawl' | 'extract' | 'report' | 'run';

function parseCommand(argv: readonly string[]): Command {
  const raw = argv[2] ?? 'run';
  if (raw === 'crawl' || raw === 'extract' || raw === 'report' || raw === 'run') return raw;
  throw new Error(`Unknown command "${raw}". Expected: crawl | extract | report | run`);
}

async function main(): Promise<number> {
  const command = parseCommand(process.argv);
  const config = loadConfig();
  const log = createLogger(config.logLevel, { command });

  log.info('starting', {
    baseUrl: config.baseUrl,
    artifactDir: config.artifactDir,
    outDir: config.outDir,
    concurrency: config.concurrency,
  });

  const store = new ArtifactStore(config.artifactDir);
  await store.load();

  let harvest: HarvestSummary | null = null;
  if (command === 'crawl' || command === 'run') {
    const harvester = new Harvester(config, store, log);
    harvest = await harvester.run([config.baseUrl]);
    log.info('harvest complete', {
      processed: harvest.visited,
      urlsKnown: harvest.frontier.known,
      pending: harvest.frontier.pending,
      artifacts: store.all.length,
      uniqueBodies: store.uniqueBodyCount,
      errors: harvest.errors.length,
    });
    printArtifactInventory(store);
  }

  if (command === 'crawl') return 0;

  const registry = buildRegistry();
  let extraction;
  try {
    extraction = await extractAll(store, registry, log, {
      onNewPassword: (password, hit, total) => {
        process.stdout.write(
          `[${String(total).padStart(2, ' ')}/${TARGET_PASSWORD_COUNT}] ${password}  ←  ${hit.method}  @ ${hit.sourceUrl}\n`,
        );
      },
    });
  } finally {
    // The OCR worker is a child process; release it whether or not we succeeded.
    await shutdownOcr();
  }

  const passwords = await writePasswordsJson(config.outDir, config.baseUrl, extraction);
  await writeCrawlReport(config.outDir, {
    baseUrl: config.baseUrl,
    harvest,
    extraction,
    store,
    registry,
  });

  process.stdout.write('\n');
  process.stdout.write(`Unique passwords: ${passwords.count} / ${TARGET_PASSWORD_COUNT}\n`);
  process.stdout.write(`(the published example ${EXAMPLE_PASSWORD} is excluded by design)\n`);
  process.stdout.write(`Artifacts scanned: ${extraction.artifactsScanned}`);
  process.stdout.write(` (${extraction.bodiesScanned} unique bodies)\n`);
  process.stdout.write(`Reports written to ${config.outDir}\n`);

  if (passwords.count !== TARGET_PASSWORD_COUNT) {
    log.warn('password count does not match the target', {
      found: passwords.count,
      target: TARGET_PASSWORD_COUNT,
    });
    return passwords.count > 0 ? 2 : 1;
  }
  return 0;
}

function printArtifactInventory(store: ArtifactStore): void {
  const byMime = new Map<string, { count: number; bytes: number }>();
  for (const record of store.all) {
    const entry = byMime.get(record.mimeType) ?? { count: 0, bytes: 0 };
    entry.count += 1;
    entry.bytes += record.byteLength;
    byMime.set(record.mimeType, entry);
  }
  process.stdout.write('\nArtifact inventory by content-type:\n');
  const rows = [...byMime.entries()].sort((a, b) => b[1].count - a[1].count);
  const width = Math.max(...rows.map(([mime]) => mime.length), 12);
  for (const [mime, entry] of rows) {
    process.stdout.write(
      `  ${mime.padEnd(width)}  ${String(entry.count).padStart(5)}  ${entry.bytes.toLocaleString('en-US').padStart(12)} bytes\n`,
    );
  }
  process.stdout.write(`  ${'TOTAL'.padEnd(width)}  ${String(store.all.length).padStart(5)}\n\n`);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
