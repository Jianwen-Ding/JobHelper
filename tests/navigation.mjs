/**
 * Navigation, across the shapes real systems actually use.
 *
 * An application is almost never one page, and every applicant tracking system
 * gets you to the form differently: a path suffix, a single-page route change
 * with no navigation at all, a hand-off to another host with the referrer
 * stripped, a new tab, a form in two steps. Each of those is a different way
 * for the tool to lose track of what you were doing — and losing track is
 * invisible, because a card that has forgotten the description still looks
 * like a card.
 *
 * So each shape is walked here, and each asks the same three questions:
 * did the card come back, did it still know which job this is, and is the work
 * done on the previous page still here.
 *
 *   node tests/navigation.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ASHBY_ROLE,
  ADVERT_FRAME,
  ATS_FORM,
  CROWDED_PAGE,
  CYGNUS_BOARD,
  BLOG_WITH_FORM,
  EMBEDDED_BOARD,
  FRAMED_ROLE,
  LATE_RENDER,
  LEVER_ROLE,
  NEW_TAB_ROLE,
  OWN_SITE,
  SPA_BOARD,
  STEP_ONE,
  WORKDAY,
  cleanStore,
  findChromium,
  serveFixtures,
  serveSlowProxy,
  useServer,
  requireOpenSave,
  pointExtensionAt,
} from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';

/*
 * What the running store can actually fill with.
 *
 * Assertions here named `email` and `phone` outright, and a profile with
 * neither is a perfectly ordinary profile — so the suite failed for reasons
 * that had nothing to do with the extension. Ask the server instead, and judge
 * each check against a field it really offers.
 */
let offeredFields = {};
async function loadOffered() {
  offeredFields = await fetch(`${SERVER}/api/autofill`)
    .then((r) => r.json())
    .then((r) => r.fields ?? {})
    .catch(() => ({}));
}
/** The selector for the first of these the store can fill, or null. */
const fillable = (pairs) => pairs.find(([key]) => offeredFields[key])?.[1] ?? null;

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

/** Wait for the card to be up and to have finished its first pass. */
async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 25_000 });
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 25_000 });
  await page.waitForTimeout(1800);
}

/** Build the resume, so there is work worth losing. */
async function buildResume(page) {
  const card = cardOf(page);
  await card.getByRole('button', { name: 'Build resume' }).click();
  await card.locator('.fit.ok, .fit.bad').waitFor({ timeout: 120_000 });
  // The keeper runs on an interval; give it one.
  await page.waitForTimeout(2500);
}

/**
 * The same three questions, whatever route was taken to get here.
 * `before` is what the description page said, so this can tell "carried" from
 * "worked it out again".
 */
async function expectContinuity(page, label, { role, expectTrail = true } = {}) {
  const card = cardOf(page);

  check(`${label}: the card came back`, (await card.count()) > 0);

  const shown = (await card.locator('.role').textContent())?.trim();
  check(`${label}: still knows the role`, shown === role, shown);

  const rows = await card.locator('.trail-row').count();
  check(
    `${label}: joined it to the page before`,
    expectTrail ? rows >= 2 : rows === 0,
    `${rows} pages`,
  );

  const fit = (await card.locator('.fit').textContent())?.trim() ?? '';
  check(`${label}: kept the resume that was already built`, /page/i.test(fit) && !/not compiled/i.test(fit), fit);
}

