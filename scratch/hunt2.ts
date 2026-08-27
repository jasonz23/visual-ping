import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files: string[] = [];
(function walk(dir: string): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
})('artifacts/bodies');

const NEEDLE = Buffer.from('VISUALPING{', 'latin1');
type Variant = { name: string; needle: Buffer };
const variants: Variant[] = [];
for (let key = 1; key < 256; key += 1) {
  variants.push({ name: `xor 0x${key.toString(16)}`, needle: Buffer.from(NEEDLE.map((b) => b ^ key)) });
  variants.push({ name: `add ${key}`, needle: Buffer.from(NEEDLE.map((b) => (b + key) & 0xff)) });
}
// bit-reversed bytes
variants.push({
  name: 'bit-reversed bytes',
  needle: Buffer.from(NEEDLE.map((b) => {
    let r = 0;
    for (let i = 0; i < 8; i += 1) r = (r << 1) | ((b >> i) & 1);
    return r;
  })),
});
// UTF-16BE
const be = Buffer.from(NEEDLE.toString('latin1'), 'utf16le');
be.swap16();
variants.push({ name: 'utf-16be', needle: be });

console.log('bodies:', files.length, 'variants:', variants.length);
const hits: string[] = [];
for (const f of files) {
  const raw = readFileSync(f);
  for (const v of variants) {
    if (raw.includes(v.needle)) hits.push(`${v.name}  ${f}`);
  }
}
console.log(hits.length ? hits.slice(0, 20).join('\n') : 'no transformed prefix found');
