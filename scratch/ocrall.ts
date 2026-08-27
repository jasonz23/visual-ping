import { readFileSync, readdirSync } from 'node:fs';
import { createWorker } from 'tesseract.js';

async function main(): Promise<void> {
  const worker = await createWorker('eng');
  for (const f of readdirSync('scratch/img')) {
    const { data } = await worker.recognize(readFileSync(`scratch/img/${f}`));
    console.log('==', f, '->', JSON.stringify(data.text.trim().slice(0, 200)));
  }
  await worker.terminate();
}
void main();
