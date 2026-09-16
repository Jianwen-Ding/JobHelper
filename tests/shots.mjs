/**
 * Screenshot harness for reviewing the UI by eye.
 *
 * Captures every state of the ResumeM-M editor, the extension's corner card,
 * and the popup — including the empty, busy, error, and overflow states that
 * are easy to build and never look at.
 *
 *   node tests/shots.mjs [outDir]
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOG, NORTHWIND, STREAMLY, cleanStore, findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const OUT = process.argv[2] ?? '/tmp/shots';

const shots = [];
async function shot(target, name, opts = {}) {
  await target.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
  shots.push(name);
  console.log(`  ${name}`);
}

const api = (p, init) =>
  fetch(`${SERVER}${p}`, { headers: { 'Content-Type': 'application/json' }, ...init }).then((r) => r.json());

/** A resume with absurd margins, purely to photograph the overflow state. */
async function makeOverflowResume() {
  await api('/api/resumes/shot-overflow', {
    method: 'PUT',
    body: JSON.stringify({
      id: 'shot-overflow',
      label: 'Overflow demo',
      extends: 'newgrad',
      layout: { marginIn: 2.6, autoFit: false, maxPages: 1 },
    }),
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  try {
    if (!(await fetch(`${SERVER}/health`)).ok) throw new Error();
  } catch {
    console.error(`No ResumeM-M server at ${SERVER}.`);
    process.exit(2);
  }

  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-shots-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1440, height: 940 },
    // Chromium's PDF viewer does not paint under HiDPI in headless, which
    // turns every preview pane into a black rectangle. Keep this at 1.
    deviceScaleFactor: 1,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;

    /* ================= ResumeM-M editor ================= */
    console.log('\nResumeM-M editor:');
    await makeOverflowResume();
    const gui = await context.newPage();
    await gui.goto(SERVER, { waitUntil: 'networkidle' });
    await gui.waitForTimeout(4000);
    await shot(gui, 'rmm-01-build');

    // A pending, uncompiled change — the "changed" chip state.
    const firstSelect = gui.locator('#editor select').first();
    await firstSelect.selectOption({ index: 1 });
    await gui.waitForTimeout(600);
    await shot(gui, 'rmm-02-build-changed');

    await gui.locator('#resume-select').selectOption('intern-kafka');
    await gui.waitForTimeout(4000);
    await shot(gui, 'rmm-03-build-variation');

    // Overflow: the state that justifies the whole fit machinery.
    await gui.locator('#resume-select').selectOption('shot-overflow');
    await gui.waitForTimeout(6000);
    await shot(gui, 'rmm-04-build-overflow');
    await gui.locator('#resume-select').selectOption('newgrad');
    await gui.waitForTimeout(3500);

    // Skills live at the bottom of the editor.
    await gui.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await gui.waitForTimeout(500);
    await shot(gui, 'rmm-05-skills');
    await gui.evaluate(() => window.scrollTo(0, 0));

    console.log('  (modals)');
    await gui.locator('#btn-add-entry').click();
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-06-modal-add-entry');
    await gui.locator('#modal-cancel').click();

    await gui.locator('#editor button:has-text("+ phrasing")').first().click();
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-07-modal-add-phrasing');
    await gui.locator('#modal-cancel').click();

    await gui.locator('#editor button:has-text("+ alternate")').first().click();
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-08-modal-add-alternate');
    await gui.locator('#modal-cancel').click();

    await gui.locator('#editor button:has-text("+ Add bullet")').first().click();
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-09-modal-add-bullet');
    await gui.locator('#modal-cancel').click();

    // Delete confirmation.
    await gui.locator('#editor button:has-text("Remove")').first().click();
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-10-modal-confirm-delete');
    await gui.locator('#modal-cancel').click();

    await gui.locator('#btn-feedback').click();
    await gui.waitForTimeout(2500);
    await shot(gui, 'rmm-11-modal-feedback');
    await gui.locator('#modal-ok').click();

    console.log('  (other tabs)');
    await gui.locator('#tabs button[data-tab="master"]').click();
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-12-master-empty');
    await gui.locator('#btn-master').click();
    await gui.waitForTimeout(6000);
    await shot(gui, 'rmm-13-master');

    await gui.locator('#tabs button[data-tab="applications"]').click();
    await gui.waitForTimeout(900);
    await shot(gui, 'rmm-14-applications-empty');

    // Populate the tracker so the table state is photographed too.
    await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ company: 'Streamly', role: 'SWE Intern, Data Platform', status: 'interview', resumeId: 'intern-kafka' }),
    });
    await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ company: 'Northwind', role: 'Frontend Engineer', status: 'applied', resumeId: 'newgrad' }),
    });
    await api('/api/applications', {
      method: 'POST',
      body: JSON.stringify({ company: 'Example Co.', role: 'Backend Intern', status: 'rejected', resumeId: 'intern' }),
    });
    await gui.locator('#tabs button[data-tab="build"]').click();
    await gui.locator('#tabs button[data-tab="applications"]').click();
    await gui.waitForTimeout(900);
    await shot(gui, 'rmm-15-applications');

    await gui.locator('#tabs button[data-tab="letters"]').click();
    await gui.waitForTimeout(900);
    await shot(gui, 'rmm-16-letters');

    await gui.locator('#tabs button[data-tab="voice"]').click();
    await gui.waitForTimeout(500);
    await shot(gui, 'rmm-17-voice');

    // Narrow viewport: the editor is used beside a browser window as often as
    // full screen.
    await gui.setViewportSize({ width: 900, height: 940 });
    await gui.locator('#tabs button[data-tab="build"]').click();
    await gui.waitForTimeout(1200);
    await shot(gui, 'rmm-18-narrow');
    await gui.setViewportSize({ width: 1440, height: 940 });
    await gui.close();

    /* ================= Extension card ================= */
    console.log('\nExtension card:');
    const page = await context.newPage();
    await page.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });
    const host = page.locator('#jobhelper-card-host');
    const card = page.locator('#jobhelper-card-host .card');
    await host.waitFor({ state: 'attached', timeout: 20_000 });
    await page.waitForTimeout(900);
    await shot(card, 'ext-01-proposed');
    await shot(page, 'ext-02-in-page');

    await card.getByRole('button', { name: 'Build resume' }).click();
    await page.waitForTimeout(500);
    await shot(card, 'ext-03-compiling');

    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
    await page.waitForTimeout(400);
    await shot(card, 'ext-04-built');

    await card.getByRole('button', { name: 'Draft a letter' }).click();
    await card.locator('textarea.tall').waitFor({ timeout: 60_000 });
    await page.waitForTimeout(400);
    await shot(card, 'ext-05-letter');

    // Scroll the card to its questions section.
    await card.locator('.q').first().scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await shot(card, 'ext-06-questions');

    await card.getByRole('button', { name: 'Autofill this form' }).click();
    await page.waitForFunction(() => document.querySelector('#em')?.value?.length > 0, { timeout: 15_000 });
    await page.waitForTimeout(500);
    await shot(page, 'ext-07-autofilled');

    await card.getByRole('button', { name: 'Save application folder' }).click();
    await card.locator('.done-box').waitFor({ timeout: 90_000 });
    await page.waitForTimeout(400);
    await shot(card, 'ext-08-done');
    await page.close();

    // A posting the base resume already suits: the "nothing to change" state.
    const page2 = await context.newPage();
    await page2.goto(fixtures.urlFor(NORTHWIND), { waitUntil: 'domcontentloaded' });
    const card2 = page2.locator('#jobhelper-card-host .card');
    await page2.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 20_000 });
    await page2.waitForTimeout(900);
    await shot(card2, 'ext-09-second-posting');
    await page2.close();

    /* ================= Popup ================= */
    console.log('\nPopup:');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 620 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.waitForTimeout(2200);
    await shot(popup, 'ext-10-popup');

    // The state everyone hits first: the server is not running.
    await popup.evaluate(() => chrome.storage.sync.set({ serverUrl: 'http://127.0.0.1:4699' }));
    await popup.reload();
    await popup.waitForTimeout(2500);
    await shot(popup, 'ext-11-popup-disconnected');
    await popup.evaluate(() => chrome.storage.sync.set({ serverUrl: 'http://127.0.0.1:4600' }));
    await popup.close();

    /* ================= Clean up ================= */
    await cleanStore(SERVER, ['Streamly', 'Northwind', 'Example Co.']);
    await fetch(`${SERVER}/api/resumes/shot-overflow`, { method: 'DELETE' });
  } finally {
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${shots.length} screenshots in ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
