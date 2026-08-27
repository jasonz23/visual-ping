/**
 * Extractor registry.
 *
 * One handler per channel. Handlers are independent and every applicable handler
 * runs over every artifact — no short-circuiting on the first hit, because a single
 * file can carry a password in more than one channel (e.g. a PNG with both an EXIF
 * comment and bytes appended after IEND).
 */
import type { ArtifactRecord, ExtractionContext, ExtractionResult, Extractor } from '../types.js';

export class ExtractorRegistry {
  private readonly extractors: Extractor[] = [];

  register(extractor: Extractor): this {
    if (this.extractors.some((existing) => existing.id === extractor.id)) {
      throw new Error(`Duplicate extractor id: ${extractor.id}`);
    }
    this.extractors.push(extractor);
    return this;
  }

  registerAll(extractors: readonly Extractor[]): this {
    for (const extractor of extractors) this.register(extractor);
    return this;
  }

  get all(): readonly Extractor[] {
    return this.extractors;
  }

  applicableTo(record: ArtifactRecord, body: Buffer): Extractor[] {
    return this.extractors.filter((extractor) => {
      try {
        return extractor.appliesTo(record, body);
      } catch {
        return false;
      }
    });
  }

  /** Run every applicable extractor over one artifact. Never throws. */
  async runAll(ctx: ExtractionContext): Promise<ExtractionResult[]> {
    const results: ExtractionResult[] = [];
    for (const extractor of this.extractors) {
      let applies = false;
      try {
        applies = extractor.appliesTo(ctx.record, ctx.body);
      } catch (error) {
        results.push({
          extractor: extractor.id,
          applied: false,
          hits: [],
          error: `appliesTo threw: ${message(error)}`,
        });
        continue;
      }
      if (!applies) {
        results.push({ extractor: extractor.id, applied: false, hits: [] });
        continue;
      }
      try {
        const hits = await extractor.extract(ctx);
        results.push({ extractor: extractor.id, applied: true, hits });
      } catch (error) {
        results.push({
          extractor: extractor.id,
          applied: true,
          hits: [],
          error: message(error),
        });
      }
    }
    return results;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
