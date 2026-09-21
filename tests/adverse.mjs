/**
 * When things go wrong in the middle.
 *
 * Every other harness here asks whether the tool works when nothing is
 * against it. These are the three conditions it was actually built to
 * survive, and none of them had a test:
 *
 *   - the tab is closed while you are writing, and reopened
 *   - the store goes away halfway through
 *   - the store is there but slow, while you are building rather than while
 *     it is deciding whether to offer at all
 *
 * The first of those has a whole mechanism behind it — work is filed under
 * the page's address when a tab closes, because a reopened tab gets a new id
 * and would never find it otherwise — written in response to losing a cover
 * letter and three answers to an accidental close. It had never been run.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/adverse.mjs
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  BARE_ROLE,
  HEAVY_POSTING,
  HELIOS_FORM,
  HELIOS_ROLE,
  SWAP_FORM,
  SWAP_FORM_TWO,
  cleanStore,
  findChromium,
  pointExtensionAt,
  requireOpenSave,
  serveFixtures,
  serveSlowProxy,
  useServer,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';

/**
 * The companies this suite files under, cleared before it starts as well as
 * after it finishes. One store is handed to several suites in turn, and one
 * interrupted run otherwise leaves its applications for whoever gets that
 * store next — who then reports a bug in code that is behaving perfectly.
 */
const MINE = ['Helios', 'Caelum', 'Tabor'];

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  if (ok) {
    passed++;
    console.log(`  ok    ${what}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${what}${detail ? ` — ${detail}` : ''}`);
  }
};
const group = (name) => console.log(`\n${name}`);

const cardOf = (page) => page.locator(`${HOST} .card`);

/**
 * Press a button on the card, and say what the card said if it is not there.
 *
 * Playwright's own message for this is "waiting for getByRole('button', {
 * name: 'Build resume' })", repeated until the timeout. It says what was
 * wanted and nothing whatever about what was in front of it — and a card with
 * no Build button on it is never blank: it is a card saying the save cannot
 * be reached, or that this has been applied to already, or that something is
 * still running. That sentence is the whole diagnosis, and throwing it away
 * has cost several runs.
 */
async function press(card, name) {
  const button = card.getByRole('button', { name });
  try {
    await button.click();
  } catch (err) {
    const said = await card.innerText().catch(() => '(the card could not be read)');
    const buttons = await card.getByRole('button').allInnerTexts().catch(() => []);
    throw new Error(
      `No "${name}" button to press.\n` +
        `The buttons on the card were: ${buttons.length ? buttons.map((b) => JSON.stringify(b)).join(', ') : '(none)'}\n` +
        `And the card said:\n${said}\n\n${err.message}`,
    );
  }
}

async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });

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
  /*
   * Wait for the card to stop changing, rather than for a number of
   * milliseconds. It fills in as the page is read — the role first, then the
   * company once it is worked out, then the buttons — and a fixed sleep is a
   * bet on how long that takes. On a loaded machine the bet loses, and the
   * failure reads like the extension getting the company wrong rather than
   * like the test looking too early. Two identical reads half a second apart
   * is the same claim, checked instead of assumed, and quicker when there is
   * nothing else running.
   */
  const read = () => page.locator(`${HOST} .card`).innerText().catch(() => '');
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const now = await read();
    if (now && now === last) return;
    last = now;
  }
}

/** A free port, asked of the operating system rather than guessed. */
const freePort = () =>
  new Promise((done, fail) => {
    const probe = net.createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const chosen = probe.address().port;
      probe.close(() => done(chosen));
    });
  });

/**
 * A store of our own that we are allowed to kill.
 *
 * Pointed at the same folder as the one the harness was given, so the data is
 * the same; it is a second front door, and closing it does not disturb
 * whatever else is using the first.
 */
async function ownServer(dataDir, poolBuild) {
  const port = await freePort();
  const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
    cwd: path.resolve(extensionRoot, '..', 'ResumeM-M'),
    detached: true,
    env: { ...process.env, RMM_DATA: dataDir, PORT: String(port), RMM_AUTOCOMMIT: '0' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  let mine;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const health = await (await fetch(`${url}/health`)).json();
      if (health.projectOpen && health.dataDir === dataDir) {
        mine = health;
        break;
      }
    } catch {
      // Not up yet.
    }
    await new Promise((go) => setTimeout(go, 500));
  }

  /*
   * Say so when this server and the pool's are different builds.
   *
   * This is the only suite that starts a second ResumeM-M, and it starts it
   * from source while the pool runs the built copy. The runner's guard checks
   * the pool against the code on disk before anything begins, which is the
   * right check and covers the ordinary case — but this server is started
   * minutes later, and stamps itself from the files as they are then. Edit a
   * source file while a run is going and only this suite sees two builds of
   * the same application arguing over one save.
   *
   * It fails when that happens, which is correct, but it fails as a thirty
   * second wait for a button that never appears — and three runs were spent
   * today reading that as a product bug and then as a concurrency flake. One
   * sentence is the difference between those and the truth.
   */
  if (mine && poolBuild && mine.build !== poolBuild) {
    console.error(
      [
        '',
        'This suite started a ResumeM-M from source and it is a different build',
        'from the one the pool is serving:',
        `  pool    ${poolBuild}`,
        `  ours    ${mine.build}`,
        '',
        'Both are pointed at the same save, so whichever answers gets a say in',
        'what the other is looking at. The usual cause is a source file edited',
        'after the run began. Let the run finish, then start it again.',
      ].join('\n'),
    );
    try {
      process.kill(-child.pid);
    } catch {
      child.kill();
    }
    process.exit(2);
  }

  return {
    url,
    kill: () => {
      try {
        process.kill(-child.pid);
      } catch {
        child.kill();
      }
    },
  };
}

