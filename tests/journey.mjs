/**
 * One application, end to end, with a clock on it.
 *
 * Everything else here asks whether a thing works. This asks what it is like
 * to use: how long you wait at each step, whether the card tells you it is
 * still assembling one application as you move between hosts, and whether
 * anything you wrote survives the round trip out to the editor and back.
 *
 * The timings are printed every run and asserted against budgets that are
 * deliberately generous — this is a headless browser on a shared machine, and
 * the point is to catch a step going from two seconds to twenty, not to police
 * a hundred milliseconds. When a budget is exceeded the number is in the
 * output, so the next question ("which step?") is already answered.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import {
  ASHBY_FORM,
  ASHBY_ROLE,
  CROWDED_PAGE,
  CYGNUS_BOARD,
  EMBEDDED_BOARD,
  FRAMED_ROLE,
  HEAVY_POSTING,
  CYGNUS_ROLE_A,
  HELIOS_ROLE,
  LEVER_FORM,
  LEVER_ROLE,
  STREAMLY,
  WORKDAY,
  findChromium,
  pointExtensionAt,
  requireOpenSave,
  serveFixtures,
} from './fixtures.mjs';


/**
 * The store, answering the analysis slowly.
 *
 * Everything on this machine is local and answers in tens of milliseconds, so
 * the path taken when the user is actually waiting is the one path nothing
 * exercises. Only the analysis is delayed: the rest has to keep working, or
 * the test is measuring a broken server rather than a slow one.
 */
import http from 'node:http';

function slowProxy(target, delayMs) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      if (/\/analyze/.test(req.url ?? '')) await new Promise((go) => setTimeout(go, delayMs));
      try {
        const upstream = await fetch(`${target}${req.url}`, {
          method: req.method,
          headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json' },
          body: body.length ? Buffer.concat(body) : undefined,
        });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((d) => server.close(d)) }),
    );
  });
}

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

/** Time something, print what it took, and hold it to a budget. */
const timings = [];
async function timed(what, budgetMs, run) {
  const began = Date.now();
  const value = await run();
  const took = Date.now() - began;
  timings.push({ what, took, budgetMs });
  check(`${what} — ${(took / 1000).toFixed(1)}s`, took <= budgetMs, took > budgetMs ? `over ${budgetMs / 1000}s` : '');
  return value;
}

const cardOf = (page) => page.locator(`${HOST} .card`);

/**
 * The card is up *and* has finished reading the page.
 *
 * Not merely attached: on a page with structured data the card appears at once
 * with the page's own title in it, which is the right thing to show and the
 * wrong thing to time. `.loading` comes off when the analysis lands, and that
 * is the moment the card is worth looking at.
 */
async function settled(page) {
  await page.locator(HOST).waitFor({ state: 'attached', timeout: 30_000 });
  await page.waitForFunction(
    () => {
      const card = document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card');
      return card && !card.classList.contains('loading');
    },
    null,
    { timeout: 30_000 },
  );
  await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
}

