/**
 * Autofill, against the form shapes that actually appear.
 *
 * Every bug found here was silent: the form simply came out less filled than
 * it should have, which looks identical to a form the tool was never confident
 * about. So the fixtures below are the awkward shapes — a dropdown whose first
 * option is a placeholder, a label that is just "Name", a field inside a fixed
 * modal, a question too short to look like one — and each asserts a value, not
 * an absence of errors.
 *
 * Driven through a real browser because this is DOM code end to end; the module
 * itself touches no extension API, so it is served and imported directly.
 *
 *   node tests/autofill.mjs
 */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findChromium } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

const FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Test</title></head><body>
<form>
  <!-- A label that is just "Name", which means the whole of it. -->
  <label for="nm">Name</label><input id="nm" name="name">
  <label for="fn">First Name</label><input id="fn" name="first_name">
  <label for="ln">Last Name</label><input id="ln" name="last_name">

  <!-- Dropdowns whose first option is a placeholder with a value of its own. -->
  <label for="ct">City</label>
  <select id="ct" name="city"><option value="none">Select a city…</option><option value="Boston">Boston</option></select>
  <label for="wa">Work Authorization</label>
  <select id="wa" name="work_auth"><option value="">Choose</option><option>Authorized to work in the US</option></select>
  <label for="sp">Will you now or in the future require sponsorship?</label>
  <select id="sp" name="sponsorship"><option value="-1">-- Select --</option><option>No</option><option>Yes</option></select>
  <label for="nomatch">City</label>
  <select id="nomatch" name="city_2"><option value="">Choose</option><option>Remote</option></select>

  <!-- Already answered by hand, and not to be touched. -->
  <label for="em">Email</label><input id="em" name="email" value="already@typed.com">
  <label for="ctry">Country</label>
  <select id="ctry" name="country"><option>Canada</option><option>United States</option></select>

  <!-- A form inside a fixed modal, which is ordinary. -->
  <div style="position:fixed;top:0;left:0"><label for="ph">Phone</label><input id="ph" name="phone"></div>

  <!-- Never fillable. -->
  <label for="dis">LinkedIn Profile</label><input id="dis" name="linkedin" disabled>
  <div style="display:none"><label for="hid">GitHub</label><input id="hid" name="github"></div>

  <!-- Questions: one short but plainly a question, one that is just a label. -->
  <label for="q1">Why us?</label><textarea id="q1"></textarea>
  <label for="q2">Describe a technical project you are proud of. *</label><textarea id="q2" required></textarea>
  <label for="q3">Notes</label><textarea id="q3"></textarea>
</form></body></html>`;

const PROFILE = {
  first_name: 'Jianwen',
  last_name: 'Ding',
  full_name: 'Jianwen Ding',
  email: 'ding.jianw@northeastern.edu',
  phone: '555-0100',
  linkedin: 'linkedin.com/in/x',
  github: 'github.com/x',
  address_city: 'Boston',
  address_country: 'United States',
  work_authorization: 'Authorized to work in the US',
  requires_sponsorship: 'No',
};

async function main() {
  const source = fs.readFileSync(path.join(root, 'src/content/autofill.js'), 'utf8');
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/autofill.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(source);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FORM);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(`${base}/apply`, { waitUntil: 'domcontentloaded' });

    const out = await page.evaluate(async ({ b, profile }) => {
      const m = await import(`${b}/autofill.js`);
      const report = m.fillForm(profile);
      const value = (id) => document.getElementById(id).value;
      return {
        filled: report.filled.map((f) => f.key),
        skipped: report.skipped.map((s) => ({ key: s.key, reason: s.reason })),
        questions: m.findQuestions().map((q) => ({ question: q.question, required: m.isRequired(q.fieldId) })),
        wantsLetter: m.wantsCoverLetter(),
        values: Object.fromEntries(
          ['nm', 'fn', 'ln', 'ct', 'wa', 'sp', 'nomatch', 'em', 'ctry', 'ph'].map((id) => [id, value(id)]),
        ),
      };
    }, { b: base, profile: PROFILE });

    group('Names');
    check('a label that is just "Name" gets the whole name', out.values.nm === 'Jianwen Ding', out.values.nm);
    check('first and last still go to their own fields', out.values.fn === 'Jianwen' && out.values.ln === 'Ding');

    group('Dropdowns');
    // `value` is never empty on a select: the placeholder has a value of its
    // own, so every one of these was skipped as "already filled".
    check('a placeholder option does not count as an answer', out.values.ct === 'Boston', out.values.ct);
    check(
      'work authorization is matched at all',
      out.values.wa === 'Authorized to work in the US',
      out.values.wa,
    );
    check('so is sponsorship', out.values.sp === 'No', out.values.sp);
    check(
      'a dropdown with no matching option is left alone and reported',
      out.values.nomatch === '' && out.skipped.some((s) => s.reason === 'no matching option'),
      out.values.nomatch,
    );

    group('What it must not touch');
    check('an answer already typed', out.values.em === 'already@typed.com', out.values.em);
    check(
      'a dropdown already answered',
      out.values.ctry === 'Canada' && out.skipped.some((s) => s.key === 'address_country'),
      out.values.ctry,
    );
    check('a disabled field', !out.filled.includes('linkedin'));
    check('a hidden field', !out.filled.includes('github'));

    group('Fields that are visible but not laid out normally');
    check('a field inside a fixed modal is filled', out.values.ph === '555-0100', out.values.ph);

    group('Questions');
    const asked = out.questions.map((q) => q.question);
    check('a short question is still a question', asked.includes('Why us?'), asked.join(' | '));
    check('a long one is too', asked.some((q) => q.startsWith('Describe a technical project')));
    check('a bare label is not', !asked.includes('Notes'));
    check(
      'the required marker is read off the label',
      out.questions.find((q) => q.question.startsWith('Describe'))?.required === true,
    );
    check('the asterisk is stripped from the question itself', !asked.some((q) => q.includes('*')));
    check('and a form with no cover letter box says so', out.wantsLetter === false);
  } finally {
    await browser.close();
    server.close();
  }

  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
