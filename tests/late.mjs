/**
 * A tailoring pass that finishes after the card has moved on.
 *
 * "Have AI Tailor" is the one thing here measured in minutes — 178 seconds
 * for one posting, with the model's tool calls scrolling past in the server's
 * terminal. What the person watching the card saw at the end of it was
 * nothing: no line saying it had finished, and the same proposal underneath
 * as before they pressed it. "I don't know what it even did" is the accurate
 * description of that.
 *
 * The cause is a guard that is right about what it refuses and was wrong
 * about what it did next. Every pass carries a number; a reply whose number
 * is stale must not write to the card, because on a single-page board the
 * posting in front of you may be a different job by then. But a stale reply
 * was dropped where it stood, and the thing that makes a number stale is any
 * change to the url — which a board ticks on its own while you wait. Three
 * minutes of work, discarded in silence, on the same posting it was for.
 *
 * So this drives exactly that: press the button, move the url underneath it,
 * and let the slow reply land afterwards.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/late.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELIOS_ROLE, findChromium, pointExtensionAt, requireOpenSave, serveFixtures, serveSlowProxy } from './fixtures.mjs';

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
   * The AI pass, answered by the proxy rather than by a model.
   *
   * Only the call the button starts is stood in for — `tailor: "ai"` is in
   * its body and in no other — so the opening read and the one the rebuilt
   * card makes are the real server's, at the real server's speed. The
   * stand-in is the last real reply with two fields changed, which is what
   * the card reads to decide a model chose something: see `isDecision`.
   *
   * No model is started, and nothing is guessed about the shape of an
   * analysis.
   */
  let stoodIn = 0;
  const slow = await serveSlowProxy(SERVER, {
    slowRoute: /extension\/analyze/,
    ms: 9000,
    respondInstead: (url, body, lastReply) => {
      if (!/extension\/analyze/.test(url) || !lastReply) return null;
      try {
        if (JSON.parse(body).tailor !== 'ai') return null;
      } catch {
        return null;
      }
      stoodIn++;
      return { ...lastReply, tailor: 'ai', aiUsed: true };
    },
  });

  // Both switches, because the AI button is drawn from the pair of them.
  const configWas = await (await fetch(`${SERVER}/api/config`)).json();
  const setServerAi = (enabled) =>
    fetch(`${SERVER}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ai: { ...configWas.ai, enabled } }),
    });
  await setServerAi(true);

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-late-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, slow.base);
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
    await settings.evaluate(() => chrome.storage.sync.set({ useAi: true }));
    await settings.close();

    const page = await context.newPage();
    await page.goto(`${fixtures.base}${HELIOS_ROLE.path}`);
    const card = page.locator(`${HOST} .card`);
    await page.locator(`${HOST} .card .role`).waitFor({ timeout: 40_000 });

    const aiButton = card.locator('button.mode', { hasText: 'Have AI Tailor' });
    const aiOn = card.locator('button.mode.on', { hasText: 'Have AI Tailor' });

    console.log('\nThe url moves while the model is still reading');
    // Waited for rather than slept on: the button appears with the proposal,
    // and how long the opening read takes is the machine's business.
    await aiButton.waitFor({ timeout: 40_000 });
    check('the AI is offered at all', (await aiButton.count()) === 1, 'both switches on');
    check('and nothing claims it has run yet', (await aiOn.count()) === 0);

    await aiButton.click();
    await page.waitForTimeout(1200);

    /*
     * What a single-page board does on its own, done deliberately: the url
     * changes and the posting does not. The content script notices within a
     * second, takes the card down and reads the page again — and the pass
     * the button started is stale from that moment.
     */
    await page.evaluate(() => history.pushState({}, '', `${location.pathname}?src=jh-late`));

    // The rebuilt card, before the slow reply lands.
    await page.locator(`${HOST} .card .role`).waitFor({ timeout: 40_000 });
    await page.waitForTimeout(1500);
    check('the card comes back for the same posting', (await card.locator('.role').count()) === 1);

    /*
     * And now the wait the user actually did. Long enough for the stood-in
     * reply (nine seconds) plus the rebuilt card's own real analysis, which
     * the proxy slows too.
     */
    for (let i = 0; i < 40 && (await aiOn.count()) === 0; i++) await page.waitForTimeout(1000);

    check('the run was answered without starting a model', stoodIn === 1, `stood in for ${stoodIn}`);
    check(
      'the finished tailoring lands on the card that came back',
      (await aiOn.count()) === 1,
      await card.locator('button.mode.on').allTextContents().then((t) => t.join(' | ')),
    );

    const summary = (await card.locator('.hint').allTextContents()).join(' ');
    check(
      'and the card says the changes are the AI’s',
      /changes the AI chose/i.test(summary),
      summary.slice(0, 140) || '(no summary)',
    );

    const said = (await card.locator('.ok-note, .err').allTextContents()).join(' ');
    check(
      'and says out loud that it finished',
      /finished tailoring/i.test(said),
      said.slice(0, 140) || '(nothing said)',
    );
  } finally {
    await context.close();
    fixtures.close();
    slow.close();
    await setServerAi(configWas.ai?.enabled ?? false).catch(() => undefined);
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
