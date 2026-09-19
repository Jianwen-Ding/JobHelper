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
 * starting the next. Each tab reads a posting, asks for a keyword match, walks
 * its own Apply link to a form that names nobody, asks for the match again
 * there — where the description can only have come from this tab's trail —
 * builds, and writes a letter naming its own employer. Every step happens in
 * tab 1, then tab 2, then tab 3, and only then does the next step begin.
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

/** What this suite files under, cleared before it starts as well as after. */
const MINE = TABS.map((t) => t.company);

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
 * Ask for the keyword match, and wait for the proposal it makes.
 *
 * Tolerant of never getting one, on purpose. A card whose trail has been taken
 * from it proposes nothing at all, and a `waitFor` that throws there ends the
 * run with a stack trace in the middle of the report — every check after it
 * unasked, including the ones about the store. A proposal that does not arrive
 * is an empty list, which the checks below have plenty to say about.
 */
async function matchByKeyword(card) {
  await card.locator('button.mode', { hasText: 'Match by keyword' }).click();
  await card.locator('.diff-head').first().waitFor({ timeout: 60_000 }).catch(() => undefined);
  await openChanges(card);
  await card.locator('.change').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
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

    await inTurn('Nothing is tailored until it is asked for', async (tab) => {
      const card = cardOf(tab.page);
      const rows = await card.locator('.change').count();
      const said = (await card.locator('.no-change').innerText().catch(() => '')).trim();
      check(
        `tab ${tab.n} arrived with the resume unchanged`,
        rows === 0 && /exactly as you keep it/i.test(said),
        `${rows} changes — ${said.slice(0, 48)}`,
      );
      // These two are description pages; the letter step belongs to the form
      // they link to, and typing one here would be typing into the notes box.
      check(`and with no letter to write yet`, (await card.locator('textarea.tall').count()) === 0);
    });

    await inTurn('"Match by keyword", pressed in each tab in turn', async (tab) => {
      const card = cardOf(tab.page);
      await matchByKeyword(card);
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

    await inTurn('Matching again on the form, against the posting behind it', async (tab) => {
      const card = cardOf(tab.page);
      await matchByKeyword(card);
      tab.keptOnForm = await kept(card);
      check(
        `tab ${tab.n} matched against ${tab.company}'s posting, not another tab's`,
        ownsIt(tab, tab.keptOnForm),
        listed(tab.keptOnForm),
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
       * And the proposal, asked for once more. The card comes back from a
       * navigation holding the tailored resume but not the list of changes it
       * made, so the rows have to be asked for again — which suits this
       * perfectly, because the description the match runs against is by then
       * only in the trail.
       */
      await matchByKeyword(card);
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
