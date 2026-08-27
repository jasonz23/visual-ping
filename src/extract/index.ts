/** The default extractor set. Adding a channel means adding one entry here. */
import { ExtractorRegistry } from './registry.js';
import {
  base64Extractor,
  compressionExtractor,
  dataUriExtractor,
  hexExtractor,
  percentAndEntityExtractor,
} from './handlers/encodings.js';
import {
  cookieExtractor,
  requestHeaderExtractor,
  responseHeaderExtractor,
} from './handlers/headers.js';
import { binaryStringsExtractor, rawTextExtractor, utf16TextExtractor } from './handlers/text.js';
import { cssExtractor } from './handlers/css.js';
import { htmlExtractor } from './handlers/html.js';
import { javascriptExtractor, sourceMapExtractor } from './handlers/javascript.js';
import { jsonExtractor } from './handlers/json.js';
import { svgExtractor } from './handlers/svg.js';
import {
  imageMetadataExtractor,
  pngChunkExtractor,
  trailingBytesExtractor,
} from './handlers/image.js';
import { pdfExtractor } from './handlers/pdf.js';
import { archiveExtractor } from './handlers/archive.js';
import { mediaMetadataExtractor } from './handlers/media.js';
import { fontExtractor } from './handlers/font.js';
import { wasmExtractor } from './handlers/wasm.js';
import { ocrExtractor } from './handlers/ocr.js';

export function buildRegistry(): ExtractorRegistry {
  return new ExtractorRegistry().registerAll([
    rawTextExtractor,
    utf16TextExtractor,
    binaryStringsExtractor,
    responseHeaderExtractor,
    requestHeaderExtractor,
    cookieExtractor,
    htmlExtractor,
    cssExtractor,
    javascriptExtractor,
    sourceMapExtractor,
    jsonExtractor,
    svgExtractor,
    imageMetadataExtractor,
    pngChunkExtractor,
    trailingBytesExtractor,
    ocrExtractor,
    pdfExtractor,
    archiveExtractor,
    mediaMetadataExtractor,
    fontExtractor,
    wasmExtractor,
    base64Extractor,
    hexExtractor,
    percentAndEntityExtractor,
    compressionExtractor,
    dataUriExtractor,
  ]);
}

export { ExtractorRegistry };
