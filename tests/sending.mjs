/**
 * Does the tracker learn that an application went out — on the systems people
 * actually apply through, and never on a button that only looks like one?
 *
 * Knowing an application was sent is guesswork from outside a portal. The
 * evidence is the page: a form submitted, or the control that sends it
 * pressed. That guess is only worth having if it survives how these systems
 * are really built, and only safe if it stays quiet when nothing was sent —
 * a job marked as done comes off the list of things to finish, so a false
 * positive costs more than a miss.
 *
 * Twenty-three systems, each ending its application differently, and thirteen
 * controls that must leave the tracker alone — a draft, a question, a filter,
 * a newsletter, a referral, a message, a search, a feedback box, and three
 * that carry the whole phrase: another job's Apply, a deferral, and a mailto.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/sending.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveFixtures, findChromium, pointExtensionAt, requireOpenSave, cleanStore } from './fixtures.mjs';
import {
  SENDS,
  DOES_NOT_SEND,
  FRAME_DOCUMENTS,
  EMBEDDED_APPLY,
  RECEIPT_APPLY,
  RECEIPT_ELSEWHERE,
  RECEIPT_EMBED,
  RECEIPT_DOCUMENTS,
  NAMELESS_APPLY,
} from './ats-web.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};
const group = (name) => console.log(`\n${name}`);

const cardOf = (page) => page.locator(`${HOST} .card`);

/** Wait for the card to stop changing, rather than for a number of seconds. */
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
  const read = () => cardOf(page).innerText().catch(() => '');
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const now = await read();
    if (now && now === last) return;
    last = now;
  }
}

/** What the store has filed under a company, as the editor would show it. */
async function filed(company) {
  const [apps, drafts] = await Promise.all([
    fetch(`${SERVER}/api/applications`).then((r) => r.json()),
    fetch(`${SERVER}/api/workspace`).then((r) => r.json()),
  ]);
  const of = (list) => list.find((x) => (x.company ?? '').toLowerCase().includes(company.toLowerCase()));
  return { application: of(apps.applications ?? []), draft: of(drafts.drafts ?? []) };
}

/**
 * Press a control by its visible name, whatever element it turns out to be.
 *
 * Playwright's button role covers `button` and `input[type=submit]` and
 * anything carrying `role=button`, which between them is every shape in these
 * fixtures — including the anchor and the div, which is the point.
 */
async function press(page, name, { inFrame = false } = {}) {
  /*
   * In the frame when the form is in the frame. An embedded board puts the
   * fields, the button and the click inside an iframe, and Playwright's
   * page-level locators do not cross into one.
   */
  const where = inFrame ? page.frameLocator('iframe') : page;
  await where.getByRole('button', { name, exact: true }).first().click({ timeout: 10_000 });
}

/**
 * Wait for the store to say something, rather than for a number of seconds.
 *
 * Both waits in a walk used to be fixed: long enough for the keeper's
 * interval, then long enough for a submission to be recorded. Asking until
 * the answer arrives ends each one when it is true — which for a submission
 * is a few hundred milliseconds, not two seconds.
 */
/*
 * Longer than the worker's own wait: a send is held until the save flushed
 * with it has landed, for up to `SEND_WAITS_FOR_SAVE_MS` (ten seconds), so a
 * window shorter than that fails a send that is merely slow. A send that has
 * landed ends the wait at once, so the length only costs time on a failure.
 */
async function awaitFiled(company, wanted, within = 15_000) {
  const until = Date.now() + within;
  for (;;) {
    const now = await filed(company);
    if (wanted(now) || Date.now() >= until) return now;
    await new Promise((done) => setTimeout(done, 200));
  }
}

/**
 * One application, from arriving on the form to whatever the tracker says
 * afterwards. Returns what was filed so the caller can judge it.
 */
