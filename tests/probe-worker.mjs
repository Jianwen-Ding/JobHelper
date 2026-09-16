/**
 * PROBE (not part of the suite): the service-worker layer.
 *
 *   node tests/probe-worker.mjs
 *
 * 1. `framesByTab` is in-memory. Let the MV3 worker idle out while a page with
 *    an application in an iframe sits there, then autofill: does the frame get
 *    filled?
 * 2. What the popup says when ResumeM-M is not running.
 * 3. What the popup/card do when ResumeM-M answers slowly, or with rubbish.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMED_FORM, FRAMED_ROLE, findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';

const group = (n) => console.log(`\n${n}`);
const say = (k, v) => console.log(`  ${k}: ${v}`);

/** A "server" that never answers, and one that answers with rubbish. */
function serveAwkward() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url.startsWith('/health')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, ai: { enabled: false, configured: true, command: 'claude' } }));
        return;
      }
      if (req.url.startsWith('/api/resumes')) {
        // Malformed JSON with a 200.
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('<html>proxy error</html>');
        return;
      }
      // Everything else: never answer at all.
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    );
  });
}

async function main() {
  const fixtures = await serveFixtures([FRAMED_ROLE, FRAMED_FORM]);
  const awkward = await serveAwkward();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe2-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extId = new URL(worker.url()).host;
    const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;

    /* ---------- 1. the worker forgets which frames exist ---------- */
    group('1. autofill after the worker has idled out');
    {
      // No card, so nothing keeps the worker awake: the popup is the only way in.
      const setup = await context.newPage();
      await setup.goto(popupUrl);
      await setup.evaluate((s) => chrome.storage.sync.set({ autoPrompt: false, serverUrl: s }), SERVER);
      await setup.close();

      const page = await context.newPage();
      await page.goto(fixtures.urlFor(FRAMED_ROLE), { waitUntil: 'load' });
      await page.waitForTimeout(4000);
      say('service workers alive after load', context.serviceWorkers().length);

      // Idle. Chrome stops an MV3 worker after ~30s with no events.
      await page.waitForTimeout(75_000);
      say('service workers alive after 75s of silence', context.serviceWorkers().length);

      const driver = await context.newPage();
      await driver.goto(popupUrl);
      const report = await driver.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === url);
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'autofill' });
        return res;
      }, fixtures.urlFor(FRAMED_ROLE));
      say('autofill report', JSON.stringify(report).slice(0, 300));

      const frame = page.frames().find((f) => f.url().endsWith('/form'));
      const typed = await frame?.evaluate(() => ({
        first: document.getElementById('fn').value,
        phone: document.getElementById('ph').value,
      }));
      say('what landed in the application frame', JSON.stringify(typed));
      say(
        'VERDICT',
        typed?.first ? 'frame was filled (no bug here)' : 'FRAME NOT FILLED — worker lost framesByTab',
      );

      // Control: ask again straight away, now that the worker is awake and the
      // frames have re-announced? They have not: nothing reloads them.
      const again = await driver.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === url);
        return chrome.tabs.sendMessage(tab.id, { type: 'autofill' });
      }, fixtures.urlFor(FRAMED_ROLE));
      say('a second attempt, worker now awake', JSON.stringify(again).slice(0, 200));
      const typed2 = await frame?.evaluate(() => document.getElementById('fn').value);
      say('frame after the second attempt', JSON.stringify(typed2));

      // And after a reload, which does re-announce.
      await page.reload({ waitUntil: 'load' });
      await page.waitForTimeout(3000);
      const third = await driver.evaluate(async (url) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((t) => t.url === url);
        return chrome.tabs.sendMessage(tab.id, { type: 'autofill' });
      }, fixtures.urlFor(FRAMED_ROLE));
      const frame3 = page.frames().find((f) => f.url().endsWith('/form'));
      say('after a reload', JSON.stringify(await frame3?.evaluate(() => document.getElementById('fn').value)));
      void third;
      await driver.close();
      await page.close();
    }

    /* ---------- 2. the popup with no server ---------- */
    group('2. the popup when ResumeM-M is not running');
    {
      const p = await context.newPage();
      await p.goto(popupUrl);
      await p.evaluate(() => chrome.storage.sync.set({ serverUrl: 'http://127.0.0.1:4599' }));
      await p.reload();
      await p.waitForTimeout(3000);
      say('status line', JSON.stringify(await p.locator('#status').textContent()));
      say('ai chip', JSON.stringify(await p.locator('#aiState').textContent()));
      await p.close();
    }

    /* ---------- 3. slow / malformed ---------- */
    group('3. the popup when ResumeM-M answers with rubbish, or not at all');
    {
      const p = await context.newPage();
      await p.goto(popupUrl);
      await p.evaluate((u) => chrome.storage.sync.set({ serverUrl: u }), awkward.base);
      await p.reload();
      await p.waitForTimeout(4000);
      say('status after a 200 that is not JSON', JSON.stringify(await p.locator('#status').textContent()));

      // /api/autofill never answers. Nothing times out, so this hangs forever.
      const started = Date.now();
      const hung = await p.evaluate(
        () =>
          new Promise((resolve) => {
            const t = setTimeout(() => resolve('still waiting after 20s'), 20_000);
            chrome.runtime.sendMessage({ type: 'autofillData' }, (r) => {
              clearTimeout(t);
              resolve(`answered: ${JSON.stringify(r).slice(0, 120)}`);
            });
          }),
      );
      say(`autofillData against a server that never answers (${Date.now() - started}ms)`, hung);
      await p.close();
    }
  } finally {
    await context.close();
    fixtures.close();
    awkward.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
