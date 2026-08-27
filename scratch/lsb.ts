import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';

function bitsToString(bits: number[]): string {
  let out = '';
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) byte = (byte << 1) | (bits[i + b] ?? 0);
    out += String.fromCharCode(byte);
  }
  return out;
}

for (const f of readdirSync('scratch/img')) {
  if (!f.endsWith('.png')) continue;
  const png = PNG.sync.read(readFileSync(`scratch/img/${f}`));
  console.log('==', f, png.width + 'x' + png.height);
  // channel-interleaved RGB LSB, MSB-first bit order
  const rgb: number[] = [];
  const perChannel: Record<string, number[]> = { r: [], g: [], b: [], a: [] };
  for (let i = 0; i < png.data.length; i += 4) {
    for (const [ci, name] of [[0,'r'],[1,'g'],[2,'b'],[3,'a']] as const) {
      const bit = (png.data[i + ci] ?? 0) & 1;
      perChannel[name]!.push(bit);
      if (ci < 3) rgb.push(bit);
    }
  }
  for (const [label, bits] of [['rgb', rgb], ...Object.entries(perChannel)] as [string, number[]][]) {
    const s = bitsToString(bits);
    const m = /VISUALPING\{[0-9a-fA-F]{16}\}/.exec(s);
    const printable = s.slice(0, 60).replace(/[^ -~]/g, '.');
    console.log(`   ${label.padEnd(4)} ${m ? 'HIT ' + m[0] : 'head: ' + printable}`);
  }
}
