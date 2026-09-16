import { chromium } from 'playwright-core';
import { findChromium } from './tests/fixtures.mjs';
const b = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 900, height: 950 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto('http://127.0.0.1:4600', { waitUntil: 'networkidle' });
await p.waitForTimeout(4000);
// Turn off a couple of bullets and an entry
const boxes = await p.$$('#editor .bullet input[type=checkbox]');
if (boxes[1]) await boxes[1].click();
if (boxes[2]) await boxes[2].click();
const entryBoxes = await p.$$('#editor .entry-head input[type=checkbox]');
if (entryBoxes[1]) await entryBoxes[1].click();
await p.waitForTimeout(500);
await p.screenshot({ path: '/tmp/collapse-test.png' });
await ctx.close(); await b.close();
console.log('done');
