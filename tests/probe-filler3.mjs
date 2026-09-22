/** Ad-hoc probe, round three: a radio ticked in the wrong form, and a
 *  deliberate "None" replaced by something else. */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (label, value) => console.log(`  ${label}: ${JSON.stringify(value)}`);

const PROFILE = {
  first_name: 'Jianwen', last_name: 'Ding', email: 'a@b.com',
  degree: 'Bachelor of Science', school: 'Northeastern University',
  address_country: 'United States', address_state: 'MA',
  work_authorization: 'Authorized to work in the US', requires_sponsorship: 'No',
};

const PAGES = {
  /* A job-alert signup above the application, both using name="country". */
  '/two-countries': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form id="alerts">
  <fieldset>
    <legend>Which country should we send job alerts for?</legend>
    <label><input type="radio" name="country" value="United States"> United States</label>
    <label><input type="radio" name="country" value="Canada"> Canada</label>
  </fieldset>
</form>
<form id="application">
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <fieldset>
    <legend>Country of residence</legend>
    <label><input type="radio" name="country" value="United States"> United States</label>
    <label><input type="radio" name="country" value="Canada"> Canada</label>
  </fieldset>
</form></body></html>`,

  /* "None" and "N/A" are real answers on these two questions. */
  '/real-none': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form>
  <label for="dg">Highest degree completed</label>
  <select id="dg" name="degree">
    <option>Bachelor of Science</option><option>Master of Science</option><option selected>None</option>
  </select>
  <label for="st">State or province</label>
  <select id="st" name="state">
    <option>MA</option><option>NY</option><option selected>N/A</option>
  </select>
</form></body></html>`,
};

async function main() {
  const source = fs.readFileSync(path.join(root, 'src/content/autofill.js'), 'utf8');
  // And what it imports; see the same line in tests/autofill.mjs.
  const shared = fs.readFileSync(path.join(root, 'src/shared/remembering.js'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url.startsWith('/shared/remembering.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(shared);
      return;
    }
    if (url.startsWith('/autofill.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(source);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGES[url] ?? '<html><body>no fixture</body></html>');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const go = async (p, fn) => {
    await page.goto(`${base}${p}`, { waitUntil: 'domcontentloaded' });
    return page.evaluate(fn, { b: base, profile: PROFILE });
  };

  try {
    console.log('\n11. Two forms sharing a radio-group name');
    out('result', await go('/two-countries', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const report = m.fillForm(profile);
      return {
        report,
        checked: [...document.querySelectorAll('input[type=radio]')]
          .map((r) => ({ form: r.form?.id, value: r.value, checked: r.checked }))
          .filter((r) => r.checked),
      };
    }));

    console.log('\n12. "None" and "N/A" chosen on purpose');
    out('result', await go('/real-none', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const before = { dg: document.getElementById('dg').value, st: document.getElementById('st').value };
      const report = m.fillForm(profile);
      return {
        before,
        after: { dg: document.getElementById('dg').value, st: document.getElementById('st').value },
        report,
      };
    }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
