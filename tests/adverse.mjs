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
  HELIOS_FORM,
  HELIOS_ROLE,
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

async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
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
async function ownServer(dataDir) {
  const port = await freePort();
  const child = spawn('npx', ['tsx', 'src/server/index.ts'], {
    cwd: path.resolve(extensionRoot, '..', 'ResumeM-M'),
    detached: true,
    env: { ...process.env, RMM_DATA: dataDir, PORT: String(port), RMM_AUTOCOMMIT: '0' },
    stdio: 'ignore',
  });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const health = await (await fetch(`${url}/health`)).json();
      if (health.projectOpen && health.dataDir === dataDir) break;
    } catch {
      // Not up yet.
    }
    await new Promise((go) => setTimeout(go, 500));
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

    /* ---------------------------------------------------------------- *
     * The store goes away halfway through                               *
     * ---------------------------------------------------------------- */

    group('The store goes away while you are using it');
    {
      doomed = await ownServer(health.dataDir);
      await useServer(context, doomed.url);

      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);

      doomed.kill();
      doomed = null;
      await page.waitForTimeout(1500);

      await cardOf(page).getByRole('button', { name: 'Build resume' }).click();
      await page.waitForTimeout(9000);

      const body = (await cardOf(page).innerText()).replace(/\s+/g, ' ');
      check('it says the store is not there', /not open|not running|start it/i.test(body), body.slice(-140));
      check('and offers a way out', /try again/i.test(body));
      check('the card does not vanish', (await cardOf(page).count()) > 0);
      check('and nothing is thrown at the page', errors.length === 0, errors.join('; '));
      await page.close();
      await useServer(context, SERVER);
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

        await card.getByRole('button', { name: 'Build resume' }).click();
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
  } finally {
    if (doomed) doomed.kill();
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, ['Helios']);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
