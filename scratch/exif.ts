import { readFileSync, readdirSync } from 'node:fs';
import exifr from 'exifr';

async function main(): Promise<void> {
  for (const f of readdirSync('scratch/img')) {
    const buf = readFileSync(`scratch/img/${f}`);
    const parsed: unknown = await exifr.parse(buf, true).catch((e: unknown) => ({ err: String(e) }));
    console.log('====', f);
    console.log(JSON.stringify(parsed, null, 1)?.slice(0, 1500));
  }
}
void main();
