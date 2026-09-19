/**
 * Wandering off in the middle of an application.
 *
 * Applying takes a while, and in the middle of it people leave the form. They
 * go and read the company's About page, or look up what the posting pays, or
 * open the documentation for something it mentioned. Every one of those is a
 * page this tool is right to stay quiet on — and quiet is indistinguishable
 * from having forgotten. The description, the resume and the half-written
 * letter are all still held, and until now nothing said so, which made the
 * only safe assumption "leaving the form threw my work away".
 *
 * So this walks the wandering rather than the application: build something on
 * a posting, leave for somewhere unrelated, and ask whether the tool still
 * says an application is open, still says whose, still says your writing is
 * safe — and whether it can put you back on it.
 *
 *   node tests/carrying.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATS_FORM,
  ATS_FORM_UNANSWERABLE,
  BLOG,
  CYGNUS_ROLE_A,
  DOCS,
  HELIOS_ROLE,
  HELIOS_FORM,
  cleanStore,
  findChromium,
  serveFixtures,
  requireOpenSave,
  pointExtensionAt,
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
 * The companies this suite files under, cleared before it starts as well as
 * after it finishes.
 *
 * Clearing only at the end is enough exactly once. The pool hands one store to
 * several suites in turn, and a run that is interrupted — or one that fails
 * before its `finally` — leaves its applications behind for whoever gets that
 * store next. Then this suite reads a Helios application that was sent by
 * somebody else, sees `applied` where it expects `applying`, and reports a bug
 * in code that is behaving perfectly. A suite that does not clear before it
 * starts is not testing the extension; it is testing what was left lying
 * around.
 */
const MINE = ['Helios', 'Cygnus'];

/** What the store has filed under a company, as the editor would show it. */
async function filed(company) {
  const [apps, drafts] = await Promise.all([
    fetch(`${SERVER}/api/applications`).then((r) => r.json()),
    fetch(`${SERVER}/api/workspace`).then((r) => r.json()),
  ]);
  const of = (list) => list.find((x) => (x.company ?? '').toLowerCase().includes(company.toLowerCase()));
  return { application: of(apps.applications ?? []), draft: of(drafts.drafts ?? []) };
}

/** How many pages of the compiled resume are actually drawn in the card. */
const drawnPages = (page) =>
  page.evaluate(
    () =>
      document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.pdf-pages')?.childElementCount ?? 0,
  );

/** And how tall the pane holding them is, since an empty one is not zero. */
const paneHeight = (page) =>
  page.evaluate(
    () =>
      document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.pdf-pane')
        ?.getBoundingClientRect().height ?? 0,
  );

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
  /*
   * Wait for the card to stop changing, rather than for a number of
   * milliseconds. It fills in as the page is read — the role first, then the
   * company once it is worked out, then the buttons — and a fixed sleep is a
   * bet on how long that takes. On a loaded machine the bet loses, and the
   * failure reads like the extension getting the company wrong rather than
   * like the test looking too early. Two identical reads half a second apart
   * is the same claim, checked instead of assumed, and quicker when there is
   * nothing else running.
   */
  const read = () => page.locator(`${HOST} .card`).innerText().catch(() => '');
  let last = await read();
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(250);
    const now = await read();
    if (now && now === last) return;
    last = now;
  }
}

/**
 * What the toolbar says about this tab.
 *
 * Read from the worker rather than from a screenshot, because the badge is
 * browser chrome and a page cannot see it — and because the text and the
 * hover title are two different promises, both of which matter.
 */
