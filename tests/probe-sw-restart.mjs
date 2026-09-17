/**
 * PROBE (not part of the suite): what happens to `framesByTab` when the MV3
 * worker is stopped and respawned while the page stays put.
 *
 *   node tests/probe-sw-restart.mjs
 *
 * Chrome will not be persuaded to idle-stop the worker while a debugger is
 * attached, so the stop is forced through CDP — the same thing Chrome does on
 * its own after ~30s of no events.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAMED_FORM, FRAMED_ROLE, findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const say = (k, v) => console.log(`  ${k}: ${v}`);

async function main() {
  const fixtures = await serveFixtures([FRAMED_ROLE, FRAMED_FORM]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe5-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extId = new URL(worker.url()).host;
    const popupUrl = `chrome-extension://${extId}/src/popup/popup.html`;

    const setup = await context.newPage();
    await setup.goto(popupUrl);
    await setup.evaluate((s) => chrome.storage.sync.set({ autoPrompt: false, serverUrl: s }), SERVER);
    await setup.close();

    const page = await context.newPage();
    await page.goto(fixtures.urlFor(FRAMED_ROLE), { waitUntil: 'load' });
    await page.waitForTimeout(4000);

    const before = await worker.evaluate(() => 'alive');
    say('worker before', before);

    // Stop it the way Chrome's own idle timer does.
    const cdp = await context.newCDPSession(page);
    await cdp.send('ServiceWorker.enable').catch((e) => say('ServiceWorker.enable', e.message));
    const scope = `chrome-extension://${extId}/`;
    await cdp.send('ServiceWorker.stopAllWorkers').catch((e) => say('stopAllWorkers', e.message));
    void scope;
    await page.waitForTimeout(3000);
    say('workers listed after stop', context.serviceWorkers().length);

    // Wake it and autofill, without reloading the page.
    const driver = await context.newPage();
    await driver.goto(popupUrl);
    const report = await driver.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((t) => t.url === url);
      return chrome.tabs.sendMessage(tab.id, { type: 'autofill' });
    }, fixtures.urlFor(FRAMED_ROLE));
    say('autofill report', JSON.stringify(report).slice(0, 300));

    const frame = page.frames().find((f) => f.url().endsWith('/form'));
    const typed = await frame?.evaluate(() => document.getElementById('fn').value);
    say('what landed in the application frame', JSON.stringify(typed));
    say('VERDICT', typed ? 'frame filled' : 'FRAME NOT FILLED — framesByTab was lost with the worker');
  } finally {
    await context.close();
    fixtures.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
