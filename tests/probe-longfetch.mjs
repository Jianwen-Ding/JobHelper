/**
 * PROBE (not part of the suite): does the MV3 worker survive a request that
 * outlives its idle timeout?
 *
 *   node tests/probe-longfetch.mjs          # 75s, past the 30s idle timeout
 *   JH_STALL_MS=330000 node tests/…         # 5.5 min, past the old hard cap
 *
 * Chrome stops a service worker after ~30s of inactivity, and a pending
 * `fetch` is famously not on the list of things that count as activity. If
 * that held here, every AI tailoring run — a model reading a posting, minutes
 * of it — would be racing a termination that closes the message channel and
 * loses the reply, which is one of the errors this extension has been seen to
 * report.
 *
 * MEASURED, on the Chromium this repo tests against: it survives. A compile
 * stalled 75s came back at 76s, and one stalled 331s came back at 331s, both
 * with the worker still alive and the preview drawn. A fetch started inside a
 * message handler does hold the worker open. So no keepalive is needed, and
 * "message channel closed" has to be explained by something else — the frame
 * that asked going away mid-request is the remaining candidate, which is
 * ordinary and costs nothing.
 *
 * Kept so that conclusion can be re-measured rather than re-argued.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELIOS_ROLE, findChromium, pointExtensionAt, serveFixtures, serveSlowProxy, useServer } from './fixtures.mjs';

const extensionRoot = '/home/user/JobHelper';
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4601';
const HOST = '#jobhelper-card-host';

async function main() {
  const fixtures = await serveFixtures();
  // Slow the compile well past the 30s idle timeout, but inside the 10-minute
  // deadline the worker gives it.
  const stall = Number(process.env.JH_STALL_MS ?? 75_000);
  const slow = await serveSlowProxy(SERVER, { slowRoute: /render|compile/, ms: stall });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-longfetch-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 950 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);
    await useServer(context, slow.base);

    const page = await context.newPage();
    const logs = [];
    page.on('console', (m) => logs.push(`${m.type()}: ${m.text().slice(0, 160)}`));
    page.on('pageerror', (e) => logs.push(`pageerror: ${String(e).slice(0, 160)}`));
    await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    await page.locator(`${HOST} .card:not(.loading)`).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);

    const card = page.locator(`${HOST} .card`);
    const began = Date.now();
    await card.getByRole('button', { name: 'Build resume' }).click();
    console.log(`pressed Build resume; the store will stall ${Math.round(stall / 1000)}s…`);

    // Either the preview lands, or an error appears, or nothing ever happens.
    const outcome = await Promise.race([
      card.locator('.fit.ok, .fit.bad').waitFor({ timeout: stall + 90_000 }).then(() => 'compiled'),
      card.locator('.err').waitFor({ timeout: stall + 90_000 }).then(() => 'error'),
    ]).catch(() => 'nothing');

    const took = Math.round((Date.now() - began) / 1000);
    console.log(`outcome after ${took}s: ${outcome}`);
    console.log('card says:', (await card.innerText()).replace(/\s+/g, ' ').slice(0, 220));
    console.log('workers alive now:', context.serviceWorkers().length);
    console.log('page console:');
    for (const l of logs.slice(-15)) console.log('   ', l);
    await page.close();
  } finally {
    await useServer(context, SERVER).catch(() => undefined);
    slow.close();
    await context.close();
    fixtures.close?.();
    process.exit(0);
  }
}
main();
