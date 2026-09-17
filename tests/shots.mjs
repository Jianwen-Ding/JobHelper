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
import {
  BLOG,
  NORTHWIND,
  STREAMLY,
  cleanStore,
  findChromium,
  pointExtensionAt,
  serveFixtures,
} from './fixtures.mjs';

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

/** One file holding two letters and an answer, to photograph the sorting. */
const CORPUS_FILE = [
  'Dear Streamly,',
  '',
  'I am writing about the data platform internship. I have spent two years on pipelines that mostly stayed up, and I would like to keep doing that somewhere it matters.',
  '',
  'Sincerely,',
  'Jianwen Ding',
  '',
  'Dear Northwind,',
  '',
  'Your posting mentions Kafka, which I have run in anger for about eighteen months, including the week it decided to stop working entirely.',
  '',
  'Sincerely,',
  'Jianwen Ding',
  '',
  'Why do you want to work here?',
  '',
  'Because I have read the code you publish, and it is written the way I like to write: plainly, and with the awkward cases handled rather than ignored.',
].join('\n');

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
    /*
     * The extension has its own idea of where the store is, and it is not
     * this harness's `SERVER`. Without this, every card photographed here was
     * talking to whatever happens to be on the default port — which on a
     * developer's machine is their real save, and in a run like this one was
     * a server with no save open, so every card came out as the same error.
     */
    await pointExtensionAt(context, worker, SERVER);

    /* ================= ResumeM-M editor ================= */
    console.log('\nResumeM-M editor:');
    await makeOverflowResume();
    const gui = await context.newPage();
    await gui.goto(SERVER, { waitUntil: 'networkidle' });
    await gui.waitForTimeout(4000);
    await shot(gui, 'rmm-01-build');

    // A line stepped off its pinned default — the "changed" chip state.
    await gui.locator('#editor .stepper button:has-text("›")').first().click();
    await gui.waitForTimeout(900);
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

    /*
     * Everything a bullet can do apart from stepping between its wordings is
     * folded behind its "…", so it has to be opened before any of it can be
     * clicked. Only the stepper is out in the open, deliberately — it is the
     * one thing you do to a line often enough that a menu would be in the way.
     *
     * Open the disclosure that holds the button, not merely the first one on
     * the page: only one can be open at a time, so opening the wrong one is
     * the same as opening none. Some of these buttons are not in a disclosure
     * at all, hence the fallback.
     */
    const clickFolded = async (label) => {
      const owner = gui.locator(`#editor .bullet-disclosure:has(button:has-text("${label}"))`).first();
      if (await owner.count()) {
        const more = owner.locator('.bullet-more').first();
        if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
        await gui.waitForTimeout(250);
        await owner.locator(`button:has-text("${label}")`).first().click();
      } else {
        await gui.locator(`#editor button:has-text("${label}")`).first().click();
      }
      await gui.waitForTimeout(400);
    };

    await clickFolded('+ phrasing');
    await shot(gui, 'rmm-07-modal-add-phrasing');
    await gui.locator('#modal-cancel').click();

    await clickFolded('+ alternate');
    await shot(gui, 'rmm-08-modal-add-alternate');
    await gui.locator('#modal-cancel').click();

    await clickFolded('+ Add bullet');
    await shot(gui, 'rmm-09-modal-add-bullet');
    await gui.locator('#modal-cancel').click();

    // Delete confirmation.
    await clickFolded('Remove');
    await shot(gui, 'rmm-10-modal-confirm-delete');
    await gui.locator('#modal-cancel').click();

    // Feedback runs in the background now, so there is no modal to wait on —
    // there is a chip that turns up when it has something to say.
    await gui.locator('#btn-feedback').click();
    await gui.waitForTimeout(1200);
    await shot(gui, 'rmm-11-feedback-working');
    await gui.locator('#jobs-chip:not(.hidden)').waitFor({ timeout: 60_000 }).catch(() => {});
    await gui.waitForTimeout(2500);
    await shot(gui, 'rmm-11b-feedback-ready');
    await gui.locator('#jobs-chip').click();
    await gui.waitForTimeout(1200);
    await shot(gui, 'rmm-11c-feedback-open');
    await gui.locator('#modal-ok').click().catch(() => {});
    await gui.waitForTimeout(300);

    console.log('  (other tabs)');
    /*
     * Everything-you-have is a choice in the resume picker now, not a tab of
     * its own — it is a way of looking at the same editor, so it belongs
     * beside the resumes rather than beside the Workspace. This still asked
     * for the tab, and had done since the move.
     */
    await gui.locator('#resume-select').selectOption('__master__');
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
    await gui.locator('#tabs button[data-tab="resumes"]').click();
    await gui.locator('#tabs button[data-tab="applications"]').click();
    await gui.waitForTimeout(900);
    await shot(gui, 'rmm-15-applications');

    await gui.locator('#tabs button[data-tab="letters"]').click();
    await gui.waitForTimeout(900);
    await shot(gui, 'rmm-16-letters');

    await gui.locator('#tabs button[data-tab="voice"]').click();
    await gui.waitForTimeout(500);
    await shot(gui, 'rmm-17-voice');

    // The notes box holding something the store does not. It is the one field
    // here with no autosave, so it is the one that has to say so. Behind a
    // disclosure, because notes are secondary to the samples above them.
    await gui.locator('#voice-extras summary').click();
    await gui.waitForTimeout(250);
    await gui.locator('#voice').fill('Never say "synergy".');
    await gui.locator('#voice').dispatchEvent('input');
    await gui.waitForTimeout(200);
    await shot(gui, 'rmm-17b-voice-unsaved');
    await gui.locator('#btn-save-voice').click();
    await gui.waitForTimeout(500);

    // Adding files to the corpus: the drop zone, and the proposals it makes
    // before anything is saved.
    await gui.locator('#voice-files').setInputFiles({
      name: 'old applications.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from(CORPUS_FILE),
    });
    await gui.locator('.proposals').waitFor({ timeout: 30_000 });
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-18-voice-proposals');
    await gui.locator('.proposal').nth(1).locator('input[type=checkbox]').click();
    await gui.waitForTimeout(300);
    await shot(gui, 'rmm-19-voice-proposal-dropped');
    await gui.locator('#modal-cancel').click();

    // The workspace: empty, and holding a draft.
    await gui.locator('#tabs button[data-tab="workspace"]').click();
    await gui.waitForTimeout(700);
    await shot(gui, 'rmm-20-workspace-empty');

    await api('/api/workspace', {
      method: 'POST',
      body: JSON.stringify({
        company: 'Streamly',
        role: 'SWE Intern, Data Platform',
        url: 'https://example.com/streamly',
        resumeId: 'intern-kafka',
        coverLetterRequired: true,
        questions: [{ question: 'Why do you want to work here?', required: true }],
      }),
    });
    await gui.locator('#tabs button[data-tab="resumes"]').click();
    await gui.locator('#tabs button[data-tab="workspace"]').click();
    await gui.waitForTimeout(1500);
    await shot(gui, 'rmm-21-workspace-draft');

    // History: the timeline, and one version opened against the last.
    await gui.locator('#tabs button[data-tab="history"]').click();
    await gui.waitForTimeout(250);
    await shot(gui, 'rmm-22-history-loading');
    await gui.locator('#resume-timeline .version-card, #resume-timeline .empty').first().waitFor({ timeout: 60_000 });
    await gui.waitForTimeout(400);
    await shot(gui, 'rmm-22b-history');

    // The raw git log behind it, and one commit opened.
    const raw = gui.locator('#btn-raw-history, a:has-text("Show raw git log")');
    if (await raw.count()) {
      await raw.first().click();
      await gui.waitForTimeout(1200);
      await shot(gui, 'rmm-23-history-raw');
      const commit = gui.locator('#commits .commit').first();
      if (await commit.count()) {
        await commit.click();
        await gui.waitForTimeout(1500);
        await shot(gui, 'rmm-23b-history-commit');
      }
    }

    // Pinning: a base in the picker, and a wording marked as the default.
    await gui.locator('#tabs button[data-tab="resumes"]').click();
    await gui.waitForTimeout(1200);
    // Back to a real resume first. The picker was left on everything-you-have
    // further up, and pinning a base is meaningless there — the button is
    // correctly hidden, so this waited thirty seconds for it.
    await gui.locator('#resume-select').selectOption('newgrad');
    await gui.waitForTimeout(3500);
    await gui.locator('#btn-base').click();
    await gui.waitForTimeout(1200);
    await shot(gui, 'rmm-24-pinned-base');
    await gui.locator('#btn-base').click();
    await gui.waitForTimeout(900);

    /*
     * The screens that tell you something you will act on.
     *
     * These were never photographed, and that family is where the worst bug
     * so far lived: a panel announcing "everything you are sending, in one
     * place" while leaving out the cover letter the form asked for. Anything
     * that makes a claim about your application is worth looking at.
     */
    console.log('  (the screens that make claims)');

    // Save & Files: a whole tab that had never been captured.
    await gui.locator('#tabs button[data-tab="save"]').click();
    await gui.waitForTimeout(1500);
    await shot(gui, 'rmm-26-save-and-files');

    // What was actually sent for one application, which is the record you
    // would check before a phone screen.
    await gui.locator('#tabs button[data-tab="applications"]').click();
    await gui.waitForTimeout(1200);
    const firstApp = gui.locator('#apps-wrap tbody tr').first();
    if (await firstApp.count()) {
      await firstApp.click();
      await gui.waitForTimeout(1500);
      await shot(gui, 'rmm-27-application-detail');
    }

    // A stored letter, and a stored answer, as they are kept for reuse.
    await gui.locator('#tabs button[data-tab="letters"]').click();
    await gui.waitForTimeout(1200);
    const firstLetter = gui.locator('#letters .card-row, #letters .letter-row, #letters li').first();
    if (await firstLetter.count()) {
      await firstLetter.click();
      await gui.waitForTimeout(900);
      await shot(gui, 'rmm-28-letter-open');
    }

    // Saving a variation: the modal that decides what a new resume is called.
    await gui.locator('#tabs button[data-tab="resumes"]').click();
    await gui.waitForTimeout(1200);
    await gui.locator('#btn-save-as').click();
    await gui.waitForTimeout(600);
    await shot(gui, 'rmm-29-modal-save-as');
    await gui.locator('#modal-cancel').click();

    /*
     * A resume that cannot compile.
     *
     * Not by writing a broken one — a made-up field in a resume's layout
     * compiles perfectly happily, which is its own small reassurance. The way
     * it actually happens is an engine named in the settings that is not
     * installed, and that is driven in `tests/fit.test.ts`, which can assert
     * the sentence rather than photograph it.
     */

    // Narrow viewport: the editor is used beside a browser window as often as
    // full screen.
    await gui.setViewportSize({ width: 900, height: 940 });
    await gui.locator('#tabs button[data-tab="resumes"]').click();
    await gui.waitForTimeout(1200);
    await shot(gui, 'rmm-25-narrow');
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

    // The letter drafts itself once the posting asks for one, so there is
    // nothing to click — only something to wait for.
    const draftButton = card.getByRole('button', { name: 'Draft a letter' });
    if (await draftButton.count()) await draftButton.click();
    await card.locator('textarea.tall').waitFor({ timeout: 90_000 });
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

    // Coming back from the builder: the proposal on screen was matched before
    // whatever you just went and added existed, and the card says so.
    const openedEditor = context.waitForEvent('page');
    await card2.getByRole('button', { name: 'Edit in ResumeM-M' }).click();
    const sentTo = await openedEditor;
    await page2.bringToFront();
    await page2
      .waitForFunction(
        () => /been editing the store/i.test(document.querySelector('#jobhelper-card-host')?.shadowRoot?.textContent ?? ''),
        undefined,
        { timeout: 10_000, polling: 100 },
      )
      .catch(() => undefined);
    await page2.waitForTimeout(300);
    await shot(card2, 'ext-09b-came-back-from-builder');
    await sentTo.close();
    await page2.close();

    /* ================= Popup ================= */
    console.log('\nPopup:');
    const popup = await context.newPage();
    await popup.setViewportSize({ width: 360, height: 620 });
    await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
    await popup.waitForTimeout(2200);
    await shot(popup, 'ext-10-popup');

    /*
     * The same window while an application is open, which is the state
     * people arrive in: they clicked the number on the toolbar to find out
     * what it means, and this is the answer.
     */
    const applying = await context.newPage();
    await applying.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });
    await applying.locator('#jobhelper-card-host .card .role').waitFor({ timeout: 20_000 });
    await applying.waitForTimeout(1200);
    // Wander off, so the card is gone and the window is the only thing left
    // saying the application is still in hand.
    await applying.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
    await applying.waitForTimeout(1500);
    // A real popup is not a tab and reports on the page beneath it; opened as
    // one it would report on itself, so put the page in front and boot again.
    await applying.bringToFront();
    await popup.evaluate(() => location.reload());
    await popup.waitForTimeout(2200);
    await shot(popup, 'ext-10b-popup-application-open');
    await applying.close();

    // The state everyone hits first: the server is not running.
    await popup.evaluate(() => chrome.storage.sync.set({ serverUrl: 'http://127.0.0.1:4699' }));
    await popup.reload();
    await popup.waitForTimeout(2500);
    await shot(popup, 'ext-11-popup-disconnected');
    await popup.evaluate((url) => chrome.storage.sync.set({ serverUrl: url }), SERVER);
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
