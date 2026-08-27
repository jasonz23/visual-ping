import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { PNG } from 'pngjs';

const NEEDLE = 'VISUALPING{';
for (const f of readdirSync('scratch/img')) {
  if (!f.endsWith('.png')) continue;
  const buf = readFileSync(`scratch/img/${f}`);
  // Concatenate every IDAT payload, then inflate.
  const idat: Buffer[] = [];
  const other: string[] = [];
  let off = 8;
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IDAT') idat.push(data);
    else other.push(`${type}(${len})`);
    if (type === 'IEND') break;
    off += len + 12;
  }
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { raw = Buffer.alloc(0); }
  const png = PNG.sync.read(buf);
  const found = [
    ['inflated IDAT (with filter bytes)', raw],
    ['unfiltered pixels', Buffer.from(png.data)],
  ] as const;
  const hits: string[] = [];
  for (const [label, b] of found) {
    for (const enc of ['latin1', 'utf8', 'utf16le'] as const) {
      const s = b.toString(enc);
      const m = /VISUALPING\{[0-9a-fA-F]{16}\}/.exec(s);
      if (m) hits.push(`${label}/${enc}: ${m[0]}`);
      if (s.includes(NEEDLE)) hits.push(`${label}/${enc}: prefix present`);
    }
  }
  console.log('==', f, 'chunks:', other.join(' '), 'idat inflated:', raw.length, hits.length ? '\n   ' + hits.join('\n   ') : '-> nothing');
}
