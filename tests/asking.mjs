/**
 * The chip that asks instead of guessing, and the list its "no" writes to.
 *
 * Three things have to hold together for this to be an improvement rather
 * than one more thing in the corner of the screen.
 *
 * A page that settles the question keeps its card, immediately, with no chip
 * in front of it. Everything the tool is actually for is in that set, and a
 * redesign that made a real posting take a click would have made the tool
 * worse in exchange for making it quieter.
 *
 * A page that does not settle it gets the chip and nothing else — no card, and
 * nothing sent to the store to be classified, which is the half that cannot be
 * seen from the page and is checked here by watching what the store is asked.
 *
 * And "no" has to mean something that outlives the tab. It writes the same
 * muted-host list the popup's button shows and clears, so there is one place
 * to see it and one way back; a later yes takes the site off it again.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  FORUM_THREAD,
  HELIOS_ROLE,
  findChromium,
  pointExtensionAt,
  requireOpenSave,
  serveFixtures,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';

const ASK = '#jobhelper-ask-host';
const CARD = '#jobhelper-card-host';

/** Long enough for a card or a chip to arrive, and then some. */
const APPEAR_MS = 12_000;
/** Long enough that "it never came" is a fact rather than a race. */
const SETTLE_MS = 5000;

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

const appears = async (page, selector, ms = APPEAR_MS) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await page.locator(selector).count()) > 0) return true;
    await page.waitForTimeout(150);
  }
  return false;
};

/** Watched rather than sampled: something that appears and leaves still appeared. */
const neverAppears = async (page, selector, ms = SETTLE_MS) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if ((await page.locator(selector).count()) > 0) return false;
    await page.waitForTimeout(150);
  }
  return true;
};

/** What the extension is holding, read the way the popup reads it. */
async function mutedHosts(context, worker) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
  // The worker answers `{ ok, data }`, which is what the popup unwraps.
  const hosts = await page.evaluate(
    () =>
      new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'getSettings' }, (r) => resolve(r?.data?.mutedHosts ?? null));
      }),
  );
  await page.close();
  if (hosts === null) throw new Error('could not read the settings out of the extension');
  return hosts;
}

