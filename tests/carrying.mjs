/**
 * Wandering off in the middle of an application.
 *
 * Applying takes a while, and in the middle of it people leave the form. They
 * go and read the company's About page, or look up what the posting pays, or
 * open the documentation for something it mentioned. Every one of those is a
 * page this tool is right to stay quiet on — and quiet is indistinguishable
 * from having forgotten. The description, the resume and the half-written
 * letter are all still held, and until now nothing said so, which made the
 * only safe assumption "leaving the form threw my work away".
 *
 * So this walks the wandering rather than the application: build something on
 * a posting, leave for somewhere unrelated, and ask whether the tool still
 * says an application is open, still says whose, still says your writing is
 * safe — and whether it can put you back on it.
 *
 *   node tests/carrying.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BLOG,
  CYGNUS_ROLE_A,
  DOCS,
  HELIOS_ROLE,
  HELIOS_FORM,
  cleanStore,
  findChromium,
  serveFixtures,
  requireOpenSave,
  pointExtensionAt,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';

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

const HOST = '#jobhelper-card-host';
const cardOf = (page) => page.locator(`${HOST} .card`);

async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 25_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 25_000 });
  await page.waitForTimeout(1800);
}

/**
 * What the toolbar says about this tab.
 *
 * Read from the worker rather than from a screenshot, because the badge is
 * browser chrome and a page cannot see it — and because the text and the
 * hover title are two different promises, both of which matter.
 */
