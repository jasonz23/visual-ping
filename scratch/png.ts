import { readFileSync, readdirSync } from 'node:fs';
import { readPngTextChunks, findTrailingBytes, readJpegComments } from '../src/extract/handlers/image.js';

for (const f of readdirSync('scratch/img')) {
  const buf = readFileSync(`scratch/img/${f}`);
  const chunks = readPngTextChunks(buf);
  const trailer = findTrailingBytes(buf);
  const comments = readJpegComments(buf);
  if (buf.subarray(1, 4).toString() === 'PNG') {
    console.log(`== ${f}  ${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);
  } else {
    console.log(`== ${f}`);
  }
  for (const c of chunks) console.log('   chunk', c.type, JSON.stringify(c.keyword), '=>', JSON.stringify(c.value.slice(0, 200)));
  if (trailer) console.log('   trailer after', trailer.marker, trailer.bytes, 'bytes:', JSON.stringify(trailer.data.subarray(0, 200).toString('utf8')));
  for (const c of comments) { const s = c.slice(0,120); if (/[ -~]{6}/.test(s)) console.log('   jpegseg:', JSON.stringify(s)); }
}
