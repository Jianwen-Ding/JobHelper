/**
 * Starting a fresh application must not carry anything over from the last one.
 *
 *   node tests/joins.mjs
 *
 * The dangerous case is an expectation left standing. Clicking "Apply" records
 * "the next page belongs to this application", which deliberately overrides
 * every host and path rule — so an expectation that outlives the application
 * that made it can hand a page to the wrong job, and the form comes up holding
 * another company's resume with nothing on screen looking wrong.
 *
 * 1. On Vega's posting, click "Apply for this job" — the click is recorded as
 *    an expectation. The navigation does not happen (the board's own handler
 *    cancels it, or the link opens a new tab; either is ordinary).
 * 2. In the same tab, open a different company's posting. That starts a fresh
 *    application... but keeps Vega's expectation.
 * 3. Now open Vega's form. It is "expected", so it joins Lyra's application —
 *    and arrives holding Lyra's resume.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASHBY_ROLE,
  ATS_FORM,
  LEVER_FORM,
  LEVER_ROLE,
  findChromium,
  serveFixtures,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';
const cardOf = (page) => page.locator(`${HOST} .card`);

const say = (k, v) => console.log(`  ${k}: ${v}`);

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  (ok ? passed++ : failed++);
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 25_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 25_000 });
  await page.waitForTimeout(1800);
}

async function main() {
  const fixtures = await serveFixtures([LEVER_ROLE, LEVER_FORM, ASHBY_ROLE, ATS_FORM]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe3-'));
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

    // 1. Vega's posting, and a click on Apply that does not navigate.
    await page.goto(fixtures.urlFor(LEVER_ROLE), { waitUntil: 'domcontentloaded' });
    await settled(page);
    say('page 1 role', (await cardOf(page).locator('.co').textContent())?.trim());
    await page.evaluate(() => {
      const a = [...document.querySelectorAll('a')].find((x) => /apply/i.test(x.textContent));
      a.addEventListener('click', (e) => e.preventDefault());
      a.click();
    });
    await page.waitForTimeout(1200);
    say('clicked Apply on Vega, navigation cancelled', 'ok');

    // 2. A different company, in the same tab. Fresh application.
    await page.goto(fixtures.urlFor(ASHBY_ROLE), { waitUntil: 'domcontentloaded' });
    await settled(page);
    say('page 2 company', (await cardOf(page).locator('.co').textContent())?.trim());
    say('page 2 trail rows', await cardOf(page).locator('.trail-row').count());

    // Build something, so there is work with a name on it.
    await cardOf(page).getByRole('button', { name: 'Build resume' }).click();
    await cardOf(page).locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
    await page.waitForTimeout(2500);

    // 3. Vega's application form.
    await page.goto(fixtures.urlFor(LEVER_FORM), { waitUntil: 'domcontentloaded' });
    await settled(page);
    const co = (await cardOf(page).locator('.co').textContent())?.trim();
    const rows = await cardOf(page).locator('.trail-row').allTextContents();
    const fit = (await cardOf(page).locator('.fit').textContent())?.trim();
    say('page 3 (Vega form) company shown', co);
    say('page 3 trail', JSON.stringify(rows));
    say('page 3 resume state', fit);
    check(
      "the second job's pages stay out of the first job's application",
      !rows.some((r) => /lyra|ashby/i.test(r)),
      JSON.stringify(rows),
    );
    check('and its resume does not come with them', !/fits|too long/i.test(fit ?? ''), fit);
    check('the form is read as its own company', !/lyra/i.test(co ?? ''), co || '(none)');
    await page.close();
  } finally {
    await context.close();
    fixtures.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
