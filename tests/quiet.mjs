/**
 * Pages the extension must not offer on.
 *
 * The local score is deliberately generous, and that is the right trade: the
 * cost of a card on a page that turns out not to be a job is a dismissal, and
 * the cost of silence on one that is, is the whole tool not being there when it
 * was needed. Generous is not indiscriminate, though, and this is the half of
 * the trade that nothing was measuring.
 *
 * Every page here is one you would actually have open. Each is given longer
 * than the extension's own rescore window would need, so "it appeared a moment
 * later" counts as a failure rather than as a pass that got lucky on timing.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { QUIET, findChromium, pointExtensionAt, requireOpenSave, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';

/** Long enough for the analysis, and past the window in which a page is re-judged. */
const WATCH_MS = 6000;

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  await requireOpenSave(SERVER);
  const fixtures = await serveFixtures(QUIET);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-quiet-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    console.log('\nPages that are not job postings');
    for (const fixture of QUIET) {
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto(fixtures.urlFor(fixture), { waitUntil: 'domcontentloaded' });
      // Watched rather than sampled once: a card that appears and then removes
      // itself is still a card that appeared, and that flicker is the thing
      // people actually complained about.
      let everAppeared = false;
      const until = Date.now() + WATCH_MS;
      while (Date.now() < until) {
        if ((await page.locator('#jobhelper-card-host').count()) > 0) {
          everAppeared = true;
          break;
        }
        await page.waitForTimeout(250);
      }

      check(`stays quiet on ${fixture.name}`, !everAppeared);
      check(`and breaks nothing on ${fixture.name}`, errors.length === 0, errors.join('; '));
      await page.close();
    }
  } finally {
    await context.close();
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