async function walk(context, fixtures, fixture, { build = true } = {}) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message ?? e).slice(0, 120)));
  try {
    await page.goto(`${fixtures.urlFor(fixture)}${fixture.query ?? ''}`, { waitUntil: 'domcontentloaded' });
    await settled(page);

    if (build) {
      const card = cardOf(page);
      await card.getByRole('button', { name: 'Build resume' }).click();
      await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
    }

    // The keeper writes on an interval, and the space is opened from there.
    const before = await awaitFiled(fixture.company, (f) => f.application?.status === 'applying');
    await press(page, fixture.sends, { inFrame: fixture.inFrame });

    /*
     * A page that should send is waited on until it has; one that should not
     * has to be given a window and then read, because there is no event for
     * something never happening. Two seconds is the same window the positives
     * take about a tenth of.
     */
    /*
     * Both, not just the application. `filed` reads the two lists at once, so
     * asking only about the application returned a snapshot whose draft half
     * had been fetched a moment earlier — a race in the reader rather than in
     * the server, which writes both in one handler.
     */
    const after = fixture.sent
      ? await awaitFiled(
          fixture.company,
          (f) => f.application?.status === 'applied' && f.draft?.status === 'submitted',
        )
      : await new Promise((done) => setTimeout(() => done(filed(fixture.company)), 2000));
    /*
     * How far apart the draft and the send were, by the store's own clock.
     *
     * `holdASpace` is what opens the draft, and it used to run only off the
     * keeper's two-second interval — decoupled from Submit — so a short form
     * sent between ticks was filed as sent a whole tick before any draft
     * existed for it, and under load with none at all. See `saveWorkNow` in
     * `watchForSending`'s `took`, which flushes that save at the press.
     *
     * Both stamps are written by the store as each request lands, so this
     * reads the gap itself rather than timing a poll from here — a loaded
     * machine slows the two requests together, but it cannot make the next
     * interval tick arrive sooner than the wall clock allows.
     */
    const appliedAt = Date.parse(
      after.application?.history?.find((h) => h.status === 'applied')?.at ?? after.application?.appliedAt ?? '',
    );
    const draftAt = Date.parse(after.draft?.createdAt ?? '');
    const draftGapMs = Number.isFinite(appliedAt) && Number.isFinite(draftAt) ? draftAt - appliedAt : null;
    return { before, after, draftGapMs, errors, page };
  } finally {
    await page.close().catch(() => undefined);
  }
}

/**
 * How many applications to walk at once.
 *
 * Thirty-six pages at six seconds each is nearly four minutes, which made
 * this the longest suite by a factor of three and more than doubled the whole
 * run's wall clock — and a loaded machine is how a passing suite next door
 * turns into a thirty-second timeout that reads like a bug. Each page here is
 * a different company and a different application, so nothing is shared but
 * the server.
 *
 * Three rather than six: every walk compiles a resume, which the false-
 * positive sweep's pages do not, and six LaTeX runs at once on one server is
 * how this stops being cheaper.
 */
const AT_ONCE = 3;

/** Walk a list in batches, yielding each batch's results as they land. */
async function* inBatches(list, run) {
  for (let at = 0; at < list.length; at += AT_ONCE) {
    yield await Promise.all(list.slice(at, at + AT_ONCE).map(run));
  }
}

/**
 * What this suite files under; cleared before it starts as well as after.
 *
 * Exactly as the store spells them — `cleanStore` matches the company on the
 * row, not a prefix of it. A probe of mine passed "Marlow" for a row filed
 * under "Marlow Systems", so the row survived every run; the next run read it
 * back and I spent an evening chasing an application that appeared to have
 * been filed as sent before its form was submitted. It had been sent, the run
 * before.
 */
const MINE = [...SENDS, ...DOES_NOT_SEND, RECEIPT_APPLY, RECEIPT_ELSEWHERE, RECEIPT_EMBED, NAMELESS_APPLY]
  .map((f) => f.company)
  .concat(['Novena', 'Larkspur', 'Marlow Systems']);

