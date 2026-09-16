/**
 * End-to-end check: load the unpacked extension into Chromium, open a fake
 * job posting served over http, and drive the card through building a resume
 * and autofilling the form.
 *
 * Requires a ResumeM-M server on http://127.0.0.1:4600. Start one with
 * `npm run serve` in the ResumeM-M checkout before running this.
 */

import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = process.env.RMM_SERVER ?? 'http://127.0.0.1:4600';

const PAGE = `<!doctype html>
<html><head><title>Software Engineer Intern at Streamly</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"JobPosting",
 "title":"Software Engineer Intern, Data Platform",
 "hiringOrganization":{"@type":"Organization","name":"Streamly"},
 "jobLocation":{"@type":"Place","address":{"addressLocality":"Boston","addressRegion":"MA"}},
 "description":"<p>Join our Data Platform team working on Kafka-based streaming infrastructure, building distributed systems in Go and Python. You will maintain CI/CD pipelines with Docker and Kubernetes on AWS.</p><ul><li>Minimum qualifications: pursuing a BS in Computer Science</li><li>Experience with distributed systems and SQL</li></ul><p>Equal opportunity employer.</p>"}
</script></head>
<body>
  <h1>Software Engineer Intern, Data Platform</h1>
  <p>Responsibilities include building distributed systems. Apply now.</p>
  <form>
    <label for="fn">First Name</label><input id="fn" name="first_name">
    <label for="ln">Last Name</label><input id="ln" name="last_name">
    <label for="em">Email</label><input id="em" name="email" type="email">
    <label for="ph">Phone</label><input id="ph" name="phone">
    <label for="li">LinkedIn Profile</label><input id="li" name="linkedin">
    <label for="sc">School</label><input id="sc" name="school">
    <label for="wa">Are you legally authorized to work in the US?</label><input id="wa" name="work_auth">
    <button type="button">Submit Application</button>
  </form>
</body></html>`;

function servePage() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(PAGE);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/jobs/123`, close: () => server.close() });
    });
  });
}

function findChromium() {
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(
    (r) => r && fs.existsSync(r),
  );
  for (const root of roots) {
    for (const dir of fs.readdirSync(root)) {
      if (!dir.startsWith('chromium') || dir.includes('headless_shell')) continue;
      for (const rel of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
        const p = path.join(root, dir, rel);
        if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  return undefined;
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function main() {
  // Fail early and clearly if the store server is not up.
  try {
    const res = await fetch(`${SERVER}/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    console.error(`No ResumeM-M server at ${SERVER}. Start it with \`npm run serve\` there first.`);
    process.exit(2);
  }

  const page404 = await servePage();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-profile-'));

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(),
    headless: true,
    args: [
      '--no-sandbox',
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
    ],
  });

  try {
    // The service worker registers shortly after launch.
    let worker = context.serviceWorkers()[0];
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    check('service worker started', Boolean(worker), worker?.url().split('/').pop());

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));

    await page.goto(page404.url, { waitUntil: 'domcontentloaded' });

    // The card lives in a shadow root on a host element.
    const cardHost = page.locator('#jobhelper-card-host');
    await cardHost.waitFor({ state: 'attached', timeout: 20_000 });
    check('card appeared on a job posting', true);

    const role = await cardHost.locator('.role').innerText();
    check('posting parsed', role.includes('Data Platform'), role);

    const company = await cardHost.locator('.co').innerText();
    check('company parsed', company.includes('Streamly'), company);

    const changes = await cardHost.locator('.changes li').allInnerTexts();
    check('tailoring proposed changes', changes.length > 0, `${changes.length}: ${changes.join(' | ').slice(0, 120)}`);

    // Build the resume through the server and confirm the fit verdict.
    await cardHost.getByRole('button', { name: 'Build resume' }).click();
    const fit = cardHost.locator('.fit');
    await fit.filter({ hasText: /page/ }).waitFor({ timeout: 60_000 });
    const fitText = await fit.innerText();
    check('resume compiled and fits one page', /Fits on one page/.test(fitText), fitText);

    // Autofill the form from the stored profile.
    await cardHost.getByRole('button', { name: 'Autofill this form' }).click();
    await page.waitForFunction(() => document.querySelector('#em')?.value?.length > 0, { timeout: 15_000 });
    const filled = await page.evaluate(() => ({
      first: document.querySelector('#fn').value,
      email: document.querySelector('#em').value,
      linkedin: document.querySelector('#li').value,
      school: document.querySelector('#sc').value,
    }));
    check('autofill filled first name', Boolean(filled.first), filled.first);
    check('autofill filled email', filled.email.includes('@'), filled.email);
    check('autofill filled linkedin', Boolean(filled.linkedin), filled.linkedin);
    check('autofill filled school', Boolean(filled.school), filled.school);

    // The finale: name the files, write the folder, record the application.
    await cardHost.getByRole('button', { name: 'Save application folder' }).click();
    await cardHost.locator('.done').waitFor({ timeout: 60_000 });
    const done = await cardHost.locator('.done').innerText();
    check('application folder written', /Resume Streamly\.pdf/.test(done), done.split('\n').pop());

    const tracked = await (await fetch(`${SERVER}/api/applications`)).json();
    const entry = tracked.applications.find((a) => a.company === 'Streamly');
    check('application tracked', Boolean(entry), entry ? `${entry.status} · ${entry.snapshotDir}` : 'not found');

    check('no page errors', errors.length === 0, errors.join('; '));

    // Put the store back: this drives the real server, and a test run should
    // not leave a fake application and a generated resume behind.
    if (entry) {
      await fetch(`${SERVER}/api/applications/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      if (entry.resumeId) {
        await fetch(`${SERVER}/api/resumes/${encodeURIComponent(entry.resumeId)}`, { method: 'DELETE' });
      }
      const after = await (await fetch(`${SERVER}/api/applications`)).json();
      check('cleaned up after itself', !after.applications.some((a) => a.id === entry.id));
    }

    // A page that is plainly not a posting must stay quiet.
    const quiet = await context.newPage();
    await quiet.setContent('<html><body><h1>A blog about bread</h1><p>Sourdough notes.</p></body></html>');
    await quiet.waitForTimeout(2500);
    const shown = await quiet.locator('#jobhelper-card-host').count();
    check('stays quiet on a non-job page', shown === 0);
  } finally {
    await context.close();
    page404.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
