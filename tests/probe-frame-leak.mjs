/**
 * PROBE (not part of the suite): does `looksLikeApplicationForm()` let a
 * third party's iframe be filled with the user's real details?
 *
 *   node tests/probe-frame-leak.mjs
 *
 * Two frames sit on an ordinary posting:
 *   /thirdparty/enquiry  — the repo's own BLOG_ENQUIRY_FRAME markup verbatim
 *                          ("four parts of a person", per fixtures.mjs)
 *   /thirdparty/jobad    — a job-advert creative, the commonest ad on a board
 * Neither is the application form. The posting's own form is in the page.
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';
const HOST = '#jobhelper-card-host';

const ROLE_BODY = `
  <h2>About the role</h2>
  <p>We are looking for a platform engineer to run our Kafka and Kubernetes
     estate. You will own the streaming infrastructure end to end, in Go and
     Python, and the CI/CD that ships it.</p>
  <h2>Minimum qualifications</h2>
  <ul><li>Experience with distributed systems</li><li>Years of experience with SQL and AWS</li></ul>
  <p>Equal opportunity employer. Full-time. Compensation is competitive.</p>`;

const POSTING = {
  name: 'leak-posting',
  path: '/quasar/roles/platform-engineer',
  company: 'Quasar',
  title: 'Platform Engineer',
  html: `<!doctype html><html><head><title>Platform Engineer at Quasar</title></head>
<body>
  <h1>Quasar</h1><div>Platform Engineer</div>
  ${ROLE_BODY}
  <form>
    <label for="fn">First Name</label><input id="fn" name="first_name">
    <label for="ln">Last Name</label><input id="ln" name="last_name">
    <label for="em">Email</label><input id="em" name="email" type="email">
    <label for="cl">Cover Letter</label><textarea id="cl" name="cover_letter"></textarea>
    <label for="q1">Why do you want to work here?</label><textarea id="q1" name="why_here"></textarea>
    <button type="button">Submit Application</button>
  </form>
  <iframe id="enquiry" title="Book a class" src="/thirdparty/enquiry" style="width:420px;height:320px"></iframe>
  <iframe id="jobad" title="Sponsored" src="/thirdparty/jobad" style="width:420px;height:320px"></iframe>
</body></html>`,
};

/* Copied verbatim from fixtures.mjs BLOG_ENQUIRY_FRAME. */
const ENQUIRY = {
  name: 'thirdparty-enquiry',
  path: '/thirdparty/enquiry',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Get in touch</title></head>
<body><form>
  <h3>Book a class</h3>
  <label for="a">Name</label><input id="a" name="name">
  <label for="b">Email</label><input id="b" name="email" type="email">
  <label for="c">Phone</label><input id="c" name="phone">
  <label for="d">Town</label><input id="d" name="town">
  <button type="button">Send</button>
</form>
<script>
  // What a third party's own code sees. The isolated world does not hide the
  // value from the page: the extension dispatches input/change on the element.
  window.seen = {};
  for (const el of document.querySelectorAll('input')) {
    el.addEventListener('input', () => { window.seen[el.id] = el.value; });
  }
</script>
</body></html>`,
};

/* A job-advert creative: the commonest third-party iframe on a job board. */
const JOB_AD = {
  name: 'thirdparty-jobad',
  path: '/thirdparty/jobad',
  html: `<!doctype html>
<html><head><meta charset="utf-8"><title>Sponsored</title></head>
<body>
  <p>Sponsored: Senior SRE at Hyperion. Apply for this role in 60 seconds.</p>
  <form>
    <label for="ad-em">Get job alerts by email</label><input id="ad-em" name="email" type="email">
    <label for="ad-nm">Your name</label><input id="ad-nm" name="name">
    <button type="button">Subscribe</button>
  </form>
</body></html>`,
};

let passed = 0;
let failed = 0;
const check = (what, ok, detail = '') => {
  (ok ? passed++ : failed++);
  console.log(`  ${ok ? 'ok  ' : 'LEAK'}  ${what}${detail ? ` — ${detail}` : ''}`);
};

async function main() {
  try {
    if (!(await fetch(`${SERVER}/health`)).ok) throw new Error();
  } catch {
    console.error(`No ResumeM-M server at ${SERVER}.`);
    process.exit(2);
  }
  const profile = (await (await fetch(`${SERVER}/api/autofill`)).json()).fields;
  console.log('\nprofile the server hands out:', JSON.stringify(profile));

  const fixtures = await serveFixtures([POSTING, ENQUIRY, JOB_AD]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-probe-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    viewport: { width: 1360, height: 900 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });

  try {
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
    const page = await context.newPage();
    await page.goto(fixtures.urlFor(POSTING), { waitUntil: 'load' });
    await page.locator(HOST).waitFor({ state: 'attached', timeout: 25_000 });
    await page.locator(`${HOST} .card .role`).waitFor({ timeout: 25_000 });
    await page.waitForTimeout(2500);

    await page.locator(`${HOST} .card`).getByRole('button', { name: 'Autofill this form' }).click();
    await page.waitForTimeout(4000);

    const enquiry = page.frames().find((f) => f.url().endsWith('/thirdparty/enquiry'));
    const got = await enquiry.evaluate(() => ({
      name: document.getElementById('a').value,
      email: document.getElementById('b').value,
      phone: document.getElementById('c').value,
      town: document.getElementById('d').value,
      seenByThePage: window.seen,
    }));
    console.log('  enquiry frame after autofill:', JSON.stringify(got));
    check(
      "the third party's enquiry frame was left alone",
      !got.name && !got.email && !got.phone && !got.town,
      JSON.stringify(got),
    );

    const ad = page.frames().find((f) => f.url().endsWith('/thirdparty/jobad'));
    const adGot = await ad.evaluate(() => ({
      email: document.getElementById('ad-em').value,
      name: document.getElementById('ad-nm').value,
    }));
    console.log('  job-advert frame after autofill:', JSON.stringify(adGot));
    check("the job advert's frame was left alone", !adGot.email && !adGot.name, JSON.stringify(adGot));

    const own = await page.evaluate(() => document.getElementById('fn').value);
    check("the posting's own form was still filled", Boolean(own), own);

    // What the card reported back to the user.
    const report = await page.locator(`${HOST} .card`).textContent();
    console.log('  card text contains "Filled":', /filled/i.test(report ?? ''));

    // And the other half: a frame that passes the gate also hands over its
    // whole markup, which is analysed and then stored.
    const stored = await worker.evaluate(async () => {
      const all = await chrome.storage.session.get(null);
      return Object.entries(all).map(([k, v]) => ({
        key: k,
        thirdPartyMarkupKept: (v?.pages ?? []).some((p) => /Book a class|Sponsored: Senior SRE/.test(p.html ?? '')),
      }));
    });
    console.log('  trail records:', JSON.stringify(stored));
  } finally {
    await context.close();
    fixtures.close();
  }
  console.log(`\n${passed} clean, ${failed} leaking`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
