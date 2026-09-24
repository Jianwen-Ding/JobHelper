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
import { cleanStore, findChromium, pointExtensionAt, requireOpenSave, serveFixtures } from './fixtures.mjs';

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

/*
 * And a walk: one form answered by hand and sent, then another employer's
 * form asking the same things in its own words.
 *
 * The first is shaped like a Greenhouse board's custom questions, the second
 * like a Lever one's — the same stock of questions, worded by two systems.
 * Every short box on the first is one the profile has nothing for, which is
 * what makes somebody type it: where they heard of the job, when they can
 * start, what they are asking for, what name they go by, where their work is,
 * who they work for now, and two yes-or-no questions a form asks as text.
 *
 * And the ones that must never come back: what they are paid now, a
 * referee's name and number, a national ID, a date of birth, the gender box
 * of the equal-opportunity section, why this employer, and an essay. Each is
 * typed, so each is exactly as available to be remembered as the rest.
 */
const typedPosting = ({ name, path, company, title, questions, after }) => ({
  name,
  path,
  company,
  title,
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>${title} at ${company}</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"${title}",
 "hiringOrganization":{"@type":"Organization","name":"${company}"},
 "jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"Boston","addressRegion":"MA"}},
 "description":"<p>Build and run our payments services in Go and Postgres, on Kubernetes and AWS.</p><ul><li>Experience with distributed systems</li></ul>"}
</script></head>
<body>
  <h1>${title}</h1>
  <p>${company} · Boston, MA</p>
  <h2>About the role</h2>
  <p>Build and run our payments services in Go and Postgres, on Kubernetes and
     AWS, with the CI/CD that ships them.</p>
  <h2>Minimum qualifications</h2>
  <ul><li>Experience with distributed systems</li><li>Experience with SQL and AWS</li></ul>
  <h2>Apply for this job</h2>
  <form method="post" action="${after}">
    <label for="fn">First Name</label><input id="fn" name="first_name">
    <label for="em">Email</label><input id="em" name="email" type="email">
${questions}
    <button type="submit">Submit application</button>
  </form>
</body></html>`,
});

const box = (id, label, type = 'text') =>
  `    <label for="${id}">${label}</label><input id="${id}" name="question_${id}" type="${type}">`;

const FIRST_FORM = typedPosting({
  name: 'typed-first',
  path: '/helios-typed/jobs/77',
  company: 'Helios Systems',
  title: 'Backend Engineer',
  after: '/helios-typed/thanks',
  questions: [
    box('heard', 'How did you hear about us?'),
    box('start', 'Earliest start date'),
    box('salary', 'Expected salary'),
    box('employer', 'Current employer'),
    box('pname', 'Preferred first name'),
    box('portfolio', 'Portfolio link', 'url'),
    box('adult', 'Are you 18 or older?'),
    box('reloc', 'Willing to relocate?'),
    `    <label for="arr">Which working arrangement do you prefer for this position?</label>
    <select id="arr" name="arrangement">
      <option value="">Select...</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
    </select>`,
    // Never to be kept, however they were typed.
    box('now-paid', 'Current salary'),
    box('ref-name', 'Reference name'),
    box('ref-phone', 'Reference phone number'),
    box('natid', 'National ID number'),
    box('dob', 'Date of birth'),
    box('gender', 'Gender (optional)'),
    box('whyus', 'What makes Helios Systems the right next step for you?'),
    `    <label for="essay">Tell us about a system you designed and what you would change about it.</label>
    <textarea id="essay" name="essay"></textarea>`,
  ].join('\n'),
});

const SECOND_FORM = typedPosting({
  name: 'typed-second',
  path: '/orbital-typed/jobs/5150',
  company: 'Orbital Labs',
  title: 'Platform Engineer',
  after: '/orbital-typed/thanks',
  questions: [
    box('heard', 'How did you hear about this job?'),
    box('start', 'What is your earliest start date?'),
    box('salary', 'What is your expected salary?'),
    box('employer', 'Current employer (if any)'),
    box('pname', 'Your preferred first name'),
    box('portfolio', 'Link to your portfolio', 'url'),
    box('adult', 'Are you 18 or older? *'),
    box('reloc', 'Are you willing to relocate?'),
    `    <label for="arr">Which working arrangement do you prefer?</label>
    <select id="arr" name="arrangement">
      <option value="">Select...</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
    </select>`,
    // Near the questions above, and different questions.
    box('latest', 'Latest start date'),
    box('lname', 'Preferred last name'),
    box('now-paid', 'What is your current salary?'),
    box('ref-name', 'Reference name'),
    box('whyus', 'What makes Orbital Labs the right next step for you?'),
    // New here, typed, and then not wanted kept.
    box('tz', 'Which time zone do you work in?'),
    // And new here and kept, typed after it: see the wait below.
    box('days', 'Which days suit you for interviews?'),
  ].join('\n'),
});

const THANKS = (path) => ({
  name: `${path}-thanks`,
  path,
  html: '<!doctype html><html><head><meta charset="utf-8"><title>Thank you</title></head><body><h1>Thank you for applying</h1><p>Your application has been received.</p></body></html>',
});

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

/** Ask until `get` answers something, or give up and answer null. */
async function until(get, ms = 15_000) {
  const end = Date.now() + ms;
  for (;;) {
    const got = await get().catch(() => null);
    if (got || Date.now() > end) return got ?? null;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** What each of these boxes holds now. */
const valuesOf = (page, ids) =>
  page.evaluate((ids) => Object.fromEntries(ids.map((id) => [id, document.getElementById(id)?.value ?? null])), ids);

const typedRows = (bank) => bank.filter((a) => a.variants.some((v) => v.label === 'Typed on a form'));
const answerOf = (item) => (item?.variants.find((v) => v.id === item.default) ?? item?.variants[0])?.text;

/*
 * The walk. Autofill first, the way a form is filled — it puts in what the
 * profile knows — then the rest typed by hand, and sent. Then the next
 * employer's form, and Autofill again.
 */
async function walkTwoForms(context, fixtures) {
  await putBank([]);

  const first = await context.newPage();
  await first.goto(fixtures.urlFor(FIRST_FORM), { waitUntil: 'domcontentloaded' });
  await settled(first);
  await cardOf(first).getByRole('button', { name: 'Autofill this form' }).click();
  await first.waitForFunction(() => document.getElementById('em')?.value !== '', null, { timeout: 20_000 }).catch(() => undefined);

  const KEPT = {
    heard: 'A friend on the payments team',
    start: 'Two weeks after an offer',
    salary: '$150,000 base',
    employer: 'Northwind Analytics',
    pname: 'Jay',
    portfolio: 'https://example.dev/work',
    adult: 'Yes',
    reloc: 'Yes, within the US',
  };
  const REFUSED = {
    'now-paid': '$128,000',
    'ref-name': 'Pat Example',
    'ref-phone': '(555) 010-0100',
    natid: 'AB1234567',
    dob: '04/02/1999',
    gender: 'Decline to self-identify',
    whyus: 'Your payments work',
    essay: 'A queueing system I designed for settlement files. '.repeat(4).trim(),
  };
  for (const [id, value] of Object.entries({ ...KEPT, ...REFUSED })) await first.fill(`#${id}`, value);
  await first.selectOption('#arr', 'Hybrid');
  await first.click('button[type=submit]');
  await first.waitForURL(/thanks/, { timeout: 15_000 }).catch(() => undefined);

  const afterFirst = await until(async () => {
    const bank = await bankOf();
    return typedRows(bank).length >= Object.keys(KEPT).length ? bank : null;
  });
  const bankNow = afterFirst ?? (await bankOf());
  const kept = typedRows(bankNow).map((a) => `${a.question} = ${answerOf(a)}`);

  console.log('\nTyped on one form, offered on the next');
  check(
    'every short box typed on the first form is kept, under the question as it was asked',
    ['How did you hear about us?', 'Earliest start date', 'Expected salary', 'Current employer', 'Preferred first name',
      'Portfolio link', 'Are you 18 or older?', 'Willing to relocate?'].every((q) =>
      typedRows(bankNow).some((a) => a.question === q)),
    kept.join(' | ') || 'nothing kept',
  );
  check(
    'with the answer as it was typed',
    Object.values(KEPT).every((v) => typedRows(bankNow).some((a) => answerOf(a) === v)),
    kept.join(' | ') || 'nothing kept',
  );
  const leaked = bankNow.filter((a) =>
    a.variants.some((v) => Object.values(REFUSED).includes(v.text)) ||
    /salary\b.*current|current salary|reference|national id|birth|gender|helios|tell us/i.test(a.question),
  );
  check(
    'nothing personal, nobody else’s, nothing about this employer and no essay goes into the bank',
    leaked.length === 0,
    leaked.map((a) => `${a.question} = ${answerOf(a)}`).join(' | ') || `${bankNow.length} rows, none of them those`,
  );
  check(
    'the choice made beside them is kept too',
    bankNow.some((a) => a.question === 'Which working arrangement do you prefer for this position?' && answerOf(a) === 'Hybrid'),
    bankNow.map((a) => a.question).join(' | '),
  );
  await first.close();

  const second = await context.newPage();
  await second.goto(fixtures.urlFor(SECOND_FORM), { waitUntil: 'domcontentloaded' });
  await settled(second);
  await cardOf(second).getByRole('button', { name: 'Autofill this form' }).click();
  await second
    .waitForFunction(() => document.getElementById('heard')?.value !== '', null, { timeout: 20_000 })
    .catch(() => undefined);
  const ids = ['heard', 'start', 'salary', 'employer', 'pname', 'portfolio', 'adult', 'reloc', 'arr', 'latest', 'lname', 'now-paid', 'ref-name', 'whyus', 'tz'];
  const got = await valuesOf(second, ids);
  const wrong = Object.entries(KEPT)
    .filter(([id, v]) => got[id] !== v)
    .map(([id, v]) => `${id}: "${got[id]}" not "${v}"`);
  check(
    'the second form, worded its own way, gets every one of them back',
    wrong.length === 0,
    wrong.join(' | ') || Object.keys(KEPT).join(', '),
  );
  check(
    'and the choice asked without "for this position" is answered as well',
    got.arr === 'Hybrid',
    `"${got.arr}"`,
  );
  const touched = ['latest', 'lname', 'now-paid', 'ref-name', 'whyus', 'tz'].filter((id) => got[id] !== '');
  check(
    'a different question beside them is left for the person',
    touched.length === 0,
    touched.map((id) => `${id}: "${got[id]}"`).join(' | ') || 'latest start, last name, current salary, reference, why us, time zone',
  );
  const note = ((await cardOf(second).locator('.ok-note').first().innerText().catch(() => '')) ?? '').trim();
  check(
    'the card names the boxes it filled from answers given before, so they can be checked',
    /from answers you gave before/i.test(note) && /How did you hear about this job\?/.test(note) &&
      /What is your expected salary\?/.test(note) && /Which working arrangement do you prefer\?/.test(note),
    note || '(no note)',
  );

  /*
   * Then the person changes one and types two new, and says not to keep one
   * of those. The change goes onto the answer it replaced, so the next form
   * gets the new figure and not the first form's.
   */
  await second.fill('#salary', '$160,000 base');
  await second.fill('#tz', 'US Eastern');
  await second.fill('#days', 'Tuesdays and Thursdays');
  await second.locator('h1').click();
  const offer = cardOf(second).getByRole('button', { name: /Don.t keep “Which time zone do you work in\?”/ });
  await offer.waitFor({ timeout: 10_000 }).catch(() => undefined);
  check(
    'the card says what it will keep, with a way to not keep each one',
    (await offer.count()) === 1,
    ((await cardOf(second).locator('.to-keep').innerText().catch(() => '')) ?? '').replace(/\s+/g, ' ') || '(nothing about keeping)',
  );
  await offer.click().catch(() => undefined);
  await second.click('button[type=submit]');
  await second.waitForURL(/thanks/, { timeout: 15_000 }).catch(() => undefined);
  /*
   * Until the last of them has landed. The worker saves them one after
   * another in the order they were typed, so once the interview days are in
   * the bank the time zone has been saved or not — and waiting on the salary
   * alone read the bank between the two and passed whatever became of it.
   */
  const afterSecond = await until(async () => {
    const bank = await bankOf();
    return answerOf(bank.find((a) => a.question === 'Expected salary')) === '$160,000 base' &&
      bank.some((a) => a.question === 'Which days suit you for interviews?')
      ? bank
      : null;
  });
  const bankLater = afterSecond ?? (await bankOf());
  check(
    'an answer changed after it was filled replaces the one it was filled from',
    answerOf(bankLater.find((a) => a.question === 'Expected salary')) === '$160,000 base' &&
      !bankLater.some((a) => a.question === 'What is your expected salary?'),
    bankLater.filter((a) => /salary/i.test(a.question)).map((a) => `${a.question} = ${answerOf(a)}`).join(' | '),
  );
  /*
   * And what Autofill picked is not taken for a pick. The second form asks
   * the arrangement without "for this position", Autofill answers it from the
   * first form's row, and its own `change` used to file that answer again
   * under this form's wording — a second row for one answer, labelled as
   * chosen by somebody who never touched it.
   */
  check(
    'a choice Autofill made is not saved again as one the person made',
    !bankLater.some((a) => a.question === 'Which working arrangement do you prefer?'),
    bankLater.filter((a) => /working arrangement/i.test(a.question)).map((a) => `${a.question} = ${answerOf(a)}`).join(' | '),
  );
  check(
    'and the one the person said not to keep is not kept',
    !bankLater.some((a) => /time zone/i.test(a.question) || a.variants.some((v) => v.text === 'US Eastern')),
    bankLater.map((a) => a.question).join(' | '),
  );
  await second.close();

  /*
   * And the editor's Letters & Answers tab, which is where kept answers are
   * seen and taken away, does both for these. Deleted there, it is not
   * offered again.
   */
  const editor = await context.newPage();
  await editor.goto(`${SERVER}/`, { waitUntil: 'domcontentloaded' });
  const tab = editor.locator('button[data-tab="letters"]');
  await editor.waitForFunction(() => !document.querySelector('button[data-tab="letters"]')?.disabled, null, { timeout: 15_000 }).catch(() => undefined);
  await tab.click();
  const row = editor.locator('#answers .mini-card', { hasText: 'How did you hear about us?' });
  await row.waitFor({ timeout: 10_000 }).catch(() => undefined);
  const shown = (await row.innerText().catch(() => '')) ?? '';
  check('the editor lists a typed answer with the rest', /A friend on the payments team/.test(shown), shown.replace(/\s+/g, ' ') || '(not listed)');
  await row.getByRole('button', { name: 'Delete' }).click().catch(() => undefined);
  await editor.locator('#modal-ok').click().catch(() => undefined);
  const gone = await until(async () => ((await bankOf()).some((a) => a.question === 'How did you hear about us?') ? null : true), 8_000);
  await editor.close();

  const again = await context.newPage();
  await again.goto(fixtures.urlFor(SECOND_FORM), { waitUntil: 'domcontentloaded' });
  await settled(again);
  await cardOf(again).getByRole('button', { name: 'Autofill this form' }).click();
  await again
    .waitForFunction(() => document.getElementById('start')?.value !== '', null, { timeout: 20_000 })
    .catch(() => undefined);
  const later = await valuesOf(again, ['heard', 'start']);
  check(
    'and one deleted in the editor is not offered again',
    gone === true && later.heard === '' && later.start === KEPT.start,
    `deleted: ${gone === true}, heard "${later.heard}", start "${later.start}"`,
  );
  await again.close();
}

/*
 * The employers these walks apply to, taken out of the tracker before and
 * after. The two forms are sent, so each leaves an application marked as
 * sent — and another suite looking for its own "Helios" in the same save
 * found this one instead.
 */
const COMPANIES = ['Vantage Systems', 'Helios Systems', 'Orbital Labs'];

async function main() {
  await requireOpenSave(SERVER);
  await cleanStore(SERVER, COMPANIES).catch(() => undefined);
  const fixtures = await serveFixtures([
    POSTING,
    FIRST_FORM,
    SECOND_FORM,
    THANKS('/helios-typed/thanks'),
    THANKS('/orbital-typed/thanks'),
  ]);
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

    await walkTwoForms(context, fixtures);
  } finally {
    await context.close();
    await putBank(before).catch(() => undefined);
    await cleanStore(SERVER, COMPANIES).catch(() => undefined);
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
