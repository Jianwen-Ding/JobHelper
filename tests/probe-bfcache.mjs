/**
 * Does Back actually restore from the bfcache under our launch flags?
 *
 * Playwright passes `--disable-back-forward-cache` by default, so every
 * `goBack()` in the suite has been a reload — which re-runs the content
 * script, re-reads the page and resets the trail, i.e. the one path where
 * everything is correct. Real Chrome does not do that.
 *
 *   node tests/probe-bfcache.mjs
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAGE = (name) => `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>
<body><h1>${name}</h1><a id="away" href="/b">go to b</a>
<script>
  window.__loads = (window.__loads ?? 0) + 1;
  window.addEventListener('pageshow', (e) => { window.__persisted = e.persisted; });
</script></body></html>`;

const http = await import('node:http');
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE(req.url === '/b' ? 'B' : 'A'));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function measure(label, extra) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-bfcache-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: findChromium(),
    headless: true,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
    ...extra,
  });
  try {
    const page = await context.newPage();
    await page.goto(`${base}/a`, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => { window.__marker = 'set on the first visit'; });
    await page.click('#away');
    await page.waitForLoadState('domcontentloaded');
    // Not waitForLoadState: a bfcache restore fires no load event at all,
    // which is the first thing that gives it away.
    await page.goBack({ waitUntil: 'commit' }).catch(() => undefined);
    await page.waitForTimeout(1200);
    const seen = await page.evaluate(() => ({
      loads: window.__loads,
      persisted: window.__persisted ?? null,
      marker: window.__marker ?? null,
    }));
    console.log(
      `${label.padEnd(34)} loads=${seen.loads}  pageshow.persisted=${String(seen.persisted).padEnd(5)}  ` +
        `javascript state survived: ${seen.marker !== null}`,
    );
  } finally {
    await context.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  await measure('as the suite launches today', {});
  await measure('with the bfcache left enabled', {
    ignoreDefaultArgs: ['--disable-back-forward-cache'],
  });
} finally {
  server.close();
}
