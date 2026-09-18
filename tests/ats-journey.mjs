/**
 * The whole path, on every applicant tracking system we claim to handle.
 *
 * `ats-forms.mjs` drives `fillForm` against thirteen systems' markup, which
 * answers "does autofill understand this form". `e2e.mjs` walks detect →
 * tailor → compile → autofill → file → track, but only on two postings
 * invented for the purpose. Neither answers the question someone actually has,
 * which is whether the whole thing works on a Greenhouse form — or a Workday
 * one, or iCIMS, where the form is in an iframe.
 *
 * So this walks the complete path on each of them in turn, against a real
 * server, and reports how long each took. A system that is detected but cannot
 * be filled, or filled but cannot be filed, fails here and nowhere else.
 *
 *   RMM_SERVER=http://127.0.0.1:4788 node tests/ats-journey.mjs
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { SYSTEMS } from './ats-forms.mjs';
import { cleanStore, findChromium, pointExtensionAt, requireOpenSave } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
/** What this suite files under; cleared before it starts as well as after. */
const MINE = ['Meridian'];

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

const HOST = '#jobhelper-card-host';

/*
 * A page each system would plausibly serve: its own form, under a path naming
 * the system, with enough of a posting above it to be worth reading. The
 * markup below the heading is the system's, untouched — that is the point.
 */
const shell = (system, body) => `<!doctype html>
<html><head><meta charset="utf-8"><title>Platform Engineer at Meridian</title></head>
<body>
  <h1>Platform Engineer</h1>
  <p>Meridian · Boston, MA</p>
  <h2>About the role</h2>
  <p>We are looking for a platform engineer to run our Kafka and Kubernetes
     estate, in Go and Python, and the CI/CD that ships it.</p>
  <h2>Minimum qualifications</h2>
  <ul><li>Experience with distributed systems</li><li>Years of experience with SQL and AWS</li></ul>
  <h2>Apply</h2>
  <form>${body}</form>
</body></html>`;

/** Where each system's page lives, named so the classifier can see the host. */
const pathFor = (system) => `/${system.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/meridian/jobs/4210`;

