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
 * Fifteen systems, each ending its application differently, and four pages
 * where the obvious-looking button is a draft, a question, a filter or a
 * newsletter.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/sending.mjs
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveFixtures, findChromium, pointExtensionAt, requireOpenSave, cleanStore } from './fixtures.mjs';
import { SENDS, DOES_NOT_SEND } from './ats-web.mjs';

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
async function press(page, name) {
  await page.getByRole('button', { name, exact: true }).first().click({ timeout: 10_000 });
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
      // The keeper writes on an interval, and the space is opened from there.
      await page.waitForTimeout(2600);
    }

    const before = await filed(fixture.company);
    await press(page, fixture.sends);
    await page.waitForTimeout(2200);
    const after = await filed(fixture.company);
    return { before, after, errors, page };
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function main() {
  await requireOpenSave(SERVER);
  const fixtures = await serveFixtures([...SENDS, ...DOES_NOT_SEND]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-send-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 950 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  const started = Date.now();
  const timings = [];
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    /* ---- The systems, and the many ways they spell "send it" ---- */
    for (const fixture of SENDS) {
      group(`${fixture.name} — "${fixture.sends}"`);
      const at = Date.now();
      const { before, after, errors } = await walk(context, fixtures, fixture);
      timings.push({ name: fixture.name, ms: Date.now() - at });

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
      check('nothing was thrown at the page', errors.length === 0, errors.join(' | '));
    }

    /* ---- And the controls that only look like one ---- */
    group('Controls that must leave the tracker alone');
    for (const fixture of DOES_NOT_SEND) {
      const at = Date.now();
      const { before, after, errors } = await walk(context, fixtures, fixture);
      timings.push({ name: fixture.name, ms: Date.now() - at });

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

    console.log('\nTime per system');
    for (const t of [...timings].sort((a, b) => b.ms - a.ms)) {
      console.log(`  ${(t.ms / 1000).toFixed(1)}s  ${t.name}`);
    }
    console.log(`\nWhole sweep: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  } finally {
    await cleanStore(
      SERVER,
      [...SENDS, ...DOES_NOT_SEND].map((f) => f.company).concat(['Novena']),
    ).catch(() => undefined);
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
