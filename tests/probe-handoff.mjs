/**
 * PROBE (not part of the suite): the careers-site-to-ATS hand-off, repeated.
 *
 *   node tests/probe-handoff.mjs [runs]
 *
 * One check in `navigation.mjs` fails about one run in four, and only this
 * one: "A company site handing off to an applicant tracking system". It is the
 * only walk where the two pages share no host and the link carries
 * rel="noreferrer", so the click is the *only* evidence that they belong to
 * the same application — `content.js` sends `expectContinuation` from a
 * capture-phase click listener and does not wait for it, which the comment
 * there calls best effort by design.
 *
 * Guessing which half of that is at fault has been wrong twice before on this
 * project, so this measures instead. Each run records, from the worker's own
 * storage:
 *
 *   before   — did the description page get itself into the trail at all
 *   marked   — did `expecting` ever appear, polled from the moment of the click
 *   when     — how long after the click it appeared
 *   after    — how many pages the trail holds once the form page has settled
 *
 * A run where `marked` is false and `after` is 1 says the message was lost. A
 * run where `marked` is true and `after` is still 1 says something downstream
 * dropped it, and points somewhere else entirely.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ATS_FORM, OWN_SITE, cleanStore, findChromium, pointExtensionAt, requireOpenSave, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';
const RUNS = Number(process.argv[2] ?? 12);

const cardOf = (page) => page.locator(`${HOST} .card`);

/** The id of the tab showing this url, which does not change across the hop. */
const tabIdFor = (worker, url) =>
  worker.evaluate(async (u) => (await chrome.tabs.query({ url: u }))[0]?.id ?? null, url);

/** The trail record for one tab, read out of the worker's own storage. */
const trailOf = (worker, tabId) =>
  worker.evaluate(async (id) => {
    const key = `trail:${id}`;
    const stored = (await (chrome.storage.session ?? chrome.storage.local).get(key))[key];
    if (!stored) return { pages: 0, expecting: null };
    return { pages: (stored.pages ?? []).length, expecting: stored.expecting?.to ?? null };
  }, tabId);

async function settled(page) {
  await page.waitForTimeout(400);
  await page.locator(HOST).first().waitFor({ timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(600);
}

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    console.error(`No save open at ${SERVER}. Start one and try again.`);
    process.exit(2);
  }

  // The walk files an application under Acme every run; without this the
  // second run meets a card that already knows about the first.
  await cleanStore(SERVER, ['Acme']);

  const ats = await serveFixtures(undefined, { hostname: 'localhost' });
  const fixtures = await serveFixtures(undefined, { vars: { ATS: `${ats.base}${ATS_FORM.path}` } });
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-handoff-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  const rows = [];
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    for (let run = 1; run <= RUNS; run++) {
      const page = await context.newPage();
      const from = fixtures.urlFor(OWN_SITE);
      await page.goto(from, { waitUntil: 'domcontentloaded' });
      await settled(page);

      // Build, so there is work to lose — and so the walk matches the suite's.
      const card = cardOf(page);
      await card.getByRole('button', { name: 'Build resume' }).click();
      await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
      await page.waitForTimeout(2500);

      const tabId = await tabIdFor(worker, from);
      const before = await trailOf(worker, tabId);

      /*
       * Poll for `expecting` from the instant of the click. The tab id does
       * not change across the navigation, so the record can be watched while
       * the page it was written from is being torn down.
       */
      const clickedAt = Date.now();
      const watching = (async () => {
        for (let i = 0; i < 60; i++) {
          const seen = await trailOf(worker, tabId).catch(() => null);
          if (seen?.expecting) return Date.now() - clickedAt;
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      })();

      await page.click('#apply');
      const marked = await watching;

      await page.waitForLoadState('domcontentloaded');
      await settled(page);

      const rowsShown = await cardOf(page).locator('.trail-row').count();
      const role = (await cardOf(page).locator('.role').textContent().catch(() => ''))?.trim();
      const after = await trailOf(worker, tabId);

      rows.push({ run, before: before?.pages ?? 0, marked, rowsShown, pages: after?.pages ?? 0, role });
      console.log(
        `  run ${String(run).padStart(2)}  before=${before?.pages ?? 0}  expecting=${marked === null ? 'never' : `${marked}ms`}  trail-rows=${rowsShown}  pages=${after?.pages ?? 0}  role=${role}`,
      );
      await page.close();
    }
  } finally {
    /*
     * The fixture servers as well as the browser. Leaving them listening kept
     * node's event loop alive after the last run had printed its summary, so
     * every invocation of this probe "hung" at the end with nothing left to
     * do and had to be killed — three times before I read the teardown rather
     * than the output.
     */
    await context.close();
    ats.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const lost = rows.filter((r) => r.rowsShown < 2);
  console.log(`\n  ${lost.length} of ${rows.length} runs started a fresh application at the form.`);
  if (lost.length > 0) {
    const neverMarked = lost.filter((r) => r.marked === null).length;
    console.log(`  of those, ${neverMarked} never recorded the click, ${lost.length - neverMarked} did and lost it later.`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
