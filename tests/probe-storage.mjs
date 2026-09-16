/**
 * PROBE (not part of the suite): what the trail costs while a card is open.
 *
 *   node tests/probe-storage.mjs
 *
 * `keepWorkSafe` in content.js sends `saveWork` every 2s for as long as the
 * card holds anything, and `saveWork` rewrites the *whole* trail record —
 * every page's markup included. Counted here from the worker's own
 * storage.session.onChanged.
 *
 * Also: is `trail:<tabId>` cleaned up when the tab closes?
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STREAMLY, findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';
const say = (k, v) => console.log(`  ${k}: ${v}`);

async function main() {
  const fixtures = await serveFixtures([STREAMLY]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe4-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const setup = await context.newPage();
    await setup.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
    await setup.evaluate((s) => chrome.storage.sync.set({ serverUrl: s }), SERVER);
    await setup.close();

    const page = await context.newPage();
    await page.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });
    await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
    await page.locator(`${HOST} .card`).getByRole('button', { name: 'Build resume' }).click();
    await page.locator(`${HOST} .card .fit.ok, ${HOST} .card .fit.bad`).waitFor({ timeout: 120_000 });
    await page.waitForTimeout(3000);

    const snapshot = await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.entries(all).map(([k, v]) => ({
        key: k,
        bytes: JSON.stringify(v).length,
        pages: v?.pages?.length,
        htmlBytes: (v?.pages ?? []).reduce((n, p) => n + (p.html ?? '').length, 0),
        workBytes: JSON.stringify(v?.work ?? null).length,
      }));
    });
    say('session storage now', JSON.stringify(snapshot));

    // Count rewrites over 10 seconds.
    await worker.evaluate(() => {
      globalThis.__probe = { writes: 0, bytes: 0 };
      chrome.storage.session.onChanged.addListener((changes) => {
        for (const [, c] of Object.entries(changes)) {
          globalThis.__probe.writes += 1;
          globalThis.__probe.bytes += JSON.stringify(c.newValue ?? null).length;
        }
      });
    });
    await page.waitForTimeout(10_000);
    const counted = await worker.evaluate(() => globalThis.__probe);
    say('session writes in 10s (one idle tab, nobody typing)', JSON.stringify(counted));

    // Does the record go when the tab does?
    await page.close();
    await new Promise((r) => setTimeout(r, 2500));
    const after = await worker.evaluate(() => chrome.storage.session.get(null).then((a) => Object.keys(a)));
    say('session keys after the tab closed', JSON.stringify(after));
  } finally {
    await context.close();
    fixtures.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
