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
  requireOpenSave,
  pointExtensionAt,
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

/**
 * Wait for the card to stop changing, rather than for a number of milliseconds.
 *
 * The card fills in as the page is read: the role first, then the company once
 * it is worked out, then the buttons. A fixed sleep is a bet on how long that
 * takes, and on a loaded machine it loses — the card still said "127.0.0.1"
 * where the company goes when the test looked, and the failure read exactly
 * like the extension getting the company wrong rather than like the test
 * looking too early.
 *
 * Two identical reads half a second apart is the same claim the sleep was
 * making, checked instead of assumed. It is also quicker when nothing is
 * loaded, which is most of the time.
 */
async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 25_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 25_000 });

  /*
   * And past the provisional card, which carries the role and none of the
   * buttons. Without this the loop below could find a card that had stopped
   * changing only because the analysis had not come back yet — and the test
   * then spent its click timeout waiting for a button that was never going
   * to be there in time. It is the same bet on how long the machine takes,
   * made one step earlier.
   *
   * Tolerant on purpose: a page whose analysis never lands is a case several
   * of these suites are about, and they still have their own assertions to
   * make about it.
   */
  await page
    .locator(`${HOST} .card:not(.loading)`)
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined);
  const read = () => page.locator(`${HOST} .card`).innerText().catch(() => '');
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const now = await read();
    if (now && now === last) return;
    last = now;
  }
}

async function main() {
  await requireOpenSave(SERVER);
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
    await pointExtensionAt(context, worker, SERVER);

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

    /*
     * And the other way a page gets lost: leaving before it counts.
     *
     * Reading a posting used to end with a second pass over the page and
     * every frame in it, taken after the card was already up — and until
     * that finished, the page belonged to no application. Pressing Apply
     * inside that window, which is what people do on a description page,
     * started a fresh application on the form and threw away the description
     * that had just been read: the role reverted to whatever the form says
     * about itself, and the tracker got two rows for one job.
     *
     * So this one does not wait for anything it does not have to. The card
     * showing the role is the moment a person would reach for Apply.
     */
    {
      // Vega's posting and Vega's own form: the pair that should join. Two
      // companies never join, however fast you walk between them.
      const quick = await context.newPage();
      await quick.goto(fixtures.urlFor(LEVER_ROLE), { waitUntil: 'domcontentloaded' });
      /*
       * The moment the card stops guessing, and not a step later. Until the
       * analysis lands the card shows the page's own title and says so with
       * `.loading`; after it lands, the posting has been read and belongs to
       * an application. Anything this test waits for beyond that is time a
       * real person would have spent clicking.
       *
       * The card has to be there before "it is not loading" means anything.
       * Asking only about `.card.loading` is answered "true" by a page with
       * no card on it at all — which is every page for the first fraction of
       * a second, so the wait returned at once and this navigated away before
       * the posting had been read by anyone. It then failed for the one
       * reason that is not a bug: nothing had happened yet.
       */
      await quick.waitForFunction(
        () => {
          const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          return Boolean(root?.querySelector('.card')) && !root.querySelector('.card.loading');
        },
        null,
        { timeout: 30_000 },
      );
      const first = (await cardOf(quick).locator('.role').textContent())?.trim();

      await quick.goto(fixtures.urlFor(LEVER_FORM), { waitUntil: 'domcontentloaded' });
      await settled(quick);

      /*
       * Asked of the worker, which is where the answer lives. The card only
       * lists the pages it is writing from once there is more than one, so
       * counting rows in it cannot tell "they did not join" from "the card
       * has not drawn the list yet".
       */
      const held = await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        const key = `trail:${tab.id}`;
        const got = await chrome.storage.session.get(key);
        return (got[key]?.pages ?? []).map((p) => p.url);
      }, quick.url());
      const role = (await cardOf(quick).locator('.role').textContent())?.trim();
      check(
        'a posting followed immediately still counts as the page before',
        held.length >= 2,
        `${held.length} pages held, role now "${role}", was "${first}"`,
      );
      await quick.close();
    }
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