async function toolbar(worker, page) {
  return worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab) return { text: '', title: '', found: false };
    return {
      found: true,
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      title: await chrome.action.getTitle({ tabId: tab.id }),
    };
  }, page.url());
}

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }

  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-carry-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    const page = await context.newPage();

    group('On the posting');
    {
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const mark = await toolbar(worker, page);
      check('the toolbar says an application is open', mark.text !== '', `badge "${mark.text}"`);
      check('and says whose it is', /helios/i.test(mark.title), mark.title);
    }

    group('Following Apply to the form, and writing something');
    {
      await page.click('a[href*="apply"], a[href*="application"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);

      const card = cardOf(page);
      /*
       * `.tall` and not the first textarea on the card. The first is "Anything
       * to change?", the box that steers the next tailoring run — a test that
       * typed into it proved only that the notes box is not the letter.
       */
      const letter = card.locator('textarea.tall').first();
      await letter.waitFor({ timeout: 20_000 });
      await letter.click();
      await letter.pressSequentially('I have wanted to work on this for years.', { delay: 8 });
      // The keeper writes on an interval; give it one to fire.
      await page.waitForTimeout(2500);

      const mark = await toolbar(worker, page);
      check('the toolbar counts both pages', mark.text === '2', `badge "${mark.text}"`);
      check('and says the writing is being held', /writing is being held/i.test(mark.title), mark.title);
    }

    group('Leaving for a page that has nothing to do with it');
    {
      await page.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      check('no card on it, as it should be', (await cardOf(page).count()) === 0);

      const mark = await toolbar(worker, page);
      check(
        'but the toolbar still says the application is open',
        mark.text === '2',
        `badge "${mark.text}"`,
      );
      check('still names it', /helios/i.test(mark.title), mark.title);
      check('and still promises the writing is safe', /writing is being held/i.test(mark.title), mark.title);
    }

    group('And on a second unrelated page, two navigations later');
    {
      await page.goto(fixtures.urlFor(DOCS), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const mark = await toolbar(worker, page);
      check('the mark has not worn off', mark.text === '2', `badge "${mark.text}"`);
    }

    group('Going back to the form');
    {
      await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const card = cardOf(page);
      const text = await card.locator('textarea.tall').first().inputValue();
      check('the letter is still there, word for word', /wanted to work on this for years/i.test(text), text.slice(0, 60));

      /*
       * And no draft was started to be thrown away. The automatic draft waits
       * to hear whether a letter was carried here; if one was, there is
       * nothing to draft. With the AI on, a draft started here is minutes of
       * somebody's budget spent on a letter they had already written — and
       * the only visible trace of it is the line saying it was not used, so
       * that line is what this looks for.
       */
      const body = (await card.textContent()) ?? '';
      check(
        'and no draft was run just to be discarded',
        !/while this was running|offered rather than used/i.test(body),
      );
    }

    group('And the toolbar window says the same thing, in sentences');
    {
      await page.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/src/popup/popup.html`);
      /*
       * A real popup is not a tab, so it asks about the tab underneath it.
       * Opened here it is one, so put the page back in front and let the
       * popup boot again from there — otherwise it would report on itself.
       */
      await page.bringToFront();
      await popup.evaluate(() => location.reload());
      await popup.locator('#openApplication').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);

      check('the panel is showing', !(await popup.locator('#openApplication').isHidden()));
      const who = (await popup.locator('#openWho').textContent())?.trim();
      check('and names the application', who === 'Helios', who);
      const what = (await popup.locator('#openWhat').textContent())?.trim() ?? '';
      check('says how much of it has been read', /2 pages/.test(what), what);
      check('and that the writing is safe', /writing is being held/i.test(what), what);

      // The way back: the last page of it, in the tab it belongs to.
      await popup.locator('#backToApplication').click();
      await page.waitForURL(/helios\/apply/, { timeout: 15_000 }).catch(() => undefined);
      check('"Back to it" returns to where you were', /helios\/apply/.test(page.url()), page.url());
      await popup.close().catch(() => undefined);
    }

    group('Out to the builder to add a phrasing, and back');
    {
      /*
       * The reason to go is that this posting wants a bullet the store does
       * not have. Coming back to a proposal built before it existed is the
       * half of that trip nobody built, and there is nothing on the card to
       * say the thing you just went and wrote is not in it.
       */
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const card = cardOf(page);

      const before = (await card.textContent()) ?? '';
      check('nothing says the store changed, because it has not', !/been editing the store/i.test(before));

      const opened = context.waitForEvent('page');
      await card.getByRole('button', { name: 'Edit in ResumeM-M' }).click();
      const editor = await opened;
      check('the builder opens on this resume', /#resumes\//.test(editor.url()), editor.url());

      // Coming back is what the card is watching for.
      await page.bringToFront();
      await page.waitForFunction(
        () => {
          const c = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          return /been editing the store/i.test(c?.textContent ?? '');
        },
        undefined,
        { timeout: 10_000, polling: 100 },
      ).catch(() => undefined);

      const after = (await card.textContent()) ?? '';
      check('on returning, the card says the match may be out of date', /been editing the store/i.test(after));
      check('and offers to redo it rather than doing it', /match it again/i.test(after));
      await editor.close();
    }

    group('Two applications open at once, each minding its own');
    {
      /*
       * The tab is the application, and the mark has to agree: applying to
       * two places in two tabs is ordinary, and a toolbar that reported the
       * other one's company would be worse than reporting nothing — it is
       * the same mistake as a cover letter addressed to the wrong employer,
       * made somewhere you would believe it.
       */
      const second = await context.newPage();
      await second.goto(fixtures.urlFor(CYGNUS_ROLE_A), { waitUntil: 'domcontentloaded' });
      await settled(second);

      const theirs = await toolbar(worker, second);
      check('the new tab names its own', /cygnus/i.test(theirs.title), theirs.title);

      await page.bringToFront();
      const ours = await toolbar(worker, page);
      check('and the first tab still names Helios', /helios/i.test(ours.title), ours.title);
      check('with its own page count', ours.text === '2', `badge "${ours.text}"`);
      check('not the other one’s', !/cygnus/i.test(ours.title), ours.title);
      await second.close();
    }

    group('A tab that was never on a posting is not marked');
    {
      const clean = await context.newPage();
      await clean.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
      await clean.waitForTimeout(2500);
      const mark = await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const last = tabs[tabs.length - 1];
        return { text: await chrome.action.getBadgeText({ tabId: last.id }), title: await chrome.action.getTitle({ tabId: last.id }) };
      });
      check('no badge on it', mark.text === '', `badge "${mark.text}"`);
      check('and the plain title', mark.title === 'JobHelper', mark.title);
      await clean.close();
    }
  } finally {
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, ['Helios', 'Cygnus']);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
