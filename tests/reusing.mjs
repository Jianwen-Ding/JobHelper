/**
 * An answer given on one application, offered back on the next.
 *
 *   RMM_SERVER=http://127.0.0.1:4600 node tests/reusing.mjs
 *
 * `autofill.mjs` proves the page half: given a list of remembered answers,
 * `fillForm` puts them in the right controls and refuses the personal ones.
 * `worker.mjs` proves the worker half: the bank is asked, and only confident
 * matches come back. Neither proves the two are joined up, and that is the
 * join that breaks silently — a message name typed wrong, or a reply read one
 * level too deep, leaves autofill working exactly as it did before and the
 * whole feature simply absent. Nothing on screen says so.
 *
 * So this presses the button, against the real store and the real matcher,
 * with real rows in the bank. Two of the five choice questions on the form
 * must come back answered and three must not, and which is the point:
 * `matchAnswer` only calls a match `confident` when the two questions are
 * near-identical, and only a confident match is ever typed into a form. A
 * question worded differently enough to be a different question is left for
 * the person, and that bar is deliberate — a loose match written into an
 * application is a thing somebody did not say, sent over their name.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { findChromium, pointExtensionAt, requireOpenSave, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';
const cardOf = (page) => page.locator(`${HOST} .card`);

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

/*
 * A posting with a form under it, which is the shape most boards serve — and
 * the shape that gets a card with an Autofill button on it without any
 * navigating about.
 *
 * The four choice questions are the point:
 *
 * - `arr` is the same question with the required marker this form puts on
 *   it, which is the ordinary case: the boards word these from a shared
 *   stock and differ in punctuation.
 * - `heard` is asked as radio buttons where the bank's row was saved from a
 *   dropdown. The bank holds a question and an answer, not a control, and
 *   proving that is most of why this suite drives two shapes.
 * - `dobm` is a dropdown with a matching row in the bank and must come out
 *   empty. That row is put there deliberately: an old bank predates the rule
 *   that keeps such things out, and the Workspace lets answers be typed in by
 *   hand, so the reuse side cannot assume it was handed a clean bank.
 * - `reworded` asks what `arr` asks, in words that share nothing with it.
 *   It must come out empty, and a change that makes it fill is a change that
 *   has lowered the bar on writing into somebody's application.
 * - `prev` is word for word what the bank holds, and must come out empty
 *   too: the "Yes" in the bank was chosen on another employer's form, and
 *   this one is Vantage's. See `DEPENDS_ON_EMPLOYER`.
 */
const POSTING = {
  name: 'reusing',
  path: '/vantage/jobs/4410',
  company: 'Vantage Systems',
  title: 'Backend Engineer',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Backend Engineer at Vantage Systems</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"Backend Engineer",
 "hiringOrganization":{"@type":"Organization","name":"Vantage Systems"},
 "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Boston","addressRegion":"MA"}},
 "description":"<p>Build and run our payments services in Go and Postgres, on Kubernetes and AWS.</p><ul><li>Minimum qualifications: experience with distributed systems</li><li>Experience with SQL</li></ul>"}
</script></head>
<body>
  <h1>Backend Engineer</h1>
  <p>Vantage Systems · Boston, MA</p>
  <h2>About the role</h2>
  <p>Build and run our payments services in Go and Postgres, on Kubernetes and
     AWS, with the CI/CD that ships them.</p>
  <h2>Minimum qualifications</h2>
  <ul><li>Experience with distributed systems</li><li>Experience with SQL and AWS</li></ul>
  <h2>Apply for this job</h2>
  <form>
    <label for="fn">First Name</label><input id="fn" name="first_name">
    <label for="em">Email</label><input id="em" name="email" type="email">

    <label for="arr">Which working arrangement do you prefer? *</label>
    <select id="arr" name="arrangement">
      <option value="">Select...</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
    </select>

    <label for="reworded">What kind of setup suits you best?</label>
    <select id="reworded" name="setup">
      <option value="">Select...</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
    </select>

    <label for="prev">Have you previously been employed by this company?</label>
    <select id="prev" name="prev_employment">
      <option value="">Select...</option><option>Yes</option><option>No</option>
    </select>

    <fieldset>
      <legend>How did you hear about this position?</legend>
      <label><input type="radio" name="heard" value="linkedin"> LinkedIn</label>
      <label><input type="radio" name="heard" value="referral"> Employee referral</label>
      <label><input type="radio" name="heard" value="other"> Somewhere else</label>
    </fieldset>

    <label for="dobm">Month of birth</label>
    <select id="dobm" name="dobm">
      <option value="">Select...</option><option>April</option><option>May</option>
    </select>
  </form>
