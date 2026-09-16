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
  ATS_FORM,
  LEVER_ROLE,
  NEW_TAB_ROLE,
  OWN_SITE,
  STEP_ONE,
  WORKDAY,
  cleanStore,
  findChromium,
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
  try {
    if (!(await fetch(`${SERVER}/health`)).ok) throw new Error();
  } catch {
    console.error(`No ResumeM-M server at ${SERVER}.`);
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
    context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));

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

      await page.click('a[href$="/questions"]');
      await page.waitForLoadState('domcontentloaded');
      await settled(page);
      await expectContinuity(page, 'two-step form', { role: roleOnStepOne });
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
  } finally {
    await context.close();
    fixtures.close();
    ats.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, ['Vega', 'Lyra', 'Orion', 'Acme', 'Nova', 'Rigel']);
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