/** Press the toolbar button, which is what `show-card` is. */
async function pressTheButton(context, worker, url) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/src/popup/popup.html`);
  await page.evaluate(async (want) => {
    const [tab] = await chrome.tabs.query({ url: want });
    if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'show-card' }).catch(() => undefined);
  }, url);
  await page.close();
}

/** A button inside the chip's shadow root. */
const inChip = (page, cls) => page.locator(`${ASK} button.${cls}`);

async function main() {
  await requireOpenSave(SERVER);
  const fixtures = await serveFixtures([FORUM_THREAD, HELIOS_ROLE]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-asking-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      /*
       * So the fixtures can be reached under a real name.
       *
       * The never-offer list is decided from the address, and every fixture
       * here is served from 127.0.0.1, which is on no list. Pointing the
       * browser's resolver at the same socket is the only way to ask the
       * question the user actually reported — "it still pops up on reddit" —
       * rather than a unit test of the matcher standing in for it.
       */
      '--host-resolver-rules=MAP old.reddit.com 127.0.0.1, MAP reddit.com 127.0.0.1, MAP jobs.example.test 127.0.0.1',
    ],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    const forumUrl = fixtures.urlFor(FORUM_THREAD);
    const postingUrl = fixtures.urlFor(HELIOS_ROLE);

    /* ---------------------------------------------------------------- *
     * A page that settles the question is not asked about              *
     * ---------------------------------------------------------------- */

    console.log('\nA real posting still gets its card, with nothing in front of it');
    {
      const page = await context.newPage();
      await page.goto(postingUrl, { waitUntil: 'domcontentloaded' });
      check('the card appears on a posting', await appears(page, `${CARD} .card`));
      check('and no chip was ever shown for it', await neverAppears(page, ASK, 1500));
      await page.close();
    }

    /* ---------------------------------------------------------------- *
     * And the sites nothing is offered on at all                        *
     * ---------------------------------------------------------------- */

    /*
     * The same page, at two addresses.
     *
     * Served from one socket and reached under two names, so the only thing
     * that differs between these two blocks is the host — which is the whole
     * claim. On `jobs.example.test` the thread is ambiguous and gets the chip;
     * on `old.reddit.com` it is a forum and gets nothing, not even the chip,
     * because the words on a social site are about jobs without being one and
     * no amount of reading them harder separates the two.
     */
    console.log('\nNothing at all on a site nobody wants an offer on');
    {
      const port = new URL(fixtures.base).port;
      for (const host of ['old.reddit.com', 'reddit.com']) {
        const page = await context.newPage();
        await page.goto(`http://${host}:${port}${FORUM_THREAD.path}`, { waitUntil: 'domcontentloaded' });
        check(`no chip on ${host}`, await neverAppears(page, ASK));
        check(`and no card on ${host}`, await neverAppears(page, CARD, 1200));
        await page.close();
      }

      // And the button still reaches it, because a "who is hiring" thread is
      // a real thing and the list is not the last word.
      const page = await context.newPage();
      const url = `http://old.reddit.com:${port}${FORUM_THREAD.path}`;
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await pressTheButton(context, worker, url);
      check('but the button still works there', await appears(page, `${CARD} .card`));
      await page.close();
    }

    console.log('\nAnd the same page under an ordinary name is asked about');
    {
      const port = new URL(fixtures.base).port;
      const page = await context.newPage();
      await page.goto(`http://jobs.example.test:${port}${FORUM_THREAD.path}`, { waitUntil: 'domcontentloaded' });
      check('the chip appears when the host is not on the list', await appears(page, ASK));
      await page.close();
    }

    /* ---------------------------------------------------------------- *
     * A page that does not gets asked about, and nothing else          *
     * ---------------------------------------------------------------- */

    console.log('\nA page we would only be guessing about is asked about instead');
    let askedTheStore = false;
    {
      const page = await context.newPage();
      // Nothing about the page should reach the store while the question is
      // open. Watched on the wire, because it cannot be seen from the page.
      page.on('request', (r) => {
        if (r.url().startsWith(SERVER) && /analy[sz]e/.test(r.url())) askedTheStore = true;
      });
      await page.goto(forumUrl, { waitUntil: 'domcontentloaded' });
      check('the chip appears on a forum thread', await appears(page, ASK));
      check('and the card does not', await neverAppears(page, CARD));
      check('and the page was never sent to the store', !askedTheStore);
      check('the chip offers both answers', (await inChip(page, 'yes').count()) === 1 && (await inChip(page, 'no').count()) === 1);
      await page.close();
    }

    /* ---------------------------------------------------------------- *
     * "Not now" leaves the site alone                                   *
     * ---------------------------------------------------------------- */

    console.log('\nNot now is not no');
    {
      const page = await context.newPage();
      await page.goto(forumUrl, { waitUntil: 'domcontentloaded' });
      await appears(page, ASK);
      await inChip(page, 'later').click();
      check('the chip goes away when dismissed', await neverAppears(page, ASK, 1200));
      check('and the site is not recorded anywhere', (await mutedHosts(context, worker)).length === 0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      check('and it asks again on the next visit', await appears(page, ASK));
      await page.close();
    }

    /* ---------------------------------------------------------------- *
     * "No" is remembered                                                *
     * ---------------------------------------------------------------- */

    console.log('\nNo means this site, not this page');
    {
      const page = await context.newPage();
      await page.goto(forumUrl, { waitUntil: 'domcontentloaded' });
      await appears(page, ASK);
      await inChip(page, 'no').click();
      check('the chip goes away when refused', await neverAppears(page, ASK, 1200));

      const hosts = await mutedHosts(context, worker);
      check('the site is on the muted list the popup shows', hosts.includes('127.0.0.1'), hosts.join(', '));

      await page.reload({ waitUntil: 'domcontentloaded' });
      check('nothing is offered there again', await neverAppears(page, ASK));
      check('and no card either', await neverAppears(page, CARD, 1200));
      await page.close();
    }

    /*
     * And the muting is not page-deep: a *different* page on that host, one
     * that would otherwise have got a card without being asked, stays quiet
     * too. This is the half that makes "no" worth pressing.
     */
    console.log('\nAnd it covers the whole site, not the page it was pressed on');
    {
      const page = await context.newPage();
      await page.goto(postingUrl, { waitUntil: 'domcontentloaded' });
      check('a posting on a muted site gets nothing', await neverAppears(page, CARD));
      await page.close();
    }

    /* ---------------------------------------------------------------- *
     * Saying yes again takes it back off                                 *
     * ---------------------------------------------------------------- */

    console.log('\nSaying yes again takes the site back off the list');
    {
      const page = await context.newPage();
      await page.goto(postingUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(1000);
      await pressTheButton(context, worker, postingUrl);
      check('the card comes up when asked for', await appears(page, `${CARD} .card`));
      const hosts = await mutedHosts(context, worker);
      check('and the site is no longer muted', !hosts.includes('127.0.0.1'), hosts.join(', '));
      await page.close();
    }

    /*
     * Which has to be true from the page as well as from the toolbar: the
     * chip's own Yes is the answer most people will give, and it must not
     * leave the site muted from an earlier no.
     */
    console.log('\nAnd the chip’s own yes does the same, and puts the card up');
    {
      const mute = await context.newPage();
      await mute.goto(forumUrl, { waitUntil: 'domcontentloaded' });
      await appears(mute, ASK);
      await inChip(mute, 'no').click();
      await mute.close();

      // Unmuted from the toolbar so the chip can appear again, which is the
      // only way to reach its Yes.
      const page = await context.newPage();
      await page.goto(forumUrl, { waitUntil: 'domcontentloaded' });
      await pressTheButton(context, worker, forumUrl);
      await page.waitForTimeout(500);
      const after = await mutedHosts(context, worker);
      check('the button alone clears the mute', !after.includes('127.0.0.1'), after.join(', '));
      await page.close();
    }

    console.log('\nAnd the chip’s Yes reads the page');
    {
      const page = await context.newPage();
      await page.goto(forumUrl, { waitUntil: 'domcontentloaded' });
      check('the chip is back now the site is not muted', await appears(page, ASK));
      await inChip(page, 'yes').click();
      check('pressing yes puts the card up', await appears(page, `${CARD} .card`));
      check('and the chip is gone', (await page.locator(ASK).count()) === 0);
      await page.close();
    }

    /*
     * The other way the card goes away, and the way back from it.
     *
     * The card's × takes the host element off the page and tells the content
     * script nothing, so `cardHandle` — the thing `putUpCard` checks before
     * building one — stayed pointing at a node that is no longer in the
     * document. Every route back then short-circuited on it: pressing the
     * toolbar button did nothing at all, and a frame reporting an application
     * form later on could not raise one either. "Not now" is meant to mean
     * not now, not never until you reload.
     */
    console.log('\nClosing the card, and asking for it again');
    {
      const page = await context.newPage();
      await page.goto(postingUrl, { waitUntil: 'domcontentloaded' });
      check('the card is up', await appears(page, `${CARD} .card`));

      await page.locator(`${CARD} button[aria-label="Close JobHelper on this page"]`).click();
      check('pressing × takes it away', await neverAppears(page, `${CARD} .card`, 2000));

      await pressTheButton(context, worker, postingUrl);
      check('and the toolbar button brings it back', await appears(page, `${CARD} .card`));
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