</body></html>`,
};

/** The card, once it has stopped filling itself in. */
async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 25_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 25_000 });
  await page
    .locator(`${HOST} .card:not(.loading)`)
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined);
  const read = () => page.locator(`${HOST} .card`).innerText().catch(() => '');
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const now = await read();
    if (now && now === last) return;
    last = now;
  }
}

const bankOf = async () => (await (await fetch(`${SERVER}/api/store`)).json()).answers ?? [];
const putBank = (answers) =>
  fetch(`${SERVER}/api/answers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(answers),
  });

async function main() {
  await requireOpenSave(SERVER);
  const fixtures = await serveFixtures([POSTING]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-reusing-'));

  /*
   * Put back exactly what was there, whatever happens below. These suites
   * share one save, and a bank left holding a date of birth is a mess for
   * every other suite as well as a thing nobody wants written down.
   */
  const before = await bankOf();
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 1000 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    /*
     * From an empty bank, so these rows are the only ones the matcher sees.
     * The shared test store holds variants labelled "Yes" and "No", and the
     * store treats every label as an employer's name: a banked "Yes" then
     * reads as naming another employer and is never confident, so `prev`
     * below came out empty with or without the rule it is here to check.
     */
    await putBank([]);
    for (const [question, answer] of [
      // As the last form worded it: this one adds a required marker.
      ['Which working arrangement do you prefer?', 'Hybrid'],
      // True of the employer it was chosen for, and this is not that one.
      ['Have you previously been employed by this company?', 'Yes'],
      ['How did you hear about this position?', 'LinkedIn'],
      // The one the reuse side has to refuse on its own account.
      ['Month of birth', 'April'],
    ]) {
      await fetch(`${SERVER}/api/answers/save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question, answer, label: 'Chosen on a form' }),
      });
    }

    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    const page = await context.newPage();
    await page.goto(fixtures.urlFor(POSTING), { waitUntil: 'domcontentloaded' });
    await settled(page);

    const button = cardOf(page).getByRole('button', { name: 'Autofill this form' });
    check('the card offers to fill the form', (await button.count()) === 1, `${await button.count()} button(s)`);
    await button.click();
    // The profile fields land first and locally; the bank is a round trip
    // behind them, so waiting on the box this is about rather than on a clock.
    await page
      .waitForFunction(() => document.getElementById('arr')?.value !== '', null, { timeout: 20_000 })
      .catch(() => undefined);

    const got = await page.evaluate(() => ({
      arr: document.getElementById('arr').value,
      prev: document.getElementById('prev').value,
      reworded: document.getElementById('reworded').value,
      dobm: document.getElementById('dobm').value,
      heard: document.querySelector('input[name="heard"]:checked')?.value ?? '',
      email: document.getElementById('em').value,
    }));

    check('the profile still fills what it always filled', got.email.includes('@'), got.email || '(empty)');
    check(
      'the same question on the next form is answered from the bank',
      got.arr === 'Hybrid',
      `"${got.arr}"`,
    );
    check(
      'and one asked with radio buttons where the bank saw a dropdown',
      got.heard === 'linkedin',
      `"${got.heard}"`,
    );
    /*
     * The conservatism, written down. Only a near-identical question is typed
     * into a form unasked; anything looser is a suggestion, and the Workspace
     * is where suggestions belong.
     */
    check(
      'a question the store only matched loosely is left for the person',
      got.reworded === '',
      `"${got.reworded}"`,
    );
    /*
     * The one that matters most, and the only one here whose failure is
     * silent: a form that goes out saying something about somebody that they
     * did not choose to say on it.
     */
    check(
      'another employer’s answer to whether you have worked here is not put on this form',
      got.prev === '',
      `"${got.prev}"`,
    );
    check(
      'a personal question is refused even with a row in the bank for it',
      got.dobm === '',
      `"${got.dobm}"`,
    );

    // And the card says where the unusual answers came from, so there is
    // somewhere to look when one of them is wrong.
    const note = ((await cardOf(page).locator('.ok-note').first().innerText().catch(() => '')) ?? '').trim();
    check('the card says they came from before', /from answers you gave before/i.test(note), note || '(no note)');
    await page.close();
  } finally {
    await context.close();
    await putBank(before).catch(() => undefined);
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
