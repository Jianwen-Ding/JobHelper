/**
 * The way out of a run that is taking too long.
 *
 * Every long thing this card does used to be one-way. A keyword match is a
 * second and nobody minds; a model reading a posting is minutes, and the only
 * exits were waiting for it and closing the card — which takes the cover
 * letter and the answers with it. So there is a Stop in the progress bar.
 *
 * The question this suite exists to answer is whether it is a stop or a
 * hidden spinner, and that cannot be settled by looking at the card: a button
 * that only clears the bar looks identical from the page. It is settled at
 * the other end of the socket, so everything here runs through a proxy that
 * holds a request open and records whether the browser hung up on it.
 *
 * What it does not claim: the model on ResumeM-M's side is a process the
 * server started, and it runs to the end whatever the extension does. Nothing
 * reachable from here can stop that, and a stop that pretended to would be
 * the more comfortable lie. What is bought is the card back.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/stopping.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HELIOS_ROLE,
  findChromium,
  pointExtensionAt,
  requireOpenSave,
  serveFixtures,
  serveSlowProxy,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }

  const fixtures = await serveFixtures([HELIOS_ROLE]);
  /*
   * Slow only the tailoring call, and only after the first.
   *
   * Landing on a posting analyses it once with `tailor: 'none'` — that is the
   * opening read, and the card cannot be clicked until it lands. `skip: 1`
   * lets that one through at speed and holds the one the button starts, which
   * is the run being stopped.
   *
   * Twelve seconds because a stop has to be a decision, not a race: the test
   * clicks Stop several seconds in, and a proxy that answered first would
   * make the whole thing pass for the wrong reason.
   */
  const slow = await serveSlowProxy(SERVER, { slowRoute: /extension\/analyze/, ms: 12_000, skip: 1 });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-stopping-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, slow.base);

    const page = await context.newPage();
    await page.goto(`${fixtures.base}${HELIOS_ROLE.path}`);
    await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
    await page.waitForTimeout(1500);

    const card = page.locator(`${HOST} .card`);
    const matchButton = card.locator('button.mode', { hasText: 'Match by keyword' });
    const bar = card.locator('.progress');
    const stop = card.locator('.progress-label .stop');

    console.log('\nA keyword match that is taking too long');

    await matchButton.click();
    await bar.waitFor({ timeout: 10_000 });
    check('the run puts a bar up', await bar.count() > 0);
    check('with a way out on it', await stop.count() > 0);

    // Long enough that the proxy has certainly not answered, so what follows
    // is the stop and not the reply arriving first.
    await page.waitForTimeout(3000);
    check('and it is still running when Stop is pressed', await bar.count() > 0);

    await stop.click();
    /*
     * Four seconds, which is well inside the twelve the proxy is holding the
     * request for. A longer budget passes for the wrong reason: the reply
     * turns up on its own and takes the bar down, so a Stop that did nothing
     * at all would look like a Stop that worked.
     */
    await bar.waitFor({ state: 'detached', timeout: 4000 }).catch(() => undefined);
    check('pressing it takes the bar down', await bar.count() === 0);
    check(
      'without reporting a failure',
      await card.locator('.err').count() === 0,
      await card.locator('.err').first().textContent().catch(() => ''),
    );

    /*
     * The part that cannot be read off the card: the browser really let go of
     * the connection. Without it, "Stop" would be a spinner that hides itself
     * while the request runs to completion in the background — which is what
     * every one-line version of this feature actually does.
     */
    check(
      'and the request is genuinely abandoned, not just hidden',
      slow.dropped.some((url) => /extension\/analyze/.test(url)),
      JSON.stringify(slow.dropped),
    );

    console.log('\nAnd the card is usable again straight away');

    /*
     * The point of stopping is getting the card back, so the thing to check
     * is that it works — not that it merely looks idle. "Use it unchanged" is
     * the cheapest proof: it is a real run through the same lane the stopped
     * one held, and it has to be able to start and finish.
     */
    const unchanged = card.locator('button.mode', { hasText: 'Use it unchanged' });
    check('the buttons are live again', await unchanged.isEnabled());
    await unchanged.click();
    await card.locator('button.mode.on', { hasText: 'Use it unchanged' }).waitFor({ timeout: 40_000 });
    check('and a new run goes through', await card.locator('button.mode.on').count() === 1);
  } finally {
    await context.close();
    fixtures.close();
    slow.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