async function main() {
  try {
    await requireOpenSave(SERVER);
  } catch {
    process.exit(2);
  }
  await cleanStore(SERVER, MINE);

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const frameOf = SYSTEMS.find((s) => url === `${pathFor(s)}/frame`);
    if (frameOf) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"></head><body><form>${frameOf.frame}</form></body></html>`);
    }
    const system = SYSTEMS.find((s) => url === pathFor(s));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (!system) return res.end('<html><body>?</body></html>');
    // iCIMS serves the form in an iframe; the posting stays on the outside.
    res.end(
      system.frame
        ? shell(system, `</form><iframe id="icims_content_iframe" src="${pathFor(system)}/frame" style="width:700px;height:500px"></iframe><form>`)
        : shell(system, system.html),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-atsj-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });

  const timings = [];
  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    await pointExtensionAt(context, worker, SERVER);

    for (const system of SYSTEMS) {
      console.log(`\n${system.name}`);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e).slice(0, 120)));
      const started = Date.now();

      try {
        await page.goto(`${base}${pathFor(system)}`, { waitUntil: 'domcontentloaded' });

        /* 1. Noticed at all. */
        await page.locator(HOST).waitFor({ state: 'attached', timeout: 30_000 });
        await page.locator(`${HOST} .card .role`).waitFor({ timeout: 30_000 });
        /*
         * Wait for the card to stop changing rather than for 1.2 seconds. It
         * fills in as the page is read, and a fixed wait is a bet on how long
         * that takes — made once per system, so twenty times a run.
         */
        const settle = () => page.locator(`${HOST} .card`).innerText().catch(() => '');
        let last = await settle();
        for (let i = 0; i < 40; i++) {
          await page.waitForTimeout(150);
          const now = await settle();
          if (now && now === last) break;
          last = now;
        }
        const card = page.locator(`${HOST} .card`);
        const role = (await card.locator('.role').textContent())?.trim();
        check('a card appears, knowing the role', /platform engineer/i.test(role ?? ''), role);

        /* 2. A resume it can actually build. */
        await card.getByRole('button', { name: 'Build resume' }).click();
        await card.locator('.fit.ok, .fit.bad, .fit').filter({ hasText: /page/i }).first()
          .waitFor({ timeout: 120_000 });
        const fit = (await card.locator('.fit').first().innerText()).trim();
        check('the resume compiles', /page/i.test(fit), fit);

        /* 3. Filled, wherever this system keeps its fields. */
        await card.getByRole('button', { name: 'Autofill this form' }).click();
        await card.locator('.ok-note').first().waitFor({ timeout: 30_000 });
        const report = (await card.locator('.ok-note').first().innerText()).trim();
        const filled = Number(/Filled (\d+)/.exec(report)?.[1] ?? 0);
        check('autofill puts something in the form', filled > 0, report);

        /* 4. Filed, with the files a portal would ask for. */
        await card.getByRole('button', { name: 'Prepare to submit' }).click();
        await card.locator('.done-box').waitFor({ timeout: 120_000 });
        const done = await card.locator('.done-box').innerText();
        check('an application folder is written', /-Resume\.pdf/.test(done), done.split('\n')[1] ?? '');

        check('and nothing threw on the way', errors.length === 0, errors.join('; '));
        timings.push([system.name, Date.now() - started]);
      } catch (err) {
        check(`${system.name}: the walk completed`, false, String(err).split('\n')[0].slice(0, 120));
        timings.push([system.name, Date.now() - started]);
      }
      await page.close();
    }

    /*
     * Tracked, and tracked as one thing.
     *
     * Every system above applies to the same role at the same company, so
     * there should be exactly one record with exactly one resume attached —
     * not sixteen. Asserting "at least one" would have passed whatever
     * happened, which is worth saying because that is what this check said
     * first.
     */
    console.log('\nWhat the tracker made of all that');
    const tracked = await (await fetch(`${SERVER}/api/applications`)).json();
    const meridian = tracked.applications.filter((a) => a.company === 'Meridian');
    check('one application, not one per system', meridian.length === 1, `${meridian.length} recorded`);
    const only = meridian[0];
    check('it names the role', /platform engineer/i.test(only?.role ?? ''), only?.role);
    check('and the resume that was sent', Boolean(only?.resumeId), only?.resumeId ?? 'none');
  } finally {
    await context.close();
    server.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
    await cleanStore(SERVER, MINE);
  }

  console.log('\nTime for the whole path, by system');
  for (const [name, ms] of timings) {
    console.log(`  ${(ms / 1000).toFixed(1).padStart(6)}s  ${name}`);
  }
  const slowest = timings.slice().sort((a, b) => b[1] - a[1])[0];
  if (slowest) console.log(`  slowest: ${slowest[0]} at ${(slowest[1] / 1000).toFixed(1)}s`);

  /*
   * How long an application takes is a feature, not a statistic.
   *
   * Every walk above is the whole path — read the posting, build the resume,
   * fill the form, write the folder — on a machine also running two other
   * suites. It settles around three seconds a system, and the number that
   * matters is not the average but whether any one system has quietly become
   * the slow one: a rule that rescans, a compile that stopped being cached, a
   * wait that was a race and is now a sleep. So the shape of the distribution
   * is checked rather than a stopwatch value, which would fail on a busy
   * machine and prove nothing on an idle one.
   *
   * Four times the median is loose on purpose. It is not a performance
   * target; it is the line past which one system is behaving differently
   * from the other twenty, which is a bug with a cause worth finding.
   */
  const ordered = timings.map(([, ms]) => ms).sort((a, b) => a - b);
  const median = ordered[Math.floor(ordered.length / 2)] ?? 0;
  const dawdling = timings.filter(([, ms]) => ms > Math.max(median * 4, 20_000));
  check(
    'no system takes far longer than the rest of them',
    dawdling.length === 0,
    dawdling.length
      ? `${dawdling.map(([n, ms]) => `${n} ${(ms / 1000).toFixed(1)}s`).join(', ')} against a median of ${(median / 1000).toFixed(1)}s`
      : `median ${(median / 1000).toFixed(1)}s, slowest ${((slowest?.[1] ?? 0) / 1000).toFixed(1)}s`,
  );

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
