/**
 * Going to write the sentence, and coming back with it.
 *
 * The two products are one workflow, and the seam between them is where it is
 * most likely to be unpleasant. The moment it matters is a specific one: you
 * are looking at a posting, the proposal in front of you is the best the
 * store can do, and the store has no bullet for the thing this posting is
 * actually asking about. The answer is two minutes in the builder — and the
 * whole value of the trip is that what you write there ends up in what you
 * send from here.
 *
 * `carrying.mjs` walks as far as the builder opening and the card noticing
 * you came back. That is the easy half. This walks the other one: edit the
 * shared source in the builder, return, rebuild, and check the new wording is
 * in the resume the card then compiles and files — and that the base resume
 * everything else inherits from carries it too, which is the point of a
 * shared store.
 *
 *   node tests/roundtrip.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELIOS_ROLE, cleanStore, findChromium, serveFixtures, requireOpenSave, pointExtensionAt } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
/** What this suite files under; cleared before it starts as well as after. */
const MINE = ['Helios Robotics'];

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

/**
 * Distinctive enough that finding it anywhere proves where it came from.
 * Timestamped so a re-run against a store a previous run edited cannot pass
 * on the previous run's work.
 */
const MARKER = `backpressure-aware consumer groups ${Date.now().toString(36)}`;

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
  await page.waitForTimeout(1500);
}

/** The resume as it resolves on the server, which is what actually gets typeset. */
async function resolved(id) {
  const res = await fetch(`${SERVER}/api/resumes/${encodeURIComponent(id)}/resolved`);
  if (!res.ok) throw new Error(`resolve ${id}: ${res.status}`);
  return res.json();
}

const allText = (r) =>
  (r.sections ?? [])
    .flatMap((s) => (s.entries ?? []).flatMap((e) => (e.bullets ?? []).map((b) => b.text)))
    .join('\n');

/** Every phrasing in the shared source, which is a different question from what one resume prints. */
async function sharedSource() {
  const res = await fetch(`${SERVER}/api/store`);
  if (!res.ok) throw new Error(`store: ${res.status}`);
  const data = await res.json();
  return data.entries ?? [];
}

const everyPhrasing = (entries) =>
  entries
    .flatMap((e) => e.bullets ?? [])
    .flatMap((b) => (b.variants ?? []).map((v) => v.text ?? ''))
    .join('\n');

