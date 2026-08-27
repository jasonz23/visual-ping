import exifr from 'exifr';
import { buildJpeg, FAKE } from '../tests/fixtures/build.js';
import { decodeMetadataValue } from '../src/extract/handlers/image.js';

async function main(): Promise<void> {
  const jpeg = buildJpeg('cover photo', FAKE.exif);
  console.log('bytes', jpeg.length);
  const parsed = await exifr.parse(jpeg, true).catch((e: unknown) => ({ err: String(e) }));
  console.log('parsed:', JSON.stringify(parsed)?.slice(0, 600));
  const p2 = await exifr.parse(jpeg, { tiff: true, exif: true, iptc: true, xmp: true, icc: true }).catch((e: unknown) => ({ err: String(e) }));
  console.log('parsed2:', JSON.stringify(p2)?.slice(0, 600));
  if (p2 && typeof p2 === 'object') {
    for (const [k, v] of Object.entries(p2)) console.log(k, decodeMetadataValue(v));
  }
}
void main();