async function main() {
  await loadOffered();
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }

  // Two origins, so the careers-site-to-ATS hand-off is a genuine cross-host
  // navigation rather than two paths on one server.
  const ats = await serveFixtures(undefined, { hostname: 'localhost' });
  const fixtures = await serveFixtures(undefined, { vars: { ATS: `${ats.base}${ATS_FORM.path}` } });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-nav-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    /* ---- A path suffix on the same host: Lever's shape ---- */
    group('Apply is the same address with /apply on the end');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(LEVER_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await buildResume(page);

      await page.click('a[href$="/apply"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      await expectContinuity(page, 'lever', { role: 'Platform Engineer' });
      await page.close();
    }

    /* ---- The link says only "Apply": Ashby's shape ---- */
    group('The link is a bare "Apply" and the path changes underneath');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(ASHBY_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await buildResume(page);

      await page.click('a[href$="/application"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      await expectContinuity(page, 'ashby', { role: 'Platform Engineer' });
      await page.close();
    }

    /* ---- No navigation at all: Workday's shape ---- */
    group('A single-page board that swaps the form in without navigating');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(WORKDAY), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await buildResume(page);

      await page.click('#apply');
      // Nothing navigates; the card notices the url changing on its own.
      await page.waitForTimeout(3500);
      await settled(page);
      await expectContinuity(page, 'workday', { role: 'Platform Engineer' });

      const onForm = await page.locator('#q1').count();
      check('workday: the form really did replace the description', onForm === 1);
      await page.close();
    }

    /* ---- Another host, and no referrer to prove where you came from ---- */
    group('A company site handing off to an applicant tracking system');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(OWN_SITE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await buildResume(page);

      await page.click('#apply');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      // The click is the only evidence these two pages belong together: the
      // hosts differ and rel="noreferrer" removed the rest.
      await expectContinuity(page, 'careers → ATS', { role: 'Platform Engineer' });
      await page.close();
    }

    /* ---- Apply opens a new tab ---- */
    group('Apply opens the form in a new tab');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(NEW_TAB_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await buildResume(page);

      const opened = context.waitForEvent('page');
      await page.click('a[target="_blank"]');
      const tab = await opened;
      await tab.waitForLoadState('domcontentloaded');
      await settled(tab);
      await expectContinuity(tab, 'new tab', { role: 'Platform Engineer' });
      await tab.close();
      await page.close();
    }

    /* ---- A form in two steps ---- */
    group('A form split over two pages');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(STEP_ONE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const roleOnStepOne = (await cardOf(page).locator('.role').textContent())?.trim();
      await buildResume(page);

      // Type an answer here, because the same question is asked on step two —
      // and typing it twice is exactly what this is meant to save.
      const typed = 'Because I have read the code you publish.';
      const box = cardOf(page).locator('.q textarea').first();
      check('step one asks a question at all', (await box.count()) === 1);
      await box.fill(typed);
      await box.dispatchEvent('input');
      await page.waitForTimeout(2500);

      check(
        'the cover letter box is not offered as a question as well',
        !(await cardOf(page).locator('.q').allTextContents()).some((q) => /cover\s*letter/i.test(q)),
      );

      await page.click('a[href$="/questions"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      await expectContinuity(page, 'two-step form', { role: roleOnStepOne });

      const carried = await cardOf(page).locator('.q textarea').first().inputValue();
      check('the answer typed on step one is still there', carried === typed, carried);
      await page.close();
    }

    /* ---- Two jobs opened from one board ---- */
    group('Two roles reached through the board that lists both');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(CYGNUS_BOARD), { waitUntil: 'domcontentloaded' });
      await settled(page);

      await page.click('#role-a');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      check(
        'the first role is read as itself',
        /platform engineer/i.test((await cardOf(page).locator('.role').textContent()) ?? ''),
      );

      await page.goBack();
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      await page.click('#role-b');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);

      // The listing sits between the two and is a prefix of both, so joining
      // on the address alone put the first role's description into the
      // second's application — the failure that reads perfectly until a human
      // notices the letter is about another job.
      const card = cardOf(page);
      const role = (await card.locator('.role').textContent())?.trim() ?? '';
      check('the second role is read as itself too', /data scientist/i.test(role), role);

      const trail = (await card.locator('.trail-row').allTextContents()).join(' | ');
      check(
        'and the other job is not part of this application',
        !/platform engineer/i.test(trail),
        trail || '(no trail)',
      );
      await page.close();
    }

    /* ---- And the one that must not join ---- */
    group('A different job is a different application');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(LEVER_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);

      await page.goto(fixtures.urlFor(ASHBY_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);

      const card = cardOf(page);
      const co = (await card.locator('.co').textContent()) ?? '';
      check('did not carry one company into another', co.includes('Lyra') || !co.includes('Vega'), co);
      check('and did not claim to be writing from both', (await card.locator('.trail').count()) === 0);
      await page.close();
    }

    /* ---- The form is in an iframe, as iCIMS serves it ---- */
    group('The application form is served in a frame of its own');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(FRAMED_ROLE), { waitUntil: 'load' });
      await settled(page);
      // The scan crosses a frame boundary and so takes a beat longer than the
      // rest of the card.
      await page.waitForTimeout(2500);

      const card = cardOf(page);
      check('the posting is still read from the page itself', (await card.locator('.role').count()) === 1);

      const asked = await card.locator('.q').allTextContents();
      check(
        'the question inside the frame is offered',
        asked.some((q) => /why do you want to work here/i.test(q)),
        asked.join(' | ') || '(none)',
      );
      check(
        'and the cover letter box in there is not offered as a question',
        !asked.some((q) => /cover\s*letter/i.test(q)),
        asked.join(' | '),
      );
      // When the form asks for a letter the card puts up the step; when it does
      // not, it puts up a "+ Cover letter" link to overrule that. Which of the
      // two is showing is the whole of what the frame told it.
      const steps = await card.locator('.step').allTextContents();
      check(
        'the cover letter step is offered, which only the frame asked for',
        steps.some((s) => /cover letter/i.test(s)),
        steps.map((s) => s.slice(0, 30)).join(' | '),
      );
      check(
        'and it is not still offering to add one, as if none were wanted',
        (await card.getByRole('button', { name: '+ Cover letter' }).count()) === 0,
      );

      // Autofill has to reach into the frame, and report what it did there as
      // part of the same run.
      await card.getByRole('button', { name: 'Autofill this form' }).click();
      await page.waitForTimeout(3000);
      const frame = page.frames().find((f) => f.url().endsWith('/form'));
      const typed = await frame?.evaluate(() => ({
        first: document.getElementById('fn').value,
        email: document.getElementById('em').value,
        phone: document.getElementById('ph').value,
      }));
      /*
       * Judged against what the store actually offers. Naming email and phone
       * outright made this fail on any profile that has neither — which is a
       * perfectly ordinary profile — for a reason with nothing to do with
       * frames. What is being tested here is that autofill reached *into the
       * frame* at all.
       */
      const wanted = [
        ['first', offeredFields.first_name],
        ['email', offeredFields.email],
        ['phone', offeredFields.phone],
      ].filter(([, offered]) => offered);
      check(
        'autofill filled the fields inside the frame',
        wanted.length > 0 && wanted.every(([key]) => Boolean(typed?.[key])),
        `${JSON.stringify(typed)} against ${wanted.map(([k]) => k).join(', ') || 'nothing on offer'}`,
      );

      /*
       * The script runs in every frame of every page now, so the thing that
       * matters most is what it does *not* do there. A frame is not a page: no
       * card of its own, however job-shaped its contents — otherwise every
       * embed and advert on the web gets one.
       */
      const cardsInFrame = await frame?.evaluate(() => document.querySelectorAll('#jobhelper-card-host').length);
      check('the frame did not put up a card of its own', cardsInFrame === 0, `${cardsInFrame} in the frame`);
      check('and the page has exactly one', (await page.locator(HOST).count()) === 1);

      // Writing an answer has to cross the boundary too — the card only ever
      // holds a string, so the frame it belongs to travels inside the field id.
      const q = card.locator('.q').filter({ hasText: /why do you want to work here/i }).first();
      await q.locator('textarea').first().fill('Because I have read the code you publish.');
      await q.getByRole('button', { name: /insert into form/i }).click();
      await page.waitForTimeout(1500);
      const inserted = await frame?.evaluate(() => document.getElementById('q1').value);
      check('an answer written on the card lands in the frame', /read the code/.test(inserted ?? ''), inserted);

      await page.close();
    }

    /* ---- Going back, which restores a page rather than loading one ---- */
    group('Back to the posting before this one');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(LEVER_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);

      await page.goto(fixtures.urlFor(ASHBY_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      check('the second posting reads as itself', (await cardOf(page).locator('.co').textContent())?.includes('Lyra'));

      /*
       * Back does not reload: the browser may restore the page whole, card and
       * all, without the content script running again. A card that came back
       * from storage belongs to the posting it was built for — so what must
       * not happen is Lyra's card sitting on Vega's page, which is the same
       * mistake as every other stale-state one, arriving by the one route that
       * reinstates a whole card at once.
       */
      await page.goBack();
      await page.waitForLoadState('domcontentloaded');
      await page.waitForTimeout(4000);

      const co = (await cardOf(page).locator('.co').textContent()) ?? '';
      check('and going back does not leave the later card on the earlier page', !co.includes('Lyra'), co);
      check('the card on the restored page names the posting that is on it', co.includes('Vega'), co);
      await page.close();
    }

    /* ---- One application among fifty frames ---- */
    group('A posting buried in a page full of somebody else\'s frames');
    {
      const page = await context.newPage();
      const startedAt = Date.now();
      await page.goto(fixtures.urlFor(CROWDED_PAGE), { waitUntil: 'load' });
      await settled(page);
      await page.waitForTimeout(3000);
      const upIn = Date.now() - startedAt;

      const card = cardOf(page);
      check('the card still appears, with forty-nine frames on the page', (await card.count()) > 0);
      check('and does not take absurdly long about it', upIn < 30_000, `${upIn}ms`);

      const asked = await card.locator('.q').allTextContents();
      check(
        'the one application frame is found among the rest',
        asked.some((q) => /what draws you to this team/i.test(q)),
        asked.join(' | ') || '(none)',
      );
      check(
        'and none of the adverts contributed a question',
        !asked.some((q) => /advertisement/i.test(q)),
        asked.join(' | '),
      );

      await card.getByRole('button', { name: 'Autofill this form' }).click();
      await page.waitForTimeout(6000);
      const form = page.frames().find((f) => f.url().endsWith('/platform-engineer/form'));
      const sel = fillable([
        ['email', '#em'],
        ['first_name', '#fn'],
        ['phone', '#ph'],
      ]);
      const filled = sel ? await form?.evaluate((s) => document.querySelector(s)?.value ?? '', sel) : '';
      check('autofill reached the right frame', Boolean(filled), `${sel ?? 'nothing on offer'} = ${filled}`);

      const promos = page.frames().filter((f) => f.url().endsWith('/promo/newsletter'));
      const leaked = await Promise.all(
        promos.map((f) => f.evaluate(() => document.getElementById('ad-em')?.value ?? '').catch(() => '')),
      );
      check(
        'and none of the other forty-eight',
        leaked.every((v) => !v),
        `${leaked.filter(Boolean).length} of ${promos.length} were written to`,
      );
      await page.close();
    }

    /* ---- The posting arrives after the page has already been judged ---- */
    group('A posting that is not in the page when the page loads');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(LATE_RENDER), { waitUntil: 'load' });
      // The fixture fills itself in after four seconds, which is ordinary for
      // a board that fetches its posting. Nothing else about the page changes:
      // same url, same tab, no navigation to notice.
      await page.waitForTimeout(12_000);

      const there = (await page.locator(HOST).count()) > 0;
      check('the card appears once the posting arrives', there);
      if (there) {
        const role = (await cardOf(page).locator('.role').textContent())?.trim() ?? '';
        check('and reads the role that was rendered in', /platform engineer/i.test(role), role);
      }
      await page.close();
    }

    /* ---- The posting itself is inside the embed ---- */
    group('A careers page that is a heading and an embedded board');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(EMBEDDED_BOARD), { waitUntil: 'load' });
      // No `settled`: the question is whether anything appears at all, so
      // waiting for the card would be waiting for the thing under test.
      await page.waitForTimeout(9000);

      const there = (await page.locator(HOST).count()) > 0;
      check('the card appears even though the page itself says nothing', there);
      if (there) {
        const card = cardOf(page);
        const role = (await card.locator('.role').textContent())?.trim() ?? '';
        check('and reads the role out of the frame', /platform engineer/i.test(role), role);
        const asked = await card.locator('.q').allTextContents();
        check(
          'and finds the question in there too',
          asked.some((q) => /why do you want to work here/i.test(q)),
          asked.join(' | ') || '(none)',
        );
      }
      await page.close();
    }

    /* ---- And the page that is not a job, whatever its frame collects ---- */
    group('An article with an enquiry form embedded in it');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(BLOG_WITH_FORM), { waitUntil: 'load' });
      await page.waitForTimeout(9000);

      // A frame can now make the card appear on a page that says nothing. It
      // must not be able to make it appear on a page that is not a job: the
      // frame gets the page looked at, it does not get to decide the answer.
      check(
        'no card, though the frame collects four parts of a person',
        (await page.locator(HOST).count()) === 0,
      );
      await page.close();
    }

    /* ---- Somebody else's frame on the same page ---- */
    group("A third party's frame on the posting");
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(ADVERT_FRAME), { waitUntil: 'load' });
      await settled(page);
      await page.waitForTimeout(2500);

      const card = cardOf(page);
      const asked = await card.locator('.q').allTextContents();
      check(
        "the advert's question is not offered as an application question",
        !asked.some((q) => /think of this advertisement/i.test(q)),
        asked.join(' | ') || '(none)',
      );
      check(
        "but the posting's own question still is",
        asked.some((q) => /why do you want to work here/i.test(q)),
        asked.join(' | ') || '(none)',
      );

      await card.getByRole('button', { name: 'Autofill this form' }).click();
      await page.waitForTimeout(3000);

      const promo = page.frames().find((f) => f.url().endsWith('/promo/newsletter'));
      const leaked = await promo?.evaluate(() => ({
        email: document.getElementById('ad-em').value,
        name: document.getElementById('ad-nm').value,
      }));
      check(
        "no personal detail was typed into the advert's form",
        !leaked?.email && !leaked?.name,
        JSON.stringify(leaked),
      );
      const own = fillable([
        ['email', '#em'],
        ['first_name', '#fn'],
        ['phone', '#ph'],
      ]);
      const ownValue = own ? await page.locator(own).inputValue() : '';
      check("and the posting's own form was still filled", Boolean(ownValue), `${own ?? 'nothing on offer'} = ${ownValue}`);
      await page.close();
    }

    /* ---- Work must not outlive the application it was done for ---- */
    group('A second job opened in the tab that just finished with the first');
    {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(LEVER_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      await buildResume(page);

      // A different company, so this starts a new application — which the card
      // here gets right.
      await page.goto(fixtures.urlFor(ASHBY_ROLE), { waitUntil: 'domcontentloaded' });
      await settled(page);
      const fresh = (await cardOf(page).locator('.fit').textContent())?.trim() ?? '';
      check('the new posting does not open holding the old resume', /not compiled/i.test(fresh), fresh);

      // The page after it is the one that was given them: a restarted trail
      // replaced its pages and kept everything else, so the first job's resume
      // was still sitting there waiting to be handed to the second job's form.
      await page.click('a[href$="/application"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      const onForm = (await cardOf(page).locator('.fit').textContent())?.trim() ?? '';
      check('and neither does its application form', /not compiled/i.test(onForm), onForm);
      await page.close();
    }

    /*
     * Left for last because it points the extension at a slower server, and
     * nothing after it would be measuring what it thinks it is.
     */
    group('Moving on while the analysis of the previous posting is still running');
    {
      const slow = await serveSlowProxy(SERVER, { slowRoute: /analyze/, ms: 4000 });
      await useServer(context, slow.base);
      try {
        const page = await context.newPage();
        await page.goto(fixtures.urlFor(SPA_BOARD), { waitUntil: 'domcontentloaded' });

        // Deliberately not `settled`: the point is to move on while the first
        // pass is still out, which against a local server is a window of two
        // hundred milliseconds and in use — with the AI on — is minutes.
        await page.waitForTimeout(1200);
        await page.click('#to-b');

        // What the card claimed, in order, once the second role was on screen.
        // The end state is not enough: the passes finish in the order they
        // started, so the later one lands last and tidies up after the older
        // one wrote over it. The damage is the seconds in between, which is
        // where "Build resume" gets pressed.
        const roles = [];
        for (let i = 0; i < 100; i++) {
          const role = await page.evaluate(() => {
            const host = document.querySelector('#jobhelper-card-host');
            return host?.shadowRoot?.querySelector('.card .role')?.textContent?.trim() ?? '';
          });
          if (role && roles[roles.length - 1] !== role) roles.push(role);
          await page.waitForTimeout(60);
        }

        const afterSwitch = roles.slice(roles.findIndex((r) => /data scientist/i.test(r)) + 1);
        check(
          'the abandoned pass does not put its role back on the new card',
          !afterSwitch.some((r) => /platform engineer/i.test(r)),
          roles.join(' → '),
        );
        check(
          'and the card ends on the role actually on screen',
          /data scientist/i.test(roles[roles.length - 1] ?? ''),
          roles[roles.length - 1],
        );
        await page.close();
      } finally {
        await useServer(context, SERVER);
        slow.close();
      }
    }
  } finally {
    await context.close();
    fixtures.close();
    ats.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, ['Vega', 'Lyra', 'Orion', 'Acme', 'Nova', 'Rigel', 'Altair', 'Cygnus', 'Vireo', 'Lyricus', 'Vela', 'Mensa Labs']);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
