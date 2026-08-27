import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';

const RE = /VISUALPING\{[0-9a-fA-F]{16}\}/;

function pack(bits: number[], msbFirst: boolean): string {
  let out = '';
  for (let i = 0; i + 7 < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b += 1) {
      const bit = bits[i + b] ?? 0;
      byte = msbFirst ? (byte << 1) | bit : byte | (bit << b);
    }
    out += String.fromCharCode(byte);
  }
  return out;
}

for (const f of readdirSync('scratch/img')) {
  if (!f.endsWith('.png')) continue;
  const png = PNG.sync.read(readFileSync(`scratch/img/${f}`));
  const { width, height, data } = png;
  const at = (x: number, y: number, c: number): number => data[(y * width + x) * 4 + c] ?? 0;

  const orders: Array<[string, () => Array<[number, number, number]>]> = [
    ['row-major', () => { const o: Array<[number,number,number]> = []; for (let y=0;y<height;y++) for (let x=0;x<width;x++) for (let c=0;c<4;c++) o.push([x,y,c]); return o; }],
    ['col-major', () => { const o: Array<[number,number,number]> = []; for (let x=0;x<width;x++) for (let y=0;y<height;y++) for (let c=0;c<4;c++) o.push([x,y,c]); return o; }],
  ];
  const channelSets: Array<[string, number[]]> = [
    ['rgb', [0,1,2]], ['rgba', [0,1,2,3]], ['r', [0]], ['g', [1]], ['b', [2]], ['a', [3]],
  ];
  const found: string[] = [];
  for (const [oname, gen] of orders) {
    const coords = gen();
    for (const [cname, chans] of channelSets) {
      for (const planes of [1, 2]) {
        const bits: number[] = [];
        for (const [x, y, c] of coords) {
          if (!chans.includes(c)) continue;
          const v = at(x, y, c);
          for (let p = 0; p < planes; p += 1) bits.push((v >> p) & 1);
        }
        for (const msb of [true, false]) {
          const s = pack(bits, msb);
          const m = RE.exec(s);
          if (m) found.push(`${oname}/${cname}/${planes}bit/${msb?'msb':'lsb'} -> ${m[0]}`);
        }
      }
    }
  }
  console.log('==', f, `${width}x${height}`, found.length ? found.join('\n   ') : 'no stego payload found');
}
