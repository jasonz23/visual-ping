import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const files: string[] = [];
function walk(dir: string): void {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(p);
  }
}
walk('artifacts/bodies');
console.log('bodies:', files.length);

const PREFIX = 'VISUALPING{';
// Every encoding of the literal prefix we can cheaply search for.
const needles = new Map<string, string>();
needles.set('literal', PREFIX);
needles.set('lowercase', PREFIX.toLowerCase());
needles.set('reversed', [...PREFIX].reverse().join(''));
needles.set('hex', Buffer.from(PREFIX).toString('hex'));
needles.set('hex-upper', Buffer.from(PREFIX).toString('hex').toUpperCase());
needles.set('utf16le', Buffer.from(PREFIX, 'utf16le').toString('latin1'));
needles.set('url-encoded', encodeURIComponent(PREFIX));
// base64 of the prefix at all three alignments
for (let pad = 0; pad < 3; pad += 1) {
  const b64 = Buffer.from('x'.repeat(pad) + PREFIX).toString('base64');
  needles.set(`base64@${pad}`, b64.slice(pad === 0 ? 0 : 4, 12));
}
// caesar shifts
for (let shift = 1; shift < 26; shift += 1) {
  const shifted = [...PREFIX].map((c) => {
    if (c >= 'A' && c <= 'Z') return String.fromCharCode(((c.charCodeAt(0) - 65 + shift) % 26) + 65);
    return c;
  }).join('');
  needles.set(`caesar+${shift}`, shifted);
}
// atbash
needles.set('atbash', [...PREFIX].map((c) => (c >= 'A' && c <= 'Z' ? String.fromCharCode(155 - c.charCodeAt(0)) : c)).join(''));
// base32
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32(buf: Buffer): string {
  let bits = '', out = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}
needles.set('base32', base32(Buffer.from(PREFIX)).slice(0, 12));

const hits = new Map<string, string[]>();
for (const f of files) {
  const raw = readFileSync(f);
  const asLatin = raw.toString('latin1');
  for (const [name, needle] of needles) {
    if (name === 'literal' || name === 'lowercase') continue; // already known
    if (needle.length < 6) continue;
    if (asLatin.includes(needle)) {
      const list = hits.get(name) ?? [];
      list.push(f);
      hits.set(name, list);
    }
  }
}
for (const [name, list] of hits) console.log(name, '->', list.length, list.slice(0, 3));
if (hits.size === 0) console.log('no encoded prefix found in any body');
