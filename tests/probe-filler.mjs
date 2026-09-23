/**
 * Ad-hoc probe: autofill.js as a filler, against awkward-but-real form shapes.
 * Mirrors tests/autofill.mjs's harness (module served over http, imported in a
 * real page) so the baseline and the probe are the same kind of evidence.
 *
 *   node tests/probe-filler.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const out = (label, value) => console.log(`  ${label}: ${JSON.stringify(value)}`);

/* The real dev profile, as /api/autofill serves it, plus email/phone. */
const PROFILE = {
  first_name: 'Jianwen',
  last_name: 'Ding',
  full_name: 'Jianwen Ding',
  email: 'ding.jianw@northeastern.edu',
  phone: '555-0100',
  linkedin: 'linkedin.com/in/x',
  github: 'github.com/x',
  school: 'Northeastern University',
  degree: 'Bachelor of Science',
  major: 'Computer Science',
  gpa: '3.8',
  location: 'Boston, MA',
  address_city: 'Boston',
  address_state: 'MA',
  address_country: 'United States',
  work_authorization: 'Authorized to work in the US',
  requires_sponsorship: 'No',
};

const PAGES = {
  /* 1. An unlabelled field sitting after a labelled one. */
  '/bleed': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form>
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <input id="mystery" name="ref_code">
  <label for="em">Email</label><input id="em" name="email">
  <input id="mystery2" name="promo">
  <label for="ln">Last Name</label><input id="ln" name="last_name">
</form></body></html>`,

  /* 2. Required detection when the fields share one container. */
  '/required': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<div class="wrap">
  <form>
    <label for="fn">First Name *</label><input id="fn" name="first_name">
    <label for="q1">Why do you want to work here?</label><textarea id="q1"></textarea>
    <label for="q2">Anything else you would like us to know?</label><textarea id="q2"></textarea>
  </form>
</div></body></html>`,

  /* 3. Radio groups, the shapes Workable/Teamtailor use. */
  '/radios': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form id="a">
  <fieldset>
    <legend>Will you now or in the future require sponsorship?</legend>
    <label><input type="radio" name="spon" value="yes"> Yes</label>
    <label><input type="radio" name="spon" value="no"> No</label>
  </fieldset>
  <fieldset>
    <legend>Are you legally authorized to work in the US?</legend>
    <label><input type="radio" name="auth" value="yes"> Yes</label>
    <label><input type="radio" name="auth" value="no"> No</label>
  </fieldset>
</form>
<!-- A second, unrelated form re-using the same group name, which browsers
     scope per-form but this code does not. -->
<form id="b">
  <fieldset>
    <legend>Marketing: may we email you about sponsorship webinars?</legend>
    <label><input type="radio" name="spon" value="yes"> Yes</label>
    <label><input type="radio" name="spon" value="no"> No</label>
  </fieldset>
</form>
</body></html>`,

  /* 4. Selects: multi-select, a deliberate "None", and a typed date/number. */
  '/selects': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form>
  <label for="ms">State</label>
  <select id="ms" name="state" multiple>
    <option value="MA" selected>MA</option><option value="NY" selected>NY</option>
    <option value="CA">CA</option>
  </select>

  <!-- The applicant deliberately answered "None" here. -->
  <label for="none">Will you now or in the future require sponsorship?</label>
  <select id="none" name="sponsorship"><option>Yes</option><option>No</option><option selected>None</option></select>

  <!-- A GPA box that is a number input; a graduation "city" that is a date. -->
  <label for="gpa">GPA</label><input id="gpa" name="gpa" type="number" step="0.01" max="4">
  <label for="phone">Phone</label><input id="phone" name="phone" type="number">
  <label for="city">City</label><input id="city" name="city" type="date">
</form></body></html>`,

  /* 5. A combobox that is a text input (react-select and friends). */
  '/combo': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form>
  <label for="cb">Country</label>
  <input id="cb" name="country" role="combobox" aria-autocomplete="list" aria-haspopup="listbox">
  <label for="ed">Why do you want to work here?</label>
  <div id="ed" contenteditable="true" style="min-height:60px;border:1px solid #ccc"></div>
</form></body></html>`,

  /* 6. Labels that arrive by ancestor-climb, Lever/Taleo style. */
  '/climb': `<!doctype html><html><head><meta charset=utf-8><title>Apply</title></head><body>
<form>
  <div class="application-question">
    <div class="application-label">Email</div>
    <div class="application-field"><input id="em" name="a1"></div>
  </div>
  <div class="application-question">
    <div class="application-label">Current employer</div>
    <div class="application-field"><input id="emp" name="a2"></div>
  </div>
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
  const go = async (p, fn, arg) => {
    await page.goto(`${base}${p}`, { waitUntil: 'domcontentloaded' });
    return page.evaluate(fn, { b: base, profile: PROFILE, arg });
  };

  try {
    console.log('\n1. A field with no label of its own, after one that has');
    out('labels + values', await go('/bleed', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const before = [...document.querySelectorAll('input')].map((i) => [i.id, m.labelFor(i)]);
      const report = m.fillForm(profile);
      return {
        labelsSeen: Object.fromEntries(before),
        values: Object.fromEntries([...document.querySelectorAll('input')].map((i) => [i.id, i.value])),
        filled: report.filled,
      };
    }));

    console.log('\n2. Required detection when one container holds the whole form');
    out('questions', await go('/required', async ({ b }) => {
      const m = await import(`${b}/autofill.js`);
      return m.findQuestions().map((q) => ({ q: q.question.slice(0, 40), required: m.isRequired(q.fieldId) }));
    }));

    console.log('\n3. Radio groups');
    out('radios', await go('/radios', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const report = m.fillForm(profile);
      return {
        report,
        checked: [...document.querySelectorAll('input[type=radio]')]
          .map((r, i) => ({ i, form: r.form?.id, name: r.name, value: r.value, checked: r.checked }))
          .filter((r) => r.checked),
      };
    }));

    console.log('\n4. Selects and typed inputs');
    out('selects', await go('/selects', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const events = [];
      for (const el of document.querySelectorAll('select,input')) {
        for (const type of ['input', 'change']) {
          el.addEventListener(type, () => events.push(`${el.id}:${type}`));
        }
      }
      const report = m.fillForm(profile);
      return {
        report,
        multiSelected: [...document.getElementById('ms').selectedOptions].map((o) => o.value),
        noneValue: document.getElementById('none').value,
        gpa: document.getElementById('gpa').value,
        phone: document.getElementById('phone').value,
        city: document.getElementById('city').value,
        events,
      };
    }));

    console.log('\n5. A combobox that is a text input, and a contenteditable answer');
    out('combo', await go('/combo', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const report = m.fillForm(profile);
      const qs = m.findQuestions();
      const inserted = qs[0] ? await m.insertAnswer(qs[0].fieldId, 'Because I read your code.') : null;
      return {
        report,
        comboValue: document.getElementById('cb').value,
        questions: qs.map((q) => q.question),
        inserted,
        editable: document.getElementById('ed').textContent,
      };
    }));

    console.log('\n6. Labels found by climbing');
    out('climb', await go('/climb', async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const labels = [...document.querySelectorAll('input')].map((i) => [i.id, m.labelFor(i)]);
      const report = m.fillForm(profile);
      return {
        labels: Object.fromEntries(labels),
        values: Object.fromEntries([...document.querySelectorAll('input')].map((i) => [i.id, i.value])),
        report,
      };
    }));
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
