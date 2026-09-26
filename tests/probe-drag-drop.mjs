/**
 * Ad-hoc probe: does a script-made File survive a real drag to a real drop
 * zone in Chromium?
 *
 *   node tests/probe-drag-drop.mjs
 *
 * No extension involved. A draggable chip whose `dragstart` adds a `File` to
 * `event.dataTransfer`, a drop zone that reads it back the two ways a real
 * form reads it — `dataTransfer.files` and `dataTransfer.items` — and a real
 * mouse drag between them.
 */
import { chromium } from 'playwright-core';
import { findChromium } from './fixtures.mjs';

const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setContent(`<!doctype html><title>drag</title>
<style>#chip,#zone{width:200px;height:80px;border:1px solid #000;margin:20px}</style>
<div id="chip" draggable="true">chip</div>
<div id="zone">zone</div>
<pre id="out"></pre>
<script>
  const bytes = new Uint8Array([0x25,0x50,0x44,0x46,0x2d,0x31,0x2e,0x34,10,10,10]);
  document.getElementById('chip').addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'copy';
    e.dataTransfer.items.add(new File([bytes], 'Morgan-Testwell-Resume.pdf', { type: 'application/pdf' }));
    e.dataTransfer.setData('text/plain', 'Morgan-Testwell-Resume.pdf');
  });
  const zone = document.getElementById('zone');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  window.__seen = null;
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    window.__seen = {
      types: [...e.dataTransfer.types],
      files: [...e.dataTransfer.files].map((f) => ({ name: f.name, size: f.size })),
      items: [...e.dataTransfer.items].map((i) => ({ kind: i.kind, type: i.type })),
      fromItems: [...e.dataTransfer.items]
        .filter((i) => i.kind === 'file')
        .map((i) => { const f = i.getAsFile(); return f ? { name: f.name, size: f.size } : null; }),
      text: e.dataTransfer.getData('text/plain'),
    };
  });
</script>`);

const from = await page.locator('#chip').boundingBox();
const to = await page.locator('#zone').boundingBox();
await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
await page.mouse.down();
await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log(JSON.stringify(await page.evaluate(() => window.__seen), null, 2));
await browser.close();
