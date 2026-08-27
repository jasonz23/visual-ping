import { readFileSync, readdirSync } from 'node:fs';
import exifr from 'exifr';

async function main(): Promise<void> {
  for (const f of readdirSync('scratch/img')) {
    const buf = readFileSync(`scratch/img/${f}`);
    const parsed = (await exifr.parse(buf, true).catch(() => null)) as Record<string, unknown> | null;
    if (!parsed) continue;
    console.log('====', f);
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v === 'object') {
        const bytes = Buffer.from(Object.values(v as Record<string, number>));
        console.log(' ', k, '=> latin1:', JSON.stringify(bytes.toString('latin1')));
        console.log(' ', k, '=> utf16le:', JSON.stringify(bytes.subarray(8).toString('utf16le')));
      } else if (typeof v === 'string' && v.length < 200) {
        console.log(' ', k, '=', v);
      }
    }
  }
}
void main();