async function main() {
  const health = await requireOpenSave(SERVER).catch(() => process.exit(2));
  await cleanStore(SERVER, MINE);

  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-adverse-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  let doomed = null;
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    /* ---------------------------------------------------------------- *
     * The tab is closed while you are writing                           *
     * ---------------------------------------------------------------- */

    group('The tab is closed in the middle of a letter');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(page);

      const letter = cardOf(page).locator('textarea.tall').first();
      await letter.waitFor({ timeout: 20_000 });
      await letter.click();
      await letter.pressSequentially('Three paragraphs in and the tab goes.', { delay: 8 });
      // The keeper writes on an interval; give it one.
      await page.waitForTimeout(2600);

      // Closed the way it happens: no warning, no chance to save.
      await page.close();
      await new Promise((go) => setTimeout(go, 1200));

      const reopened = await context.newPage();
      await reopened.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(reopened);
      await reopened.waitForTimeout(1500);

      const back = await cardOf(reopened).locator('textarea.tall').first().inputValue();
      check('the letter is there again', /three paragraphs in/i.test(back), back.slice(0, 50));

      /*
       * And says so. Finding your own writing back with no explanation is
       * its own kind of unsettling — you cannot tell what else it kept.
       */
      const body = (await cardOf(reopened).innerText()).replace(/\s+/g, ' ');
      const said = /[^.]*before this tab closed[^.]*\./i.exec(body)?.[0]?.trim();
      check('and the card says where it came from', Boolean(said), said ?? '(said nothing)');
      await reopened.close();
    }

    /*
     * And found from the posting, not only from the page it was typed on.
     *
     * A closed tab's work is parked under the pages the trail held, and that
     * was the last one only — which is the form. But the form is not how
     * anybody comes back: you search for the job again and land on the
     * description, which is a different address, and the letter was
     * unreachable while sitting in storage under the form's url. `remember`
     * has parked under every page for exactly this reason, and says so; the
     * close handler now does the same.
     */
    group('The tab is closed on the form, and the posting is opened again');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(page);

      const letter = cardOf(page).locator('textarea.tall').first();
      await letter.waitFor({ timeout: 20_000 });
      await letter.click();
      await letter.pressSequentially('Written on the form, looked for on the posting.', { delay: 8 });
      await page.waitForTimeout(2600);
      await page.close();
      await new Promise((go) => setTimeout(go, 1200));

      // Back the way people come back: to the posting.
      const again = await context.newPage();
      await again.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(again);
      await again.waitForTimeout(1500);
      // Read out of the box, not out of the card's text: a textarea's value
      // is a property, so `innerText` never contains it and an assertion
      // against the card's words can only ever fail.
      const back = await cardOf(again).locator('textarea.tall').first().inputValue().catch(() => '(no box)');
      check(
        'the letter written on the form is findable from the posting',
        /looked for on the posting/i.test(back),
        back.slice(0, 80),
      );
      await again.close();
    }

    /* ---------------------------------------------------------------- *
     * The store goes away halfway through                               *
     * ---------------------------------------------------------------- */

    group('The store goes away while you are using it');
    {
      doomed = await ownServer(health.dataDir, health.build);
      await useServer(context, doomed.url);

      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);

      doomed.kill();
      doomed = null;
      await page.waitForTimeout(1500);

      await press(cardOf(page), 'Build resume');
      await page.waitForTimeout(9000);

      const body = (await cardOf(page).innerText()).replace(/\s+/g, ' ');
      check('it says the store is not there', /not open|not running|start it/i.test(body), body.slice(-140));
      check('and offers a way out', /try again/i.test(body));
      check('the card does not vanish', (await cardOf(page).count()) > 0);
      check('and nothing is thrown at the page', errors.length === 0, errors.join('; '));
      await page.close();
      await useServer(context, SERVER);
    }

    /*
     * The application really is sent, and the store is not there to be told.
     *
     * `applicationSent` answers `{ ok: false }` rather than throwing when
     * ResumeM-M cannot be reached — the store being down is not a reason to
     * interrupt somebody who has just sent an application. The content script
     * never read that answer: it fired the message, swallowed the rejection,
     * and announced "Recorded as sent." on the next line. Measured:
     *
     *   card says     : "… | Recorded as sent."
     *   tracker after : applying
     *
     * Nothing recorded and the claim made anyway, which this file's subject
     * — sending.js — calls the worst failure available. It compounded too:
     * the old code latched the watcher on the same line, so starting the
     * store and pressing Submit again did nothing.
     *
     * Both halves are checked: what it says when it cannot record, and that
     * it will still record once it can.
     */
    group('The form is submitted while the store is away');
    {
      const posting = {
        name: 'sent-while-away',
        path: '/helios/jobs/staff-platform-engineer',
        company: 'Helios',
        html: `<!doctype html><html><head><title>Staff Platform Engineer at Helios</title></head>
          <body><h1>Helios</h1><div>Staff Platform Engineer</div>
          <h2>About the role</h2>
          <p>We are looking for a platform engineer to own our systems.
             Responsibilities include shipping to production.</p>
          <h2>Minimum qualifications</h2>
          <ul><li>Years of experience with distributed systems</li></ul>
          <p>Equal opportunity employer. Full-time. Upload your resume to apply.</p>
          <h2>Application</h2>
          <form id="ap">
            <label>First name <input name="first_name"></label>
            <label>Last name <input name="last_name"></label>
            <label>Email <input name="email" type="email"></label>
            <label>Why do you want to work here? <textarea name="q1"></textarea></label>
            <label>Resume <input type="file" name="resume"></label>
            <button type="submit">Submit Application</button>
          </form>
          <script>document.getElementById('ap')
            .addEventListener('submit', (e) => e.preventDefault());</script>
          </body></html>`,
      };

      const statusOf = async (within = 12_000) => {
        const until = Date.now() + within;
        for (;;) {
          const { applications } = await fetch(`${SERVER}/api/applications`).then((r) => r.json());
          const rows = (applications ?? []).filter((a) => /helios/i.test(a.company ?? ''));
          const row = rows.find((a) => /staff platform engineer/i.test(a.role ?? ''));
          if (row?.status === 'applied' || Date.now() >= until) {
            return row?.status ?? `(no row; helios rows: ${rows.map((a) => `${a.id}=${a.status}`).join(', ') || 'none'})`;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      };

      const site = await serveFixtures([posting]);
      const page = await context.newPage();
      try {
        doomed = await ownServer(health.dataDir, health.build);
        await useServer(context, doomed.url);

        await page.goto(site.urlFor(posting), { waitUntil: 'domcontentloaded' });
        await settled(page);
        await press(cardOf(page), 'Build resume');
        await cardOf(page).locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });

        doomed.kill();
        doomed = null;
        await page.waitForTimeout(1500);

        await page.getByRole('button', { name: 'Submit Application', exact: true }).click({ timeout: 15_000 });
        await page.waitForTimeout(6000);

        const said = (await cardOf(page).innerText()).replace(/\s+/g, ' ');
        check('the card does not claim it was recorded', !/recorded as sent/i.test(said), said.slice(-120));
        check('it says it was not recorded', /not recorded/i.test(said), said.slice(-120));

        // And the watcher was not spent on the attempt that failed.
        await useServer(context, SERVER);
        await page.waitForTimeout(2500);
        await page.getByRole('button', { name: 'Submit Application', exact: true }).click({ timeout: 15_000 });

        /*
         * The row first, then the card — in that order because that is the
         * order they happen in. This polls the store directly, so it sees the
         * commit land before the reply has travelled back to the page; read
         * together, the card was still showing the previous attempt's failure
         * and the check failed on timing rather than on behaviour.
         */
        const after = await statusOf(40_000);
        check('and pressing Submit once the store is back records it', after === 'applied', after);

        let nowSays = '';
        for (let i = 0; i < 60; i++) {
          nowSays = (await cardOf(page).innerText()).replace(/\s+/g, ' ');
          if (/recorded as sent/i.test(nowSays)) break;
          await page.waitForTimeout(250);
        }
        check('and the card says so then', /recorded as sent/i.test(nowSays), nowSays.slice(-120));
      } finally {
        await page.close().catch(() => undefined);
        await site.close();
        if (doomed) {
          doomed.kill();
          doomed = null;
        }
        await useServer(context, SERVER);
      }
    }

    /* ---------------------------------------------------------------- *
     * The store is there, but slow where it costs                       *
     * ---------------------------------------------------------------- */

    group('The store is slow while you are building, not while it decides');
    {
      /*
       * `quiet.mjs` slows the verdict, which is about whether to offer at
       * all. This slows the compile, which is the step someone is waiting on
       * with the form already open — and the question is whether the wait is
       * explained and whether what they typed survives it.
       */
      const slow = await serveSlowProxy(SERVER, { slowRoute: /render|bundle/, ms: 6000 });
      try {
        await useServer(context, slow.base);
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
        await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
        await settled(page);

        const card = cardOf(page);
        const letter = card.locator('textarea.tall').first();
        /*
         * Emptied first. The group above closed a tab on this same page, so
         * its letter is filed under this address and correctly restored here
         * — which meant the check below passed on a concatenation of the two
         * and would have passed with nothing typed at all.
         */
        await letter.fill('');
        await page.waitForTimeout(300);
        await letter.click();
        await letter.pressSequentially('Typed before the slow build started.', { delay: 6 });

        await press(card, 'Build resume');
        await page.waitForTimeout(1200);
        const during = (await card.innerText()).replace(/\s+/g, ' ');
        check('the wait is explained while it happens', /compil/i.test(during), during.slice(0, 120));

        await card.locator('.fit').filter({ hasText: /page/i }).first().waitFor({ timeout: 120_000 });
        const after = await card.locator('textarea.tall').first().inputValue();
        check(
          'and what was typed is still there afterwards, exactly',
          after.trim() === 'Typed before the slow build started.',
          JSON.stringify(after.slice(0, 60)),
        );
        check('nothing thrown', errors.length === 0, errors.join('; '));
        await page.close();
      } finally {
        await useServer(context, SERVER);
        slow.close();
      }
    }
    /* ---------------------------------------------------------------- *
     * The store accepts the connection and then never answers            *
     * ---------------------------------------------------------------- */

    group('A keyword match against a store that never answers');
    {
      /*
       * The worst kind of broken server: the socket is accepted, so nothing
       * refuses and nothing errors, and the request simply never comes back.
       *
       * Every mode of `rebuild` went out on the ten-minute deadline, which is
       * the AI's — a model reading a posting really does take that long. A
       * keyword match does not: it reads the pages and picks among phrasings
       * already written, and the worst case measured is two seconds. So a
       * match against a wedged store sat behind a progress bar for ten
       * minutes with nothing to press, which is indistinguishable from the
       * tool having hung, because it had.
       *
       * The deadline is twenty seconds, so this waits at most thirty for a
       * message. Deliberately not a check on the wording: what matters is
       * that it stops, says something, and gives the buttons back.
       *
       * Asked for through "Work out the suggestions again", because there is
       * no "Match by keyword" button any more. The match is not a mode: it
       * runs once on arrival and what it produces is a list of offers. The
       * one thing that still asks a wedged store to work it out afresh is
       * coming back from the builder — you went to write a phrasing the store
       * did not have, and the list beside the resume was computed before it
       * existed — and that link is a `rebuild` on `tailor: 'match'`, which is
       * exactly the request whose deadline this is about.
       *
       * Which is also why the store is only wedged after the card has
       * arrived, rather than on the second call through a `skip`. Counting
       * calls was fragile once the opening analysis stopped being the only
       * one before the click: the trip to the builder opens a page of its own
       * on the same server, and a test that depends on how many requests that
       * costs is measuring the builder.
       */
      const stalled = await serveSlowProxy(SERVER, { slowRoute: /extension\/analyze/, ms: 90_000 });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
        await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
        await settled(page);

        const card = cardOf(page);
        // Out to the builder and back, which is what puts the offer on the
        // card. Nothing is typed there: the notice is about having been away,
        // not about what was done while away.
        await useServer(context, stalled.base);
        const builder = context.waitForEvent('page');
        await card.locator('.to-builder').click();
        await (await builder).waitForLoadState('domcontentloaded').catch(() => undefined);
        await page.bringToFront();

        const offer = card.locator('.hint.warn button');
        await offer.waitFor({ timeout: 20_000 });
        check(
          'coming back from the builder offers the match again',
          /work out the suggestions again/i.test(((await offer.textContent()) ?? '').trim()),
          ((await offer.textContent()) ?? '').trim(),
        );

        const began = Date.now();
        await offer.click();
        const failed = await card
          .locator('.err')
          .first()
          .waitFor({ timeout: 30_000 })
          .then(() => true)
          .catch(() => false);
        const took = Math.round((Date.now() - began) / 1000);

        check('it gives up rather than waiting out the AI deadline', failed, `${took}s`);
        check(
          'and the buttons come back, so the resume can still be sent as it is',
          await card.locator('button.mode', { hasText: 'Use Original' }).isEnabled(),
        );
        check('nothing thrown while it gave up', errors.length === 0, errors.join('; '));
        await page.close();
      } finally {
        await useServer(context, SERVER);
        stalled.close();
      }
    }

    /* ---------------------------------------------------------------- *
     * The browser stops the extension's worker, as it does constantly    *
     * ---------------------------------------------------------------- */

    group('The browser stops the worker mid-application');
    {
      /*
       * Chrome idle-stops an MV3 service worker after about thirty seconds
       * of no events, and restarts it on the next one. That is not an edge
       * case, it is the normal life of the worker — and everything this tool
       * holds between pages lives on that side.
       *
       * Session storage survives it; anything kept in a variable does not.
       * So the question is whether a letter typed before the stop is still
       * offered after it, and whether the page notices anything at all.
       *
       * Forced through CDP because Chrome will not idle-stop a worker while
       * a debugger is attached, which is exactly the condition a test runs
       * under.
       */
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
      await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(page);

      const letter = cardOf(page).locator('textarea.tall').first();
      await letter.fill('');
      await page.waitForTimeout(300);
      await letter.click();
      await letter.pressSequentially('Written before the worker was stopped.', { delay: 6 });
      await page.waitForTimeout(2600);

      /*
       * Marked first, so the stop can be proved rather than assumed. A
       * variable set on the worker is gone when the worker is; if
       * `stopAllWorkers` quietly did nothing, this whole group would pass
       * while testing nothing at all.
       */
      const live = context.serviceWorkers()[0];
      await live.evaluate(() => {
        self.__stillTheSameWorker = true;
      });

      const cdp = await context.newCDPSession(page);
      await cdp.send('ServiceWorker.enable').catch(() => undefined);
      await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined);
      await page.waitForTimeout(1500);

      // Something that has to go through the worker, which wakes it again.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settled(page);
      await page.waitForTimeout(1500);

      const revived = context.serviceWorkers()[0];
      const stillMarked = await revived
        .evaluate(() => Boolean(self.__stillTheSameWorker))
        .catch(() => false);
      check('the worker really was stopped and came back', !stillMarked);

      const after = await cardOf(page).locator('textarea.tall').first().inputValue();
      check(
        'the letter survives the worker being killed',
        /written before the worker was stopped/i.test(after),
        after.slice(0, 60),
      );
      check('the card comes back at all', (await cardOf(page).count()) > 0);
      check('and the page is told nothing about it', errors.length === 0, errors.join('; '));
      await page.close();
    }
    /* ---------------------------------------------------------------- *
     * Session storage is nearly full                                     *
     * ---------------------------------------------------------------- */

    group('There is almost no room left to remember anything');
    {
      /*
       * Session storage is ten megabytes shared across every tab, and the
       * code that writes the trail says so: five tabs holding five pages
       * each fills it exactly, at which point the write throws and "the
       * trail silently stops working, which is the worst of the available
       * outcomes". The fallback drops the earlier pages' text and tries
       * again, keeping what was written.
       *
       * This does not reach that fallback, and it is worth saying so rather
       * than implying otherwise. I tried: a heavy posting first, and the
       * quota filled to within tens of kilobytes. It still passes with the
       * fallback removed, because `trimForStorage` strips scripts and styles
       * before anything is stored and a trail is small by the time it gets
       * here — which is the real protection, and `lighten` is a second belt
       * behind it. `lighten` is tested for what it does in `trail.mjs`,
       * where a pure function belongs.
       *
       * What this establishes is the thing a user would notice: with the
       * cupboard full, nothing breaks and the letter is still there.
       */
      const worker2 = context.serviceWorkers()[0];
      const filled = await worker2.evaluate(async () => {
        const store = chrome.storage.session ?? chrome.storage.local;
        const write = async (key, size) => {
          try {
            await store.set({ [key]: 'x'.repeat(size) });
            return true;
          } catch {
            return false;
          }
        };
        let bytes = 0;
        // Coarse first, then fine, so what is left over is tens of kilobytes
        // rather than most of a megabyte.
        for (let i = 0; i < 12 && (await write(`jh-ballast-a${i}`, 1024 * 1024)); i++) bytes += 1024 * 1024;
        for (let i = 0; i < 40 && (await write(`jh-ballast-b${i}`, 32 * 1024)); i++) bytes += 32 * 1024;
        return bytes;
      });
      check('the quota really was filled', filled > 0, `${(filled / 1024 / 1024).toFixed(2)} MB of ballast`);

      try {
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));

        // Half a megabyte of posting first, so the trail is too big to store
        // whole and the fallback is the only way the letter survives.
        await page.goto(fixtures.urlFor(HEAVY_POSTING), { waitUntil: 'domcontentloaded' });
        await settled(page);
        await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
        await settled(page);

        const letter = cardOf(page).locator('textarea.tall').first();
        await letter.fill('');
        await page.waitForTimeout(300);
        await letter.click();
        await letter.pressSequentially('Written with the cupboard full.', { delay: 6 });
        await page.waitForTimeout(2600);

        await page.reload({ waitUntil: 'domcontentloaded' });
        await settled(page);
        await page.waitForTimeout(1500);

        const after = await cardOf(page).locator('textarea.tall').first().inputValue();
        check(
          'the letter is kept even so',
          /written with the cupboard full/i.test(after),
          after.slice(0, 60),
        );
        check('and nothing is thrown at the page', errors.length === 0, errors.join('; '));
        await page.close();
      } finally {
        await worker2.evaluate(async () => {
          const store = chrome.storage.session ?? chrome.storage.local;
          const all = await store.get(null);
          await store.remove(Object.keys(all).filter((k) => k.startsWith('jh-ballast-')));
        });
      }
    }

    /* ---------------------------------------------------------------- *
     * The page forbids everything the card is made of                    *
     * ---------------------------------------------------------------- */

    group('A posting served under a strict Content-Security-Policy');
    {
      /*
       * The systems this tool exists for are the ones with the tightest
       * policies: they handle passports, salary figures and right-to-work
       * documents, and their headers say so. The card is a shadow root full of
       * inline style attached to their page, so if a policy can stop it
       * drawing then the extension is simply broken where it matters most —
       * and nothing else here would say so, because every other fixture is
       * served with no headers at all.
       *
       * Drawing is the easy half, and it is nearly free: Chrome exempts a
       * content script's own styles from the page's policy, and measurably so
       * — a copy of this extension that appends a stylesheet to the page's own
       * `<head>` under `style-src 'none'` still draws, still gets no
       * violation. So "the card appeared" is a guard against that exemption
       * changing, not a test of anything we do.
       *
       * The part with teeth is the preview, and it found something. pdf.js
       * renders the compiled resume in a Worker, and a worker is not a style:
       * `worker-src` is one of the directives an applicant tracking system
       * pins down. Under `default-src 'none'` the page emits
       * `worker-src blob` — once per preview, from a `chrome-extension`
       * source file — which on a site with a `report-uri` is a report posted
       * to somebody else's security monitoring for the sake of drawing a
       * resume.
       *
       * It is left alone, because every way out is worse. The worker can only
       * ever be a blob: a content script cannot construct one from an
       * extension URL, since that is cross-origin to the document it runs in,
       * so pdf.js fetches the script and wraps it — `workerPort` set by hand
       * is refused for the same reason and silently ignored. Turning the
       * worker off everywhere would move PDF parsing onto the thread of the
       * form being filled in, on every site, to quieten a report on a few.
       *
       * And nothing breaks: pdf.js catches the refusal and parses on the main
       * thread, so the pages still draw. That is the property worth pinning,
       * and it is what the check below asserts — if a policy ever stops the
       * preview appearing at all, this says so.
       *
       * `BARE_ROLE` and not one of the ordinary fixtures, because those carry
       * an inline `<style>` of their own that the same policy refuses — the
       * console would be full of complaints that were nothing to do with us.
       */
      const POLICIES = [
        ["default-src 'self'", "default-src 'self'"],
        ["style-src 'none'", "default-src 'self'; style-src 'none'"],
        ['no inline anything', "default-src 'none'; style-src 'self'; script-src 'self'"],
        ['trusted types', "require-trusted-types-for 'script'"],
      ];

      for (const [name, policy] of POLICIES) {
        const strict = await serveFixtures([BARE_ROLE], { headers: { 'Content-Security-Policy': policy } });
        const page = await context.newPage();
        const complaints = [];
        page.on('pageerror', (e) => complaints.push(String(e).slice(0, 100)));
        /*
         * The violation event rather than the console, because that is the
         * thing with consequences: it is what a `report-uri` posts to the
         * site's own security monitoring. The console also carries the
         * browser's ordinary resource noise — a 404 for the favicon this
         * one-page server does not have — which is nothing to do with either
         * the policy or the card.
         */
        await page.addInitScript(() => {
          window.__jhViolations = [];
          document.addEventListener('securitypolicyviolation', (e) => {
            window.__jhViolations.push(`${e.violatedDirective} ${e.blockedURI} ${(e.sourceFile ?? '').slice(-40)}`);
          });
        });

        await page.goto(`${strict.base}${BARE_ROLE.path}`, { waitUntil: 'domcontentloaded' });
        const drew = await page
          .locator(`${HOST} .card`)
          .waitFor({ timeout: 25_000 })
          .then(() => true)
          .catch(() => false);
        check(`${name}: the card is drawn`, drew);

        /*
         * Styled, not merely present. A card whose stylesheet was refused is
         * a stack of unstyled divs down the middle of somebody's application
         * form, which is worse than no card at all — so this asks the page
         * what it actually computed rather than whether an element exists.
         */
        const laidOut = await page
          .evaluate(() => {
            const el = document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card');
            if (!el) return null;
            return { position: getComputedStyle(el).position, width: Math.round(el.getBoundingClientRect().width) };
          })
          .catch(() => null);
        check(
          `${name}: and its stylesheet was applied`,
          laidOut?.position === 'fixed' && laidOut.width > 200,
          JSON.stringify(laidOut),
        );

        /*
         * All the way through, on the tightest policy of the set: build the
         * resume, and look at whether its pages are actually on the canvas.
         * This is the one that exercises the pdf.js worker, and a card
         * claiming "1 page" over an empty box is the failure it is here for.
         */
        if (drew && policy.includes("script-src 'self'")) {
          const card = cardOf(page);
          await press(card, 'Build resume');
          await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
          await page.waitForTimeout(1500);
          const drawn = await page
            .evaluate(
              () =>
                document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.pdf-pages')
                  ?.childElementCount ?? 0,
            )
            .catch(() => 0);
          check(`${name}: and the compiled resume is drawn, worker and all`, drawn > 0, `${drawn} pages`);
        }

        await page.waitForTimeout(1500);
        /*
         * Every violation except the known blob worker above. Listed rather
         * than counted so that a new one — a directive nobody has thought
         * about yet — cannot hide behind the one we have accepted.
         */
        const violations = (await page.evaluate(() => window.__jhViolations ?? []).catch(() => [])).filter(
          (v) => !/^worker-src blob/.test(v),
        );
        check(
          `${name}: and the page reports nothing else`,
          violations.length === 0,
          violations.join(' | '),
        );
        check(`${name}: and nothing is thrown at the page`, complaints.length === 0, complaints.join(' | '));
        await page.close();
        strict.close();
      }
    }

    /* ---------------------------------------------------------------- *
     * The save changes under an application that is already open          *
     * ---------------------------------------------------------------- */

    group('Another save is opened while an application is being written');
    {
      /*
       * Two saves is the ordinary reason to have saves at all — a personal
       * one and a work one — and an application takes long enough to write
       * that the editor can be pointed at the other one meanwhile.
       *
       * Nothing said so. Filing the application then wrote it into whichever
       * save happened to be open, saved its tailored resume there, and
       * typeset the PDFs from that save's profile and wordings: a 200 back,
       * files that were not the ones reviewed, and a row in the wrong
       * tracker. The proposal now carries the save it was built from, and
       * the store refuses a write meant for one it no longer has open.
       */
      // The same save the harness is using, on a second front door of our
      // own: switching saves on the shared one would disturb every other
      // suite running beside this.
      const mine = await (await fetch(`${SERVER}/health`)).json();
      const own = await ownServer(mine.dataDir, mine.build);
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-other-save-'));
      try {
        await pointExtensionAt(context, context.serviceWorkers()[0], own.url);

        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
        await page.goto(fixtures.urlFor(SWAP_FORM), { waitUntil: 'domcontentloaded' });
        await settled(page);
        const card = cardOf(page);
        await press(card, 'Build resume');
        await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });

        /*
         * The person switches saves in the editor, in another window.
         *
         * Retried, because building now also files the application as
         * `applying` so that its files are in the upload folder before the
         * portal's dialog opens — and that is a real compile, held open as an
         * API request. A save cannot be swapped out from under a write that is
         * landing in it, so the server answers 409 until it finishes. That
         * refusal is the guard working; what this test is about is what
         * happens *after* the save changes, so it waits for its turn the way a
         * person pressing the button again would.
         */
        let switched;
        for (let i = 0; i < 30; i++) {
          switched = await fetch(`${own.url}/api/projects/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: elsewhere, mode: 'create' }),
          });
          if (switched.ok || switched.status !== 409) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        check('the editor changed save', switched.ok, String(switched.status));

        // And then presses the button that files it.
        await press(card, 'Submit');
        await card.locator('.err, .done-box').first().waitFor({ timeout: 120_000 });

        /*
         * The refusal in the store's own words, not merely the absence of a
         * folder. A first version of this check also accepted any card text
         * containing "save", and passed on the word "saved" in a sentence
         * about the base resume being untouched — which is a check that
         * cannot fail.
         */
        const said = await card.innerText();
        const refusal = said.split('\n').find((line) => /open now|open that save again/i.test(line));
        check('the card says the save changed rather than filing it anyway', Boolean(refusal), refusal ?? said.slice(0, 160));
        check('and no folder is reported as written', !(await card.locator('.done-box').count()));

        // Nothing of this application reached the save that is open.
        const landed = await fetch(`${own.url}/api/applications`).then((r) => r.json());
        /*
         * Named, not just counted. A row that got in here came through some
         * request that went out without `X-RMM-Project`, and the store does
         * not refuse those — so which row it is, and what state it is in, is
         * the only thing that says which request lost the save.
         */
        const strays = (landed.applications ?? []).filter((a) => /caelum/i.test(a.company ?? ''));
        check(
          'the other save is untouched',
          strays.length === 0,
          strays.length
            ? strays.map((a) => `${a.id} [${a.status}] role=${JSON.stringify(a.role ?? '')}`).join(' | ')
            : (landed.applications ?? []).map((a) => a.company).join(', ') || '(empty)',
        );
        /*
         * And it is in the save it was built from, which is the half of the
         * claim the check above cannot make on its own.
         *
         * "No Caelum row over there" passes just as well when nothing was ever
         * filed anywhere — a posting the analysis could not name yields no
         * company and no role, `holdASpace` returns before it writes, and the
         * group reports a save protected from a write that never happened.
         * That is not hypothetical here: this form was moved onto an employer
         * of its own to stop an earlier group's work being rescued onto it,
         * and a fixture with a new name is exactly the thing that can fail to
         * be read.
         */
        const home = await fetch(`${SERVER}/api/applications`).then((r) => r.json());
        const filed = (home.applications ?? []).filter((a) => /caelum/i.test(a.company ?? ''));
        check(
          'and it is in the save it was built from',
          filed.length > 0,
          filed.map((a) => `${a.id} [${a.status}]`).join(' | ') ||
            (home.applications ?? []).map((a) => a.company).join(', ') || '(empty)',
        );
        check('nothing was thrown at the page', errors.length === 0, errors.join('; '));
        await page.close();
      } finally {
        own.kill();
        fs.rmSync(elsewhere, { recursive: true, force: true });
        await pointExtensionAt(context, context.serviceWorkers()[0], SERVER);
      }
    }

    /* ---------------------------------------------------------------- *
     * …and the browser stops the worker in between                       *
     * ---------------------------------------------------------------- */

    group('Another save is opened, and the worker is stopped in between');
    {
      /*
       * The same thing again, with the one event that happens on the way.
       *
       * Which save the application was built from was held in a variable on
       * the worker, and this worker is stopped after about half a minute of
       * no extension events — which reading a posting and writing a letter
       * produce none of. So by the time Submit was pressed the variable was
       * routinely gone, no `X-RMM-Project` header went with the write, and
       * the store's guard only refuses a save it disagrees with: a forgotten
       * one was not a refusal, it was the protection above switching itself
       * off silently, in the ordinary case rather than a rare one.
       *
       * The group before this proves the guard works while the worker is
       * alive, which is the condition a test runs under and not the one a
       * person applies under.
       *
       * Worth being straight about what this catches. Against the code
       * without the fix it failed one run in four, not four in four: the
       * re-analysis that picks up the wrong save has to land after the switch
       * for the fault to show, and when that happens is a race this cannot
       * set. Reloading the page to force the order leaves the card unable to
       * come back at all — which is its own question, and not this one. So
       * this is a sampling check over a real browser rather than a guard that
       * cannot be got past; the argument that the fix is right is in
       * `saveOf`, and this is the evidence that it holds end to end.
       */
      const mine = await (await fetch(`${SERVER}/health`)).json();
      const own = await ownServer(mine.dataDir, mine.build);
      const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'rmm-other-save-'));
      try {
        /*
         * The group above left its application staged in this save — building
         * files it as `applying` so the documents are in the upload folder
         * before a portal's dialog opens. The card would come up on that one,
         * which is a different card with different buttons.
         */
        await cleanStore(own.url, MINE);
        await pointExtensionAt(context, context.serviceWorkers()[0], own.url);

        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
        await page.goto(fixtures.urlFor(SWAP_FORM_TWO), { waitUntil: 'domcontentloaded' });
        await settled(page);
        const card = cardOf(page);
        /*
         * Built here, on a form no other group opens. This used to press
         * "Build resume" only if it was there, because the card rescued the
         * work left behind by an earlier group on the shared Helios form and
         * came up already compiled — but a resume built two groups ago
         * against the save that was open then is not what this group is about
         * to watch the save change under. See `SWAP_FORM_TWO`.
         */
        await press(card, 'Build resume');
        await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });

        /*
         * Marked first, so the stop is proved rather than assumed: without
         * this, a `stopAllWorkers` that quietly did nothing would leave this
         * group passing while testing the group above a second time.
         */
        await context.serviceWorkers()[0].evaluate(() => {
          self.__sameWorkerAsBefore = true;
        });
        const cdp = await context.newCDPSession(page);
        await cdp.send('ServiceWorker.enable').catch(() => undefined);
        await cdp.send('ServiceWorker.stopAllWorkers').catch(() => undefined);
        await page.waitForTimeout(1500);

        let switched;
        for (let i = 0; i < 30; i++) {
          switched = await fetch(`${own.url}/api/projects/switch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ dir: elsewhere, mode: 'create' }),
          });
          if (switched.ok || switched.status !== 409) break;
          await new Promise((r) => setTimeout(r, 1000));
        }
        check('the editor changed save', switched.ok, String(switched.status));

        await press(card, 'Submit');
        await card.locator('.err, .done-box').first().waitFor({ timeout: 120_000 });

        const revived = context.serviceWorkers()[0];
        const stillMarked = await revived
          .evaluate(() => Boolean(self.__sameWorkerAsBefore))
          .catch(() => false);
        check('the worker really was stopped and came back', !stillMarked);

        const said = await card.innerText();
        const refusal = said.split('\n').find((line) => /open now|open that save again/i.test(line));
        check(
          'the card still says the save changed, with the worker restarted under it',
          Boolean(refusal),
          refusal ?? said.slice(0, 160),
        );
        check('and no folder is reported as written', !(await card.locator('.done-box').count()));

        const landed = await fetch(`${own.url}/api/applications`).then((r) => r.json());
        /*
         * Named, not just counted. A row that got in here came through some
         * request that went out without `X-RMM-Project`, and the store does
         * not refuse those — so which row it is, and what state it is in, is
         * the only thing that says which request lost the save.
         */
        const strays = (landed.applications ?? []).filter((a) => /tabor/i.test(a.company ?? ''));
        check(
          'the other save is untouched',
          strays.length === 0,
          strays.length
            ? strays.map((a) => `${a.id} [${a.status}] role=${JSON.stringify(a.role ?? '')}`).join(' | ')
            : (landed.applications ?? []).map((a) => a.company).join(', ') || '(empty)',
        );
        // And in the save it was built from — see the group above, whose note
        // says why a check for an absence needs the presence beside it.
        const home = await fetch(`${SERVER}/api/applications`).then((r) => r.json());
        const filed = (home.applications ?? []).filter((a) => /tabor/i.test(a.company ?? ''));
        check(
          'and it is in the save it was built from',
          filed.length > 0,
          filed.map((a) => `${a.id} [${a.status}]`).join(' | ') ||
            (home.applications ?? []).map((a) => a.company).join(', ') || '(empty)',
        );
        check('nothing was thrown at the page', errors.length === 0, errors.join('; '));
        await page.close();
      } finally {
        own.kill();
        fs.rmSync(elsewhere, { recursive: true, force: true });
        await pointExtensionAt(context, context.serviceWorkers()[0], SERVER);
      }
    }
  } finally {
    if (doomed) doomed.kill();
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, MINE);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
