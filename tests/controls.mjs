/**
 * The controls that let you correct the tool.
 *
 * Everything else here asks whether the extension gets it right on its own.
 * These are the four things a person reaches for when it has got it wrong:
 * mute this site, un-mute it again, drop a page that does not belong to this
 * application, and start the application over from the page in front of you.
 *
 * None of them had a test. That is the wrong way round — a wrong judgement the
 * user can undo is a small annoyance, and a wrong judgement they cannot undo is
 * the reason somebody turns a tool off. Muting in particular was a one-way
 * door: one click, no warning, and the card never came back on that host.
 *
 * A context of its own, because muting is a setting for the whole browser
 * profile and these fixtures are all served from 127.0.0.1 — muting it inside
 * a shared context would take the card off every other suite's pages too.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/controls.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
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
const HOST = '#jobhelper-card-host';

/** What this suite files under; cleared before it starts as well as after. */
const MINE = ['Helios'];

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

/** Wait for the card to be up and past its provisional state. */
async function settled(page) {
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
  await page.locator(`${HOST} .card:not(.loading)`).waitFor({ timeout: 60_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
}

/**
 * Whether a card ever turns up, answered in full either way.
 *
 * A budget rather than a sleep: when the card is coming this returns as soon
 * as it does, and when it is not — which is what muting is for — it spends the
 * whole budget, which is the only honest way to claim that nothing appeared.
 */
async function cardAppears(page, within = 8000) {
  const until = Date.now() + within;
  for (;;) {
    if ((await cardOf(page).count()) > 0) return true;
    if (Date.now() >= until) return false;
    await page.waitForTimeout(200);
  }
}

/**
 * The pages this tab's application is actually made of.
 *
 * Read out of the worker's own storage rather than asked for over
 * `chrome.runtime.sendMessage`: a service worker does not receive the messages
 * it sends itself, so asking from inside `worker.evaluate` comes back
 * undefined — which reads as "no pages", which is what an emptied trail looks
 * like. Both corrections below appeared to work perfectly for that reason.
 */
async function heldPages(worker, page) {
  return worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab) return ['(no such tab)'];
    const key = `trail:${tab.id}`;
    const stored = (await (chrome.storage.session ?? chrome.storage.local).get(key))[key];
    return (stored?.pages ?? []).map((p) => p.url);
  }, page.url());
}

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }
  await cleanStore(SERVER, MINE);

  const fixtures = await serveFixtures([HELIOS_ROLE, HELIOS_FORM]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-controls-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);
    const extensionId = new URL(worker.url()).host;

    /**
     * The popup, opened as a tab.
     *
     * A real popup is not a tab, so `chrome.tabs.query({active: true})` inside
     * it returns the page behind it. Opened this way the popup *is* the active
     * tab, which is exactly the case `activeTab` now steps around — so this
     * harness exercises that step rather than pretending it is not there.
     */
    const openPopup = async () => {
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
      await popup.locator('#mute').waitFor({ timeout: 20_000 });
      await popup.waitForTimeout(1000);
      return popup;
    };

    /* ---------------------------------------------------------------- *
     * Muting a site, and wanting it back                                 *
     * ---------------------------------------------------------------- */

    group('Muting a site, and getting it back');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      check('the card is there to begin with', (await cardOf(page).count()) > 0);

      await page.bringToFront();
      const popup = await openPopup();
      check(
        'the button offers to mute, not to unmute',
        (await popup.locator('#mute').textContent())?.trim() === 'Mute this site',
      );
      await popup.locator('#mute').click();
      await popup.waitForTimeout(800);

      const said = (await popup.locator('#status').textContent())?.trim() ?? '';
      // The host, not the extension: the popup is the active tab here, and
      // muting itself is the failure this names.
      check('it names the site it muted', /muted 127\.0\.0\.1/i.test(said), said);
      check(
        'and the button turns into the way back',
        (await popup.locator('#mute').textContent())?.trim() === 'Show here again',
      );
      await popup.close();

      const quiet = await context.newPage();
      await quiet.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      check('no card on a muted site', !(await cardAppears(quiet)));
      await quiet.bringToFront();

      /*
       * And back again, which is the half that did not exist. There was no
       * list of muted hosts, no toggle, and nothing saying this site was
       * muted — so the only way to undo one click was to edit extension
       * storage by hand.
       */
      const popup2 = await openPopup();
      check(
        'the popup says so on a site that is muted',
        (await popup2.locator('#mute').textContent())?.trim() === 'Show here again',
      );
      await popup2.locator('#mute').click();
      await popup2.waitForTimeout(800);
      const back = (await popup2.locator('#status').textContent())?.trim() ?? '';
      check('unmuting says what happened', /no longer muted/i.test(back), back);
      await popup2.close();
      await quiet.close();

      const returned = await context.newPage();
      await returned.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      check('and the card comes back', await cardAppears(returned, 20_000));
      await returned.close();
      await page.close();

      const left = await worker.evaluate(() => chrome.storage.sync.get('mutedHosts'));
      check('nothing is left behind in the settings', (left.mutedHosts ?? []).length === 0, JSON.stringify(left));
    }

    /* ---------------------------------------------------------------- *
     * How eager the tool is allowed to be                               *
     * ---------------------------------------------------------------- */

    group('The score a page has to reach before it is looked at');
    {
      /*
       * `minScore` decides whether a page is even sent to the store. It has no
       * control in the popup, which is defensible — it is a number nobody
       * should have to think about — but it is still the knob that governs
       * every offer this tool makes, and nothing checked that turning it did
       * anything at all.
       */
      await worker.evaluate(() => chrome.storage.sync.set({ minScore: 999 }));
      const strict = await context.newPage();
      await strict.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      check('a posting is passed over when the bar is above it', !(await cardAppears(strict)));
      await strict.close();

      await worker.evaluate(() => chrome.storage.sync.remove('minScore'));
      const normal = await context.newPage();
      await normal.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      check('and offered again once it is not', await cardAppears(normal, 20_000));
      await normal.close();
    }

    /* ---------------------------------------------------------------- *
     * Correcting an application the tool has put together wrongly        *
     * ---------------------------------------------------------------- */

    group('Dropping a page that does not belong, and starting over');
    {
      /*
       * Joining the wrong pages into one application is the failure this
       * project has fought hardest, and the card offers two corrections for
       * it: leave this page out, or start again from the one in front of you.
       * Both were untested, which is the wrong thing to leave untested — an
       * escape hatch nobody has opened is not known to open.
       */
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await page.click('a[href*="apply"], a[href*="application"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);

      const card = cardOf(page);
      const trail = card.locator('details.trail');
      await trail.waitFor({ timeout: 20_000 });
      await trail.locator('summary').click();
      const rows = () => card.locator('.trail-row');
      check('both pages are named', (await rows().count()) === 2, `${await rows().count()} rows`);

      // Drop the first of them — the description, the one whose words the
      // letter would otherwise be written from.
      await rows().first().getByRole('button', { name: 'Not this one' }).click();
      await page.waitForTimeout(2500);
      const after = await card.locator('.trail-row').count();
      // The list hides itself below two pages — it would be saying "this
      // page" — so the rows going is the expected sign, and the count that
      // matters is the one in the worker's own storage below.
      check('the list of pages puts itself away', after === 0, `${after} rows`);

      /*
       * Asked of the worker rather than the card, because the card showing one
       * row proves only that the card was redrawn. What matters is that the
       * page is out of the application the next letter is written from.
       */
      const held = await heldPages(worker, page);
      check(
        'the page dropped is gone from the application',
        !held.some((u) => u.endsWith('/helios/roles/platform-engineer')),
        held.join(' | ') || '(none)',
      );
      // And exactly one page left, not none. Dropping one of two must leave
      // the other — an empty trail here would mean the form you are standing
      // on stopped being part of its own application.
      check('and the page kept is still there', held.length === 1, `${held.length}: ${held.join(' | ') || '(none)'}`);
      await page.close();
    }

    group('Starting a new application on the page in front of you');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await page.click('a[href*="apply"], a[href*="application"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);

      const card = cardOf(page);
      await card.locator('details.trail summary').click();
      await card.getByRole('button', { name: 'Start a new application here' }).click();
      await page.waitForTimeout(2500);

      const held = await heldPages(worker, page);
      check('the pages before this one are let go', held.length === 1, `${held.length} pages: ${held.join(' | ') || '(none)'}`);
      check(
        'and the page you are on is the one kept',
        held.length === 1 && held[0].includes('/apply/'),
        held.join(' | ') || '(none)',
      );

      /*
       * And the toolbar agrees. This is the half that made the old behaviour
       * more than a miscount: the badge went blank and the title fell back to
       * plain "JobHelper", so the tool reported no application open while the
       * user stood on the form of one.
       */
      const mark = await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        return {
          text: await chrome.action.getBadgeText({ tabId: tab.id }),
          title: await chrome.action.getTitle({ tabId: tab.id }),
        };
      }, page.url());
      check('the toolbar still says an application is open', mark.text === '1', `badge "${mark.text}"`);
      check('and still names it', /helios/i.test(mark.title), mark.title);

      /*
       * The popup's button means the other thing, and says so: "Start fresh",
       * pressed from the popup rather than from the page, is the user saying
       * they are done with this application altogether. It empties the trail,
       * and must keep doing so — the card's `keep` is what tells the two
       * apart.
       */
      await page.bringToFront();
      const popup = await openPopup();
      await popup.locator('#dropApplication').click();
      await popup.waitForTimeout(1200);
      await popup.close();
      const afterDrop = await heldPages(worker, page);
      check('the popup drops the whole application', afterDrop.length === 0, afterDrop.join(' | ') || '(none)');
      await page.close();
    }
    /* ---------------------------------------------------------------- *
     * The one place the extension writes into the store                  *
     * ---------------------------------------------------------------- */

    group('Saving an answer for next time');
    {
      /*
       * "Save for next time" puts what you just typed into the answer bank —
       * the only write the card makes into the store's own writing, and the
       * one that matters most now that the store holds real work. Nothing
       * drove it: no test clicked the button and none named the message behind
       * it, so a bug here would have landed in somebody's answers.yaml with a
       * 200 back and nothing said.
       *
       * The bank is put back exactly as it was at the end, because this suite
       * shares a store with every other one.
       */
      const bankNow = async () => (await fetch(`${SERVER}/api/store`).then((r) => r.json())).answers ?? [];
      const before = await bankNow();

      try {
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
        await settled(page);

        const card = cardOf(page);
        const box = card.locator('.q textarea').first();
        await box.waitFor({ timeout: 20_000 });
        const said = `Because of the pipelines you publish — ${Date.now()}`;
        await box.click();
        await box.fill(said);
        await page.waitForTimeout(400);

        await card.getByRole('button', { name: 'Save for next time' }).first().click();
        await page.waitForTimeout(2500);

        const after = await bankNow();
        const holds = (list) => JSON.stringify(list).includes(said);
        check('the answer reaches the bank', holds(after), `${before.length} → ${after.length} answers`);

        /*
         * And nothing else in it moved. An answer bank is somebody's writing
         * built up over months; a save that rewrites the file is one bad
         * round-trip away from taking the rest of it with them.
         */
        const kept = before.every((b) => after.some((a) => a.id === b.id));
        check('and every answer that was there is still there', kept, `${before.length} before, ${after.length} after`);
        await page.close();

        /*
         * Saving the same question twice.
         *
         * The second time round the question matches the bank item the first
         * save made, so the card sends its id and the store adds a phrasing to
         * that item instead of filing the question again. Worth pinning both
         * halves: one item, and the older phrasing still in it.
         *
         * It also moves that item's `default` to the phrasing just saved — so
         * a button labelled "Save for next time" quietly changes which answer
         * is used from now on, including over a default chosen by hand in the
         * editor. That is defensible (the newest is usually the most relevant)
         * and it is not what the label says, so it is recorded here rather
         * than changed: it is the owner's answer bank and their call.
         */
        const again = await context.newPage();
        await again.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
        await settled(again);
        const secondBox = cardOf(again).locator('.q textarea').first();
        await secondBox.waitFor({ timeout: 20_000 });
        const alsoSaid = `A second way of putting it — ${Date.now()}`;
        await secondBox.click();
        await secondBox.fill(alsoSaid);
        await again.waitForTimeout(400);
        await cardOf(again).getByRole('button', { name: 'Save for next time' }).first().click();
        await again.waitForTimeout(2500);

        const twice = await bankNow();
        const forThisQuestion = twice.filter((a) => /why do you want to work here/i.test(a.question ?? ''));
        check(
          'asking the same question again adds a phrasing, not a second question',
          forThisQuestion.length === 1,
          `${forThisQuestion.length} entries for that question`,
        );
        const variants = forThisQuestion[0]?.variants ?? [];
        check(
          'and the phrasing saved before it is still there',
          variants.some((v) => v.text === said) && variants.some((v) => v.text === alsoSaid),
          `${variants.length} phrasings`,
        );
        const fresh = variants.find((v) => v.text === alsoSaid);
        check(
          'the newest becomes the one used from now on, which the label does not say',
          forThisQuestion[0]?.default === fresh?.id,
          `default is ${forThisQuestion[0]?.default}`,
        );
        await again.close();
      } finally {
        /*
         * Whatever happened above, the bank goes back the way it was found —
         * and says so if it cannot. This was a POST to a route that only takes
         * PUT, with the failure swallowed: the restore 404'd every time, the
         * suite reported nothing, and each run left another phrasing behind in
         * a store the other suites share. A cleanup that fails quietly is
         * worse than no cleanup, because it is the one nobody checks.
         */
        const put = await fetch(`${SERVER}/api/answers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(before),
        }).catch((err) => ({ ok: false, status: String(err.message ?? err) }));
        check('the answer bank is put back as it was found', put.ok, `restore said ${put.status}`);
      }
    }
  } finally {
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
