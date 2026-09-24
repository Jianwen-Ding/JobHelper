/**
 * A chip dragged from the card and let go of over an upload box that lives in
 * an embedded frame — the shape of every careers page that embeds its board.
 *
 *   RMM_SERVER=http://127.0.0.1:4600 node tests/probe-frame-drop.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveFixtures, findChromium, pointExtensionAt, requireOpenSave, cleanStore } from './fixtures.mjs';
import { EMBEDDED_APPLY, FRAME_DOCUMENTS } from './ats-web.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';

await requireOpenSave(SERVER);
await cleanStore(SERVER, [EMBEDDED_APPLY.company]).catch(() => undefined);
const fixtures = await serveFixtures([EMBEDDED_APPLY, ...FRAME_DOCUMENTS]);
const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'jh-fdrop-')), {
  executablePath: findChromium(),
  headless: true,
  viewport: { width: 1400, height: 950 },
  args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
});
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  await pointExtensionAt(context, worker, SERVER);
  const page = await context.newPage();
  await page.goto(fixtures.urlFor(EMBEDDED_APPLY), { waitUntil: 'domcontentloaded' });
  const card = page.locator(`${HOST} .card`);
  await card.locator('.role').waitFor({ timeout: 25_000 });
  await card.getByRole('button', { name: 'Build resume' }).click({ timeout: 60_000 });
  await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
  const chip = card.locator('.staged .file.liftable').filter({ hasText: /-Resume/ }).first();
  await chip.waitFor({ timeout: 30_000 });
  await chip.hover();
  await page.waitForTimeout(1500);
  const from = await chip.boundingBox();
  const frameEl = await page.locator('iframe').elementHandle();
  const frame = await frameEl.contentFrame();
  const box = await frame.locator('label[for=rs]').boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(
      from.x + ((box.x + 10 - from.x) * i) / 12,
      from.y + ((box.y + box.height / 2 - from.y) * i) / 12,
    );
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(2500);
  const held = await frame.evaluate(() => [...document.getElementById('rs').files].map((f) => f.name));
  const said = await card.innerText();
  console.log(JSON.stringify({ held, said: said.split('\n').filter((l) => /drop|attach|placed|Put|went/i.test(l)).slice(0, 6) }, null, 1));
} finally {
  await context.close();
  await cleanStore(SERVER, [EMBEDDED_APPLY.company]).catch(() => undefined);
  fixtures.close?.();
}
