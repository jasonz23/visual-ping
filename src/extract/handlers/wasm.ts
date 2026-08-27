/**
 * WebAssembly channels: the data segment initialisers (where string constants live)
 * and custom sections such as `name` and `.debug_*`.
 */
import type { Extractor, PasswordHit } from '../../types.js';
import { scanText } from '../hit.js';

const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

export const wasmExtractor: Extractor = {
  id: 'wasm',
  description: 'WebAssembly custom sections and data-segment string constants',
  appliesTo: (record, body) =>
    body.length > 8 &&
    (body.subarray(0, 4).equals(WASM_MAGIC) ||
      record.mimeType === 'application/wasm' ||
      /\.wasm$/i.test(record.url)),
  extract: (ctx) => {
    const hits: PasswordHit[] = [];
    for (const section of readSections(ctx.body)) {
      hits.push(
        ...scanText(section.payload.toString('utf8'), {
          record: ctx.record,
          artifactPath: ctx.bodyPath,
          extractor: 'wasm',
          method: `wasm section ${section.id}${section.name ? ` ("${section.name}")` : ''}`,
        }),
      );
    }
    return hits;
  },
};

interface WasmSection {
  id: number;
  name?: string;
  payload: Buffer;
}

function readSections(body: Buffer): WasmSection[] {
  const sections: WasmSection[] = [];
  if (!body.subarray(0, 4).equals(WASM_MAGIC)) return sections;
  let offset = 8;
  while (offset < body.length) {
    const id = body[offset];
    if (id === undefined) break;
    offset += 1;
    const [size, sizeBytes] = readVarUint(body, offset);
    if (sizeBytes === 0) break;
    offset += sizeBytes;
    const end = offset + size;
    if (end > body.length) break;
    const payload = body.subarray(offset, end);
    if (id === 0) {
      const [nameLength, nameBytes] = readVarUint(payload, 0);
      const name = payload.subarray(nameBytes, nameBytes + nameLength).toString('utf8');
      sections.push({ id, name, payload });
    } else {
      sections.push({ id, payload });
    }
    offset = end;
  }
  return sections;
}

/** LEB128 unsigned varint. Returns [value, bytesRead]; bytesRead 0 on overflow. */
function readVarUint(body: Buffer, offset: number): [number, number] {
  let result = 0;
  let shift = 0;
  let index = offset;
  while (index < body.length && shift <= 28) {
    const byte = body[index];
    if (byte === undefined) return [0, 0];
    result |= (byte & 0x7f) << shift;
    index += 1;
    if ((byte & 0x80) === 0) return [result >>> 0, index - offset];
    shift += 7;
  }
  return [0, 0];
}
