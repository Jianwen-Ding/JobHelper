/**
 * Ad-hoc probe: a send pressed inside an open shadow root.
 *
 *   node tests/probe-shadow-send.mjs
 *
 * Prints what `watchForSending` recorded, and what a document-level listener
 * sees as the target of that click against what `composedPath()[0]` says.
 * Before the fix: `said: []`, `{"target":"DIV","path0":"BUTTON"}`.
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
  root.innerHTML = '<form><input name="n" required><button type="button">Submit Application</button></form>';
</script>`);
await page.evaluate(async (js) => {
  const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
  window.__said = [];
  mod.watchForSending(document, (how) => window.__said.push(how));
}, src);
await page.click('#host button');
await page.waitForTimeout(150);
console.log('said:', JSON.stringify(await page.evaluate(() => window.__said)));
console.log('retargeted target at document:', await page.evaluate(() => new Promise((r) => {
  document.addEventListener('click', (e) => r({ target: e.target.tagName, path0: e.composedPath()[0].tagName }), { once: true, capture: true });
  document.querySelector('#host').shadowRoot.querySelector('button').click();
})).then(JSON.stringify));
await browser.close();