async function main() {
  await requireOpenSave(SERVER);
  const fixtures = await serveFixtures();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-journey-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    /* ------------------------------------------------------------------ *
     * How long each shape of posting takes to read                        *
     * ------------------------------------------------------------------ */

    console.log('\nTime to a usable card, by shape of posting');
    for (const [label, fixture, budget] of [
      ['structured posting (JSON-LD)', STREAMLY, 12_000],
      ['plain careers page', CYGNUS_ROLE_A, 12_000],
      ['an applicant tracking system', LEVER_ROLE, 12_000],
      ['a board of several roles', CYGNUS_BOARD, 12_000],
      ['a posting rendered by script', WORKDAY, 15_000],
      ['half a megabyte of application shell', HEAVY_POSTING, 15_000],
      ['an Ashby-shaped posting', ASHBY_ROLE, 12_000],
      ['a posting served inside an iframe', FRAMED_ROLE, 18_000],
      ['a careers page that is only an embedded board', EMBEDDED_BOARD, 18_000],
      ['a posting among fifty other frames', CROWDED_PAGE, 18_000],
    ]) {
      const page = await context.newPage();
      await page.goto(fixtures.urlFor(fixture), { waitUntil: 'domcontentloaded' });
      await timed(label, budget, () => settled(page));
      await page.close();
    }

    /* ------------------------------------------------------------------ *
     * One application, across three pages and two hosts                   *
     * ------------------------------------------------------------------ */

    console.log('\nOne application, followed from the description to the form');
    const page = await context.newPage();

    await page.goto(fixtures.urlFor(HELIOS_ROLE), { waitUntil: 'domcontentloaded' });
    await timed('read the description page', 12_000, () => settled(page));
    const card = cardOf(page);
    const role = (await card.locator('.role').textContent())?.trim();
    check('the role is read off the description', /platform engineer/i.test(role ?? ''), role);

    // Write something here, so there is work to lose.
    const letterStep = card.locator('textarea.tall');
    if ((await letterStep.count()) > 0) {
      await letterStep.first().fill('Dear Helios, I have run a Kafka estate for a year.');
    }

    // Across to the form, which is a different page and says nothing about
    // the role.
    /*
     * Clicked, not navigated to. Following the Apply link is what a person
     * does, and it is also the evidence the trail is built from — a referrer
     * is stripped by plenty of sites and by every rel="noreferrer" link, so
     * the click itself is what says these two pages are one application.
     */
    await page.click('a[href*="/helios/apply/"]');
    await page.waitForLoadState('domcontentloaded');
    await timed('carry it to the application form', 15_000, () => settled(page));
    // The trail and the merged role arrive after the first paint, each in its
    // own request. This is the wait a user experiences as "it is still
    // thinking", so it is measured rather than slept through.
    await timed('and work out that it is the same application', 15_000, async () => {
      // `attached`, not visible: the trail sits inside a disclosure that is
      // closed until you open it, so waiting for it to be on screen is waiting
      // for a click nobody made.
      await page
        .locator(`${HOST} .card .trail-row`)
        .first()
        .waitFor({ state: 'attached', timeout: 15_000 })
        .catch(() => undefined);
    });

    const formCard = cardOf(page);
    const carriedRole = (await formCard.locator('.role').textContent())?.trim();
    check(
      'the form knows the role, which its own page never mentions',
      /platform engineer/i.test(carriedRole ?? ''),
      carriedRole,
    );

    /*
     * The thing the user needs to be told: this is still one application, and
     * these are the pages it is being written from. Without it there is no way
     * to know whether the description you read two clicks ago is being used.
     */
    const trailRows = await formCard.locator('.trail-row').count();
    check('it says which pages this application is being written from', trailRows >= 2, `${trailRows} rows`);

    /*
     * And says it in the open, not behind a disclosure. "Is it still working
     * from the description I read two clicks ago?" is the question the whole
     * trail exists to answer, and an answer you have to go looking for does
     * not answer it.
     */
    const summary = formCard.locator('.trail');
    const visibleSummary = (await summary.count()) > 0 ? ((await summary.first().innerText()) ?? '') : '';
    check(
      'and says so without being asked',
      /\b2 pages of this application\b/i.test(visibleSummary),
      visibleSummary.split('\n')[0]?.slice(0, 70) ?? '(nothing)',
    );

    /* ------------------------------------------------------------------ *
     * Out to the editor and back                                          *
     * ------------------------------------------------------------------ */

    console.log('\nOut to ResumeM-M and back');
    const questions = await formCard.locator('textarea').count();
    check('the form’s questions were found', questions > 0, `${questions} boxes`);

    // What the card would hand over. Asserted through the server rather than
    // by opening a tab, because the hand-off is the part that used to lose it.
    const before = await (await fetch(`${SERVER}/api/workspace`)).json();
    const openWorkspace = await page.evaluate(async () => {
      const host = document.querySelector('#jobhelper-card-host');
      const button = [...host.shadowRoot.querySelectorAll('button')].find((b) =>
        /Write these in ResumeM-M/.test(b.textContent),
      );
      if (!button) return 'no button';
      button.click();
      return 'clicked';
    });

    if (openWorkspace === 'clicked') {
      await page.waitForTimeout(4000);
      const after = await (await fetch(`${SERVER}/api/workspace`)).json();
      const fresh = (after.drafts ?? []).find(
        (d) => !(before.drafts ?? []).some((b) => b.id === d.id) || d.company,
      );
      check('a workspace draft exists for it', Boolean(fresh), fresh?.company ?? 'none');
      if (fresh) {
        check('with the role it was read from', /platform engineer/i.test(fresh.role ?? ''), fresh.role);
      }
    } else {
      check('the hand-off to the editor is offered', false, openWorkspace);
    }

    /* ------------------------------------------------------------------ *
     * Making the material you actually send                               *
     * ------------------------------------------------------------------ */

    /*
     * This is the part that genuinely takes time — a real LaTeX run, twice
     * over if a cover letter comes with it — and it is the wait people
     * remember, because it stands between them and the upload button. Timed
     * end to end, and checked for saying it is working while it does.
     */
    console.log('\nMaking the files');
    await formCard.getByRole('button', { name: 'Build resume' }).click();
    await timed('the card says it is compiling', 15_000, () =>
      formCard.locator('.progress').first().waitFor({ timeout: 15_000 }),
    );
    const compiling = await formCard.locator('.progress-label').innerText().catch(() => '');
    check('and says what it is doing', compiling.trim().length > 0, compiling);

    await timed('compile the resume', 90_000, () =>
      formCard.locator('.fit.ok, .fit.bad').waitFor({ timeout: 90_000 }),
    );
    const fit = await formCard.locator('.fit.ok, .fit.bad').innerText();
    check('and says whether it fits the page', /page/i.test(fit), fit);
    check('with the working indicator gone', (await formCard.locator('.progress').count()) === 0);

    await formCard.getByRole('button', { name: 'Save application folder' }).click();
    await timed('write the application folder', 90_000, () =>
      formCard.locator('.done-box').waitFor({ timeout: 90_000 }),
    );
    const written = await formCard.locator('.done-box').innerText();
    check('the resume is in it, named for the person', /-Resume\.pdf/.test(written), written.split('\n')[1] ?? written);

    await page.close();

    /* ------------------------------------------------------------------ *
     * The same journey on a different system                              *
     * ------------------------------------------------------------------ */

    /*
     * Helios is a careers site of its own. This is the other common shape: a
     * posting and its form on an applicant tracking system, where the form's
     * address is the posting's with a suffix. If the round trip only works on
     * one of them it works on neither, so it is walked twice.
     */
    console.log('\nThe same journey, on an applicant tracking system');
    const ats = await context.newPage();
    await ats.goto(fixtures.urlFor(ASHBY_ROLE), { waitUntil: 'domcontentloaded' });
    await timed('read the posting', 12_000, () => settled(ats));
    const atsRole = (await cardOf(ats).locator('.role').textContent())?.trim();
    check('the role is read', /platform engineer/i.test(atsRole ?? ''), atsRole);

    await ats.click(`a[href*="${ASHBY_FORM.path}"]`);
    await ats.waitForLoadState('domcontentloaded');
    await timed('carry it to the form', 15_000, () => settled(ats));
    await ats
      .locator(`${HOST} .card .trail-row`)
      .first()
      .waitFor({ state: 'attached', timeout: 15_000 })
      .catch(() => undefined);

    const atsCarried = (await cardOf(ats).locator('.role').textContent())?.trim();
    check('and carried to a form that never names it', /platform engineer/i.test(atsCarried ?? ''), atsCarried);
    check(
      'with the pages it is written from named there too',
      (await cardOf(ats).locator('.trail-row').count()) >= 2,
      `${await cardOf(ats).locator('.trail-row').count()} rows`,
    );
    await ats.close();

    /* ------------------------------------------------------------------ *
     * When the answer is slow, say something                              *
     * ------------------------------------------------------------------ */

    /*
     * Holding the card back until the verdict is what stops it appearing on an
     * ordinary page and vanishing. The cost is that a slow answer means
     * nothing happens at all, which reads as the extension being broken — so
     * after a wait long enough to notice, the provisional card goes up and
     * says what it is doing. This is that path, which is otherwise never taken
     * on a local server that answers in forty milliseconds.
     */
    console.log('\nWhen the store is slow to answer');
    const slow = await slowProxy(SERVER, 3000);
    try {
      await pointExtensionAt(context, worker, slow.url);
      const waiting = await context.newPage();
      await waiting.goto(fixtures.urlFor(CYGNUS_ROLE_A), { waitUntil: 'domcontentloaded' });

      await timed('a card appears while the answer is still coming', 2500, () =>
        waiting.locator(HOST).waitFor({ state: 'attached', timeout: 2500 }),
      );
      const saying = (await cardOf(waiting).textContent()) ?? '';
      check('and says it is reading the posting', /reading the posting/i.test(saying), saying.slice(0, 60));

      await timed('then the real answer replaces it', 12_000, () => settled(waiting));
      const settledRole = (await cardOf(waiting).locator('.role').textContent())?.trim();
      check('with the role it read', /platform engineer/i.test(settledRole ?? ''), settledRole);
      await waiting.close();
    } finally {
      await slow.close();
      await pointExtensionAt(context, worker, SERVER);
    }

    /* ------------------------------------------------------------------ *
     * A second application does not inherit the first                     *
     * ------------------------------------------------------------------ */

    console.log('\nA different posting is a different application');
    const other = await context.newPage();
    await other.goto(fixtures.urlFor(LEVER_FORM), { waitUntil: 'domcontentloaded' });
    await timed('read a form on another system', 15_000, () => settled(other));
    const otherRole = (await cardOf(other).locator('.role').textContent())?.trim();
    check('it did not carry the previous application over', !/platform engineer at helios/i.test(otherRole ?? ''), otherRole);
    await other.close();
  } finally {
    await context.close();
    await fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log('\nTimings');
  for (const t of timings) {
    console.log(`  ${String((t.took / 1000).toFixed(1)).padStart(6)}s  (budget ${t.budgetMs / 1000}s)  ${t.what}`);
  }
  const worst = timings.reduce((a, b) => (b.took > a.took ? b : a), timings[0] ?? { took: 0, what: 'nothing' });
  console.log(`  slowest: ${worst.what} at ${(worst.took / 1000).toFixed(1)}s`);

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
