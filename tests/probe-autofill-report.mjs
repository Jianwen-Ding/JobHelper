/**
 * The card's autofill report vs what actually happened to the form.
 * The popup distinguishes "already filled" from "still needs you"; the card
 * does not. This checks which is true of the form after the click.
 */
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium, serveFixtures } from './fixtures.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** A posting whose form has a Workday-style country combobox and a state select. */
const WIDGETY = {
  name: 'widgety',
  path: '/zephyr/careers/platform-engineer',
  company: 'Zephyr',
  html: `<!doctype html><html><head><title>Platform Engineer at Zephyr</title></head><body>
<h1>Zephyr</h1>
<h2>Job description</h2>
<p>We are looking for a platform engineer to run our Kafka and Kubernetes estate, in Go and Python,
   and the CI/CD that ships it. Responsibilities include distributed systems work.</p>
<h2>Minimum qualifications</h2><ul><li>Years of experience with SQL and AWS</li></ul>
<p>Equal opportunity employer. Full-time. Apply now. Submit application.</p>
<form>
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <label for="ln">Last Name</label><input id="ln" name="last_name">
  <label for="sc">School</label><input id="sc" name="school" value="Somewhere Else University">
  <label for="co">Country</label>
  <div id="co" role="combobox" aria-haspopup="listbox" tabindex="0"
       style="border:1px solid #999;width:300px;height:28px">Select One</div>
  <label for="st">State</label>
  <select id="st" name="state"><option value="">Select…</option><option>Ohio</option><option>Texas</option></select>
  <button type="button">Submit Application</button>
</form></body></html>`,
};

async function main() {
  const fixtures = await serveFixtures([WIDGETY]);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jh-af-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: findChromium(), headless: true, viewport: { width: 1360, height: 1000 },
    args: ['--no-sandbox', `--disable-extensions-except=${extensionRoot}`, `--load-extension=${extensionRoot}`],
  });
  try {
    if (!context.serviceWorkers()[0]) await context.waitForEvent('serviceworker', { timeout: 15_000 });
    const page = await context.newPage();
    await page.goto(fixtures.urlFor(WIDGETY), { waitUntil: 'domcontentloaded' });
    await page.locator('#jobhelper-card-host').waitFor({ state: 'attached', timeout: 25_000 });
    await page.waitForFunction(
      () => !document.querySelector('#jobhelper-card-host')?.shadowRoot?.querySelector('.card.loading'),
      null, { timeout: 30_000 });
    const card = page.locator('#jobhelper-card-host .card');

    await card.getByRole('button', { name: 'Autofill this form' }).click();
    await page.waitForTimeout(3000);
    console.log('CARD SAYS   :', await card.locator('.ok-note').innerText().catch(() => '(none)'));
    console.log('FORM REALLY :', JSON.stringify(await page.evaluate(() => ({
      first: document.querySelector('#fn').value,
      school: document.querySelector('#sc').value,
      country: document.querySelector('#co').textContent.trim(),
      state: document.querySelector('#st').value,
    }))));

    // The same report, as the popup words it.
    const worker = context.serviceWorkers()[0];
    const raw = await page.evaluate(() => new Promise((res) => {
      chrome.runtime.sendMessage({ type: 'autofillData' }, () => res(null));
    })).catch(() => null);
    console.log('raw report  :', JSON.stringify(await page.evaluate(async () => {
      const mod = await import(chrome.runtime.getURL('src/content/autofill.js'));
      const d = await new Promise((r) => chrome.runtime.sendMessage({ type: 'autofillData' }, (x) => r(x.data)));
      return mod.fillForm(d.fields);
    }), null, 1));
  } finally {
    await context.close();
    fixtures.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
