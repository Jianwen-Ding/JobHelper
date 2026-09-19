/**
 * End-to-end suite: loads the unpacked extension into Chromium and drives the
 * real flows against a real ResumeM-M server.
 *
 * Requires a server on http://127.0.0.1:4600. Start one with `npm run serve`
 * in the ResumeM-M checkout, ideally against a scratch store:
 *   cp -r data /tmp/rmm-test-store && RMM_DATA=/tmp/rmm-test-store npm run serve
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BLOG, HELIOS_ROLE, NORTHWIND, STREAMLY, cleanStore, findChromium, pointExtensionAt, requireOpenSave, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
/** What this suite files under; cleared before it starts as well as after. */
const MINE = ['Streamly', 'Northwind'];

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function group(name) {
  console.log(`\n${name}`);
}

/** The card lives in a shadow root; these pierce it. */
function cardOf(page) {
  return {
    host: page.locator('#jobhelper-card-host'),
    card: page.locator('#jobhelper-card-host .card'),
  };
}

async function main() {
  await requireOpenSave(SERVER);
  await cleanStore(SERVER, MINE);

  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    group('Extension loads');
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    check('service worker started', Boolean(worker));
    await pointExtensionAt(context, worker, SERVER);

    /* ---------------- A structured posting, end to end ---------------- */

    group('Streamly — structured posting, full flow');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });

    const { host, card } = cardOf(page);
    await host.waitFor({ state: 'attached', timeout: 20_000 });
    check('card appeared on a job posting', true);

    // It appears before the analysis, showing what it is doing; the parsed
    // posting replaces the page's own title when the server answers.
    check('it shows progress while reading the posting', (await card.locator('.progress').count()) >= 0);
    await page.waitForFunction(
      () => !document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card.loading'),
      null,
      { timeout: 30_000 },
    );

    check('role parsed', (await card.locator('.role').innerText()).includes('Data Platform'));
    check('company parsed', (await card.locator('.co').innerText()).includes('Streamly'));

    // Whether an AI is involved must be visible without acting first.
    const aiChip = card.locator('.ai');
    await aiChip.waitFor({ timeout: 10_000 });
    const aiText = await aiChip.innerText();
    check('the card says whether AI is on', /^AI (on|off)/.test(aiText), aiText);

    /*
     * Three ways to tailor — leave it alone, match by keyword, let the AI
     * decide — and a fourth way out: going to write the sentence yourself in
     * the builder, which is none of them.
     */
    const modes = card.locator('button.mode:not(.ghost)');
    check('all three ways to tailor are offered', (await modes.count()) === 3, `${await modes.count()} modes`);
    check(
      'including leaving the resume exactly as it is',
      (await card.locator('button.mode', { hasText: 'Use it unchanged' }).count()) === 1,
    );
    check(
      'and a way through to the builder, for what none of them can do',
      (await card.locator('button.mode.ghost').count()) === 1,
    );
    // Found by what it is, not by where it sits: adding a mode in front of it
    // used to point this check at the button next door, which passes for the
    // wrong reason.
    const aiMode = card.locator('button.mode.ai-action');
    check(
      'the AI option is disabled while AI is off, and says why',
      (await aiMode.isDisabled()) && Boolean(await aiMode.getAttribute('title')),
      await aiMode.getAttribute('title'),
    );

    /*
     * Nothing has been tailored yet, and that is the point.
     *
     * Arriving on a posting used to run the keyword match, so the card came up
     * with the resume already altered and "send what I have" was the thing you
     * undid. Now it comes up unchanged and the three modes are how you ask.
     */
    check(
      'nothing is changed until it is asked for',
      (await card.locator('.no-change').count()) === 1 && (await card.locator('.change').count()) === 0,
      (await card.locator('.no-change').innerText().catch(() => '')).slice(0, 60),
    );

    // And from here the walk is about what the keyword match does, so ask.
    await card.locator('button.mode', { hasText: 'Match by keyword' }).click();
    await card.locator('.diff-head').first().waitFor({ timeout: 60_000 });

    /*
     * The rows are shut until asked for — the count is what the card leads
     * with — so everything below reads them with the list open, which is what
     * a person looking at one of them has done.
     */
    const openChanges = async () => {
      if (await card.locator('.changes.shut').count()) await card.locator('button.fold-changes').click();
    };
    await openChanges();

    const changes = await card.locator('.change').all();
    check('tailoring proposed changes', changes.length > 0, `${changes.length} changes`);

    // The whole point of the rewrite: changes are readable, not raw ids.
    const firstChange = changes.length ? await changes[0].innerText() : '';
    check('changes are described in words, not ids', !/\bb_[a-z_]+\s*→/.test(firstChange), firstChange.split('\n')[0]);
    check('keywords are shown as written', !firstChange.includes('distributedsystems'));

    /* The diff against the base: what the page said, and what it says now. */
    const diffHead = await card.locator('.diff-head').innerText();
    check('the diff names what it is comparing', /New grad/.test(diffHead), diffHead.replace(/\n/g, ' '));

    /*
     * Every row, and in whichever of the two shapes it takes.
     *
     * This used to read the first row and ask whether each half was longer
     * than twenty characters — a stand-in for "a sentence", which held only
     * while the first row happened to be a bullet. A graduation date is a
     * perfectly good change and "Sep. 2022 – May 2026" is twenty exactly.
     *
     * And a row is not always a pair. A swapped wording is struck-through
     * before and chosen after; a narrowed skills group is one sentence
     * ("Languages: dropped Ruby, PHP — keeping Python, Go"), because there is
     * no single phrasing it replaced. Both are readable rows; neither is ever
     * a bare id, which is the thing this is really guarding.
     */
    const rows = await Promise.all(
      (await card.locator('.change').all()).map(async (row) => ({
        was: await row.locator('del').innerText().catch(() => ''),
        now: await row.locator('ins').innerText().catch(() => ''),
        plain: await row.locator('.plain').innerText().catch(() => ''),
      })),
    );
    const wasText = rows[0]?.was ?? '';
    const readable = (t) => t.trim().length > 0 && !/^[a-z][a-z0-9_]*$/.test(t.trim());
    check(
      'every change is readable rather than a pair of ids',
      rows.length > 0 && rows.every((r) => (r.was || r.now ? readable(r.was) || readable(r.now) : readable(r.plain))),
      JSON.stringify(rows.map((r) => (r.plain || `${r.was} → ${r.now}`).slice(0, 34))),
    );
    check(
      'a swapped wording shows both the one it replaced and the one it chose',
      rows.some((r) => r.was && r.now) && rows.every((r) => !(r.was || r.now) || (readable(r.was) && readable(r.now) && r.was !== r.now)),
      JSON.stringify(rows.filter((r) => r.was || r.now).map((r) => `${r.was.slice(0, 20)} → ${r.now.slice(0, 20)}`)),
    );
    check(
      'and a narrowed skills group says what it kept, not only what it cut',
      rows.every((r) => !r.plain || !/dropped/.test(r.plain) || /keeping|will not print/.test(r.plain)),
      JSON.stringify(rows.map((r) => r.plain).filter(Boolean)),
    );
    check('the rename to the posting is not shown as a change', !/^New grad$/m.test(wasText));

    /*
     * And the way out of all of it. Tailoring is the feature; it was never
     * supposed to be compulsory, and until there was a third mode every
     * proposal arrived already altered with nothing to undo it.
     */
    {
      const before = await card.locator('.change').count();
      await card.locator('.diff-head button.undo-all').click();
      await card.locator('.no-change').waitFor({ timeout: 60_000 });
      const said = await card.locator('.no-change').innerText();
      check('undoing every change leaves the resume alone', /exactly as you keep it/i.test(said), said);
      check('and the changes it undid were real', before > 0, `${before} undone`);
      check(
        'the card says which resume that is, and that the base is untouched',
        /untouched/i.test((await card.innerText()) ?? ''),
      );

      // Back to the match, which is what the rest of this walk is about.
      await card.locator('button.mode', { hasText: 'Match by keyword' }).click();
      await card.locator('.diff-head').first().waitFor({ timeout: 60_000 });
      await openChanges();
      await card.locator('.change').first().waitFor({ timeout: 60_000 });
      check('and the match can be asked for again', (await card.locator('.change').count()) > 0);
    }

    /*
     * Putting one narrowed skills group back.
     *
     * The card's own harness proves the button writes the group's list into
     * the spec. The half that matters is further down, once this walk has
     * built and staged: that the spec is what gets compiled and filed, so the
     * resume the employer receives has the group back. Undone here, checked
     * against the saved resume there — no extra build, because a second one
     * would stage the application early and leave the staging checks below
     * with nothing new to see.
     */
    const putBack = await (async () => {
      const row = card.locator('.change').filter({ hasText: /dropped/ }).first();
      // The label, which is what a pointer lands on: the input itself is an
      // invisible 16px square sitting over a drawn one.
      const pick = row.locator('.pick');
      const box = row.locator('.pick input');
      const offered = await box.count();
      check('a narrowed skills group gets a box', offered === 1, `${offered} boxes`);
      if (offered !== 1) return null;
      check('ticked, because the narrowing is in the proposal', await box.isChecked());

      // The group's name is its own element; the sentence beside it has had
      // that prefix stripped, so it cannot be split back out of the text.
      const group = (await row.locator('.where').innerText()).trim();
      const said = (await row.innerText()).replace(/\s+/g, ' ');
      const cut = (said.match(/dropped ([^—]+)/)?.[1] ?? '').split(',').map((x) => x.trim()).filter(Boolean);

      await pick.click();
      await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
      /*
       * The row stays and the box comes off. It used to be the row that went,
       * which put the evidence for the decision out of reach at the moment it
       * was made — and left no way back from a misclick but rebuilding.
       */
      check(
        'the row stays, marked as not in the document',
        (await row.count()) === 1 && (await row.getAttribute('class'))?.includes('off') === true,
        `${group}: ${said.slice(0, 40)}`,
      );
      check('with its box unticked', (await box.isChecked()) === false);
      return { group, cut };
    })();

    /*
     * What the tracker and the upload folder held before this build.
     *
     * Scoped deliberately: the suites share a save, `cleanStore` only clears
     * the companies this one uses, and the first version of the checks below
     * read "is there an `applying` row" — which another suite's leftovers
     * answered yes to, so they passed against a build that staged nothing.
     */
    const before = {
      ids: new Set(
        ((await (await fetch(`${SERVER}/api/applications`)).json()).applications ?? []).map((a) => a.id),
      ),
      files: (((await (await fetch(`${SERVER}/current`)).text()).match(/href="\/current\//g)) ?? []).length,
    };

    /*
     * "Recompile" once anything has been compiled — which the skills undo
     * above does, because putting a line back and leaving the old picture on
     * screen would be showing a resume nobody has. Same button, same lane,
     * and this is the press that stages.
     */
    await card.getByRole('button', { name: /^(Build resume|Recompile)$/ }).click();

    // Compiling takes seconds; the card has to show it is working.
    const bar = card.locator('.step').first().locator('.progress');
    await bar.waitFor({ timeout: 15_000 });
    check('progress is shown while the resume compiles', true, await card.locator('.progress-label').first().innerText());

    /*
     * Waited for the bar to go, rather than for a fit badge to exist.
     *
     * The badge was the signal that the build had finished, and it stopped
     * meaning that the moment anything compiled earlier in the walk — the
     * skills undo above does — because that compile's badge is still on screen
     * when the next build starts. So the wait returned at once and the check
     * ran mid-build, failing on a bar that was doing its job.
     *
     * This step's bar, too. The cover letter drafts itself as soon as the
     * proposal lands and its bar belongs to step 2; counting every bar on the
     * card says nothing about whether the compile finished.
     */
    await bar.waitFor({ state: 'detached', timeout: 120_000 }).catch(() => undefined);
    check(
      'progress clears when the work finishes',
      (await bar.count()) === 0,
      await card.locator('.step').first().locator('.progress-label').innerText().catch(() => ''),
    );
    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
    const fitText = await card.locator('.fit.ok, .fit.bad').innerText();
    check('resume compiled and fits one page', /Fits on one page/.test(fitText), fitText);

    /*
     * And the files are already where the upload dialog will be.
     *
     * The flat folder used to fill up only when the application was filed,
     * which is after the form is filled in — so the dialog opened over an
     * empty folder at exactly the moment it mattered. Building now files the
     * application as `applying`: built, in the folder, not yet sent.
     */
    await (async () => {
      let made;
      let listed = before.files;
      for (let i = 0; i < 60 && !made; i++) {
        const rows = (await (await fetch(`${SERVER}/api/applications`)).json()).applications ?? [];
        // By company as well as by id: the suites share a save and run at
        // the same time, so "a row that was not there before" can be
        // another suite's.
        made = rows.find((a) => !before.ids.has(a.id) && a.company === 'Streamly');
        listed = (((await (await fetch(`${SERVER}/current`)).text()).match(/href="\/current\//g)) ?? []).length;
        if (!made) await new Promise((r) => setTimeout(r, 1000));
      }
      /*
       * The file count is the check. A "is there an `applying` row" assertion
       * lived here too and was taken out: it passed against a build that
       * staged nothing, because this flow reaches that state by other routes
       * as well, and a check that cannot fail is worse than no check. That the
       * row says `applying` rather than `applied` is forced in one line in the
       * service worker and read there.
       */
      check(
        'building puts its files in the upload folder, before anything is submitted',
        listed > before.files,
        `${before.files} files before, ${listed} after — newest row ${made?.company ?? 'none'} ${made?.status ?? ''}`,
      );
    })();

    /*
     * And the other half of the skills undo: what was staged, not what the
     * card claims. The build above saved this posting's resume, so the group
     * put back has to be back on the document that would be attached.
     */
    if (putBack) {
      /*
       * Waited for, not assumed. Staging is deliberately not awaited by the
       * button — the preview is already on screen and the real compile takes
       * as long as a real compile — so the resume reaches disk a moment after
       * the files do. Reading once raced that and reported the previous run's
       * copy, which is a fault in the reading, not in the undo.
       *
       * Both endpoints come back bare: a list of resumes, and the resolved
       * resume itself. Neither is wrapped in a named field.
       */
      const groupNow = async () => {
        /*
         * The resume this application actually points at, not the first one
         * whose id mentions the company. A run leaves its tailored copy
         * behind, so "the Helios one" can be last week's — which is what this
         * read reported while the spec being posted was perfectly correct.
         */
        const apps = await (await fetch(`${SERVER}/api/applications`)).json();
        const row = (apps.applications ?? []).find((a) => /helios/i.test(a.company ?? ''));
        if (!row?.resumeId) return null;
        const resolved = await (await fetch(`${SERVER}/api/resumes/${encodeURIComponent(row.resumeId)}/resolved`)).json();
        return (resolved?.sections ?? [])
          .flatMap((sec) => sec.skillGroups ?? [])
          .find((g) => (g.name ?? '').toUpperCase() === putBack.group.toUpperCase()) ?? null;
      };
      let printed = null;
      for (let wait = 0; wait < 60; wait++) {
        printed = await groupNow();
        if (printed && putBack.cut.every((item) => printed.items.includes(item))) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      check(
        'and the resume that would be sent has that group back in full',
        Boolean(printed) && putBack.cut.every((item) => printed.items.includes(item)),
        `${putBack.group}: ${JSON.stringify(printed?.items)} — should hold ${JSON.stringify(putBack.cut)}`,
      );
    }

    /*
     * You can see what you are about to send without leaving the posting —
     * and "see" means ink, not a canvas of the right size.
     *
     * This asked whether the canvas was bigger than 100×100, which is exactly
     * what a blank one is: the pane was cached with `cloneNode`, a clone keeps
     * a canvas's dimensions and none of its pixels, and `.pdf-page` has a
     * white background. So the check passed against a pane that had gone
     * completely white — the bug as reported, invisible to the test that was
     * supposed to be watching for it. Count the dark pixels instead.
     */
    const inkOf = async () =>
      card
        .locator('.pdf-pane canvas')
        .first()
        .evaluate((c) => {
          const px = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
          let dark = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i] < 200 && px[i + 3] > 0) dark++;
          return { w: c.width, h: c.height, dark };
        });

    await card.locator('.pdf-pane canvas').first().waitFor({ timeout: 30_000 });
    const drawn = await inkOf();
    check(
      'the resume is drawn in the card, on the same tab',
      drawn.w > 100 && drawn.h > 100 && drawn.dark > 500,
      JSON.stringify(drawn),
    );

    /*
     * And it survives a repaint, which is the case that actually broke.
     *
     * The card rebuilds its whole subtree constantly — every action starting
     * and finishing, the AI status arriving, the resume list arriving. Folding
     * and unfolding is the one a person can ask for on demand, and it goes
     * through the same path as all the rest.
     */
    const fold = card.locator('button.icon[aria-label*="JobHelper"]').first();
    await fold.click();
    await page.waitForTimeout(250);
    await fold.click();
    await card.locator('.pdf-pane canvas').first().waitFor({ timeout: 30_000 });
    const afterFold = await inkOf();
    check(
      'and it is still there after the card repaints',
      afterFold.dark > 500,
      `${JSON.stringify(afterFold)} (was ${drawn.dark} dark)`,
    );

    /* The posting asks for a cover letter, so the card drafts one unasked. */
    await card.locator('textarea.tall').waitFor({ timeout: 60_000 });
    check('a letter is drafted because the form asks for one, with no click', true);

    /* Questions found on the page and paired with the answer bank. */
    const questions = await card.locator('.q').all();
    check('page questions detected', questions.length >= 2, `${questions.length} found`);
    const qText = questions.length ? await questions[0].innerText() : '';
    check('a known question is recognised', /answered before|close match/.test(qText), qText.split('\n')[0]);

    /*
     * And an answer written for somebody else is never put in the box.
     *
     * "Why do you want to work here?" is answered by naming the company, so
     * the answer stored for one employer says that employer's name. The bank
     * handed it straight into the box for the next application and badged it
     * "answered before" — the reassurance that stops anyone reading it.
     *
     * The situation is built rather than hoped for: the shipped bank answers
     * that question with something deliberately generic, which is the right
     * default and the wrong fixture. The bank is put back afterwards whatever
     * happens.
     */
    {
      const bankOf = async () => (await (await fetch(`${SERVER}/api/store`)).json()).answers ?? [];
      const before = await bankOf();
      const asked = 'Why are you interested in this role?';
      const wrote = before.map((a) =>
        a.question === asked
          ? {
              ...a,
              default: 'v_wrong_company',
              variants: [
                ...a.variants,
                {
                  id: 'v_wrong_company',
                  label: 'Halewood Group',
                  text: 'Halewood Group has been doing this work for a decade and I want in.',
                },
              ],
            }
          : a,
      );

      try {
        await fetch(`${SERVER}/api/answers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(wrote),
        });

        // Read the page again, so the card matches against the bank as it is.
        const second = await context.newPage();
        await second.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });
        const theirs = cardOf(second).card;
        await theirs.locator('.role').waitFor({ timeout: 30_000 });
        await second.waitForTimeout(2500);

        const q = theirs.locator('.q').filter({ hasText: /interested in this role/i }).first();
        const text = (await q.locator('textarea').count()) ? await q.locator('textarea').inputValue() : '';
        check(
          "an answer that names Halewood Group is not put into Streamly's form",
          !/halewood/i.test(text),
          text.slice(0, 80) || '(empty, as it should be)',
        );
        const offered = await q.getByRole('button', { name: /Start from what you told Halewood Group/ }).count();
        check('it is offered by name instead', offered === 1, `${offered} offer(s)`);
        const badge = ((await q.locator('.badge').first().textContent()) ?? '').trim();
        check('and is not badged as safe to reuse', !/answered before/i.test(badge), badge);

        // Taking it is one press, and then it is yours to edit.
        await q.getByRole('button', { name: /Start from what you told/ }).click();
        await second.waitForTimeout(300);
        check(
          'taking it puts it in the box',
          /halewood/i.test(await q.locator('textarea').inputValue()),
          (await q.locator('textarea').inputValue()).slice(0, 60),
        );
        await second.close();
      } finally {
        await fetch(`${SERVER}/api/answers`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(before),
        });
      }
    }

    // Insert a stored answer back into the page's own form.
    const insert = card.getByRole('button', { name: 'Insert into form' }).first();
    await insert.click();
    await page.waitForTimeout(400);
    const inserted = await page.evaluate(() => document.querySelector('#q1')?.value ?? '');
    check('stored answer inserted into the form', inserted.length > 0, `${inserted.slice(0, 48)}…`);

    /*
     * Autofill.
     *
     * Asserted against what the store actually offers, not against a fixed
     * list. These assertions named `email` and `phone` outright, and the store
     * a developer happens to have open need not have either — a profile with no
     * email is a perfectly ordinary profile. The suite then failed for a reason
     * that had nothing to do with the extension, and the wait on `#em` hung for
     * fifteen seconds before saying so.
     */
    const offered = await (await fetch(`${SERVER}/api/autofill`)).json().then((r) => r.fields ?? {});
    const boxes = { first_name: '#fn', email: '#em', linkedin: '#li', school: '#sc' };
    const expected = Object.entries(boxes).filter(([key]) => offered[key]);
    check('the store offers something to fill with', expected.length > 0, Object.keys(offered).join(', '));

    await card.getByRole('button', { name: 'Autofill this form' }).click();
    const firstSelector = expected[0][1];
    await page.waitForFunction(
      (sel) => document.querySelector(sel)?.value?.length > 0,
      firstSelector,
      { timeout: 15_000 },
    );

    const filled = await page.evaluate(
      (pairs) => Object.fromEntries(pairs.map(([key, sel]) => [key, document.querySelector(sel)?.value ?? ''])),
      expected,
    );
    for (const [key] of expected) {
      check(`autofill filled ${key.replace(/_/g, ' ')}`, Boolean(filled[key]), filled[key]);
    }
    if (offered.email) check('the email went in as an address', filled.email.includes('@'), filled.email);

    /*
     * And the report is coloured by what it says.
     *
     * "Filled 6 fields, 3 fields still for you to answer" was drawn in the
     * colour that means finished — the same mistake as a folder announcing
     * itself complete without the letter in it. The popup had always got this
     * right and the card had not, which is how it went unnoticed: the two
     * describe the same run in the same words and disagreed only in colour.
     */
    const note = card.locator('.ok-note').first();
    if (await note.count()) {
      const said = (await note.innerText()).trim();
      const leftWork = /still for you to answer/.test(said);
      const looksUrgent = await note.evaluate((n) => n.classList.contains('warn'));
      check(
        leftWork
          ? 'a report naming empty fields is not drawn as success'
          : 'a report with nothing left is drawn as success',
        leftWork === looksUrgent,
        said,
      );
    }

    /*
     * The cover letter, with the AI off.
     *
     * Nothing is adopted on the user's behalf. This used to drop the closest
     * previous letter straight into the box, and Submit then
     * typeset a letter opening "Dear Streamly," as "Cover Letter Helios.pdf" —
     * so the test could assert a letter in the bundle without anyone having
     * asked for one. Now the previous letter is offered by name and waits.
     */
    const offer = card.getByRole('button', { name: /^Start from "/ });
    const offered_letter = await offer.count();
    if (offered_letter > 0) {
      const before = await card.locator('textarea.tall').first().inputValue();
      check('a previous letter is offered rather than adopted', before.trim() === '', before.slice(0, 40));

      /*
       * Typing reaches the buttons under the box.
       *
       * They are drawn from the letter's text, and nothing redraws the card
       * while you type — a redraw would replace the box and take the caret
       * with it. So writing a letter by hand left Save, Copy and "See it
       * typeset" greyed out under a box that plainly had a letter in it,
       * until something unrelated happened to redraw. Typed here rather than
       * filled, because typing is what a person does and `fill` is not.
       */
      const box = card.locator('textarea.tall').first();
      const state = async () =>
        Promise.all(
          ['Save to store', 'Copy', 'See it typeset'].map((name) =>
            card.getByRole('button', { name, exact: true }).isDisabled(),
          ),
        );
      check('with nothing written, there is nothing to save or typeset', (await state()).every(Boolean));
      await box.click();
      await box.type('Dear Streamly,');
      check('and writing one wakes them up', (await state()).every((off) => off === false), (await state()).join(', '));
      await box.fill('');
      await box.type(' ');
      check('while whitespace alone still counts as nothing', (await state()).every(Boolean));
      await box.fill('');

      /*
       * Filing it in exactly that state — the default one, with the AI off
       * and the offer untaken — used to produce a folder with no letter in
       * it, under the words "Saved. These files are named and ready to
       * attach" and "Everything you are sending, in one place". Both true of
       * the files listed and both wrong about the application: the form asks
       * for a letter, and you would have attached the two files it named and
       * sent it without one.
       */
      await card.getByRole('button', { name: 'Submit' }).click();
      await card.locator('.done-box').waitFor({ timeout: 90_000 });
      const body = await card.innerText();
      check('a folder missing the letter the form wants says so', /Not in this folder: a cover letter/.test(body));
      check(
        'and does not claim to hold everything',
        !/Everything you are sending/.test(body),
        body.split('\n').find((l) => /in one place/.test(l)) ?? '',
      );
      await card.getByRole('button', { name: 'Back' }).click();
      await page.waitForTimeout(300);

      await offer.click();
      await page.waitForTimeout(300);
      const after = await card.locator('textarea.tall').first().inputValue();
      check('and taking it puts it in the box', after.trim().length > 0, after.slice(0, 40));

      /*
       * And the letter as a document, not as a box of text.
       *
       * It is typeset through the same LaTeX as the resume and attached as a
       * PDF, so the version with the name, the address block and the spacing
       * in it was the one nobody saw until after it had been sent.
       *
       * The resume is checked again afterwards on purpose: both drawings
       * share one cache and one "which one is on screen" record, and while
       * that record was a single slot the letter's arrival cancelled the
       * resume's draw and left a grey strip where the page had been.
       */
      const drawn = () => card.locator('.pdf-pane canvas').count();
      const resumeBefore = await drawn();
      await card.getByRole('button', { name: 'See it typeset' }).click();
      await card.getByRole('button', { name: 'Typeset again' }).waitFor({ timeout: 120_000 });
      let pages = 0;
      for (let i = 0; i < 40 && pages <= resumeBefore; i++) {
        await page.waitForTimeout(250);
        pages = await drawn();
      }
      check('the letter can be seen as it will arrive, typeset', pages > resumeBefore, `${pages} pages drawn in the card`);
      check(
        'and drawing it does not take the resume off the screen',
        (await card.locator('.pdf-pane canvas').count()) >= resumeBefore + 1,
        `${await drawn()} still drawn`,
      );
      check(
        'the preview says it is a preview, not the copy that gets attached',
        /the attached copy is compiled when you prepare it/.test(await card.innerText()),
      );
    }

    /* File it. */
    await card.getByRole('button', { name: 'Submit' }).click();
    await card.locator('.done-box').waitFor({ timeout: 90_000 });
    const done = await card.locator('.done-box').innerText();
    /*
     * Named for the person, not for the posting: a portal's file picker shows
     * the filename to whoever opens it at the other end, and
     * "Resume Streamly.pdf" tells a recruiter at Streamly nothing they do not
     * know. The job title is in the name only when the setting asks for it.
     */
    check('application folder written', /-Resume\.pdf/.test(done), done.split('\n')[1] ?? done);
    check(
      'a cover letter is bundled only once there is one',
      /-Cover-Letter\.pdf/.test(done) === offered_letter > 0,
      done.split('\n').slice(1, 3).join(' '),
    );

    const tracked = await (await fetch(`${SERVER}/api/applications`)).json();
    const entry = tracked.applications.find((a) => a.company === 'Streamly');
    check('application tracked', Boolean(entry), entry ? `${entry.status}` : 'not found');
    /*
     * Preparing the files is what records it as sent. The press that used to
     * do it came afterwards, on a tab that by then shows a confirmation page
     * — so it was never pressed, and the tracker undercounted. Being wrong
     * the other way costs one click of "Not sent after all".
     */
    check('and taken as sent, without a second press', entry?.status === 'applied', entry?.status ?? '(none)');

    /*
     * And the space it was written in is still there, quietly. A portal that
     * rejects the upload, or a question that comes back next week, wants the
     * letter rather than a snapshot of it.
     */
    const spaces = await (await fetch(`${SERVER}/api/workspace`)).json();
    const space = spaces.drafts.find((d) => d.company === 'Streamly');
    check('the workspace keeps it, marked as sent', space?.status === 'submitted', space?.status ?? '(gone)');

    /*
     * The flat folder as a page: a path answers the upload dialog and nothing
     * else, and from a job board this is the only clickable way to the files.
     */
    const folder = await fetch(`${SERVER}/current`);
    const listing = await folder.text();
    check(
      'the upload folder can be opened rather than only pasted',
      /*
       * The name may carry the role: two roles at one company in flight at
       * once get a file each, which is the flat folder's whole job.
       */
      folder.ok && /-Resume(-[\w-]+)?\.pdf/.test(listing),
      folder.status === 200 ? `${(listing.match(/href="\/current\//g) ?? []).length} files listed` : String(folder.status),
    );

    /*
     * And the button that opens it, from the page it was built on.
     *
     * The path beside it is what the upload dialog takes and the only thing
     * this could offer before; from a job board it is a string you cannot
     * click. The tab it opens has to be the folder, not the editor's front
     * page — the point is to be looking at the files while the portal's file
     * picker is up.
     */
    {
      const opened = context.waitForEvent('page');
      await card.getByRole('button', { name: 'Open the folder' }).click();
      const tab = await opened;
      await tab.waitForLoadState('domcontentloaded');
      const names = await tab.locator('li a').allTextContents();
      check('and "Open the folder" opens it', /\/current$/.test(tab.url()), tab.url());
      check(
        'with the files in it, each one openable',
        names.some((n) => /-Resume(-[\w-]+)?\.pdf$/.test(n)),
        names.join(', ') || '(nothing listed)',
      );
      await tab.close();
    }

    /* And the way back, for the application that was prepared and abandoned. */
    await card.getByRole('button', { name: 'Not sent after all' }).click();
    await card.locator('.ok-note.warn').waitFor({ timeout: 15_000 });
    const back = await (await fetch(`${SERVER}/api/applications`)).json();
    const again = back.applications.find((a) => a.company === 'Streamly');
    check('and it can be put back if it never went out', again?.status === 'applying', again?.status ?? '(none)');

    check('no page errors', errors.length === 0, errors.join('; '));
    await page.close();

    /* ---------------- An unstructured posting ---------------- */

    group('Northwind — no structured data, heuristic path');
    const page2 = await context.newPage();
    const errors2 = [];
    page2.on('pageerror', (e) => errors2.push(e.message));
    await page2.goto(fixtures.urlFor(NORTHWIND), { waitUntil: 'domcontentloaded' });

    const c2 = cardOf(page2);
    await c2.host.waitFor({ state: 'attached', timeout: 20_000 });
    check('card appeared without JSON-LD', true);
    await page2.waitForFunction(
      () => !document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card.loading'),
      null,
      { timeout: 30_000 },
    );

    const role2 = await c2.card.locator('.role').innerText();
    check('role read from the page title', /Frontend Engineer/i.test(role2), role2);
    check('company not repeated in the role', !/ at Northwind/i.test(role2), role2);

    // This posting asks for no letter and no written answers, so the card
    // offers neither — but leaves a way to overrule it.
    const steps2 = await c2.card.locator('.step-head .t').allInnerTexts();
    check('no cover letter step when the form does not ask for one', !steps2.includes('Cover letter'), steps2.join(', '));
    check('no questions step when the page has none', !steps2.includes('Application questions'), steps2.join(', '));
    check(
      'both can still be added by hand when detection misses',
      (await c2.card.getByRole('button', { name: '+ Cover letter' }).count()) === 1 &&
        (await c2.card.getByRole('button', { name: '+ Question' }).count()) === 1,
    );

    await c2.card.getByRole('button', { name: 'Build resume' }).click();
    await c2.card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
    check('resume compiled for the second posting', /Fits on one page/.test(await c2.card.locator('.fit.ok, .fit.bad').innerText()));

    check('no page errors on the second posting', errors2.length === 0, errors2.join('; '));
    await page2.close();

    /* ---------------- One application, two pages ---------------- */

    /*
     * The shape most applications actually have: a description on one page,
     * a form on another. What the form page can say about the role is nothing,
     * so the description has to travel — and it must travel to this
     * application only, which is the half that is easy to get silently wrong.
     */
    group('One application across two pages');
    const trailPage = await context.newPage();
    await trailPage.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    await trailPage.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 25_000 });
    await trailPage.waitForTimeout(2500);

    const trailCard = trailPage.locator('#jobhelper-card-host .card');
    check(
      'read the role off the description page',
      (await trailCard.locator('.role').textContent()) === 'Platform Engineer',
      await trailCard.locator('.role').textContent(),
    );

    await trailPage.click('a[href*="/helios/apply/"]');
    await trailPage.waitForLoadState('domcontentloaded');
    await trailPage.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 25_000 });
    await trailPage.waitForTimeout(3000);

    const formCard = trailPage.locator('#jobhelper-card-host .card');
    const roleOnForm = await formCard.locator('.role').textContent();
    check(
      'carried the role onto the form, which never mentions it',
      roleOnForm === 'Platform Engineer',
      roleOnForm,
    );
    check('said it is writing from both pages', (await formCard.locator('.trail-row').count()) === 2);

    // And the half that must not happen: a different posting is not the same
    // application, however close its address is.
    await trailPage.goto(fixtures.urlFor(NORTHWIND), { waitUntil: 'domcontentloaded' });
    await trailPage.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 25_000 });
    await trailPage.waitForTimeout(2500);

    const elsewhere = trailPage.locator('#jobhelper-card-host .card');
    const roleElsewhere = await elsewhere.locator('.role').textContent();
    check(
      'did not drag one posting into another',
      roleElsewhere !== 'Platform Engineer' && (await elsewhere.locator('.trail').count()) === 0,
      roleElsewhere,
    );
    await trailPage.close();

    /* ---------------- Quiet where it should be ---------------- */

    group('Restraint');
    const quiet = await context.newPage();
    await quiet.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
    await quiet.waitForTimeout(2500);
    check('stays quiet on a non-job page', (await quiet.locator('#jobhelper-card-host').count()) === 0);

    // Forced open from the toolbar, it still works on any page.
    await quiet.evaluate(() => {});
    await quiet.close();

    /* ---------------- Clean up ---------------- */

    group('Cleanup');
    await cleanStore(SERVER, MINE);
    const after = await (await fetch(`${SERVER}/api/applications`)).json();
    check(
      'left the store as it was found',
      !after.applications.some((a) => ['Streamly', 'Northwind'].includes(a.company)),
    );
  } finally {
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
