/**
 * Three applications, three tabs, at the same time.
 *
 * Nobody applies to one job. They open four postings, tailor a resume on the
 * first, start a letter on the second, go back to the first — and the tool has
 * to keep those apart without being told. The service worker's `trailKey` is
 * the line that does it, and the comment above it records what it cost before
 * it was there: one trail for the whole browser, every tab's card saving its
 * work every couple of seconds over the top of every other tab's, so "a tab
 * reading about one company would, on navigating, come back holding the other
 * company's description and the other company's resume". A letter written from
 * that card is addressed to the wrong employer from a resume tailored to a job
 * you are not applying for, which is the exact failure this whole tool exists
 * to prevent.
 *
 * So this walks three applications at once and never finishes one before
 * starting the next. Each tab reads a posting and is offered a keyword match
 * of its own, walks its own Apply link to a form that names nobody, reads the
 * match offered there — where the description can only have come from this
 * tab's trail — takes it, builds, and writes a letter naming its own employer.
 * Every step happens in tab 1, then tab 2, then tab 3, and only then does the
 * next step begin.
 *
 * Two of the three postings are the case that actually breaks: their forms are
 * a number on a shared host (`/gh/j/4821`, `/gh/j/9912`, `/gh/j/7730`) and say
 * nothing about who is hiring. The employer, the job and the proposal on those
 * cards are a direct reading of whether the tab kept its own trail.
 *
 *   RMM_SERVER=http://127.0.0.1:4601 node tests/tabs.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALL,
  HARBOUR_ROLE,
  HARBOUR_FORM,
  KESTREL_ROLE,
  KESTREL_FORM,
  MARIGOLD_ROLE,
  MARIGOLD_FORM,
  cleanStore,
  findChromium,
  pointExtensionAt,
  requireOpenSave,
  serveFixtures,
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

/**
 * The three applications, and the one word that tells each of them apart.
 *
 * The store keeps its Languages group as Python, SQL, TypeScript, Java, Go and
 * C. A keyword match against these three descriptions narrows that group three
 * different ways, so `keeps` is one skill that survives in one posting's
 * proposal and is dropped from the other two's — on the card, and in the
 * resume that reaches the store. `foreign` is the other two, which is what a
 * contaminated card would be showing.
 *
 * Matched as a whole entry rather than as text: "SQL" is a substring of
 * "PostgreSQL", and a check that reads the row as a string calls Harbour's
 * proposal Harbour's for the wrong reason and would go on doing so with
 * somebody else's resume on screen.
 *
 * Every letter names its own employer, for the same reason: the text in the
 * box is either this tab's or it is evidence.
 */
const TABS = [
  {
    n: 1,
    role: HARBOUR_ROLE,
    form: HARBOUR_FORM,
    company: 'Harbour Analytics',
    title: 'Data Scientist, Pricing',
    keeps: 'SQL',
    letter: 'I would like to build the pricing models at Harbour Analytics.',
  },
  {
    n: 2,
    role: MARIGOLD_ROLE,
    form: MARIGOLD_FORM,
    company: 'Marigold',
    title: 'Frontend Engineer, Design Systems',
    keeps: 'TypeScript',
    letter: 'I would like to own the design system at Marigold.',
  },
  {
    n: 3,
    role: KESTREL_ROLE,
    form: KESTREL_FORM,
    company: 'Kestrel Freight',
    title: 'Streaming Infrastructure Engineer',
    keeps: 'Go',
    letter: 'I would like to run the streaming estate at Kestrel Freight.',
  },
];
for (const tab of TABS) tab.foreign = TABS.filter((t) => t !== tab);

/*
 * Starting from a resume, per application.
 *
 * The card's "Start from" picker wrote the one setting every tab shares. So
 * switching it on one application changed where every other tab rebuilt from
 * and where the next posting started, and a tailored copy picked on one
 * employer's posting became the starting point of the next: a user's Waymo
 * posting opened on the resume made for, and sent to, Keysight, and "keeps on
 * putting me back on this other resume created and submitted on another
 * site". Two postings of their own, so nothing above is disturbed.
 */
