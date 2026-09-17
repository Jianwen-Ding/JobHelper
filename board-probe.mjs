import { chromium } from 'playwright-core';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { CYGNUS_BOARD, CYGNUS_ROLE_A, findChromium, serveFixtures, pointExtensionAt } from './tests/fixtures.mjs';
const SERVER = 'http://127.0.0.1:4788';
const fixtures = await serveFixtures([CYGNUS_BOARD, CYGNUS_ROLE_A]);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-board-'));
const root = '/home/user/JobHelper';
const ctx = await chromium.launchPersistentContext(dir, {
  executablePath: findChromium(), headless: true,
  args: ['--no-sandbox', `--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
await pointExtensionAt(ctx, worker, SERVER);
const page = await ctx.newPage();
page.on('console', (m) => console.log('  [c]', m.type(), m.text().slice(0, 160)));
await page.goto(fixtures.urlFor(CYGNUS_BOARD), { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(8000);
console.log('host count:', await page.locator('#jobhelper-card-host').count());
await ctx.close(); await fixtures.close(); process.exit(0);
