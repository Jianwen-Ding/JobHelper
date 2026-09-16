import { chromium } from 'playwright-core';
import { findChromium } from './tests/fixtures.mjs';
const b = await chromium.launch({ executablePath: findChromium(), headless: true, args: ['--no-sandbox'] });
const ctx = await b.newContext({ viewport: { width: 900, height: 950 }, deviceScaleFactor: 1 });
const p = await ctx.newPage();
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto('http://127.0.0.1:4600', { waitUntil: 'networkidle' });
await p.waitForTimeout(4000);

await p.locator('#editor .bullet input[type=checkbox]').nth(1).click({ force: true });
await p.waitForTimeout(400);
await p.locator('#editor .bullet input[type=checkbox]:visible').nth(1).click({ force: true });
await p.waitForTimeout(400);
await p.locator('#editor .entry-head input[type=checkbox]').nth(1).click({ force: true });
await p.waitForTimeout(500);
await p.screenshot({ path: '/tmp/collapse-test.png' });
await ctx.close(); await b.close();
console.log('done');
