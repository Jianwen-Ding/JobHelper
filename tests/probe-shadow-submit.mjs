/**
 * Ad-hoc probe: a native form submit inside an open shadow root.
 *
 *   node tests/probe-shadow-submit.mjs
 *
 * The companion to probe-shadow-send.mjs, and the reason the fix is on the
 * click rather than on the submit: `submit` is `composed: false`, so it never
 * crosses the boundary and no document listener can be made to see it. The
 * press that causes it does cross, which is what is watched.
 */
import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { findChromium } from './fixtures.mjs';

const src = fs.readFileSync('src/shared/sending.js', 'utf8');
const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(`<!doctype html><title>Apply</title>
<div id="host"></div>
<script>
  const root = document.getElementById('host').attachShadow({ mode: 'open' });
  root.innerHTML = '<form novalidate><input name="n" value="Jane"><button type="submit">Submit Application</button></form>';
  root.querySelector('form').addEventListener('submit', (e) => e.preventDefault());
  window.__sawSubmitAtDoc = false;
  document.addEventListener('submit', () => { window.__sawSubmitAtDoc = true; }, true);
</script>`);
await page.evaluate(async (js) => {
  const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
  window.__said = [];
  mod.watchForSending(document, (how) => window.__said.push(how));
}, src);
await page.click('#host button');
await page.waitForTimeout(150);
console.log('said:', JSON.stringify(await page.evaluate(() => window.__said)));
console.log('submit reached the document:', await page.evaluate(() => window.__sawSubmitAtDoc));
await browser.close();