const PELLUCID = 'Pellucid Robotics';
const QUORRA = 'Quorra Labs';
const KEYSIGHT = 'Keysight Technologies, Inc.';
const SUMMER = 'tabs-summer-2027-intern';
const SENT_ELSEWHERE = 'job-keysight-technologies-inc-tabs-engineering-software-developer-intern';
const jobPage = (company, title, body, extra = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title} — ${company}</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"JobPosting","title":"${title}",
"hiringOrganization":{"@type":"Organization","name":"${company}"},"description":"<p>${body}</p>"}</script>
</head><body><h1>${title}</h1><p>${company} is hiring. ${body}</p>${extra}</body></html>`;
const PELLUCID_ROLE = {
  name: 'pellucid-role',
  path: '/pellucid/jobs/robotics-software-intern',
  company: PELLUCID,
  html: jobPage(PELLUCID, 'Robotics Software Intern', 'Write Go and Python services on Kubernetes for distributed systems. Kafka, AWS.',
    '<p><a href="/pellucid/jobs/robotics-software-intern/apply">Apply</a></p>'),
};
const PELLUCID_FORM = {
  name: 'pellucid-form',
  path: '/pellucid/jobs/robotics-software-intern/apply',
  company: PELLUCID,
  html: jobPage(PELLUCID, 'Robotics Software Intern', 'Write Go and Python services on Kubernetes.',
    `<h2>Apply for this job</h2><form><label for="fn">First Name</label><input id="fn" name="first_name">
