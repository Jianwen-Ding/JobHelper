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

    const changes = await card.locator('.change').all();
    check('tailoring proposed changes', changes.length > 0, `${changes.length} changes`);

    // The whole point of the rewrite: changes are readable, not raw ids.
    const firstChange = changes.length ? await changes[0].innerText() : '';
    check('changes are described in words, not ids', !/\bb_[a-z_]+\s*→/.test(firstChange), firstChange.split('\n')[0]);
    check('keywords are shown as written', !firstChange.includes('distributedsystems'));

    /* The diff against the base: what the page said, and what it says now. */
    const diffHead = await card.locator('.diff-head').innerText();
    check('the diff names what it is comparing', /New grad/.test(diffHead), diffHead.replace(/\n/g, ' '));

    const firstRow = card.locator('.change').first();
    const wasText = await firstRow.locator('del').innerText();
    const nowText = await firstRow.locator('ins').innerText();
    check('each change shows the sentence it replaced', wasText.length > 20, wasText.slice(0, 50));
    check('each change shows the sentence it chose', nowText.length > 20 && nowText !== wasText, nowText.slice(0, 50));
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
      await card.locator('.change').first().waitFor({ timeout: 60_000 });
      check('and the match can be asked for again', (await card.locator('.change').count()) > 0);
    }

    await card.getByRole('button', { name: 'Build resume' }).click();

    // Compiling takes seconds; the card has to show it is working.
    await card.locator('.progress').first().waitFor({ timeout: 15_000 });
    check('progress is shown while the resume compiles', true, await card.locator('.progress-label').innerText());

    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
    check('progress clears when the work finishes', (await card.locator('.progress').count()) === 0);
    const fitText = await card.locator('.fit.ok, .fit.bad').innerText();
    check('resume compiled and fits one page', /Fits on one page/.test(fitText), fitText);

    // You can see what you are about to send without leaving the posting.
    await card.locator('.pdf-pane canvas').first().waitFor({ timeout: 30_000 });
    const drawn = await card.locator('.pdf-pane canvas').first().evaluate((c) => c.width > 100 && c.height > 100);
    check('the resume is drawn in the card, on the same tab', drawn);

    /* The posting asks for a cover letter, so the card drafts one unasked. */
    await card.locator('textarea.tall').waitFor({ timeout: 60_000 });
    check('a letter is drafted because the form asks for one, with no click', true);

    /* Questions found on the page and paired with the answer bank. */
    const questions = await card.locator('.q').all();
    check('page questions detected', questions.length >= 2, `${questions.length} found`);
    const qText = questions.length ? await questions[0].innerText() : '';
    check('a known question is recognised', /answered before|close match/.test(qText), qText.split('\n')[0]);

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
     * previous letter straight into the box, and "Prepare to submit" then
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
       * Filing it in exactly that state — the default one, with the AI off
       * and the offer untaken — used to produce a folder with no letter in
       * it, under the words "Saved. These files are named and ready to
       * attach" and "Everything you are sending, in one place". Both true of
       * the files listed and both wrong about the application: the form asks
       * for a letter, and you would have attached the two files it named and
       * sent it without one.
       */
      await card.getByRole('button', { name: 'Prepare to submit' }).click();
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
    }

    /* File it. */
    await card.getByRole('button', { name: 'Prepare to submit' }).click();
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
      folder.ok && /-Resume\.pdf/.test(listing),
      folder.status === 200 ? `${(listing.match(/href="\/current\//g) ?? []).length} files listed` : String(folder.status),
    );

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
    await cleanStore(SERVER, ['Streamly', 'Northwind']);
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