async function toolbar(worker, page) {
  return worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab) return { text: '', title: '', found: false };
    return {
      found: true,
      text: await chrome.action.getBadgeText({ tabId: tab.id }),
      title: await chrome.action.getTitle({ tabId: tab.id }),
    };
  }, page.url());
}

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }
  await cleanStore(SERVER, MINE);

  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-carry-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    const page = await context.newPage();

    group('On the posting');
    {
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const mark = await toolbar(worker, page);
      check('the toolbar says an application is open', mark.text !== '', `badge "${mark.text}"`);
      // Which job, and whose: the hover title is the only place that can say
      // it while the card is not on screen.
      check('and says which job it is', /engineer at helios/i.test(mark.title), mark.title);
      // And says nothing about having been here before, because nobody has.
      // The claim is only worth making when it is true, and a card that makes
      // it on every posting is one nobody reads by the third.
      check(
        'without claiming this one has been applied to',
        (await cardOf(page).locator('.before').count()) === 0,
        (await cardOf(page).locator('.before').textContent().catch(() => '')) ?? '',
      );

      // Built here, so there is a drawn resume to carry as well as writing.
      const card = cardOf(page);
      await card.getByRole('button', { name: 'Build resume' }).click();
      await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
      await page.waitForTimeout(1200);
      check('the resume is drawn on the card', (await drawnPages(page)) > 0, `${await drawnPages(page)} pages`);
    }

    group('Following Apply to the form, and writing something');
    {
      await page.click('a[href*="apply"], a[href*="application"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);

      const card = cardOf(page);
      /*
       * `.tall` and not the first textarea on the card. The first is "Anything
       * to change?", the box that steers the next tailoring run — a test that
       * typed into it proved only that the notes box is not the letter.
       */
      const letter = card.locator('textarea.tall').first();
      await letter.waitFor({ timeout: 20_000 });
      await letter.click();
      await letter.pressSequentially('I have wanted to work on this for years.', { delay: 8 });
      // The keeper writes on an interval; give it one to fire.
      await page.waitForTimeout(2500);

      const mark = await toolbar(worker, page);
      check('the toolbar counts both pages', mark.text === '2', `badge "${mark.text}"`);
      check('and says the writing is being held', /writing is being held/i.test(mark.title), mark.title);

      /*
       * And the resume is still on screen, which it was not: drawing is
       * asynchronous and wrote into a node the next re-render had already
       * replaced, so the page landed somewhere detached and the guard said
       * this compile was already shown. Walking from a posting to its form —
       * the most ordinary step there is — left a sixteen pixel grey strip
       * where the resume had been, with nothing to say why.
       */
      const drawn = await drawnPages(page);
      check('and the resume you built is still drawn, not an empty strip', drawn > 0, `${drawn} pages`);
      check('the pane is a page tall, not a sliver', (await paneHeight(page)) > 100, `${await paneHeight(page)}px`);
    }

    /*
     * A half-written application used to exist only in the browser: a resume
     * built, half a letter typed, and nothing in the editor's Workspace or its
     * tracker to come back to. You found it again by remembering which tab it
     * was in.
     */
    group('Half finished, and already a place to come back to');
    {
      // The keeper writes on an interval, and the space is opened from there.
      await page.waitForTimeout(3000);
      const { application, draft } = await filed('Helios');
      check('the tracker holds it, without being told to', Boolean(application), application?.id ?? '(nothing)');
      check('and calls it one that is being worked on', application?.status === 'applying', application?.status ?? '(none)');
      check('the Workspace has somewhere to write it', Boolean(draft), draft?.id ?? '(nothing)');
      check('named for the posting, not the tab', /helios/i.test(draft?.company ?? ''), draft?.company ?? '');
    }

    /*
     * And the last step, which nobody records: by the time the form is sent
     * the tab is already on a confirmation page. This form's Submit is a
     * `type=button` that never fires a submit event, which is the ordinary
     * case rather than the exception.
     */
    group('Pressing Submit on the form');
    {
      await page.getByRole('button', { name: 'Submit Application' }).click();
      await page.waitForTimeout(2500);
      const { application, draft } = await filed('Helios');
      check('the tracker says it went out', application?.status === 'applied', application?.status ?? '(none)');
      check('and says why it thinks so', /pressed|submitted/i.test(application?.history?.at(-1)?.note ?? ''),
        application?.history?.at(-1)?.note ?? '');
      check('the draft stops looking like something to finish', draft?.status === 'submitted', draft?.status ?? '(none)');
    }

    /*
     * The same posting, come round again. A job reappears on a board months
     * later, or you follow a link to one you have already dealt with, and the
     * moment that is worth knowing is before the work starts rather than
     * afterwards from the tracker.
     *
     * A second tab, so this is a fresh reading of the page rather than the
     * card that watched the application being sent — what a person meets when
     * they arrive at the posting from somewhere else entirely.
     */
    group('Arriving at a posting that has already been applied to');
    {
      const again = await context.newPage();
      await again.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(again);
      const said = (await cardOf(again).locator('.before').textContent())?.trim() ?? '';
      check('the card says so, on the posting itself', /you applied to this on/i.test(said), said || '(nothing)');

      // And answers the question it raises. A sentence about March that
      // cannot be followed up is worse than one that was never said.
      const opened = context.waitForEvent('page');
      await cardOf(again).getByRole('button', { name: 'See what you sent' }).click();
      const record = await opened;
      check('and the record is one click away', /#applications\/.+/.test(record.url()), record.url());
      await record.close();
      await again.close();
    }

    group('Leaving for a page that has nothing to do with it');
    {
      await page.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);

      check('no card on it, as it should be', (await cardOf(page).count()) === 0);

      const mark = await toolbar(worker, page);
      check(
        'but the toolbar still says the application is open',
        mark.text === '2',
        `badge "${mark.text}"`,
      );
      check('still names it', /helios/i.test(mark.title), mark.title);
      check('and still promises the writing is safe', /writing is being held/i.test(mark.title), mark.title);
    }

    group('And on a second unrelated page, two navigations later');
    {
      await page.goto(fixtures.urlFor(DOCS), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(3000);
      const mark = await toolbar(worker, page);
      check('the mark has not worn off', mark.text === '2', `badge "${mark.text}"`);
    }

    group('Going back to the form');
    {
      await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const card = cardOf(page);
      const text = await card.locator('textarea.tall').first().inputValue();
      check('the letter is still there, word for word', /wanted to work on this for years/i.test(text), text.slice(0, 60));

      /*
       * And no draft was started to be thrown away. The automatic draft waits
       * to hear whether a letter was carried here; if one was, there is
       * nothing to draft. With the AI on, a draft started here is minutes of
       * somebody's budget spent on a letter they had already written — and
       * the only visible trace of it is the line saying it was not used, so
       * that line is what this looks for.
       */
      const body = (await card.textContent()) ?? '';
      check(
        'and no draft was run just to be discarded',
        !/while this was running|offered rather than used/i.test(body),
      );
    }

    group('And the toolbar window says the same thing, in sentences');
    {
      await page.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(2500);

      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/src/popup/popup.html`);
      /*
       * A real popup is not a tab, so it asks about the tab underneath it.
       * Opened here it is one, so put the page back in front and let the
       * popup boot again from there — otherwise it would report on itself.
       */
      await page.bringToFront();
      await popup.evaluate(() => location.reload());
      await popup.locator('#openApplication').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => undefined);

      check('the panel is showing', !(await popup.locator('#openApplication').isHidden()));
      const who = (await popup.locator('#openWho').textContent())?.trim();
      // The job, not only the employer: "Helios" is not enough to come back to
      // an hour later, and tells two of their roles apart not at all.
      check('and names the application', /helios/i.test(who ?? '') && /engineer/i.test(who ?? ''), who);
      const what = (await popup.locator('#openWhat').textContent())?.trim() ?? '';
      check('says how much of it has been read', /2 pages/.test(what), what);
      check('and that the writing is safe', /writing is being held/i.test(what), what);

      // The way back: the last page of it, in the tab it belongs to.
      await popup.locator('#backToApplication').click();
      await page.waitForURL(/helios\/apply/, { timeout: 15_000 }).catch(() => undefined);
      check('"Back to it" returns to where you were', /helios\/apply/.test(page.url()), page.url());
      await popup.close().catch(() => undefined);
    }

    group('Out to the builder to add a phrasing, and back');
    {
      /*
       * The reason to go is that this posting wants a bullet the store does
       * not have. Coming back to a proposal built before it existed is the
       * half of that trip nobody built, and there is nothing on the card to
       * say the thing you just went and wrote is not in it.
       */
      await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const card = cardOf(page);

      const before = (await card.textContent()) ?? '';
      check('nothing says the store changed, because it has not', !/been editing the store/i.test(before));

      const opened = context.waitForEvent('page');
      await card.getByRole('button', { name: 'Edit in ResumeM-M' }).click();
      const editor = await opened;
      check('the builder opens on this resume', /#resumes\//.test(editor.url()), editor.url());

      // Coming back is what the card is watching for.
      await page.bringToFront();
      await page.waitForFunction(
        () => {
          const c = document.querySelector('#jobhelper-card-host')?.shadowRoot;
          return /been editing the store/i.test(c?.textContent ?? '');
        },
        undefined,
        { timeout: 10_000, polling: 100 },
      ).catch(() => undefined);

      const after = (await card.textContent()) ?? '';
      check('on returning, the card says the match may be out of date', /been editing the store/i.test(after));
      /*
       * Offered, not done — and named for what it would actually do.
       *
       * Arriving tailors nothing now, so this proposal is the resume exactly
       * as it is kept. "Build it again" in that mode rebuilds it unchanged
       * and could never reach the alternate just written in the builder, so
       * the offer names the mode that would pick it up instead.
       */
      const offer = card.locator('.hint.warn button');
      const offered = ((await offer.textContent().catch(() => '')) ?? '').trim();
      check('and offers to redo it rather than doing it', (await offer.count()) === 1, offered);
      /*
       * By what it does, not by the words it used to use. The button was
       * renamed to "Work out the suggestions again" and this went on
       * matching the old wording, so it failed for a rename rather than for
       * a behaviour — which is the wrong thing for a check to be sensitive
       * to. What has to hold is that it offers the keyword match, which can
       * reach the alternate just written, and not "Build it again", which
       * rebuilds the resume unchanged and never could.
       */
      check(
        'naming the mode that would actually use what was just written',
        /suggestions again/i.test(offered) && !/build it again/i.test(offered),
        offered,
      );
      await editor.close();
    }

    group('Two applications open at once, each minding its own');
    {
      /*
       * The tab is the application, and the mark has to agree: applying to
       * two places in two tabs is ordinary, and a toolbar that reported the
       * other one's company would be worse than reporting nothing — it is
       * the same mistake as a cover letter addressed to the wrong employer,
       * made somewhere you would believe it.
       */
      const second = await context.newPage();
      await second.goto(fixtures.urlFor(CYGNUS_ROLE_A), { waitUntil: 'domcontentloaded' });
      await settled(second);

      const theirs = await toolbar(worker, second);
      check('the new tab names its own', /cygnus/i.test(theirs.title), theirs.title);

      await page.bringToFront();
      const ours = await toolbar(worker, page);
      check('and the first tab still names Helios', /helios/i.test(ours.title), ours.title);
      check('with its own page count', ours.text === '2', `badge "${ours.text}"`);
      check('not the other one’s', !/cygnus/i.test(ours.title), ours.title);
      await second.close();
    }

    group('A form that never says who is hiring');
    {
      /*
       * Most bare application forms do not name the employer anywhere. The
       * placeholder for that went into the Workspace as the application's
       * name, so the list showed "Unknown / Apply" — which identifies
       * nothing, and identifies two such applications identically.
       */
      /*
       * Clear out any draft this check has filed before. A draft's id comes
       * from its company and role, so a second run files the same one — and
       * "was anything new filed" would then be false however well it worked.
       */
      const existing = await fetch(`${SERVER}/api/workspace`).then((r) => r.json());
      for (const d of existing.drafts) {
        if (d.company === 'Unknown' || /^127\.0\.0\.1/.test(d.company ?? '') || d.company === 'Acme') {
          await fetch(`${SERVER}/api/workspace/${encodeURIComponent(d.id)}`, { method: 'DELETE' }).catch(() => {});
        }
      }
      const before = await fetch(`${SERVER}/api/workspace`)
        .then((r) => r.json())
        .then((r) => new Set(r.drafts.map((d) => d.id)));

      const bare = await context.newPage();
      await bare.goto(fixtures.urlFor(ATS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(bare);
      await cardOf(bare).getByRole('button', { name: 'Write these in ResumeM-M' }).click();
      await bare.waitForTimeout(4000);

      // Only what this just filed. The store keeps drafts between runs, and an
      // older one named "Unknown" would answer the question either way.
      const { drafts } = await fetch(`${SERVER}/api/workspace`).then((r) => r.json());
      const fresh = drafts.filter((d) => !before.has(d.id)).map((d) => d.company);
      check('an application was filed', fresh.length > 0, fresh.join(', '));
      check('and not as "Unknown"', !fresh.includes('Unknown'), fresh.join(', '));
      /*
       * Under the name on the page, if the page has one.
       *
       * This used to expect the host, and the host was the best available
       * answer while "Apply — Acme" was being read as the role "Acme". It is
       * read as the employer now, so the honest expectation is the employer:
       * the address is the fallback for a form that names nobody at all,
       * which is a different page from this one.
       */
      check(
        'but under whoever the page says it is for',
        fresh.some((n) => /acme/i.test(n ?? '')),
        fresh.join(', '),
      );
      await bare.close();
    }

    group('Arriving at the form from an email, with no posting behind it');
    {
      const heliosRows = async () =>
        fetch(`${SERVER}/api/applications`)
          .then((r) => r.json())
          .then((r) => (r.applications ?? []).filter((a) => /helios/i.test(a.company ?? '')));

      const before = await heliosRows();
      // A tab of its own, with no opener: nothing for the trail to inherit.
      const cold = await context.newPage();
      await cold.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(cold);

      const role = (await cardOf(cold).locator('.role').textContent())?.trim() ?? '';
      check('the role is read out of the address', /platform engineer/i.test(role), role);

      const card = cardOf(cold);
      await card.getByRole('button', { name: 'Build resume' }).click();
      await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
      await card.getByRole('button', { name: 'Submit' }).click();
      await cold.waitForTimeout(5000);

      const after = await heliosRows();
      check(
        'and the job it belongs to is not filed twice',
        after.length === before.length,
        `${before.length} → ${after.length}: ${after.map((a) => a.role).join(' | ')}`,
      );
      check(
        'nor filed as a job whose name nobody knows',
        !after.some((a) => /unknown/i.test(a.role ?? '')),
        after.map((a) => a.role).join(' | '),
      );
      await cold.close();
    }

    group('A report that is not good news');
    {
      /*
       * "Filled 6 fields, 1 field still for you to answer" was drawn in the
       * colour that means finished — the same mistake as a folder announcing
       * itself complete without the letter in it. The popup had always got
       * this right and the card had not, and the two describe the same run in
       * the same words, so the only difference was the colour.
       */
      const form = await context.newPage();
      await form.goto(fixtures.urlFor(ATS_FORM_UNANSWERABLE), { waitUntil: 'domcontentloaded' });
      await settled(form);
      const card = cardOf(form);
      await card.getByRole('button', { name: 'Autofill this form' }).click();
      await card.locator('.ok-note').first().waitFor({ timeout: 20_000 });
      await form.waitForTimeout(600);

      const note = card.locator('.ok-note').first();
      const said = (await note.innerText()).trim();
      check('it says a field is still yours to answer', /still for you to answer/.test(said), said);
      check(
        'and is not drawn as success',
        await note.evaluate((n) => n.classList.contains('warn')),
        said,
      );
      await form.close();
    }

    group('And never on ResumeM-M itself');
    {
      /*
       * The builder is a page full of the words this tool looks for — a
       * resume, a cover letter, application questions, and more form fields
       * than most application forms have. It offered on it: a card proposing
       * to tailor a resume for the save's own name, with the editor's own
       * buttons read as questions to answer.
       */
      const editor = await context.newPage();
      await editor.goto(SERVER, { waitUntil: 'domcontentloaded' });
      await editor.waitForTimeout(5000);
      check('no card on the builder', (await cardOf(editor).count()) === 0);

      /*
       * Asked outright, too. Left to the automatic path this depends on when
       * the rescore happens to fire, which made the check pass whether the
       * rule was there or not; "Open on this page" takes the same decision
       * immediately and every time.
       */
      await worker.evaluate(async (url) => {
        const [tab] = await chrome.tabs.query({ url: `${url}/*` });
        if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'show-card' }).catch(() => undefined);
      }, SERVER);
      await editor.waitForTimeout(4000);
      check('and none even when asked for outright', (await cardOf(editor).count()) === 0);

      const mark = await toolbar(worker, editor);
      check('and no mark on its tab', mark.text === '', `badge "${mark.text}"`);
      await editor.close();
    }

    group('A tab that was never on a posting is not marked');
    {
      const clean = await context.newPage();
      await clean.goto(fixtures.urlFor(BLOG), { waitUntil: 'domcontentloaded' });
      await clean.waitForTimeout(2500);
      const mark = await worker.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const last = tabs[tabs.length - 1];
        return { text: await chrome.action.getBadgeText({ tabId: last.id }), title: await chrome.action.getTitle({ tabId: last.id }) };
      });
      check('no badge on it', mark.text === '', `badge "${mark.text}"`);
      check('and the plain title', mark.title === 'JobHelper', mark.title);
      await clean.close();
    }

    group('Reading another job in the same tab, and coming back');
    {
      /*
       * The letter survives leaving for a blog because a page with no card
       * never asks the trail anything. Another *posting* does ask, and it
       * used to be the end of the letter: the trail decides whether the new
       * page continues the application, and when it decides not to, the whole
       * of `work` was replaced — the resume, the answers, and the letter
       * somebody had written.
       *
       * That judgement is right to be strict; two jobs at one company are two
       * applications, and carrying a letter between them is the failure it
       * exists to prevent. Being strict is not a licence to destroy: the work
       * is parked under the page it was written on, so going back to that
       * page brings it back, the same way a closed tab's writing comes back.
       */
      await page.goto(fixtures.urlFor(CYGNUS_ROLE_A), { waitUntil: 'domcontentloaded' });
      await settled(page);
      check('the other posting gets a card of its own', (await cardOf(page).count()) > 0);
      const theirs = await cardOf(page).textContent();
      check('named for the other job', /cygnus/i.test(theirs ?? ''), (theirs ?? '').slice(0, 80));
      check(
        'and not holding the letter written for the first',
        !/wanted to work on this for years/i.test(theirs ?? ''),
      );

      await page.goto(fixtures.urlFor(HELIOS_FORM), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const back = await cardOf(page).locator('textarea.tall').first().inputValue();
      check(
        'and the letter is there again on the page it was written on',
        /wanted to work on this for years/i.test(back),
        back.slice(0, 60),
      );
    }

    /*
     * The link in the email that says "finish your application".
     *
     * It lands on the form, not the description — no posting read, no trail,
     * nothing walked. And the form does not name the role: this one titles
     * itself "Apply — Helios" and says "Submit application" in its heading,
     * which is every bare application form there is.
     *
     * What that cost was not the label. Identity is the company and the role,
     * so an application filed as "Unknown role" is a different job from the
     * same job filed from its posting — and opening the posting afterwards
     * filed a second row, with no sign on the card that it had already gone.
     * One job, two rows, and the "you applied to this" line silent on the one
     * page where it was most needed.
     *
     * The role was in the address the whole time: `/helios/apply/`
     * `platform-engineer`. It is read from there when the page itself has
     * nothing, through the same two gates the page title goes through — so a
     * Greenhouse address ending `/jobs/4567` still yields nothing, and says so
     * rather than inventing a role out of a number.
     */
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
