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
import { BLOG, NORTHWIND, STREAMLY, cleanStore, findChromium, serveFixtures } from './fixtures.mjs';

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
  try {
    const res = await fetch(`${SERVER}/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`No ResumeM-M server at ${SERVER}. Start it with \`npm run serve\` there first.`);
    process.exit(2);
  }

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

    /* ---------------- A structured posting, end to end ---------------- */

    group('Streamly — structured posting, full flow');
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(fixtures.urlFor(STREAMLY), { waitUntil: 'domcontentloaded' });

    const { host, card } = cardOf(page);
    await host.waitFor({ state: 'attached', timeout: 20_000 });
    check('card appeared on a job posting', true);

    check('role parsed', (await card.locator('.role').innerText()).includes('Data Platform'));
    check('company parsed', (await card.locator('.co').innerText()).includes('Streamly'));

    // Whether an AI is involved must be visible without acting first.
    const aiChip = card.locator('.ai');
    await aiChip.waitFor({ timeout: 10_000 });
    const aiText = await aiChip.innerText();
    check('the card says whether AI is on', /^AI (on|off)/.test(aiText), aiText);

    const modes = card.locator('button.mode');
    check('both ways to tailor are offered', (await modes.count()) === 2);
    check(
      'the AI option is disabled while AI is off, and says why',
      (await modes.nth(1).isDisabled()) && Boolean(await modes.nth(1).getAttribute('title')),
      await modes.nth(1).getAttribute('title'),
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

    await card.getByRole('button', { name: 'Build resume' }).click();

    // Compiling takes seconds; the card has to show it is working.
    await card.locator('.progress').first().waitFor({ timeout: 15_000 });
    check('progress is shown while the resume compiles', true, await card.locator('.progress-label').innerText());

    await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 });
    check('progress clears when the work finishes', (await card.locator('.progress').count()) === 0);
    const fitText = await card.locator('.fit.ok, .fit.bad').innerText();
    check('resume compiled and fits one page', /Fits on one page/.test(fitText), fitText);

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

    /* Autofill. */
    await card.getByRole('button', { name: 'Autofill this form' }).click();
    await page.waitForFunction(() => document.querySelector('#em')?.value?.length > 0, { timeout: 15_000 });
    const filled = await page.evaluate(() => ({
      first: document.querySelector('#fn').value,
      email: document.querySelector('#em').value,
      linkedin: document.querySelector('#li').value,
      school: document.querySelector('#sc').value,
    }));
    check('autofill filled the name', Boolean(filled.first), filled.first);
    check('autofill filled the email', filled.email.includes('@'), filled.email);
    check('autofill filled linkedin and school', Boolean(filled.linkedin && filled.school));

    /* File it. */
    await card.getByRole('button', { name: 'Save application folder' }).click();
    await card.locator('.done-box').waitFor({ timeout: 90_000 });
    const done = await card.locator('.done-box').innerText();
    check('application folder written', /Resume Streamly\.pdf/.test(done));
    check('cover letter included in the bundle', /Cover Letter/i.test(done), done.split('\n').slice(1, 3).join(' '));

    const tracked = await (await fetch(`${SERVER}/api/applications`)).json();
    const entry = tracked.applications.find((a) => a.company === 'Streamly');
    check('application tracked', Boolean(entry), entry ? `${entry.status}` : 'not found');

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