<label for="em">Email</label><input id="em" name="email" type="email"></form>`),
};
const QUORRA_ROLE = {
  name: 'quorra-role',
  path: '/quorra/careers/platform-intern',
  company: QUORRA,
  html: jobPage(QUORRA, 'Platform Intern', 'Run streaming infrastructure in Go on Kubernetes and AWS. Kafka, distributed systems.'),
};
const QUORRA_AGAIN = { ...QUORRA_ROLE, name: 'quorra-again', path: '/quorra/careers/data-intern',
  html: jobPage(QUORRA, 'Data Intern', 'Build pipelines in Python and SQL. Kafka.') };

/** What this suite files under, cleared before it starts as well as after. */
const MINE = [...TABS.map((t) => t.company), PELLUCID, QUORRA, KEYSIGHT];

/** What the "Start from" picker says, and the base the proposal names. */
const startsFrom = (page) =>
  page.evaluate(() => {
    const root = document.querySelector('#jobhelper-card-host')?.shadowRoot;
    return {
      value: root?.querySelector('select')?.value ?? null,
      from: root?.querySelector('.diff-head .from-label')?.textContent ?? null,
    };
  });

/**
 * Lifted from `tests/carrying.mjs`: wait for the card to stop changing rather
 * than for a number of milliseconds. It fills in as the page is read — the
 * role first, the employer once it is worked out, then the buttons — and a
 * fixed sleep is a bet on how long that takes on this machine. With three tabs
 * analysing at once that bet is worse than usual.
 */
async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 30_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
  await page
    .locator(`${HOST} .card:not(.loading)`)
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined);
  const read = () => page.locator(`${HOST} .card`).innerText().catch(() => '');
  let last = await read();
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(250);
    const now = await read();
    if (now && now === last) return;
    last = now;
  }
}

/**
 * The list of changes is shut when it is drawn — the card leads with the count
 * — so open it before reading rows, which is what somebody looking at one of
 * them has done.
 */
async function openChanges(card) {
  if (await card.locator('.changes.shut').count()) {
    await card.locator('button.fold-changes').first().click();
    await card.locator('.changes.shut').waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
  }
}

/**
 * Wait for the keyword match this card was offered, and open it.
 *
 * There was a "Match by keyword" button here to press. The match is not a mode
 * any more — it runs on arrival and what it produces is a list of offers — so
 * the rows are already on the card and all that is left is unfolding them.
 * Which loses nothing this suite cared about: the rows are still worked out
 * from this tab's description, so which skills they say they would keep is
 * still a direct reading of whose posting this card thinks it is on.
 *
 * Tolerant of never getting one, on purpose. A card whose trail has been taken
 * from it proposes nothing at all, and a `waitFor` that throws there ends the
 * run with a stack trace in the middle of the report — every check after it
 * unasked, including the ones about the store. A proposal that does not arrive
 * is an empty list, which the checks below have plenty to say about.
 */
async function suggestionsOn(card) {
  await card.locator('.diff-head').first().waitFor({ timeout: 60_000 }).catch(() => undefined);
  await openChanges(card);
  await card.locator('.change').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
}

/** Every row that is a decision, and whether it is switched off. */
const pickableIn = (card) => card.locator('.change:has(.pick)');
const offFlags = async (card) => {
  const rows = await pickableIn(card).all();
  return Promise.all(rows.map(async (r) => (await r.getAttribute('class'))?.includes('off') === true));
};

/**
 * Tick every box, which is what pressing "Match by keyword" used to do in one
 * go.
 *
 * Needed because the suggestions arrive switched off. Without this the resume
 * each tab builds is its base resume untouched, identical in all three — so
 * the checks at the bottom, which ask whether the *filed* document keeps this
 * posting's skill and neither of the other two's, would be reading a document
 * no tab had tailored. Those checks would fail rather than pass quietly, but
 * failing for want of a click is not what they are there to catch.
 *
 * Waited on the box rather than on a clock or a fit badge: ticking one
 * recompiles and the boxes are dead for the length of it, so a click landing
 * mid-compile is a click on a disabled input — it does nothing and says
 * nothing.
 */
async function takeEverySuggestion(card, page) {
  const rows = await pickableIn(card).all();
  for (const [i, row] of rows.entries()) {
    const box = row.locator('.pick input');
    for (let w = 0; w < 800 && !(await box.isEnabled().catch(() => false)); w++) await page.waitForTimeout(150);
    await row.locator('.pick').click();
    for (let w = 0; w < 800 && (await pickableIn(card).nth(i).getAttribute('class'))?.includes('off'); w++) {
      await page.waitForTimeout(150);
    }
  }
  return rows.length;
}

/**
 * Every skill the proposal on screen says it is keeping, one entry each.
 *
 * Only the kept side. All six of these skills appear in all three of these
 * proposals — the whole point is which side of "dropped … — keeping …" they
 * land on, so reading the rows whole would say the same thing about every tab
 * and prove nothing.
 */
async function kept(card) {
  await openChanges(card);
  const rows = await card.locator('.change').allInnerTexts();
  return rows
    .flatMap((row) => [...row.matchAll(/keeping ([^\n]+)/g)].map((m) => m[1]))
    .flatMap((list) => list.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

/** Whether a proposal is this posting's and not either of the other two's. */
const ownsIt = (tab, items) =>
  items.includes(tab.keeps) && tab.foreign.every((other) => !items.includes(other.keeps));

/** Readable either way round, including when there is nothing to read. */
const listed = (items) => (items.length ? items.join(', ') : '(nothing proposed)');

/**
 * Who the card in front of us thinks is hiring, and for what.
 *
 * Checked as two claims rather than one, because they fail apart: a card can
 * take another tab's employer while keeping the role it read off the page it
 * is standing on.
 */
async function saysWhose(tab, where) {
  const card = cardOf(tab.page);
  const role = (await card.locator('.role').innerText().catch(() => '')).trim();
  const co = (await card.locator('.co').innerText().catch(() => '')).trim();
  check(
    `${where} tab ${tab.n} says ${tab.title}`,
    role.includes(tab.title) && tab.foreign.every((o) => !role.includes(o.title)),
    role || '(nothing)',
  );
  check(
    `${where} tab ${tab.n} says ${tab.company}`,
    co.includes(tab.company) && tab.foreign.every((o) => !co.includes(o.company)),
    co || '(nothing)',
  );
}

/**
 * The tracker, however it answers.
 *
 * `/api/resumes` comes back as a bare array; `/api/applications` wraps its
 * list in `applications` on the server this was written against. Both shapes
 * are accepted rather than picked between, because a suite that dies on the
 * wrong one reports a JSON shape when it was asked about cross-tab
 * contamination.
 */
const bare = (body, field) => (Array.isArray(body) ? body : (body?.[field] ?? []));
const applications = async () => bare(await (await fetch(`${SERVER}/api/applications`)).json(), 'applications');
const resumes = async () => bare(await (await fetch(`${SERVER}/api/resumes`)).json(), 'resumes');

/**
 * The skills the resume that would actually be attached still prints.
 *
 * The resolved document rather than the spec, and read whole rather than one
 * group at a time: the narrowing lands in whichever group the posting's words
 * fall in, and a check that looked only at Frameworks would have been reading
 * a group two of these three postings leave alone.
 */
async function filedSkills(resumeId) {
  const resolved = await (await fetch(`${SERVER}/api/resumes/${encodeURIComponent(resumeId)}/resolved`)).json();
  return (resolved?.sections ?? []).flatMap((s) => s.skillGroups ?? []).flatMap((g) => g.items ?? []);
}

/**
 * One step in tab 1, then the same step in tab 2, then in tab 3.
 *
 * The interleaving is the test. Walking one application to the end and then
 * starting the next proves nothing about tabs: the bug needs two trails alive
 * at the same time, each saving over the other between the steps of the first.
 */
async function inTurn(name, step) {
  group(name);
  for (const tab of TABS) {
    await tab.page.bringToFront();
    await step(tab);
  }
}

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }
  await cleanStore(SERVER, MINE);

  // The three pairs live below `ALL`, so they have to be named to be served.
  const fixtures = await serveFixtures([
    ...ALL,
    HARBOUR_ROLE,
    HARBOUR_FORM,
    MARIGOLD_ROLE,
    MARIGOLD_FORM,
    KESTREL_ROLE,
    KESTREL_FORM,
    PELLUCID_ROLE,
    PELLUCID_FORM,
    QUORRA_ROLE,
    QUORRA_AGAIN,
  ]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-tabs-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    for (const tab of TABS) tab.page = await context.newPage();

    await inTurn('Three postings, one tab each', async (tab) => {
      await tab.page.goto(fixtures.urlFor(tab.role), { waitUntil: 'domcontentloaded' });
      await settled(tab.page);
      const card = cardOf(tab.page);
      const role = (await card.locator('.role').innerText()).trim();
      const co = (await card.locator('.co').innerText()).trim();
      check(`tab ${tab.n} is reading ${tab.company}`, role.includes(tab.title) && co.includes(tab.company), `${role} · ${co}`);
    });

    /*
     * The match runs on arrival now, so "nothing is tailored yet" stopped
     * being "there are no rows" and became "every row is switched off".
     *
     * Read off the boxes and the count for that reason. Counting rows was the
     * old proof and it is no proof at all here — six rows on arrival is the
     * correct state — while a card that had quietly applied them would look
     * exactly the same to it.
     */
    await inTurn('Nothing is applied until it is asked for', async (tab) => {
      const card = cardOf(tab.page);
      const off = await offFlags(card);
      const count = (await card.locator('.diff-head .count').innerText().catch(() => '')).trim();
      const said = (await card.locator('.step .hint', { hasText: /untouched/ }).first().innerText().catch(() => '')).trim();
      check(
        `tab ${tab.n} was offered a match without asking`,
        off.length > 0,
        `${off.length} suggestions`,
      );
      check(
        `tab ${tab.n} arrived with the resume unchanged`,
        off.length > 0 && off.every(Boolean) && /^0 of \d+ changes$/.test(count) && /exactly as you keep it/i.test(said),
        `${off.filter(Boolean).length}/${off.length} off · ${count} · ${said.slice(0, 48)}`,
      );
      // These two are description pages; the letter step belongs to the form
      // they link to, and typing one here would be typing into the notes box.
      check(`and with no letter to write yet`, (await card.locator('textarea.tall').count()) === 0);
    });

    await inTurn('The match each tab was offered, read in turn', async (tab) => {
      const card = cardOf(tab.page);
      await suggestionsOn(card);
      tab.keptOnPosting = await kept(card);
      check(
        `tab ${tab.n} proposes a resume for ${tab.company}`,
        ownsIt(tab, tab.keptOnPosting),
        listed(tab.keptOnPosting),
      );
    });

    /*
     * And off to the form, which is where it went wrong. A card on a
     * description page can always fall back on the page in front of it; a card
     * on `/gh/j/4821` has nothing but the trail, so everything it says from
     * here is a reading of whether this tab kept its own.
     */
    await inTurn('Following each Apply link to a form that names nobody', async (tab) => {
      await tab.page.click(`a[href="${tab.form.path}"]`);
      await tab.page.waitForLoadState('domcontentloaded');
      await settled(tab.page);
      check(`tab ${tab.n} is on its own form`, tab.page.url().endsWith(tab.form.path), tab.page.url());
      // Nothing on this page says either of these. Both come from the trail.
      await saysWhose(tab, 'on the form,');
    });

    await inTurn('The match offered on the form, worked out from the posting behind it', async (tab) => {
      const card = cardOf(tab.page);
      await suggestionsOn(card);
      tab.keptOnForm = await kept(card);
      check(
        `tab ${tab.n} matched against ${tab.company}'s posting, not another tab's`,
        ownsIt(tab, tab.keptOnForm),
        listed(tab.keptOnForm),
      );
    });

    /*
     * And taken, one box at a time, before anything is built.
     *
     * The rows above are what the card *says*; from here on this suite is
     * about what each tab *sends*, and until the boxes are on those are two
     * different documents. Three tabs building their untouched base resume
     * would file three identical resumes, which is the shape of the bug this
     * whole suite exists to catch — so the taking is a step of its own, and it
     * is checked, rather than being assumed as a side effect of a mode.
     */
    await inTurn('Taking every suggestion, in each tab in turn', async (tab) => {
      const card = cardOf(tab.page);
      const offered = await takeEverySuggestion(card, tab.page);
      const off = await offFlags(card);
      const count = (await card.locator('.diff-head .count').innerText().catch(() => '')).trim();
      check(
        `tab ${tab.n} switched on all ${offered} of them`,
        offered > 0 && off.length === offered && off.every((x) => !x) && count === `${offered} changes`,
        `${off.filter((x) => !x).length}/${off.length} on · ${count}`,
      );
      // The rows are a record of what was offered, not of what was taken, so
      // they say the same thing before and after — and this tab's reading of
      // its own posting has to have survived the ticking.
      check(
        `and tab ${tab.n} is still holding ${tab.company}'s match`,
        ownsIt(tab, await kept(card)),
        listed(await kept(card)),
      );
    });

    await inTurn('"Build resume", in each tab in turn', async (tab) => {
      const card = cardOf(tab.page);
      await card.getByRole('button', { name: /^(Build resume|Recompile)$/ }).first().click();
      await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 180_000 });
      check(`tab ${tab.n} built a resume`, true, (await card.locator('.fit.ok, .fit.bad').innerText()).trim());
    });

    await inTurn('A cover letter in each, naming its own employer', async (tab) => {
      const card = cardOf(tab.page);
      const box = card.locator('textarea.tall').first();
      await box.waitFor({ timeout: 30_000 });
      await box.click();
      await box.pressSequentially(tab.letter, { delay: 6 });
      check(`tab ${tab.n} wrote to ${tab.company}`, (await box.inputValue()) === tab.letter);
    });

    // The keeper writes on an interval, so every tab has now saved its work
    // over whatever the others saved — which, with one trail, is the moment
    // the last writer wins and the other two lose their application.
    await TABS[0].page.waitForTimeout(4000);

    /*
     * And then everybody navigates, which is the step the bug needed.
     *
     * Work held in an open card is held in that tab's memory and survives
     * anything the other tabs do to storage — so the checks below would pass
     * over a browser-wide trail as happily as over a per-tab one, and prove
     * nothing. Navigating is what makes the card ask for its work back: go and
     * read the description again to check what it asked for, come back to the
     * form. Ordinary, and it is the sentence in the worker's own comment —
     * "a tab reading about one company would, on navigating, come back holding
     * the other company's description".
     */
    await inTurn('Off to read each posting again, and back to its form', async (tab) => {
      await tab.page.goto(fixtures.urlFor(tab.role), { waitUntil: 'domcontentloaded' });
      await settled(tab.page);
      await tab.page.goto(fixtures.urlFor(tab.form), { waitUntil: 'domcontentloaded' });
      await settled(tab.page);
      check(`tab ${tab.n} is back on its own form`, tab.page.url().endsWith(tab.form.path), tab.page.url());
    });

    /*
     * Back to the first tab, which is what a person does: three postings open,
     * work in all three, and the one you come back to is the one you started.
     */
    await inTurn('Back to each tab, and finding its own work in it', async (tab) => {
      const card = cardOf(tab.page);
      await saysWhose(tab, 'back in');

      // Handed back by the trail, not still in the box: nothing has been typed
      // in this tab since it navigated away and came back.
      const written = await card.locator('textarea.tall').first().inputValue();
      check(
        `tab ${tab.n} was handed back the letter written in it`,
        written === tab.letter && tab.foreign.every((o) => !written.includes(o.company)),
        written.slice(0, 70) || '(empty)',
      );

      /*
       * And the proposal, read once more. The card works the match out again
       * when it comes back from a navigation, and by then the description it
       * is matching against is only in the trail — so which skills these rows
       * say they would keep is, again, a reading of whose posting this tab
       * thinks it is on. The rows used to have to be asked for by hand; they
       * arrive with the card now, and only the fold is left to open.
       */
      await suggestionsOn(card);
      const now = await kept(card);
      check(`tab ${tab.n} still holds ${tab.company}'s proposal`, ownsIt(tab, now), listed(now));
      check(
        'and it is the one this tab was shown before it wandered',
        now.length > 0 && now.join(', ') === tab.keptOnForm.join(', '),
        `${listed(tab.keptOnForm)} → ${listed(now)}`,
      );
    });

    group('And the store has three applications, not one');
    {
      const all = await applications();
      const stored = await resumes();
      const ids = new Set(stored.map((r) => r.id));

      const mine = TABS.map((tab) => ({
        tab,
        rows: all.filter((a) => (a.company ?? '') === tab.company),
      }));
      check(
        'each employer is filed once, under its own name',
        mine.every((m) => m.rows.length === 1),
        mine.map((m) => `${m.tab.company}: ${m.rows.length}`).join(', '),
      );

      const resumeIds = mine.map((m) => m.rows[0]?.resumeId ?? null);
      check(
        'and each has a resume of its own, not a shared one',
        new Set(resumeIds).size === TABS.length && resumeIds.every(Boolean),
        JSON.stringify(resumeIds),
      );
      check(
        'which the store actually lists',
        resumeIds.every((id) => id && ids.has(id)),
        `${stored.length} resumes listed`,
      );

      for (const { tab, rows } of mine) {
        const row = rows[0];
        check(
          `${tab.company}'s application is for ${tab.title}`,
          (row?.role ?? '') === tab.title,
          row?.role ?? '(nothing filed)',
        );
        check(
          `and points at the form tab ${tab.n} was on`,
          (row?.url ?? '').endsWith(tab.form.path),
          row?.url ?? '(no url)',
        );
        if (!row?.resumeId) {
          check(`and the resume filed for ${tab.company} is tailored to it`, false, '(no resume)');
          continue;
        }
        const items = await filedSkills(row.resumeId);
        check(
          `and the resume filed for ${tab.company} keeps ${tab.keeps}, and neither of the others'`,
          ownsIt(tab, items),
          JSON.stringify(items),
        );
      }
    }
    group('The resume a tab starts from is that application\'s, not every tab\'s');
    {
      const json = (r) => r.json();
      const listed = bare(await fetch(`${SERVER}/api/resumes`).then(json), 'resumes');
      const base = listed.find((r) => r.id === 'base');
      const put = (id, spec) =>
        fetch(`${SERVER}/api/resumes/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(spec) });
      await put(SUMMER, { ...base, id: SUMMER, label: 'Summer 2027 intern', tier: 'base' });
      // Made for, and sent to, another employer on another site.
      await put(SENT_ELSEWHERE, {
        ...base,
        id: SENT_ELSEWHERE,
        label: `Engineering Software Developer, Intern in Multiple Locations | ${KEYSIGHT}`,
        tier: 'temporary',
        copiedFrom: SUMMER,
        generatedFor: { company: KEYSIGHT, role: 'Engineering Software Developer, Intern', url: 'https://jobs.keysight.example/1', at: '2026-09-20T10:00:00.000Z' },
      });
      await fetch(`${SERVER}/api/applications`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company: KEYSIGHT, role: 'Engineering Software Developer, Intern', status: 'applied', resumeId: SENT_ELSEWHERE, url: 'https://jobs.keysight.example/1' }),
      });
      // And last picked, which is how the default came to name it.
      await worker.evaluate((id) => chrome.storage.sync.set({ baseResumeId: id }), SENT_ELSEWHERE);
      const setting = () => worker.evaluate(async () => (await chrome.storage.sync.get('baseResumeId')).baseResumeId);
      const pinned = new Set([...listed.filter((r) => r.tier === 'base').map((r) => r.id), SUMMER]);

      const a = await context.newPage();
      const b = await context.newPage();
      try {
        await a.bringToFront();
        await a.goto(fixtures.urlFor(PELLUCID_ROLE), { waitUntil: 'domcontentloaded' });
        await settled(a);
        await b.bringToFront();
        await b.goto(fixtures.urlFor(QUORRA_ROLE), { waitUntil: 'domcontentloaded' });
        await settled(b);
        const aAt = await startsFrom(a);
        const bAt = await startsFrom(b);
        check(
          'a posting does not start from a copy made for another application',
          aAt.value !== SENT_ELSEWHERE && bAt.value !== SENT_ELSEWHERE && !/Keysight/.test(`${aAt.from} ${bAt.from}`),
          `${aAt.value} · ${bAt.value}`,
        );
        check('it starts from a base instead', pinned.has(aAt.value) && pinned.has(bAt.value), `${aAt.value} · ${bAt.value}`);

        // Switched in tab A, to a base that is not the one it started from.
        const target = aAt.value === SUMMER ? 'base' : SUMMER;
        await a.bringToFront();
        await cardOf(a).locator('select').first().selectOption(target);
        await a.waitForFunction(
          (want) => document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('select')?.value === want &&
            !/Starting from that resume/.test(document.querySelector('#jobhelper-card-host')?.shadowRoot?.textContent ?? ''),
          target,
          { timeout: 30_000 },
        ).catch(() => undefined);
        const label = listed.find((r) => r.id === target)?.label ?? 'Summer 2027 intern';
        let now = await startsFrom(a);
        check('the switch takes in the tab it was made in', now.value === target && now.from === label, JSON.stringify(now));
        check('and leaves the default in the popup alone', (await setting()) === SENT_ELSEWHERE, String(await setting()));

        // A redraw, then the store moving under it: built and filed, and two
        // of the watcher's ticks.
        await openChanges(cardOf(a));
        now = await startsFrom(a);
        check('it holds through a redraw', now.value === target && now.from === label, JSON.stringify(now));
        await cardOf(a).getByRole('button', { name: /^(Build resume|Recompile)$/ }).first().click();
        await cardOf(a).locator('.fit.ok, .fit.bad').waitFor({ timeout: 180_000 });
        await a.waitForTimeout(9000);
        now = await startsFrom(a);
        const copy = bare(await fetch(`${SERVER}/api/resumes`).then(json), 'resumes').find((r) => /pellucid/.test(r.id));
        check('and through the store changing, watched', now.value === target && now.from === label, JSON.stringify(now));
        check('and the copy filed is built from it', copy?.copiedFrom === target, `${copy?.id} from ${copy?.copiedFrom}`);

        // Tab B, read again: its own application, which nobody switched.
        await b.bringToFront();
        await b.reload({ waitUntil: 'domcontentloaded' });
        await settled(b);
        const bAgain = await startsFrom(b);
        check('the other tab still starts from where it started', bAgain.value === bAt.value, `${bAt.value} → ${bAgain.value}`);

        // And the next posting, in that tab, from the default rather than from tab A's switch.
        await b.goto(fixtures.urlFor(QUORRA_AGAIN), { waitUntil: 'domcontentloaded' });
        await settled(b);
        const next = await startsFrom(b);
        check('and so does the next posting', next.value === bAt.value, `${next.value}`);

        // Tab A, on to its form: the same application, so the same resume.
        await a.bringToFront();
        await a.click(`a[href="${PELLUCID_FORM.path}"]`);
        await a.waitForLoadState('domcontentloaded');
        await settled(a);
        now = await startsFrom(a);
        check('and it follows the application to its form', a.url().endsWith(PELLUCID_FORM.path) && now.value === target && now.from === label, `${a.url()} ${JSON.stringify(now)}`);
        await a.waitForTimeout(9000);
        now = await startsFrom(a);
        check('and stays there', now.value === target && now.from === label, JSON.stringify(now));
      } finally {
        await a.close().catch(() => undefined);
        await b.close().catch(() => undefined);
        await pointExtensionAt(context, worker, SERVER);
        await worker.evaluate(() => chrome.storage.sync.remove('baseResumeId')).catch(() => undefined);
        await fetch(`${SERVER}/api/resumes/${SENT_ELSEWHERE}`, { method: 'DELETE' }).catch(() => undefined);
        await fetch(`${SERVER}/api/resumes/${SUMMER}`, { method: 'DELETE' }).catch(() => undefined);
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