/** Put one phrasing back, through the API rather than through the editor. */
async function restorePhrasing(entryId, variantId, text) {
  const entries = await sharedSource();
  const entry = entries.find((e) => e.id === entryId);
  if (!entry) throw new Error(`no entry ${entryId}`);
  for (const bullet of entry.bullets ?? []) {
    for (const v of bullet.variants ?? []) if (v.id === variantId) v.text = text;
  }
  const res = await fetch(`${SERVER}/api/entries/${encodeURIComponent(entryId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(entry),
  });
  if (!res.ok) throw new Error(`restore: ${res.status}`);
}

/** Which entry and variant hold a given sentence right now. */
async function locate(fragment) {
  for (const entry of await sharedSource()) {
    for (const bullet of entry.bullets ?? []) {
      for (const v of bullet.variants ?? []) {
        if ((v.text ?? '').includes(fragment)) return { entryId: entry.id, variantId: v.id, text: v.text };
      }
    }
  }
  return null;
}

/**
 * Take out a marker a previous run left behind.
 *
 * The run below puts the line back in a `finally`, which covers a failure and
 * does not cover being killed — and a killed run leaves a sentence of test
 * debris in the shared source, which is to say on somebody's resume. One was
 * found there hours later, in a rendered PDF: "…with backpressure-aware
 * consumer groups mu5oy50d".
 *
 * The stem is fixed and only the timestamp varies, so a later run can always
 * recognise an earlier one's work and undo it. Repairing on the way in is the
 * only cleanup a process that was killed can get.
 */
async function scrubOldMarkers() {
  const stem = ' with backpressure-aware consumer groups ';
  let cleaned = 0;
  for (const entry of await sharedSource()) {
    let touched = false;
    for (const bullet of entry.bullets ?? []) {
      for (const v of bullet.variants ?? []) {
        const at = (v.text ?? '').indexOf(stem);
        if (at < 0) continue;
        v.text = v.text.slice(0, at);
        touched = true;
        cleaned++;
      }
    }
    if (!touched) continue;
    await fetch(`${SERVER}/api/entries/${encodeURIComponent(entry.id)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    });
  }
  if (cleaned) console.log(`  (took ${cleaned} leftover marker${cleaned === 1 ? '' : 's'} out of the shared source first)`);
}

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }
  await cleanStore(SERVER, MINE).catch(() => undefined);

  await scrubOldMarkers();

  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-round-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1400, height: 1000 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  /** Put back whatever we edit, whatever happens below. */
  let restore = null;

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    const page = await context.newPage();
    const started = Date.now();

    group('The posting, and the proposal the store can manage today');
    await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    await settled(page);
    const card = cardOf(page);

    const beforeText = (await card.textContent()) ?? '';
    check('a card with a proposal on it', /Resume/.test(beforeText));
    check('and the new wording is not in it yet, because it does not exist', !beforeText.includes(MARKER));

    group('Out to the builder, through the card');
    const opened = context.waitForEvent('page');
    await card.getByRole('button', { name: 'Edit in ResumeM-M' }).click();
    const editor = await opened;
    await editor.waitForLoadState('domcontentloaded');
    check('the builder opens, on this application\'s resume', /#resumes\//.test(editor.url()), editor.url());

    group('Writing the sentence the posting wanted');
    {
      // The shared source, which is where a phrasing belongs: written once
      // and inherited by every resume that prints it.
      /*
       * Say what went wrong, rather than which selector ran out.
       *
       * This step failed three runs in a row with nothing but "waiting for
       * locator('.master-source-variant')" — true, useless, and identical
       * whether the editor refused to switch, threw on the way, or simply
       * had not finished. Switching to the master view runs a save first and
       * silently declines if anything is unsaved, so the interesting facts
       * are what the dropdown says afterwards and what the page threw.
       */
      const thrown = [];
      editor.on('pageerror', (e) => thrown.push(String(e.message ?? e).slice(0, 160)));
      editor.on('console', (m) => {
        if (m.type() === 'error') thrown.push(`console: ${m.text().slice(0, 160)}`);
      });

      /*
       * And what the page was waiting for, if it was waiting.
       *
       * Switching runs a save first and awaits it, and `api()` has no
       * timeout — so a request that never answers leaves the switch half
       * done for ever, with nothing on screen to say so. These two lists say
       * whether that is what happened.
       */
      const inFlight = new Map();
      editor.on('request', (r) => inFlight.set(r, `${r.method()} ${new URL(r.url()).pathname}`));
      editor.on('requestfinished', (r) => inFlight.delete(r));
      editor.on('requestfailed', (r) => inFlight.set(r, `FAILED ${new URL(r.url()).pathname}`));

      await editor.waitForSelector('#resume-select', { timeout: 30_000 });
      await editor.selectOption('#resume-select', '__master__');
      try {
        await editor.waitForSelector('.master-source-variant', { timeout: 30_000 });
      } catch (err) {
        const showing = await editor.locator('#resume-select').inputValue().catch(() => '(unreadable)');
        // The save chip is the one that knows: it says saved, saving, unsaved
        // or failed, and "failed" carries the reason the request gave.
        const chip = editor.locator('#save-state');
        const save = await chip.textContent().catch(() => '');
        const saveClass = await chip.getAttribute('class').catch(() => '');
        const said = await editor.locator('#status').first().textContent().catch(() => '');
        const entries = await editor.locator('.entry, .entry-card').count().catch(() => -1);
        console.log(
          `  note  the master view never appeared. dropdown=${showing}; entries on screen=${entries}; ` +
            `save=[${saveClass}] "${(save ?? '').trim().slice(0, 80)}"; ` +
            `status="${(said ?? '').trim().slice(0, 120)}"; thrown=${thrown.join(' | ') || 'nothing'}; ` +
            `still in flight=${[...inFlight.values()].join(', ') || 'none'}`,
        );
        /*
         * And one more press, reported rather than believed.
         *
         * This has failed once in a parallel run and passed four times
         * standalone, with the dropdown reading the job resume again and
         * nothing in flight — which is the shape of a change event the editor
         * dropped, not of a switch that hung. Those two want different fixes,
         * and the note above cannot tell them apart. A second press that
         * works says "dropped"; one that does not says "stuck". Either way
         * this still fails: a switch that takes two presses is a bug, and
         * retrying until green is how it would stop being reported.
         */
        await editor.selectOption('#resume-select', '__master__').catch(() => undefined);
        const again = await editor
          .waitForSelector('.master-source-variant', { timeout: 10_000 })
          .then(() => true)
          .catch(() => false);
        console.log(`  note  pressing it a second time ${again ? 'worked — the first change was dropped' : 'did not work either'}`);
        throw err;
      }

      /*
       * The store is asked first, and the line is resolved last.
       *
       * Where the wording lives has to be known before it is changed, so it
       * can be put back through the API afterwards rather than by driving the
       * editor a second time. That read is a round trip, and it used to sit
       * between finding the line on screen and double-clicking it — and the
       * editor draws this list wholesale, so a handle taken before a pending
       * render lands points at a node that is about to be replaced. Under a
       * loaded machine that is exactly what happened: "element was detached
       * from the DOM, retrying", then the next match not visible.
       */
      const where = await locate('Kafka');
      check('and the shared source agrees that is where it lives', Boolean(where), where?.variantId ?? 'not found');
      restore = where;

      /*
       * And the view is left to settle before it is touched.
       *
       * Switching to Master paints it three times — measured: the container
       * holding `.master-source-variant` is added three times around the
       * switch and then not again, because the switch saves first and the
       * save and the preview each schedule a render. Waiting for the first
       * paint and acting on it means acting on a node that is replaced twice
       * underneath: "element was detached from the DOM, retrying", for the
       * whole of the click's timeout.
       */
      const line = () => editor.locator('.master-source-variant .editable', { hasText: 'Kafka' }).first();
      await line().waitFor({ timeout: 20_000 });

      /*
       * The same node, still there a moment later.
       *
       * Counting the rows cannot see this: every one of those renders draws
       * the same number of them. What changes is which nodes they are — so
       * the test holds one and asks whether it survived, which is exactly
       * what the double-click needs of it.
       */
      const steady = async () => {
        for (let i = 0; i < 80; i++) {
          const held = await line().elementHandle({ timeout: 20_000 }).catch(() => null);
          if (held) {
            await editor.waitForTimeout(500);
            const alive = await held
              .evaluate((n) => n.isConnected && n.getClientRects().length > 0)
              .catch(() => false);
            if (alive) return held;
          }
          await editor.waitForTimeout(250);
        }
        /*
         * Said as itself rather than as a selector that ran out.
         *
         * Measured: switching to Master paints the list three times — the
         * switch saves first, and the save and the preview each schedule a
         * render — and it then goes quiet, with no API traffic behind it. But
         * about one run in five it keeps going long past that, and a
         * double-click cannot land on a node that is replaced underneath it.
         * Whatever that turns out to be, "the list never stopped being
         * redrawn" is the fact worth reporting; "waiting for locator(…)" is
         * not.
         */
        throw new Error('the Master source list never stopped being redrawn');
      };
      const held = await steady();

      const shown = (await held.textContent()) ?? '';
      check('found the line this posting is about', /kafka/i.test(shown), shown.slice(0, 60));

      await held.dblclick();
      const raw = shown;
      await editor.keyboard.press('Control+A');
      await editor.keyboard.type(`${raw} with ${MARKER}`);
      await editor.keyboard.press('Enter');

      // The builder saves as you go; wait for the store rather than for the
      // screen, because the screen is what we would be fooling ourselves with.
      await editor.waitForTimeout(2500);
      check('the builder wrote it to the shared source', everyPhrasing(await sharedSource()).includes(MARKER));
    }

    group('Back to the application');
    await page.bringToFront();
    await page
      .waitForFunction(
        () => /been editing the store/i.test(document.querySelector('#jobhelper-card-host')?.shadowRoot?.textContent ?? ''),
        undefined,
        { timeout: 15_000, polling: 100 },
      )
      .catch(() => undefined);
    check('the card knows the store moved under it', /been editing the store/i.test((await card.textContent()) ?? ''));
    /*
     * Which offer it is depends on what this proposal is, and that is what
     * this checks. Arriving applies nothing now, so what is on screen is the
     * resume exactly as it is kept with a list of suggestions beside it — and
     * "build it again" over that would rebuild it unchanged and could never
     * reach the alternate just written in the builder, while the sentence
     * beside it promised otherwise. The offer has to name the thing that
     * would actually pick it up, and what would is the suggestion list being
     * worked out again over a store that now has the new wording in it.
     */
    const offer = card.locator('.hint.warn button');
    const offered = ((await offer.textContent().catch(() => '')) ?? '').trim();
    check(
      'and offers to redo the match rather than doing it behind your back',
      (await offer.count()) === 1,
      offered,
    );
    check(
      'naming the thing that would actually use what was just written',
      /work out the suggestions again/i.test(offered) && !/build it again/i.test(offered),
      offered,
    );

    group('And the sentence arrives in what gets sent');
    {
      await offer.click();
      await page.waitForTimeout(3000);
      check(
        'rebuilding clears the notice rather than leaving it up for good',
        !/been editing the store/i.test((await card.textContent()) ?? ''),
      );

      /*
       * And then take the suggestion, because being offered one changes
       * nothing.
       *
       * There was a "Match by keyword" button here, pressed because arriving
       * tailored nothing and the match was a mode. The match runs on arrival
       * now — the row below is already on the card, worked out again over the
       * store as the builder left it — but it arrives switched off, and a
       * suggestion switched off is not in the document. The new wording lives
       * on an alternate phrasing of the pipeline bullet (`v_kafka`, tagged
       * kafka/streaming), so with the box left alone the resume that gets
       * filed prints the neutral phrasing — "Built an event-processing
       * pipeline handling 2M events/day…", no Kafka, no marker — and the last
       * check below fails while the round trip itself is working. Ticking the
       * box is what a person does now; the walk has to do it too.
       *
       * The row is found by the wording itself rather than by position. That
       * one sentence is the entire subject of this suite: a row somewhere in
       * the list offering the words just typed next door is the proof the trip
       * arrived, and picking row zero would have been a guess about ordering
       * that says nothing about which wording it holds.
       */
      await card.locator('.diff-head').first().waitFor({ timeout: 60_000 });
      if (await card.locator('.changes.shut').count()) await card.locator('button.fold-changes').click();
      const swap = card.locator('.change').filter({ hasText: MARKER }).first();
      const offersIt = await swap.count();
      check(
        'and the match worked out again offers the wording written next door',
        offersIt === 1,
        `${await card.locator('.change').count()} suggestions, ${offersIt} of them this one`,
      );
      if (offersIt === 1) {
        check('switched off, like every other suggestion', (await swap.getAttribute('class'))?.includes('off') === true);
        await swap.locator('.pick').click();
        await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
        check(
          'and ticking it puts that wording in the document',
          (await swap.getAttribute('class'))?.includes('off') === false,
          (await swap.innerText()).replace(/\s+/g, ' ').slice(0, 80),
        );
      }

      // "Recompile" once the tick above has compiled something. Same button,
      // same lane — and this is the press the Submit below files.
      await card.getByRole('button', { name: /^(Build resume|Recompile)$/ }).click();
      await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
      const fit = await card.locator('.fit.ok, .fit.bad').innerText();
      check('the rebuilt resume still compiles onto one page', /Fits on one page/.test(fit), fit);

      /*
       * Filed, not just proposed. Until the folder is written the proposal is
       * a spec the card is holding and nothing is in the store, so asking the
       * store about it before this point is asking the wrong question — which
       * is what the first version of this check did, and it reported "none".
       */
      await card.getByRole('button', { name: 'Submit' }).click();
      await card.locator('.done-box').waitFor({ timeout: 120_000 });
      const done = await card.locator('.done-box').innerText();
      check('the application folder is written', /-Resume\.pdf/.test(done), done.split('\n')[1] ?? done);

      /*
       * Asked of the server, not of the card. The card can only show what it
       * was handed; the question is whether the thing that was typeset carries
       * the sentence, and only the resolver knows that.
       */
      const list = await (await fetch(`${SERVER}/api/resumes`)).json();
      const resumes = list.resumes ?? list;
      const mine = resumes.find((r) => /helios/i.test(r.id) || /helios/i.test(r.label ?? ''));
      check('the application has a resume of its own in the store', Boolean(mine), mine?.label ?? 'none');

      if (mine) {
        const r = await resolved(mine.id);
        /*
         * And this is the store's whole architecture paying off rather than
         * the rebuild: a tailored resume holds variant *ids*, and the text
         * comes from the shared source when it resolves. So an edited
         * phrasing reaches every resume that prints it whether or not
         * anything is rebuilt — checked here because that is the promise the
         * trip to the builder is made on, and it is the kind of promise that
         * would break silently.
         */
        check('and it carries the wording written next door', allText(r).includes(MARKER), mine.id);
      }
    }

    console.log(`\nWhole round trip: ${((Date.now() - started) / 1000).toFixed(1)}s`);
    await editor.close();
  } finally {
    /*
     * The line goes back. This edits shared source rather than creating
     * something of its own, so leaving it changed would quietly alter every
     * later run of every other harness against this store.
     */
    if (restore?.variantId) {
      try {
        await restorePhrasing(restore.entryId, restore.variantId, restore.text);
        check('the shared source is back as it was', !everyPhrasing(await sharedSource()).includes(MARKER));
      } catch (err) {
        check('the shared source is back as it was', false, String(err).slice(0, 120));
      }
    }
    await cleanStore(SERVER, MINE).catch(() => undefined);
    await context.close();
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  process.exit(failed ? 1 : 0);
}

main();
