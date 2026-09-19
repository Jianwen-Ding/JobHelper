/** PROBE: does the card tailor anything on arrival? */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HELIOS_ROLE, findChromium, pointExtensionAt, serveFixtures } from './fixtures.mjs';

const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4601';
async function main() {
  const fixtures = await serveFixtures();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-optin-'));
  const context = await chromium.launchPersistentContext(dir, {
    executablePath: findChromium(), headless: true, viewport: { width: 1280, height: 950 },
    args: ['--no-sandbox', `--disable-extensions-except=${process.cwd()}`, `--load-extension=${process.cwd()}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);
    const page = await context.newPage();
    await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    const card = page.locator('#jobhelper-card-host .card');
    await page.locator('#jobhelper-card-host .card:not(.loading)').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(3500);
    console.log('changes on arrival:', await card.locator('.change').count());
    console.log('no-change panel:', await card.locator('.no-change').count(), (await card.locator('.no-change').innerText().catch(() => '')).slice(0, 80));
    console.log('letter box present:', await card.locator('textarea.tall').count());
    console.log('draft-letter button:', await card.getByRole('button', { name: /Draft a letter/ }).count());
    console.log('mode on:', await card.locator('button.mode.on').innerText().catch(() => '(none)'));
  } finally { await context.close(); process.exit(0); }
}
main();
