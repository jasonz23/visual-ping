import { chromium } from 'playwright';
import { URL_ATTRIBUTE_TABLE, collectFromDom } from '../src/harvest/discovery/dom.js';

async function main(): Promise<void> {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({
    httpCredentials: { username: 'jason.zhao', password: 'e732dc68a4d7dd38066d' },
  });
  await ctx.addInitScript({
    content: 'globalThis.__name = globalThis.__name || function (fn) { return fn; };',
  });
  const page = await ctx.newPage();
  await page.goto('http://54.214.7.161/');
  try {
    const snap = await page.evaluate(collectFromDom, URL_ATTRIBUTE_TABLE);
    console.log('candidates', snap.candidates.length, 'clickables', snap.clickables.length);
    console.log(JSON.stringify(snap.candidates.slice(0, 6), null, 1));
    console.log('clickables:', JSON.stringify(snap.clickables.slice(0, 10)));
  } catch (e) {
    console.error('EVAL FAILED:', e instanceof Error ? e.message : String(e));
  }
  await browser.close();
}
void main();
