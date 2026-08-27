import { readFileSync, readdirSync } from 'node:fs';
import { PNG } from 'pngjs';

const RE = /VISUALPING\{[0-9a-fA-F]{16}\}/;
for (const f of readdirSync('scratch/img')) {
  if (!f.endsWith('.png')) continue;
  const png = PNG.sync.read(readFileSync(`scratch/img/${f}`));
  const { width, height, data } = png;
  const streams: Record<string, number[]> = { rgb: [], r: [], g: [], b: [], a: [], colRgb: [] };
  for (let i = 0; i < data.length; i += 4) {
    streams.rgb!.push(data[i]!, data[i + 1]!, data[i + 2]!);
    streams.r!.push(data[i]!);
    streams.g!.push(data[i + 1]!);
    streams.b!.push(data[i + 2]!);
    streams.a!.push(data[i + 3]!);
  }
  for (let x = 0; x < width; x += 1)
    for (let y = 0; y < height; y += 1) {
      const o = (y * width + x) * 4;
      streams.colRgb!.push(data[o]!, data[o + 1]!, data[o + 2]!);
    }
  const hits: string[] = [];
  for (const [name, arr] of Object.entries(streams)) {
    const s = Buffer.from(arr).toString('latin1');
    const m = RE.exec(s);
    if (m) hits.push(`${name}: ${m[0]}`);
    const printable = s.replace(/[^ -~]/g, '');
    if (printable.length > 40 && /[A-Za-z]{6}/.test(printable)) {
      hits.push(`${name}: long printable run: ${printable.slice(0, 80)}`);
    }
  }
  console.log('==', f, hits.length ? '\n   ' + hits.join('\n   ') : '-> nothing');
}