async function main() {
  await requireOpenSave(SERVER);
  await cleanStore(SERVER, MINE).catch(() => undefined);
  const fixtures = await serveFixtures([
    ...SENDS,
    ...DOES_NOT_SEND,
    ...FRAME_DOCUMENTS,
    RECEIPT_APPLY,
    RECEIPT_ELSEWHERE,
    RECEIPT_EMBED,
    ...RECEIPT_DOCUMENTS,
    NAMELESS_APPLY,
  ]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-send-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 950 },
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
      // A careers host of the company's own. See `NAMELESS_APPLY`.
      '--host-resolver-rules=MAP careers.corvane.test 127.0.0.1',
    ],
  });

  const started = Date.now();
  const timings = [];
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    /*
     * Walked in batches, reported in order.
     *
     * The results are collected before anything is printed so the log reads
     * as a list of systems rather than as three interleaved ones — a failure
     * has to be attributable to a system at a glance.
     */
    const timed = async (fixture) => {
      const at = Date.now();
      const result = await walk(context, fixtures, fixture);
      timings.push({ name: fixture.name, ms: Date.now() - at });
      return { fixture, ...result };
    };

    /* ---- The systems, and the many ways they spell "send it" ---- */
    for await (const batch of inBatches(SENDS, timed)) {
      for (const { fixture, before, after, draftGapMs, errors } of batch) {
        group(`${fixture.name} — "${fixture.sends}"`);
        check(
          'the form is recognised as an application at all',
          Boolean(before.application),
          before.application?.id ?? '(nothing filed)',
        );
        check(
          'and held as one being worked on before it is sent',
          before.application?.status === 'applying',
          before.application?.status ?? '(none)',
        );
        check(
          'pressing it is taken as the application going out',
          after.application?.status === 'applied',
          after.application?.status ?? '(none)',
        );
        check(
          'and the draft stops looking like something to finish',
          after.draft?.status === 'submitted',
          after.draft?.status ?? '(none)',
        );
        /*
         * The draft was opened with the send, not merely by the time the
         * checks above give up waiting. Opened only off the keeper's
         * interval, it still arrives eventually on an unloaded machine —
         * a whole tick after the application was filed as sent, and under
         * load sometimes never. See `draftGapMs` in `walk`.
         */
        /*
         * And before it, now, not merely soon after: the worker holds the send
         * until the save flushed with it has opened the draft. Under a second
         * was the old bar, when the two raced; the race put the draft anywhere
         * up to 1.5 seconds late under the parallel runner.
         */
        check(
          'and the draft was opened with the send, not a keeper tick after it',
          draftGapMs !== null && draftGapMs <= 0,
          draftGapMs === null ? '(no draft, or no send recorded)' : `${draftGapMs}ms after the send`,
        );
        check('nothing was thrown at the page', errors.length === 0, errors.join(' | '));
      }
    }

    /* ---- And the controls that only look like one ---- */
    group('Controls that must leave the tracker alone');
    for await (const batch of inBatches(DOES_NOT_SEND, timed)) {
      for (const { fixture, before, after, errors } of batch) {
        check(
          `${fixture.name}: "${fixture.sends}" does not send the application`,
          after.application?.status === 'applying',
          `${before.application?.status ?? '(none)'} → ${after.application?.status ?? '(none)'}`,
        );
        check(
          `${fixture.name}: and the draft is still there to finish`,
          after.draft?.status !== 'submitted',
          after.draft?.status ?? '(none)',
        );
        check(`${fixture.name}: nothing thrown`, errors.length === 0, errors.join(' | '));
      }
    }

    /*
     * A send from inside a frame asks the top document for its work, and is
     * answered once that work has been saved.
     *
     * The frame's script runs no keeper — the card and the keeper are in the
     * top document — so a form submitted inside an iframe flushes nothing, and
     * the worker asks the top frame for a save before it files the send. The
     * answer to that question was written into the frames' own listener,
     * behind a check that only the top frame answers, which in that listener
     * is never so: nobody answered, and the send was filed without waiting.
     * "embedded-apply" above saw it only when Submit beat the keeper's
     * two-second tick — the draft 1.4 seconds after the send — so it failed
     * now and then rather than every time. Asked directly here, it fails
     * every time it is broken.
     */
    group('A send from inside a frame asks the top document for its work');
    {
      const page = await context.newPage();
      try {
        // At an address of its own. The walk above closed its tab on this
        // posting, and a closed tab's work waits at its address for the next
        // tab opened there — so the same address arrives with the resume
        // already built and no "Build resume" to press.
        await page.goto(`${fixtures.urlFor(EMBEDDED_APPLY)}?asked=1`, { waitUntil: 'domcontentloaded' });
        await settled(page);
        await cardOf(page).getByRole('button', { name: 'Build resume' }).click();
        await cardOf(page).locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });

        const asked = await (context.serviceWorkers()[0] ?? worker).evaluate(async (url) => {
          const tab = (await chrome.tabs.query({})).find((t) => t.url === url);
          if (!tab) return { reply: { threw: `no tab at ${url}` }, began: 0, savedAt: 0 };
          const key = `trail:${tab.id}`;
          const began = Date.now();
          let reply;
          try {
            reply = await chrome.tabs.sendMessage(tab.id, { type: 'jh-flush-work' }, { frameId: 0 });
          } catch (err) {
            reply = { threw: String(err?.message ?? err) };
          }
          const savedAt = (await chrome.storage.session.get(key))[key]?.at ?? 0;
          return { reply: reply ?? null, began, savedAt };
        }, page.url());

        check('the top document answers the worker', asked.reply?.ok === true, JSON.stringify(asked.reply));
        check(
          'and only once the work it was asked for has been saved',
          asked.savedAt >= asked.began,
          asked.savedAt ? `saved ${asked.savedAt - asked.began}ms after the ask` : '(never saved)',
        );
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    /*
     * A press nobody saw, and the page after it saying it has the
     * application. The press is caught from outside the portal on a control
     * that is entirely the portal's; the receipt is the stronger evidence and
     * nothing listened for it. Walked one at a time: the second is judged by
     * waiting, and a wait is only a fair window on its own.
     */
    group('A send whose press was never seen, taken from the page that says it arrived');
    {
      const { before, after } = await walk(context, fixtures, RECEIPT_APPLY);
      check('the press itself is not one the watcher knows', before.application?.status === 'applying', before.application?.status ?? '(none)');
      check('the receipt files it as sent', after.application?.status === 'applied', after.application?.status ?? '(none)');
      check('and closes its draft', after.draft?.status === 'submitted', after.draft?.status ?? '(none)');
      check(
        'saying why',
        /said the application was received/.test(after.application?.history?.at(-1)?.note ?? ''),
        after.application?.history?.at(-1)?.note ?? '(no history)',
      );
    }
    {
      const { after } = await walk(context, fixtures, RECEIPT_EMBED);
      check(
        'and one drawn inside an embed from another site, judged by the page around it',
        after.application?.status === 'applied',
        after.application?.status ?? '(none)',
      );
    }
    {
      const wrong = { ...RECEIPT_ELSEWHERE, sent: false };
      const { after } = await walk(context, fixtures, wrong);
      check(
        'while a receipt on another site says nothing about this one',
        after.application?.status === 'applying',
        after.application?.status ?? '(none)',
      );
    }

    /*
     * A step that names nobody, on the company's own careers host. The store
     * reads "Corvane" off `careers.corvane.test` and files the workspace
     * under it; staging the files filed a second row under the bare hostname
     * and "Unknown role", because the card read its own fallbacks instead.
     */
    group('An apply step that names nobody is one application, named for the site');
    {
      const page = await context.newPage();
      try {
        const at = new URL(fixtures.urlFor(NAMELESS_APPLY));
        await page.goto(`http://careers.corvane.test:${at.port}${NAMELESS_APPLY.path}${NAMELESS_APPLY.query}`, {
          waitUntil: 'domcontentloaded',
        });
        await settled(page);
        await cardOf(page).getByRole('button', { name: 'Build resume' }).click();
        await cardOf(page).locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
        await awaitFiled('corvane', (f) => f.application && f.draft);
        await page.waitForTimeout(2500);
        const apps = (await fetch(`${SERVER}/api/applications`).then((r) => r.json())).applications ?? [];
        const rows = apps.filter((a) => /corvane/i.test(`${a.company} ${a.url ?? ''}`));
        check('it is filed once', rows.length === 1, JSON.stringify(rows.map((a) => [a.company, a.role])));
        check('under the name the site gives, not its address', rows.every((a) => a.company === 'Corvane'), rows.map((a) => a.company).join(', '));
        check('and says it does not know the role, in so many words', rows.every((a) => a.role === 'Unknown role'), rows.map((a) => a.role).join(', '));
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    /*
     * The one that would be easiest to get wrong: the button that opens an
     * application is often called the same thing as the button that ends one.
     * On a description page "Apply Now" means "show me the form", and taking
     * it as a submission would file every job you so much as looked at.
     */
    group('Apply Now on a description page is not a submission');
    {
      const posting = {
        name: 'posting-with-apply-now',
        path: '/novena/jobs/platform-engineer',
        company: 'Novena Health',
        html: `<!doctype html><html><head><title>Platform Engineer at Novena Health</title></head>
          <body><h1>Novena Health</h1><h2>About the role</h2>
          <p>We are looking for a platform engineer to run our Kafka and Kubernetes estate.
             Responsibilities include owning the streaming infrastructure. Minimum qualifications:
             years of experience with distributed systems. Equal opportunity employer. Full-time.</p>
          <p><a href="#" role="button">Apply Now</a></p></body></html>`,
      };
      const second = await serveFixtures([posting]);
      const page = await context.newPage();
      try {
        await page.goto(second.urlFor(posting), { waitUntil: 'domcontentloaded' });
        await settled(page);
        const before = await filed('Novena');
        await press(page, 'Apply Now');
        await page.waitForTimeout(2200);
        const after = await filed('Novena');
        check(
          'the description page does not file it as sent',
          after.application?.status !== 'applied' || before.application?.status === 'applied',
          `${before.application?.status ?? '(none)'} → ${after.application?.status ?? '(none)'}`,
        );
      } finally {
        await page.close().catch(() => undefined);
        await second.close();
      }
    }

    /*
     * Two applications on one single-page board, in one tab.
     *
     * The watcher says a document was sent once and once only, which is right
     * for a document and wrong for a board where a route change is the only
     * navigation there is: LinkedIn, Workday, Ashby. One document, a whole
     * afternoon, and any number of postings applied to in it. The first send
     * latched `told` and every application after it in that tab went out
     * unrecorded — and an application the tracker never heard about stays on
     * the list of things still to do, which is the quiet half of the failure
     * this file's header is about.
     *
     * Measured, second posting, same tab, form submitted:
     *
     *   with the watcher begun again   Marlow Systems/Data Scientist=applied
     *   without it                     Marlow Systems/Data Scientist=applying
     *
     * The steps before the send are asserted too, because "applied" at the end
     * only means something if it was not already applied at the start: the row
     * has to be seen at `applying` after the route change and after the build,
     * with nothing submitted yet.
     */
    group('A second application on the same single-page board');
    {
      const form = (id) => `<h2>Application</h2><form id="${id}">
        <label>First name <input name="first_name"></label>
        <label>Last name <input name="last_name"></label>
        <label>Email <input name="email" type="email"></label>
        <label>Why do you want to work here? <textarea name="q1"></textarea></label>
        <label>Resume <input type="file" name="resume"></label>
        <button type="submit">Submit Application</button></form>`;
      const about = (what) => `<h2>About the role</h2>
        <p>We are looking for a ${what} to own our systems. Responsibilities
           include shipping to production.</p><h2>Minimum qualifications</h2>
        <ul><li>Years of experience with distributed systems</li></ul>
        <p>Equal opportunity employer. Full-time. Upload your resume to apply.</p>`;

      const board = {
        name: 'one-tab-board',
        path: '/larkspur/jobs/platform-engineer',
        company: 'Larkspur',
        html: `<!doctype html><html><head><title>Platform Engineer at Larkspur</title></head><body>
          <h1 id="co">Larkspur</h1><div id="sub">Platform Engineer</div>
          <div id="view">${about('platform engineer')}</div>
          <p><button id="go" type="button">Apply Now</button></p>
          <script>
            const hold = (id) => document.getElementById(id)
              ?.addEventListener('submit', (e) => e.preventDefault());
            document.getElementById('go').addEventListener('click', () => {
              history.pushState({}, '', '/larkspur/jobs/platform-engineer/apply');
              document.getElementById('go').remove();
              document.getElementById('view').innerHTML = ${JSON.stringify(form('a'))};
              hold('a');
              const next = document.createElement('button');
              next.id = 'to-b'; next.type = 'button';
              next.textContent = 'Open the next role';
              document.body.appendChild(next);
              next.addEventListener('click', () => {
                history.pushState({}, '', '/marlow/jobs/data-scientist');
                document.title = 'Data Scientist at Marlow Systems';
                document.getElementById('co').textContent = 'Marlow Systems';
                document.getElementById('sub').textContent = 'Data Scientist';
                document.getElementById('view').innerHTML =
                  ${JSON.stringify(about('data scientist'))} + ${JSON.stringify(form('b'))};
                hold('b');
              });
            });
          </script></body></html>`,
      };

      const boardServer = await serveFixtures([board]);
      const page = await context.newPage();
      try {
        const card = cardOf(page);
        const build = async () => {
          await card.locator('.role').waitFor({ timeout: 40_000 });
          await card.getByRole('button', { name: 'Build resume' }).click({ timeout: 30_000 });
          await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
        };

        await page.goto(boardServer.urlFor(board), { waitUntil: 'domcontentloaded' });
        await settled(page);
        await build();
        await page.click('#go');
        await page.waitForTimeout(3000);

        /*
         * Attach, against a form that really has an upload box and a resume
         * that has really been built. Everything else about attaching is
         * driven against the module in a bare page; this is the one check
         * that the whole path holds together — the card asks the worker, the
         * worker fetches the bytes off the store, and a file with the right
         * name ends up in the box the employer reads.
         */
        await card.getByRole('button', { name: 'Attach files' }).click({ timeout: 30_000 });
        await page.waitForTimeout(4000);
        const inBox = await page.evaluate(
          () => [...(document.querySelector('input[type=file]')?.files ?? [])].map((f) => f.name),
        );
        check('the built resume goes into the form’s upload box', inBox.some((n) => /\.pdf$/i.test(n)), JSON.stringify(inBox));
        check('and it is named for this application', inBox.some((n) => /larkspur|resume/i.test(n)), JSON.stringify(inBox));
        const said = (await card.innerText()).replace(/\s+/g, ' ');
        const note = (await page.evaluate(() => {
          const card = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          return [...(card?.querySelectorAll('.ok-note') ?? [])].map((n) => n.textContent).join(' | ');
        })) || '(no note)';
        check('and the card says what it attached', /Attached [^.]*\.pdf/i.test(said), note.slice(0, 200));

        await press(page, 'Submit Application');
        const first = await awaitFiled('Larkspur', (f) => f.application?.status === 'applied');
        check('the first application is recorded', first.application?.status === 'applied', first.application?.status ?? '(none)');

        await page.click('#to-b');
        await page.waitForTimeout(4000);
        await settled(page);
        await build();
        const opened = await awaitFiled('Marlow Systems', (f) => f.application?.status === 'applying');
        check(
          'the second posting is held, not yet sent',
          opened.application?.status === 'applying',
          opened.application?.status ?? '(none)',
        );

        await press(page, 'Submit Application');
        const second = await awaitFiled(
          'Marlow Systems',
          (f) => f.application?.status === 'applied' && f.draft?.status === 'submitted',
        );
        check(
          'and pressing Submit on it is recorded too',
          second.application?.status === 'applied',
          second.application?.status ?? '(none)',
        );
        check(
          'with its draft closed, like the first',
          second.draft?.status === 'submitted',
          second.draft?.status ?? '(none)',
        );
      } finally {
        await page.close().catch(() => undefined);
        await boardServer.close();
      }
    }

    /*
     * A press the browser refuses is not a send.
     *
     * The click listener exists because these systems routinely call
     * `preventDefault` and post the form by hand, so waiting for a `submit`
     * event misses real sends. But constraint validation is where a click and
     * a send come apart hardest: an empty required field means no `submit`
     * event fires at all, while the capture-phase click listener has already
     * run and latched. The page said "Please fill out this field.", the
     * application was still sitting there, and the card said "Recorded as
     * sent."
     *
     * Driven against the real module in a bare page rather than through the
     * store, because the question is entirely about what the browser does with
     * a click — and the surrounding cases are what stop the fix from being a
     * cure worse than the disease.
     */
    group('A press the browser refuses');
    {
      const src = fs.readFileSync(path.join(extensionRoot, 'src/shared/sending.js'), 'utf8');
      /** The same markup, behind an open shadow boundary. */
      const inShadow = (html) =>
        `<div id="host"></div><script>
          document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
            ${JSON.stringify(html)};
          document.getElementById('host').shadowRoot
            .querySelector('form').addEventListener('submit', (e) => e.preventDefault());
        </script>`;
      const cases = [
        ['a valid form, submitted natively', true,
          '<form onsubmit="event.preventDefault()"><input name="n" required value="Jane">' +
          '<button type="submit">Submit Application</button></form>'],
        ['a script send on a role=button, fields still empty', true,
          '<form><input name="n" required><div role="button">Submit Application</div></form>'],
        ['a script send on a type=button inside an invalid form', true,
          '<form><input name="n" required><button type="button">Submit Application</button></form>'],
        ['a form that has opted out of validation', true,
          '<form novalidate onsubmit="event.preventDefault()"><input name="n" required>' +
          '<button type="submit">Submit Application</button></form>'],
        ['a button that has opted out of validation', true,
          '<form onsubmit="event.preventDefault()"><input name="n" required>' +
          '<button type="submit" formnovalidate>Submit Application</button></form>'],
        ['an empty required field, which the browser blocks', false,
          '<form><input name="n" required><button type="submit">Submit Application</button></form>'],
        /*
         * And the same three from inside an open shadow root.
         *
         * A click is retargeted on its way out of one: at a document listener
         * `event.target` is the host, which is a `<div>`, so `closest('button,
         * …')` found nothing and a real send went unrecorded. Not a curiosity —
         * `looksLikeApplicationForm` and `attachFiles` both walk shadow roots
         * on purpose, because several of these portals are web components, so
         * the card would fill such a form and attach to it and then miss it
         * going out.
         *
         * The third is the control: the boundary must not turn off the reasons
         * a press is *not* a send, or this would be a fix that records
         * everything.
         */
        ['a press inside an open shadow root', true, inShadow(
          '<form><input name="n" required><button type="button">Submit Application</button></form>')],
        ['a native submit inside an open shadow root', true, inShadow(
          '<form novalidate><input name="n" value="Jane"><button type="submit">Submit Application</button></form>')],
        ['an empty required field inside an open shadow root', false, inShadow(
          '<form><input name="n" required><button type="submit">Submit Application</button></form>')],
      ];

      for (const [what, shouldRecord, html] of cases) {
        const bare = await context.newPage();
        try {
          await bare.setContent(`<!doctype html><title>Apply</title>${html}`);
          await bare.evaluate(async (js) => {
            const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
            window.__said = [];
            mod.watchForSending(document, (how) => window.__said.push(how));
          }, src);
          await bare.click('button, [role=button]');
          await bare.waitForTimeout(150);
          const recorded = await bare.evaluate(() => window.__said.length > 0);
          check(
            shouldRecord ? `${what} is recorded` : `${what} is not recorded`,
            recorded === shouldRecord,
            `recorded=${recorded}`,
          );
        } finally {
          await bare.close().catch(() => undefined);
        }
      }
    }

    /*
     * What counts as the page saying so. Against the real module in a bare
     * page, like the refusals above: the question is only which words, where.
     */
    group('What a receipt looks like');
    {
      const src = fs.readFileSync(path.join(extensionRoot, 'src/shared/sending.js'), 'utf8');
      const cases = [
        ['Greenhouse\u2019s confirmation heading', true, '<h1>Thank you for applying.</h1>'],
        ['a dialog drawn over the form', true, '<form><input></form><div role="dialog"><h2>Application Submitted</h2><p>Your application has been submitted.</p></div>'],
        ['a status line', true, '<div role="status">Your application was successfully submitted</div>'],
        ['a title and nothing else', true, '<title>Application received</title><p>Done.</p>', true],
        ['thanks for interest, on the description', false, '<h2>Thank you for your interest in Acme</h2>'],
        ['the invitation to apply, on the form', false, '<h2>Submit your application</h2>'],
        ['a thank-you the form holds hidden until later', false, '<h1 style="display:none">Thank you for applying</h1><form><input></form>'],
        ['the words in a paragraph of help text', false, '<p>Once your application has been submitted you will get an email.</p>'],
        ['a status too long to be one line', false, `<div role="status">${'Your application has been submitted to the queue. '.repeat(6)}</div>`],
      ];
      for (const [what, says, html, own] of cases) {
        const bare = await context.newPage();
        try {
          await bare.setContent(own ? `<!doctype html>${html}` : `<!doctype html><title>Apply</title>${html}`);
          const got = await bare.evaluate(async (js) => {
            const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
            return mod.saysItWasReceived(document);
          }, src);
          check(says ? `${what} says it` : `${what} does not`, got === says, `said=${got}`);
        } finally {
          await bare.close().catch(() => undefined);
        }
      }
    }

    console.log('\nTime per system');
    for (const t of [...timings].sort((a, b) => b.ms - a.ms)) {
      console.log(`  ${(t.ms / 1000).toFixed(1)}s  ${t.name}`);
    }
    console.log(`\nWhole sweep: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await cleanStore(SERVER, MINE).catch(() => undefined);
    await context.close();
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
