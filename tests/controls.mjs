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
import http from 'node:http';
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
  serveSlowProxy,
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

/**
 * The whole stored trail, not only its pages.
 *
 * `save` — which store this application is being built from — is kept in the
 * trail rather than in the worker, precisely so it survives the worker being
 * stopped. Reading only `pages` cannot see it go missing.
 */
async function storedTrail(worker, page) {
  return worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab) return null;
    const key = `trail:${tab.id}`;
    return (await (chrome.storage.session ?? chrome.storage.local).get(key))[key] ?? null;
  }, page.url());
}

/** The cap `sweepOrphans` holds the count to, plus the one it just wrote. */
const ORPHAN_BOUND = 21;

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
     * Two looks at the server, and the slower one arriving last          *
     * ---------------------------------------------------------------- */

    /*
     * `check` runs on boot and again every time the address changes, and a
     * fetch against an address that swallows packets takes as long as its
     * deadline to give up. Point the box at one of those, then at a server
     * that is actually running: the second look answers in milliseconds and
     * says "Connected", and then the first one's failure lands on top of it,
     * blanks the picker to "— not connected —" and reports the live server as
     * down. The function's own note is about the same disagreement in the
     * other direction, which is what made this worth looking for.
     */
    group('The address is changed while the last look is still waiting');
    {
      // A proxy to nothing, slow to admit it: the shape of a server that is
      // no longer there but whose socket still accepts.
      const nowhere = await serveSlowProxy('http://127.0.0.1:1', { slowRoute: /health/, ms: 4000 });
      const page = await openPopup();
      try {
        const setAddress = async (url) => {
          await page.fill('#serverUrl', url);
          await page.locator('#serverUrl').dispatchEvent('change');
        };

        await setAddress(nowhere.base);
        // No wait: the point is that the first look is still in the air.
        await setAddress(SERVER);

        // Long enough for the slow one to give up and try to have its say.
        await page.waitForTimeout(7000);
        const said = (await page.locator('#status').textContent())?.trim() ?? '';
        check('the live server is reported as connected', /connected/i.test(said), said);
        check('and not as unreachable, by the look that was overtaken', !/not (running|connected)/i.test(said), said);
        const picker = (await page.locator('#baseResumeId').textContent())?.trim() ?? '';
        check('and the picker still holds its resumes', !/not connected/i.test(picker), picker.slice(0, 60));
      } finally {
        await page.close().catch(() => undefined);
        nowhere.close();
      }
    }

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
       * And it still knows which save it is being built from.
       *
       * That binding is held in the trail rather than in the worker so that
       * it survives the worker being stopped, and this was the one writer
       * that rebuilt the trail from scratch instead of spreading it — so the
       * binding was dropped and lived on only in the worker's memory. It went
       * on working until the worker was stopped, and then "Build resume"
       * produced a perfectly good document and refused to file it: "JobHelper
       * has lost track of which save this application was built from."
       *
       * Which save you are working in is not something "use only this page"
       * says anything about. The pages are what is being forgotten.
       */
      const kept = await storedTrail(worker, page);
      check(
        'and which save it is being built from survives the pages being dropped',
        Boolean(kept?.save),
        `save ${JSON.stringify(kept?.save ?? null)}`,
      );

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

    /*
     * "Start fresh" is pressed in the middle of a letter.
     *
     * Forgetting an application and destroying what was written for it are two
     * different things, and every other path already knew it: closing the tab
     * parks the writing, and `remember`'s own fresh start parks it with the
     * reason written out — "nothing is destroyed either, which is the failure
     * it was causing". `clearTrail`, which is what this button sends, dropped
     * `trail.work` on the floor.
     *
     * The popup is the worst place for that to happen. Two lines above the
     * button its own panel says "your writing is being held, and comes back
     * when you return", and the status afterwards reads "Forgotten." So the
     * same intent had two outcomes, and the destructive one was the one that
     * had just promised otherwise.
     *
     * The trail still empties — that is what the button is for, and the check
     * above it stays. What changes is that the letter is parked under the
     * pages being let go, so coming back to the posting finds it.
     */
    group('Forgetting an application written into');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(page);

      const letter = cardOf(page).locator('textarea.tall').first();
      await letter.waitFor({ timeout: 20_000 });
      await letter.click();
      await letter.pressSequentially('Written before I pressed Start fresh.', { delay: 8 });
      // The keeper writes on an interval; give it one.
      await page.waitForTimeout(2600);

      await page.bringToFront();
      const popup = await openPopup();
      await popup.locator('#dropApplication').click();
      await popup.waitForTimeout(1200);
      await popup.close();

      const emptied = await heldPages(worker, page);
      check('the application is forgotten, as the button says', emptied.length === 0, emptied.join(' | ') || '(none)');

      await page.close();
      await new Promise((go) => setTimeout(go, 1200));

      const back = await context.newPage();
      await back.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(back);
      await back.waitForTimeout(1500);
      const written = await cardOf(back).locator('textarea.tall').first().inputValue();
      check(
        'and the letter written for it is still reachable',
        /before i pressed start fresh/i.test(written),
        written.slice(0, 60) || '(empty)',
      );
      await back.close();
    }

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

        /*
         * Labelled with the employer it was written for.
         *
         * The store works out which employers it has written answers for from
         * the labels on them, and refuses to call an answer safe to send
         * unread when it names a *different* one. The card sent no label, so
         * everything it saved was filed as "Saved", the store's list of
         * employers was the word "Saved", and that check could never fire —
         * which is how an answer opening "Acme is why I applied" comes back
         * for another company already in the box and badged "answered
         * before".
         */
        const mine = after.find((a) => JSON.stringify(a).includes(said));
        const label = mine?.variants?.find((v) => v.text === said)?.label ?? '';
        check(
          'and it is filed under the employer it was written for',
          /helios/i.test(label),
          `labelled "${label}"`,
        );
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
    group('The list you start from, as the store fills up');
    {
      /*
       * Every filed application leaves a resume behind, named `job-<company>-
       * <role>` by the store. They were listed flat and alphabetical beside
       * the handful somebody actually starts from — so a store four
       * applications old already reads "Base resume, Summer intern, Acme —
       * 127.0.0.1, Role — Acme, …", and after a year of applying the
       * starting points are unfindable.
       *
       * Two resumes are added here and removed again, because this store is
       * shared with every other suite.
       */
      /*
       * `tier: 'temporary'` because that is what the store puts on a resume
       * it builds for a posting, and this is standing in for two of those.
       * A bare PUT gets no tier and is therefore kept, which is the right
       * default for a resume created by hand or from the CLI — it is just
       * not what these two are pretending to be.
       */
      /*
       * With the base's own sections, not empty ones.
       *
       * Fit decides the order and this company only breaks a tie — which is
       * the right way round, and means a resume with nothing in it scores
       * nothing and sorts last however well the employer matches. An empty
       * stand-in therefore tests the tiebreak by never reaching it. These two
       * carry what the base carries, so they are level with everything else
       * in the group and the employer is what separates them.
       */
      const sections = await fetch(`${SERVER}/api/resumes`)
        .then((r) => r.json())
        .then((all) => all.find((r) => r.id === 'base')?.sections ?? [])
        .catch(() => []);

      const put = (id, label, tier = 'temporary') =>
        fetch(`${SERVER}/api/resumes/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, sections, tier }),
        });
      const drop = (id) =>
        fetch(`${SERVER}/api/resumes/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => undefined);

      await put('job-helios-platform-engineer', 'Platform Engineer — Helios');
      await put('job-zzzother-data-scientist', 'Data Scientist — ZzzOther');
      try {
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
        await settled(page);

        const shape = await page.evaluate(() => {
          const sel = document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('select');
          if (!sel) return null;
          return [...sel.children]
            .filter((n) => n.tagName === 'OPTGROUP')
            .map((g) => ({ label: g.label, options: [...g.children].map((o) => o.textContent) }));
        });

        // By name rather than by position: the save this runs against also
        // holds whatever other suites left in it, so which groups exist is
        // not something this check should be asserting.
        const labels = (shape ?? []).map((g) => g.label);
        check(
          'the list is grouped rather than one flat run',
          labels.includes('Bases') && labels.includes('Built for a posting'),
          JSON.stringify(labels),
        );

        const yours = shape?.find((g) => g.label === 'Bases');
        check(
          'your own resumes come first',
          Boolean(yours)
            && labels.indexOf('Bases') === 0
            && yours.options.some((o) => /^Base resume/.test(o))
            && !yours.options.some((o) => /—\s(Helios|ZzzOther)\b/.test(o)),
          JSON.stringify(yours?.options),
        );

        /*
         * And the one built for this company at the top of the rest, among
         * the ones it is level with: applying to somewhere you have applied
         * before, what you sent them last time is the most useful thing to
         * start from and was the hardest to find. Only a tiebreak, though —
         * a resume that suits this posting better still sorts above it,
         * which is what a ranked list is for.
         */
        /*
         * By the name, whatever mark is in front of it. The star is the
         * store's separate judgement of which resumes are clearly ahead, and
         * whether one of these two earns it depends on how the rest of this
         * shared save happens to score — it was read here as part of the
         * name, so the order passed and the check failed on "★ Platform
         * Engineer — Helios".
         */
        const built = shape?.find((g) => g.label === 'Built for a posting');
        check(
          'and this company is first among the ones built for a posting',
          built?.options?.[0]?.replace(/^★\s*/, '').startsWith('Platform Engineer — Helios'),
          JSON.stringify(built?.options?.slice(0, 3)),
        );
        await page.close();
      } finally {
        await drop('job-helios-platform-engineer');
        await drop('job-zzzother-data-scientist');
      }
    }
    /* ---------------------------------------------------------------- *
     * The popup saying something true about itself                       *
     * ---------------------------------------------------------------- */

    group('A resume the picker was set to and the save no longer has');
    {
      /*
       * Nothing in the list matches the stored choice, so the browser quietly
       * selects the first option — and because that is not a change anybody
       * made, no `change` event fires and nothing is written back. The picker
       * then read confidently as one resume while every page's card failed
       * with `No resume "newgrad"`, naming an id its owner had never typed
       * and pointing at a picker that looked correctly set.
       *
       * Set and put back, because this store is shared with the suites
       * running beside this one.
       */
      const worker0 = context.serviceWorkers()[0];
      const before = await worker0.evaluate(async () => (await chrome.storage.sync.get(['baseResumeId'])).baseResumeId);
      await worker0.evaluate(async () => chrome.storage.sync.set({ baseResumeId: 'no-such-resume-here' }));
      try {
        const popup = await openPopup();
        const said = (await popup.locator('#status').textContent())?.trim() ?? '';
        check(
          'the popup says the resume it was set to has gone',
          /not in this save any more/i.test(said),
          said.slice(0, 120),
        );
        check('and says so as a problem, not as "Connected"', !/^Connected —/.test(said), said.slice(0, 60));

        // And nothing valid is left looking chosen, which the status line
        // alone cannot fix: a picker reading a real resume is a claim.
        const chosen = await popup.locator('#baseResumeId').evaluate((sel) => {
          const o = sel.selectedOptions[0];
          return { text: o?.textContent ?? '', disabled: Boolean(o?.disabled) };
        });
        check(
          'and the picker does not claim one of them is in force',
          chosen.disabled && /pick a resume/i.test(chosen.text),
          JSON.stringify(chosen),
        );
        await popup.close();
      } finally {
        await worker0.evaluate(
          async (id) => chrome.storage.sync.set({ baseResumeId: id }),
          before ?? 'base',
        );
      }
    }

    group('A page that is running, and has a reason of its own');
    {
      /*
       * `sendMessage` rejecting means there is nobody to receive it, and
       * reloading really does fix that. A content script that answers
       * `{ok: false, error}` is running and saying what went wrong — and that
       * sentence used to be thrown inside the same `try` as the bare `catch`
       * for the other failure, so it was swallowed and replaced with
       * "JobHelper is not running on this page. Reload the tab and try
       * again." Reloading changes nothing and the message never changes, so
       * the one instruction on screen is the one that cannot work.
       *
       * Everything goes to the real store except the one call autofill makes,
       * which is refused with a sentence only the store could have written.
       */
      const REFUSAL = 'Your profile has no name or email in it yet.';
      const proxy = await new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
          if (req.url.startsWith('/api/autofill')) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: REFUSAL }));
            return;
          }
          const chunks = [];
          for await (const chunk of req) chunks.push(chunk);
          const upstream = await fetch(`${SERVER}${req.url}`, {
            method: req.method,
            headers: { 'content-type': req.headers['content-type'] ?? 'application/json' },
            body: req.method === 'GET' || req.method === 'HEAD' ? undefined : Buffer.concat(chunks),
          }).catch(() => null);
          if (!upstream) {
            res.writeHead(502).end('{}');
            return;
          }
          const body = Buffer.from(await upstream.arrayBuffer());
          res.writeHead(upstream.status, {
            'content-type': upstream.headers.get('content-type') ?? 'application/json',
          });
          res.end(body);
        });
        server.listen(0, '127.0.0.1', () => resolve({
          url: `http://127.0.0.1:${server.address().port}`,
          close: () => server.close(),
        }));
      });

      try {
        await pointExtensionAt(context, context.serviceWorkers()[0], proxy.url);
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
        await settled(page);

        await page.bringToFront();
        const popup = await openPopup();
        await popup.locator('#autofill').click();
        await popup.waitForTimeout(2000);
        const said = (await popup.locator('#status').textContent())?.trim() ?? '';
        check('the page’s own reason is what the popup shows', /no name or email/i.test(said), said.slice(0, 140));
        check(
          'and not advice to reload a page that is already running',
          !/not running on this page/i.test(said),
          said.slice(0, 140),
        );
        await popup.close();
        await page.close();
      } finally {
        proxy.close();
        await pointExtensionAt(context, context.serviceWorkers()[0], SERVER);
      }
    }

    group('A server that is there but not answering with its settings');
    {
      /*
       * `aiStatus` is the one server call in the worker that does not go
       * through `serverFetch`, and it had neither of the two things
       * `serverFetch` gives everything else: a deadline, and a check that the
       * reply says it worked.
       *
       * So a 503 carrying `{"error": "The store is still starting up."}` was
       * parsed as a health payload. It has no `ai` in it, so the panel
       * concluded no AI was configured — about a server that has one and was
       * merely restarting — and offered a button to go and set up what was
       * already set up, directly above a status line reporting the real
       * problem.
       */
      const proxy = await new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          if (req.url.startsWith('/health')) {
            res.writeHead(503, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'The store is still starting up.' }));
            return;
          }
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: 'The store is still starting up.' }));
        });
        server.listen(0, '127.0.0.1', () => resolve({
          url: `http://127.0.0.1:${server.address().port}`,
          close: () => server.close(),
        }));
      });

      try {
        await pointExtensionAt(context, context.serviceWorkers()[0], proxy.url);
        const popup = await openPopup();
        await popup.waitForTimeout(1500);

        const ai = (await popup.locator('#aiState').textContent())?.trim() ?? '';
        const hint = (await popup.locator('#aiHint').textContent())?.trim() ?? '';
        check('it does not claim the AI is unconfigured', !/no ai set up/i.test(ai), `${ai} / ${hint}`);
        check('it says the setting could not be read', /AI unknown/i.test(ai), ai);
        check(
          'and does not offer to set up what is already set up',
          !/set (one )?up/i.test(hint),
          hint.slice(0, 120),
        );
        await popup.close();
      } finally {
        proxy.close();
        await pointExtensionAt(context, context.serviceWorkers()[0], SERVER);
      }
    }

    /*
     * The other half of the pair of switches, and the half with no way out.
     *
     * Both have to agree before anything is sent to an AI. `server-off` — on
     * here, off in ResumeM-M — has been a chip you can press for a while. The
     * mirror of it was a tooltip: turn the AI on in ResumeM-M, which is where
     * the command and the model live and so where somebody setting one up is
     * sitting, and the card reads "AI off" with nothing to press and nothing
     * saying the second switch is behind the toolbar icon.
     *
     * Reported from life: "AI is off even though it is on in ResumeM-M."
     *
     * Through a proxy that says the AI is on rather than by turning it on in
     * the store, because every other suite shares that store and an AI that is
     * really on would start really running.
     */
    group('ResumeM-M has its AI on and this extension does not');
    {
      const upstream = SERVER.replace(/\/$/, '');
      const proxy = await new Promise((resolve) => {
        const server = http.createServer(async (req, res) => {
          const body = [];
          for await (const chunk of req) body.push(chunk);
          const up = await fetch(`${upstream}${req.url}`, {
            method: req.method,
            headers: Object.fromEntries(
              Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)),
            ),
            body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(body),
          }).catch(() => null);
          if (!up) {
            res.writeHead(502).end('{}');
            return;
          }
          const text = await up.text();
          if (req.url.startsWith('/health') && up.ok) {
            const health = JSON.parse(text);
            health.ai = { ...health.ai, enabled: true, configured: true };
            res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(health));
            return;
          }
          res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' }).end(text);
        });
        server.listen(0, '127.0.0.1', () => resolve({
          url: `http://127.0.0.1:${server.address().port}`,
          close: () => server.close(),
        }));
      });

      try {
        await pointExtensionAt(context, context.serviceWorkers()[0], proxy.url);
        // Never opted in, which is every profile to begin with and the state
        // being reported.
        await context.serviceWorkers()[0].evaluate(() => chrome.storage.sync.remove('useAi'));

        const page = await context.newPage();
        await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
        await settled(page);
        const chip = cardOf(page).locator('.ai');
        await chip.waitFor({ timeout: 20_000 });
        await page.waitForTimeout(1200);

        const said = (await chip.innerText()).trim();
        check(
          'the chip names which switch is off, rather than saying only "AI off"',
          /jobhelper/i.test(said),
          said,
        );
        check(
          'and it is something to press',
          ((await chip.getAttribute('class')) ?? '').includes('actionable'),
          (await chip.getAttribute('class')) ?? '',
        );

        await chip.click({ timeout: 5000 }).catch(() => undefined);
        await page.waitForTimeout(2500);
        const now = (await chip.innerText()).trim();
        check('pressing it turns the AI on', /^ai on$/i.test(now), now);
        check(
          "and the extension's own switch is what was set",
          (await context.serviceWorkers()[0].evaluate(async () => (await chrome.storage.sync.get('useAi')).useAi)) === true,
        );
        await page.close();
      } finally {
        await context.serviceWorkers()[0].evaluate(() => chrome.storage.sync.remove('useAi')).catch(() => undefined);
        proxy.close();
        await pointExtensionAt(context, context.serviceWorkers()[0], SERVER);
      }
    }

    group('The AI hint before anything is known about it');
    {
      /*
       * `popup.html` shipped the "off" hint as its initial text — and not the
       * current one either, but the sentence `AI_STATE.off` documents as
       * retired, about an automatic decision that no longer happens. The one
       * moment the panel is certain to be read, before it has any news, was
       * the moment it was wrong twice over.
       */
      const html = fs.readFileSync(path.join(extensionRoot, 'src/popup/popup.html'), 'utf8');
      const initial = /id="aiHint"[^>]*>([^<]*)</.exec(html)?.[1]?.trim() ?? '';
      check(
        'it does not ship the retired sentence about tag matching',
        !/tag matching is instant and free/i.test(initial),
        initial.slice(0, 120),
      );
      check('it says it is still reading it', /reading/i.test(initial), initial.slice(0, 120));
    }

    group('A failure the popup can offer a way out of');
    {
      /*
       * `serverFetch` marks the two failures somebody can act on in one press
       * — no save open, server not running — and the card on a job page turns
       * that mark into "Open a save in ResumeM-M". The popup's `send` kept
       * only the sentence and dropped the mark, so the identical failure was a
       * red line and nothing to press, in the window people open *because*
       * they are checking the connection.
       */
      const proxy = await new Promise((resolve) => {
        const server = http.createServer((req, res) => {
          if (req.url.startsWith('/health')) {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ ok: true, projectOpen: false, dataDir: null, ai: { enabled: false, configured: false } }));
            return;
          }
          res.writeHead(409, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ kind: 'no-project', error: 'No save is open in ResumeM-M.' }));
        });
        server.listen(0, '127.0.0.1', () => resolve({
          url: `http://127.0.0.1:${server.address().port}`,
          close: () => server.close(),
        }));
      });

      try {
        await pointExtensionAt(context, context.serviceWorkers()[0], proxy.url);
        const popup = await openPopup();
        await popup.waitForTimeout(1500);

        const said = (await popup.locator('#status').textContent())?.trim() ?? '';
        check('it still says what is wrong', /no save is open/i.test(said), said.slice(0, 120));

        const button = popup.locator('#status button');
        check('and offers the button that fixes it', (await button.count()) > 0, said.slice(0, 120));
        if (await button.count()) {
          check(
            'named for what pressing it does',
            /open a save in resumem-m/i.test((await button.first().textContent()) ?? ''),
            (await button.first().textContent()) ?? '',
          );
        }
        await popup.close();
      } finally {
        proxy.close();
        await pointExtensionAt(context, context.serviceWorkers()[0], SERVER);
      }
    }

    /*
     * The card's own way out of the same failure.
     *
     * A posting opened while ResumeM-M is not running gets a card saying so,
     * with "Try again" beside "Open ResumeM-M". Starting the store and
     * pressing it is the whole recovery, and it has to leave the card as it
     * would have been had the store been there: the page's read is a whole
     * pass, and a card given only a proposal has no trail behind it, nothing
     * carried from the page before, and a keeper that never saves.
     */
    group('The page could not be read, and Try again');
    {
      await pointExtensionAt(context, worker, 'http://127.0.0.1:1');
      const page = await context.newPage();
      try {
        await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
        const card = cardOf(page);
        const retry = card.getByRole('button', { name: 'Try again' });
        await retry.waitFor({ timeout: 30_000 });
        check('the card says the store is not there, and offers Try again', true);

        await pointExtensionAt(context, worker, SERVER);
        await retry.click();
        await card.getByRole('button', { name: 'Build resume' }).waitFor({ timeout: 60_000 });
        await page.waitForTimeout(1500);
        const count = ((await card.locator('.diff-head .count').first().textContent({ timeout: 5_000 }).catch(() => '')) ?? '').trim();
        check(
          'it offers the keyword suggestions an ordinary read does',
          Number(count.match(/(\d+) changes?$/)?.[1] ?? 0) > 0,
          count || '(no list of changes)',
        );
        // The keeper runs every two seconds; give it three turns.
        let held = null;
        for (let i = 0; i < 6 && !held; i++) {
          await page.waitForTimeout(1000);
          held = (await storedTrail(worker, page))?.work ?? null;
        }
        check('and what is on the card is kept, as on any other page', Boolean(held?.spec), held ? 'held' : 'nothing held');
      } finally {
        await page.close().catch(() => undefined);
        await pointExtensionAt(context, worker, SERVER);
      }
    }

    group('A resume that will not fit on one page');
    {
      /*
       * The one-page rule is the product's whole promise, so the moment it is
       * broken is a moment somebody meets — and it was a dead end. The card
       * said "2 pages — about 23 lines too long." and stopped: no advice, no
       * way on, at the one place the overflow is ever discovered, which is
       * mid-application with a form already open.
       *
       * The builder had said "pick a shorter phrasing or drop a bullet" at its
       * own version of the same message all along. The card, where people
       * actually meet it, said less and offered nothing.
       */
      const overflow = 'controls-overflow';
      await fetch(`${SERVER}/api/resumes/${overflow}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // Absurd margins, purely to reach the state. Nothing else here can
        // make a resume too long without writing entries into the store.
        body: JSON.stringify({ label: 'Overflow', extends: 'newgrad', layout: { marginIn: 2.6, autoFit: false, maxPages: 1 } }),
      });

      try {
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
        await settled(page);
        const card = cardOf(page);

        await card.locator('select').selectOption(overflow);
        await page.waitForTimeout(2500);
        await card.getByRole('button', { name: 'Build resume' }).click();
        await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });

        const said = (await card.locator('.fit').first().innerText()).trim();
        check('it says how much too long it is', /too long/i.test(said), said.replace(/\n/g, ' '));
        check('and what to do about it', /shorter phrasing or drop a bullet/i.test(said), said.replace(/\n/g, ' '));

        /*
         * And the door. Opened onto the resume being sent — the proposal built
         * for this posting — rather than the base it extends, because the
         * lines that do not fit are in the one going out.
         */
        const opened = context.waitForEvent('page');
        await card.locator('.fit.bad button').first().click();
        const editor = await opened;
        check('and opens the resume that does not fit', /#resumes\/job-/.test(editor.url()), editor.url());
        await editor.close();
        await page.close();
      } finally {
        await fetch(`${SERVER}/api/resumes/${overflow}`, { method: 'DELETE' }).catch(() => undefined);
      }
    }

    /*
     * What happens to writing rescued from a tab nobody reopened.
     *
     * Closing a tab that holds a letter keeps the writing under the address it
     * was on, so Ctrl+Shift+T can find it again — the tab comes back with a new
     * id, and the address is the only thing the two have in common. Until now
     * that copy was removed only by a reopened tab claiming it while still
     * fresh, so close ten tabs you never return to and ten copies sit there for
     * the rest of the browser session.
     *
     * Session storage is 10MB shared across every tab and the trail is already
     * budgeted to the limit: five tabs holding five pages fills it exactly.
     * When it fills, `writeTrail` starts dropping page text — the description
     * stops crossing pages, silently, which is the one thing the trail is for.
     * Dead orphans must not be what costs that.
     */
    group('Writing rescued from a closed tab');
    {
      const orphans = () =>
        worker.evaluate(async () => {
          const all = await (chrome.storage.session ?? chrome.storage.local).get(null);
          return Object.keys(all).filter((k) => k.startsWith('jh-orphan:'));
        });

      /*
       * Planted directly: the point under test is the housekeeping, not the
       * walk that produces an orphan, which `sending` already covers.
       *
       * Planted and counted in one trip into the worker, which is not
       * fussiness. `sweepOrphans` runs from the `onRemoved` listener, and
       * that listener is asynchronous — it awaits the trail before it sweeps
       * — so a tab closed earlier in this file finishes being cleaned up
       * some time after `page.close()` has already returned. The block above
       * closes one. Counting in a second trip left a window for that sweep
       * to land, and it landed in it every time: thirty stale orphans,
       * correctly removed, a moment before the test looked to see whether
       * they were there. The suite reported a bug in the housekeeping when
       * what it had actually caught was the housekeeping working.
       *
       * The worker runs one thing at a time, so inside a single evaluate
       * nothing can interleave and the count is of what was just written.
       */
      const planted = await worker.evaluate(async (stale) => {
        const store = chrome.storage.session ?? chrome.storage.local;
        const old = Date.now() - stale;
        const put = {};
        for (let i = 0; i < 30; i++) put[`jh-orphan:https://old.example/${i}`] = { work: { letter: 'x' }, at: old };
        for (let i = 0; i < 5; i++) put[`jh-orphan:https://new.example/${i}`] = { work: { letter: 'y' }, at: Date.now() };
        await store.set(put);
        // Counted by prefix rather than in total: earlier walks in this suite
        // close tabs that hold work, so the store is not empty to begin with
        // and an absolute number would test the order of this file.
        const all = await store.get(null);
        return Object.keys(all).filter((k) => /^jh-orphan:https:\/\/(old|new)\.example\//.test(k)).length;
      }, 3 * 60 * 60 * 1000);
      check('the planted ones are there to begin with', planted === 35, `${planted}`);

      // Closing a tab that holds work is the moment a new orphan is written,
      // and the only moment the number can grow.
      const doomed = await context.newPage();
      await doomed.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await cardAppears(doomed);
      await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        const store = chrome.storage.session ?? chrome.storage.local;
        await store.set({
          [`trail:${tab.id}`]: { pages: [{ url, title: 'Helios' }], work: { letter: 'the one that matters' }, at: Date.now() },
        });
      }, doomed.url());
      await doomed.close();
      // `onRemoved` runs in the worker, after the tab has gone.
      await new Promise((r) => setTimeout(r, 1200));

      const left = await orphans();
      check('the stale ones are gone', !left.some((k) => k.includes('old.example')), `${left.length} left`);
      check('and the count is held to a bound', left.length <= ORPHAN_BOUND, `${left.length} left`);
      check('while the fresh ones are kept', left.filter((k) => k.includes('new.example')).length === 5);
      check('including the one just rescued', left.some((k) => k.includes('/helios')), left.join(' ').slice(0, 120));
    }

    /*
     * An application is rescued whole, or not at all.
     *
     * A closed tab parks its writing under *every* page of the trail it was
     * on — the posting, the form, whatever came between — because somebody
     * coming back comes back to whichever of those they were last looking
     * at. So one application is several keys, all written in the same breath
     * and all carrying the same `at`.
     *
     * The sweep bounded the number of *keys*, newest first, and cut the list
     * wherever the count ran out. That cut can fall inside one application:
     * its letter stays reachable from three of its pages and not from the
     * other two, and which page you come back through decides whether you
     * find your own writing. Nothing says so either way.
     */
    group('An application is kept whole or let go whole');
    {
      const planted = await worker.evaluate(async () => {
        const store = chrome.storage.session ?? chrome.storage.local;
        // Four applications of five pages and one of two: twenty-two keys,
        // so the cut has to fall somewhere, and where it falls is the point.
        const sizes = [5, 5, 5, 5, 2];
        const groups = [];
        const put = {};
        const now = Date.now();
        sizes.forEach((pages, i) => {
          const at = now - (sizes.length - i) * 1000; // oldest first
          const keys = [];
          for (let p = 0; p < pages; p++) {
            const key = `jh-orphan:https://whole-${i}.example/page-${p}`;
            put[key] = { parked: [{ work: { letter: `letter ${i}` }, at }], at };
            keys.push(key);
          }
          groups.push(keys);
        });
        await store.set(put);
        return groups;
      });

      // The sweep runs when a new orphan is written, which is a tab holding
      // work closing.
      const doomed = await context.newPage();
      await doomed.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await cardAppears(doomed);
      await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url });
        const store = chrome.storage.session ?? chrome.storage.local;
        await store.set({
          [`trail:${tab.id}`]: { pages: [{ url, title: 'Helios' }], work: { letter: 'the newest one' }, at: Date.now() },
        });
      }, doomed.url());
      await doomed.close();
      await new Promise((r) => setTimeout(r, 1500));

      const left = await worker.evaluate(async (groups) => {
        const store = chrome.storage.session ?? chrome.storage.local;
        const all = await store.get(null);
        return groups.map((keys) => keys.filter((k) => all[k] !== undefined).length);
      }, planted);

      const partial = left.map((kept, i) => ({ kept, of: planted[i].length }))
        .filter((g) => g.kept !== 0 && g.kept !== g.of);
      check(
        'no application is left reachable from only some of its pages',
        partial.length === 0,
        partial.length ? partial.map((g) => `${g.kept}/${g.of}`).join(', ') : left.join(', '),
      );
      // And something was actually let go, or the case proves nothing.
      check('and the sweep did do something', left.some((kept) => kept === 0), left.join(', '));
    }

    /*
     * Which tab the popup's buttons act on.
     *
     * `activeTab` steps around the popup's own page and used to take the
     * first result of `chrome.tabs.query`, which comes back in tab-strip
     * order — so it picked the *leftmost* page in the window rather than the
     * one behind the popup. With two job pages open and the right-hand one in
     * front, Autofill typed a name, an email address and a phone number into
     * the other site's form in a background tab and reported "Filled 4
     * fields." over a form that was still empty; Mute silenced a host the
     * user was not on; and the open-application panel described a posting
     * from somewhere else.
     *
     * Two loopback spellings of the same fixture server, because the host is
     * what every one of those controls is keyed on and it is the only part
     * that has to differ.
     */
    group('The tab the popup is acting on');
    {
      const left = await context.newPage();
      await left.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      const right = await context.newPage();
      await right.goto(fixtures.urlFor(HELIOS_ROLE).replace('127.0.0.1', 'localhost'), {
        waitUntil: 'domcontentloaded',
      });
      await right.bringToFront();

      const popup = await openPopup();
      const offer = (await popup.locator('#mute').getAttribute('title')) ?? '';
      check(
        'the mute button names the page you were on, not the leftmost one',
        /localhost/.test(offer) && !/127\.0\.0\.1/.test(offer),
        offer,
      );

      await popup.locator('#mute').click();
      await popup.waitForTimeout(800);
      const said = (await popup.locator('#status').textContent())?.trim() ?? '';
      check('and mutes that one', /muted localhost/i.test(said), said);

      // Put it back, so nothing after this runs against a muted host.
      await popup.locator('#mute').click();
      await popup.waitForTimeout(800);
      await popup.close();
      await left.close();
      await right.close();
    }

    /*
     * The AI panel describes the server, so it has to be re-read when the
     * server changes.
     *
     * It was painted once at boot and never again: typing a new address
     * called `check()` alone, so the window ended up asserting "AI on — your
     * AI command will be asked to tailor resumes" in the present tense
     * directly under a status line saying ResumeM-M was not running. The
     * resume picker went the same way, still listing the previous server's
     * resumes — and choosing one of those writes a base this save may not
     * have, which is the stale-base trap two groups above.
     */
    group('Pointing it somewhere else does not leave the panel behind');
    {
      const popup = await openPopup();
      const before = (await popup.locator('#aiState').textContent())?.trim() ?? '';
      check('it says something definite about the AI to begin with', before.length > 0 && before !== 'AI unknown', before);
      const listed = await popup.locator('#baseResumeId option').count();
      check('and lists the resumes it found', listed > 0, `${listed}`);

      // Nothing listens there; the fetch runs out of time.
      await popup.locator('#serverUrl').fill('http://127.0.0.1:1');
      await popup.locator('#serverUrl').press('Enter');
      await popup.waitForTimeout(3000);

      const after = (await popup.locator('#aiState').textContent())?.trim() ?? '';
      const hint = (await popup.locator('#aiHint').textContent())?.trim() ?? '';
      check('the AI chip stops describing the old server', after === 'AI unknown', `${after} / ${hint}`);
      const stale = await popup.locator('#baseResumeId option:not([disabled])').count();
      check('and so does the resume picker', stale === 0, `${stale} still listed`);

      await popup.locator('#serverUrl').fill(SERVER);
      await popup.locator('#serverUrl').press('Enter');
      await popup.waitForTimeout(1500);
      await popup.close();
      await pointExtensionAt(context, context.serviceWorkers()[0], SERVER);
    }

    /* ---------------------------------------------------------------- *
     * A control whose message does not get through                       *
     * ---------------------------------------------------------------- */

    /*
     * The popup talks to the worker for everything, and that conversation
     * fails in two ordinary ways: the worker answers `ok: false`, or the
     * channel is gone because the extension was reloaded while this window
     * was open — which is what happens all day while it is being worked on.
     *
     * Either way, a control that does not catch it stops silently. The
     * setting is not saved and the box stays ticked; the site is not muted and
     * the button does not change; nothing is written to the status line,
     * because on most of these the status line is the *last* thing the handler
     * does. A window whose one job is telling you the state of things, wrong
     * about it and quiet.
     *
     * Driven by making the channel itself fail, rather than by finding a real
     * failure for each control: the point is not any one of these messages, it
     * is that no control in here may swallow a refusal.
     */
    group('A control whose message to the worker fails');
    {
      /*
       * A real page behind the popup, because Mute has a guard of its own:
       * with nothing but the popup open there is no host to mute and it says
       * so and stops, which is the guard working and not the thing under test
       * here.
       */
      const behind = await context.newPage();
      await behind.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      const popup = await openPopup();
      try {
        const press = async (what, act) => {
          // A sentinel, so "the status line was rewritten" cannot be confused
          // with "the status line already said something".
          await popup.evaluate(() => {
            document.getElementById('status').textContent = 'nothing has been said yet';
          });
          // Every message refused, from this point on.
          await popup.evaluate(() => {
            chrome.runtime.sendMessage = (_message, reply) => reply({ ok: false, error: 'the worker said no' });
          });
          await act();
          await popup.waitForTimeout(400);
          const said = (await popup.locator('#status').textContent())?.trim() ?? '';
          check(`${what} says so when the message does not get through`, /the worker said no/.test(said), said);
          await popup.reload();
          await popup.locator('#mute').waitFor({ timeout: 20_000 });
          await popup.waitForTimeout(800);
        };

        await press('muting a site', () => popup.locator('#mute').click());
        await press('opening the editor', () => popup.locator('#openApp').click());
        await press('the offer-automatically box', () => popup.locator('#autoPrompt').click());
        await press('the AI switch', () => popup.locator('#useAi').click());
        await press('the address box', async () => {
          await popup.fill('#serverUrl', 'http://127.0.0.1:4600');
          await popup.locator('#serverUrl').dispatchEvent('change');
        });
      } finally {
        await popup.close().catch(() => undefined);
        await behind.close().catch(() => undefined);
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
