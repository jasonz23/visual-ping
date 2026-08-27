import { readFileSync } from 'node:fs';
import { createWorker } from 'tesseract.js';

async function main(): Promise<void> {
  const worker = await createWorker('eng');
  const { data } = await worker.recognize(readFileSync('scratch/img/whiteboard-scan.png'));
  console.log('TEXT:', JSON.stringify(data.text));
  await worker.terminate();
}
void main();
