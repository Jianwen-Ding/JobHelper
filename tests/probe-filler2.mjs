/** Ad-hoc probe, round two: radio grouping, selects, and stale field ids. */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = (label, value) => console.log(`  ${label}: ${JSON.stringify(value)}`);

const PROFILE = {
  first_name: 'Jianwen', last_name: 'Ding', full_name: 'Jianwen Ding',
  email: 'ding.jianw@northeastern.edu', phone: '555-0100',
  address_city: 'Boston', address_state: 'MA', address_country: 'United States',
  location: 'Boston, MA',
  work_authorization: 'Authorized to work in the US', requires_sponsorship: 'No',
};

const PAGES = {
  /* The marketing form comes first in the DOM and shares the group name. */
  '/radios-swapped': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form id="marketing">
  <fieldset>
    <legend>May we email you about sponsorship webinars?</legend>
    <label><input type="radio" name="spon" value="yes"> Yes</label>
    <label><input type="radio" name="spon" value="no"> No</label>
  </fieldset>
</form>
<form id="application">
  <fieldset>
    <legend>Will you now or in the future require sponsorship?</legend>
    <label><input type="radio" name="spon" value="yes"> Yes</label>
    <label><input type="radio" name="spon" value="no"> No</label>
  </fieldset>
</form></body></html>`,

  /* The applicant has already answered the marketing one by hand. */
  '/radios-prefilled': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form id="marketing">
  <fieldset>
    <legend>May we email you about sponsorship webinars?</legend>
    <label><input type="radio" name="spon" value="yes" checked> Yes</label>
    <label><input type="radio" name="spon" value="no"> No</label>
  </fieldset>
</form>
<form id="application">
  <fieldset>
    <legend>Will you now or in the future require sponsorship?</legend>
    <label><input type="radio" name="spon" value="yes"> Yes</label>
    <label><input type="radio" name="spon" value="no"> No</label>
  </fieldset>
</form></body></html>`,

  '/selects2': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form>
  <!-- Nothing selected yet, and more than one may be picked. -->
  <label for="ms">Which states are you authorized to work in?</label>
  <select id="ms" name="state" multiple size="4">
    <option value="MA">MA</option><option value="NY">NY</option><option value="CA">CA</option>
  </select>

  <!-- The applicant answered "N/A" on purpose. -->
  <label for="na">Will you now or in the future require sponsorship?</label>
  <select id="na" name="sponsorship"><option>Yes</option><option>No</option><option selected>N/A</option></select>

  <!-- And "None", on a question where None is a real answer. -->
  <label for="nn">Country</label>
  <select id="nn" name="country"><option>United States</option><option>Canada</option><option selected>None</option></select>
</form></body></html>`,

  /* A form that re-renders itself, as every SPA application form does. */
  '/rerender': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<div id="view">
  <form>
    <label for="q1">Why do you want to work here?</label><textarea id="q1"></textarea>
  </form>
</div></body></html>`,
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

  const radioState = () =>
    [...document.querySelectorAll('input[type=radio]')]
      .map((r) => ({ form: r.form?.id, value: r.value, checked: r.checked }))
      .filter((r) => r.checked);

  try {
    console.log('\n7. Two forms, one radio-group name, marketing first');
    out('result', await go('/radios-swapped', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const report = m.fillForm(profile);
      return {
        report,
        checked: [...document.querySelectorAll('input[type=radio]')]
          .map((r) => ({ form: r.form?.id, value: r.value, checked: r.checked }))
          .filter((r) => r.checked),
      };
    }));

    console.log('\n8. ...and when the marketing one is already answered');
    out('result', await go('/radios-prefilled', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const report = m.fillForm(profile);
      return {
        report,
        checked: [...document.querySelectorAll('input[type=radio]')]
          .map((r) => ({ form: r.form?.id, value: r.value, checked: r.checked }))
          .filter((r) => r.checked),
      };
    }));

    console.log('\n9. Multi-select, and options the applicant chose on purpose');
    out('result', await go('/selects2', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const report = m.fillForm(profile);
      return {
        report,
        multi: [...document.getElementById('ms').selectedOptions].map((o) => o.value),
        na: document.getElementById('na').value,
        none: document.getElementById('nn').value,
      };
    }));

    console.log('\n10. A field id that the form has since re-rendered away');
    out('result', await go('/rerender', async ({ b }) => {
      const m = await import(`${b}/autofill.js`);
      const first = m.findQuestions();
      // The page re-renders its own form, as a React/Vue form does on any
      // state change. The marker attribute goes with the old node.
      document.getElementById('view').innerHTML =
        '<form><label for="q1">Why do you want to work here?</label><textarea id="q1"></textarea></form>';
      return {
        fieldId: first[0]?.fieldId,
        insertReturned: await m.insertAnswer(first[0].fieldId, 'Because I read your code.'),
        valueInTheBox: document.getElementById('q1').value,
      };
    }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
