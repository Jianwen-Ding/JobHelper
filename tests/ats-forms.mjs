/**
 * Autofill and question-detection, against the markup real applicant tracking
 * systems ship.
 *
 * The patterns in `autofill.js` were written against forms built the way the
 * specification suggests: a `<label for>` beside every field, a `<select>` for
 * every choice. Barely any of these systems does that. Lever labels nothing and
 * puts the words in a placeholder; Taleo lays the form out in a table with the
 * label in the cell before; Workday's dropdowns are buttons; Greenhouse names
 * its fields `job_application[first_name]`.
 *
 * Each fixture below is the shape one of them actually uses, reduced to the
 * fields that matter. What is being tested is not that the code runs but that
 * the form comes out filled — and, where it cannot be, that the user is told
 * rather than left to discover it at the end.
 *
 *   node tests/ats-forms.mjs
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

const PROFILE = {
  first_name: 'Jianwen',
  last_name: 'Ding',
  full_name: 'Jianwen Ding',
  email: 'ding.jianw@northeastern.edu',
  phone: '555-0100',
  linkedin: 'linkedin.com/in/jianwen',
  github: 'github.com/jianwen',
  website: 'jianwen.dev',
  school: 'Northeastern University',
  address_city: 'Boston',
  address_state: 'Massachusetts',
  address_country: 'United States',
  work_authorization: 'Yes',
  requires_sponsorship: 'No',
};

/*
 * Each system: the markup, then what a filled form looks like. `want` maps a
 * field's selector to the value that must end up in it; `questions` is the
 * long-form questions that must be offered.
 */
const SYSTEMS = [
  {
    name: 'Greenhouse',
    html: `
      <label for="first_name">First Name <span class="asterisk">*</span></label>
      <input type="text" id="first_name" name="job_application[first_name]">
      <label for="last_name">Last Name <span class="asterisk">*</span></label>
      <input type="text" id="last_name" name="job_application[last_name]">
      <label for="email">Email <span class="asterisk">*</span></label>
      <input type="text" id="email" name="job_application[email]">
      <label for="phone">Phone</label>
      <input type="text" id="phone" name="job_application[phone]">
      <label for="job_application_answers_attributes_0_text_value">LinkedIn Profile</label>
      <input type="text" id="job_application_answers_attributes_0_text_value"
             name="job_application[answers_attributes][0][text_value]">
      <label for="job_application_answers_attributes_1_boolean_value">
        Are you legally authorized to work in the United States? <span class="asterisk">*</span>
      </label>
      <select id="job_application_answers_attributes_1_boolean_value"
              name="job_application[answers_attributes][1][boolean_value]">
        <option value="">--</option><option value="1">Yes</option><option value="0">No</option>
      </select>
      <label for="job_application_answers_attributes_2_boolean_value">
        Will you now or in the future require sponsorship for employment visa status?
      </label>
      <select id="job_application_answers_attributes_2_boolean_value"
              name="job_application[answers_attributes][2][boolean_value]">
        <option value="">--</option><option value="1">Yes</option><option value="0">No</option>
      </select>
      <label for="cover_letter_text">Cover Letter</label>
      <textarea id="cover_letter_text" name="job_application[cover_letter_text]"></textarea>
      <label for="q_why">Why do you want to work at Acme? <span class="asterisk">*</span></label>
      <textarea id="q_why" name="job_application[answers_attributes][3][text_value]"></textarea>`,
    want: {
      '#first_name': 'Jianwen',
      '#last_name': 'Ding',
      '#email': 'ding.jianw@northeastern.edu',
      '#phone': '555-0100',
      '#job_application_answers_attributes_0_text_value': 'linkedin.com/in/jianwen',
      '#job_application_answers_attributes_1_boolean_value': '1',
      '#job_application_answers_attributes_2_boolean_value': '0',
    },
    questions: [/why do you want to work at acme/i],
    wantsLetter: true,
  },

  {
    name: 'Lever',
    // Lever labels nothing. Every word a human reads is a placeholder, and the
    // questions are a div above the box rather than a label.
    html: `
      <input type="text" name="name" placeholder="Full name" required>
      <input type="email" name="email" placeholder="Email" required>
      <input type="tel" name="phone" placeholder="Phone">
      <input type="text" name="org" placeholder="Current company">
      <input type="text" name="urls[LinkedIn]" placeholder="LinkedIn URL">
      <input type="text" name="urls[GitHub]" placeholder="GitHub URL">
      <input type="text" name="urls[Portfolio]" placeholder="Portfolio URL">
      <ul class="application-additional">
        <li class="application-question">
          <div class="application-label"><div class="text">What interests you about this role?</div></div>
          <div class="application-field">
            <textarea name="cards[a1b2][field0]" required></textarea>
          </div>
        </li>
      </ul>
      <div class="application-additional">
        <div class="application-label"><div class="text">Additional information</div></div>
        <textarea name="comments"></textarea>
      </div>`,
    want: {
      'input[name="name"]': 'Jianwen Ding',
      'input[name="email"]': 'ding.jianw@northeastern.edu',
      'input[name="phone"]': '555-0100',
      'input[name="urls[LinkedIn]"]': 'linkedin.com/in/jianwen',
      'input[name="urls[GitHub]"]': 'github.com/jianwen',
      'input[name="urls[Portfolio]"]': 'jianwen.dev',
    },
    questions: [/what interests you about this role/i],
    wantsLetter: false,
  },

  {
    name: 'Ashby',
    html: `
      <label id="_systemfield_name-label" for="_systemfield_name">Name</label>
      <input id="_systemfield_name" name="_systemfield_name" type="text">
      <label id="_systemfield_email-label" for="_systemfield_email">Email</label>
      <input id="_systemfield_email" name="_systemfield_email" type="email">
      <label for="_systemfield_phone">Phone</label>
      <input id="_systemfield_phone" name="_systemfield_phone" type="tel">
      <label for="c_linkedin">LinkedIn</label>
      <input id="c_linkedin" name="c_linkedin" type="text">
      <label for="c_location">Location</label>
      <input id="c_location" name="c_location" type="text">
      <label for="c_q1">Tell us about a system you designed end to end.</label>
      <textarea id="c_q1" name="c_q1"></textarea>`,
    want: {
      '#_systemfield_name': 'Jianwen Ding',
      '#_systemfield_email': 'ding.jianw@northeastern.edu',
      '#_systemfield_phone': '555-0100',
      '#c_linkedin': 'linkedin.com/in/jianwen',
    },
    questions: [/tell us about a system you designed/i],
    wantsLetter: false,
  },

  {
    name: 'Workday',
    // Labels are associated by aria-labelledby, and every choice is a button
    // that opens a listbox rather than a <select>.
    html: `
      <div data-automation-id="legalNameSection_firstName">
        <label id="lbl-fn">First Name</label>
        <input aria-labelledby="lbl-fn" data-automation-id="legalNameSection_firstName" type="text" id="wd-fn">
      </div>
      <div data-automation-id="legalNameSection_lastName">
        <label id="lbl-ln">Last Name</label>
        <input aria-labelledby="lbl-ln" data-automation-id="legalNameSection_lastName" type="text" id="wd-ln">
      </div>
      <div data-automation-id="email">
        <label id="lbl-em">Email Address</label>
        <input aria-labelledby="lbl-em" type="text" id="wd-em">
      </div>
      <div data-automation-id="phone-number">
        <label id="lbl-ph">Phone Number</label>
        <input aria-labelledby="lbl-ph" type="text" id="wd-ph">
      </div>
      <div data-automation-id="addressSection_city">
        <label id="lbl-city">City</label>
        <input aria-labelledby="lbl-city" type="text" id="wd-city">
      </div>
      <div>
        <label id="lbl-country">Country</label>
        <button id="wd-country" aria-haspopup="listbox" aria-labelledby="lbl-country"
                data-automation-id="countryDropdown">Select One</button>
      </div>
      <div>
        <label id="lbl-auth">Are you legally authorized to work in the United States?</label>
        <button id="wd-auth" aria-haspopup="listbox" aria-labelledby="lbl-auth">Select One</button>
      </div>`,
    want: {
      '#wd-fn': 'Jianwen',
      '#wd-ln': 'Ding',
      '#wd-em': 'ding.jianw@northeastern.edu',
      '#wd-ph': '555-0100',
      '#wd-city': 'Boston',
    },
    // Not fillable by any means this module has; what matters is that it says so.
    reportsUnfillable: ['address_country', 'work_authorization'],
    questions: [],
    wantsLetter: false,
  },

  {
    name: 'Taleo',
    /*
     * A table, with the label in the cell before the field and no `for`. The
     * ids and names are opaque, as Taleo's really are — so the only thing that
     * can fill this form is reading the label, which is the point.
     */
    html: `
      <table><tbody>
        <tr><td><span class="label">First Name</span></td>
            <td><input type="text" id="ftlf_1" name="descriptor1.value"></td></tr>
        <tr><td><span class="label">Last Name</span></td>
            <td><input type="text" id="ftlf_2" name="descriptor2.value"></td></tr>
        <tr><td><span class="label">E-Mail Address</span></td>
            <td><input type="text" id="ftlf_3" name="descriptor3.value"></td></tr>
        <tr><td><span class="label">Primary Number</span></td>
            <td><input type="text" id="ftlf_4" name="descriptor4.value"></td></tr>
        <tr><td><span class="label">City</span></td>
            <td><input type="text" id="ftlf_5" name="descriptor5.value"></td></tr>
      </tbody></table>`,
    want: {
      '#ftlf_1': 'Jianwen',
      '#ftlf_2': 'Ding',
      '#ftlf_3': 'ding.jianw@northeastern.edu',
      '#ftlf_4': '555-0100',
      '#ftlf_5': 'Boston',
    },
    questions: [],
    wantsLetter: false,
  },

  {
    name: 'SmartRecruiters',
    html: `
      <label for="sr-fn">First name</label><input id="sr-fn" name="candidate.firstName" type="text">
      <label for="sr-ln">Last name</label><input id="sr-ln" name="candidate.lastName" type="text">
      <label for="sr-em">Email</label><input id="sr-em" name="candidate.email" type="email">
      <label for="sr-ph">Phone number</label><input id="sr-ph" name="candidate.phoneNumber" type="tel">
      <label for="sr-loc">Location</label><input id="sr-loc" name="candidate.location.city" type="text">
      <label for="sr-web">Web / Social</label><input id="sr-web" name="candidate.web.linkedin" type="text">
      <label for="sr-q1">What makes you a good fit for this position?</label>
      <textarea id="sr-q1"></textarea>`,
    want: {
      '#sr-fn': 'Jianwen',
      '#sr-ln': 'Ding',
      '#sr-em': 'ding.jianw@northeastern.edu',
      '#sr-ph': '555-0100',
      '#sr-web': 'linkedin.com/in/jianwen',
    },
    questions: [/what makes you a good fit/i],
    wantsLetter: false,
  },

  {
    name: 'Workable',
    html: `
      <label for="firstname">First name *</label><input id="firstname" name="firstname" type="text">
      <label for="lastname">Last name *</label><input id="lastname" name="lastname" type="text">
      <label for="email">Email *</label><input id="email" name="email" type="email">
      <label for="phone">Phone</label><input id="phone" name="phone" type="tel">
      <label for="address">Location</label><input id="address" name="address" type="text">
      <label for="wk-li">LinkedIn URL</label><input id="wk-li" name="linkedin_url" type="text">
      <label for="wk-cl">Cover letter</label><textarea id="wk-cl" name="cover_letter"></textarea>
      <label for="wk-q1">Do you have experience running Kubernetes in production?</label>
      <textarea id="wk-q1"></textarea>`,
    want: {
      '#firstname': 'Jianwen',
      '#lastname': 'Ding',
      '#email': 'ding.jianw@northeastern.edu',
      '#phone': '555-0100',
      '#wk-li': 'linkedin.com/in/jianwen',
    },
    questions: [/experience running kubernetes/i],
    wantsLetter: true,
  },

  {
    name: 'BambooHR',
    html: `
      <label for="bh-fn">First Name<span class="required">*</span></label>
      <input id="bh-fn" name="firstName" type="text">
      <label for="bh-ln">Last Name<span class="required">*</span></label>
      <input id="bh-ln" name="lastName" type="text">
      <label for="bh-em">Email<span class="required">*</span></label>
      <input id="bh-em" name="email" type="email">
      <label for="bh-ph">Phone<span class="required">*</span></label>
      <input id="bh-ph" name="phone" type="tel">
      <label for="bh-web">Website, Blog, or Portfolio</label>
      <input id="bh-web" name="websiteUrl" type="text">
      <label for="bh-li">LinkedIn Profile URL</label>
      <input id="bh-li" name="linkedinUrl" type="text">`,
    want: {
      '#bh-fn': 'Jianwen',
      '#bh-ln': 'Ding',
      '#bh-em': 'ding.jianw@northeastern.edu',
      '#bh-ph': '555-0100',
      '#bh-web': 'jianwen.dev',
      '#bh-li': 'linkedin.com/in/jianwen',
    },
    questions: [],
    wantsLetter: false,
  },

  {
    name: 'JazzHR',
    html: `
      <label for="jz-fn">First Name *</label><input id="jz-fn" name="firstname" type="text">
      <label for="jz-ln">Last Name *</label><input id="jz-ln" name="lastname" type="text">
      <label for="jz-em">Email *</label><input id="jz-em" name="email" type="email">
      <label for="jz-ph">Phone *</label><input id="jz-ph" name="phone" type="text">
      <label for="jz-q1">Describe your experience with distributed systems. *</label>
      <textarea id="jz-q1" name="answer_1"></textarea>`,
    want: {
      '#jz-fn': 'Jianwen',
      '#jz-ln': 'Ding',
      '#jz-em': 'ding.jianw@northeastern.edu',
      '#jz-ph': '555-0100',
    },
    questions: [/describe your experience with distributed systems/i],
    wantsLetter: false,
  },

  {
    name: 'Jobvite',
    html: `
      <label for="jv-fn">First Name</label><input id="jv-fn" name="jvFirstName" type="text">
      <label for="jv-ln">Last Name</label><input id="jv-ln" name="jvLastName" type="text">
      <label for="jv-em">Email</label><input id="jv-em" name="jvEmail" type="email">
      <label for="jv-ph">Phone</label><input id="jv-ph" name="jvPhone" type="text">
      <label for="jv-cl">Cover Letter</label><textarea id="jv-cl" name="jvCoverLetter"></textarea>`,
    want: {
      '#jv-fn': 'Jianwen',
      '#jv-ln': 'Ding',
      '#jv-em': 'ding.jianw@northeastern.edu',
      '#jv-ph': '555-0100',
    },
    questions: [],
    wantsLetter: true,
  },

  {
    name: 'Teamtailor',
    html: `
      <label for="tt-name">Name</label><input id="tt-name" name="candidate[name]" type="text">
      <label for="tt-em">Email</label><input id="tt-em" name="candidate[email]" type="email">
      <label for="tt-ph">Phone</label><input id="tt-ph" name="candidate[phone]" type="tel">
      <label for="tt-li">LinkedIn</label><input id="tt-li" name="candidate[linkedin_url]" type="text">
      <label for="tt-q1">Why would you like to join us?</label>
      <textarea id="tt-q1" name="answers[1]"></textarea>`,
    want: {
      '#tt-name': 'Jianwen Ding',
      '#tt-em': 'ding.jianw@northeastern.edu',
      '#tt-ph': '555-0100',
      '#tt-li': 'linkedin.com/in/jianwen',
    },
    questions: [/why would you like to join us/i],
    wantsLetter: false,
  },

  {
    name: 'SAP SuccessFactors',
    html: `
      <label for="sf-fn">First Name</label><input id="sf-fn" name="firstName" type="text">
      <label for="sf-ln">Last Name</label><input id="sf-ln" name="lastName" type="text">
      <label for="sf-em">E-Mail</label><input id="sf-em" name="email" type="text">
      <label for="sf-ph">Phone</label><input id="sf-ph" name="cellPhone" type="text">
      <label for="sf-country">Country/Region</label>
      <select id="sf-country" name="country">
        <option value="">Select One</option>
        <option value="USA">United States</option>
        <option value="CAN">Canada</option>
      </select>`,
    want: {
      '#sf-fn': 'Jianwen',
      '#sf-ln': 'Ding',
      '#sf-em': 'ding.jianw@northeastern.edu',
      '#sf-ph': '555-0100',
      '#sf-country': 'USA',
    },
    questions: [],
    wantsLetter: false,
  },

  {
    /*
     * Radio buttons instead of a dropdown, which is how Workable, Teamtailor
     * and most hand-rolled career sites ask a yes/no question. The label a
     * human reads belongs to the group, and the label on each button is the
     * answer — so nothing about an individual field says what is being asked.
     */
    name: 'Yes/no questions as radio buttons',
    html: `
      <label for="rb-fn">First Name</label><input id="rb-fn" name="first_name" type="text">
      <label for="rb-ln">Last Name</label><input id="rb-ln" name="last_name" type="text">
      <label for="rb-em">Email</label><input id="rb-em" name="email" type="email">
      <label for="rb-ph">Phone</label><input id="rb-ph" name="phone" type="tel">

      <fieldset>
        <legend>Are you legally authorized to work in the United States? *</legend>
        <label><input type="radio" name="work_auth" value="Yes"> Yes</label>
        <label><input type="radio" name="work_auth" value="No"> No</label>
      </fieldset>

      <fieldset>
        <legend>Will you now or in the future require sponsorship?</legend>
        <label><input type="radio" name="sponsorship" value="1"> Yes</label>
        <label><input type="radio" name="sponsorship" value="0"> No</label>
      </fieldset>

      <!-- Already answered by hand, and not to be moved. -->
      <fieldset>
        <legend>Country</legend>
        <label><input type="radio" name="country" value="Canada" checked> Canada</label>
        <label><input type="radio" name="country" value="United States"> United States</label>
      </fieldset>

      <!-- The same question, worded so that neither option is the stored
           answer. Getting this one wrong is a false declaration, so it has to
           be reported rather than reasoned about. -->
      <fieldset>
        <legend>Do you require visa sponsorship now or in the future?</legend>
        <label><input type="radio" name="visa_status" value="a"> I will require sponsorship</label>
        <label><input type="radio" name="visa_status" value="b"> I will not require sponsorship</label>
      </fieldset>

      <!-- Consent. Never ours to tick. -->
      <fieldset>
        <legend>I agree to the processing of my personal data.</legend>
        <label><input type="checkbox" name="consent" value="yes"> I agree</label>
      </fieldset>`,
    want: {
      '#rb-fn': 'Jianwen',
      '#rb-em': 'ding.jianw@northeastern.edu',
    },
    radios: {
      work_auth: 'Yes',
      sponsorship: '0',
      country: 'Canada',
      // Neither option is the stored answer, so neither is chosen.
      visa_status: '',
    },
    unchecked: ['consent'],
    neverGuesses: 'requires_sponsorship',
    questions: [],
    wantsLetter: false,
  },

  {
    name: 'iCIMS',
    // The whole form is in an iframe, which is how iCIMS serves it.
    frame: `
      <label for="ic-fn">First Name</label><input id="ic-fn" name="icims_firstname" type="text">
      <label for="ic-ln">Last Name</label><input id="ic-ln" name="icims_lastname" type="text">
      <label for="ic-em">Email Address</label><input id="ic-em" name="icims_email" type="text">
      <label for="ic-ph">Phone Number</label><input id="ic-ph" name="icims_phone" type="text">`,
    want: {
      '#ic-fn': 'Jianwen',
      '#ic-ln': 'Ding',
      '#ic-em': 'ding.jianw@northeastern.edu',
      '#ic-ph': '555-0100',
    },
    questions: [],
    wantsLetter: false,
  },
];

/** The things that look like the top of an application and are not one. */
const NOT_APPLICATIONS = {
  'a newsletter box': `
    <h3>Hiring newsletter</h3>
    <label for="a">Email</label><input id="a" name="email" type="email">
    <label for="b">First Name</label><input id="b" name="first_name">
    <button type="button">Subscribe</button>`,
  'a sign-in form': `
    <label for="a">Email</label><input id="a" name="email" type="email">
    <label for="b">Password</label><input id="b" name="password" type="password">
    <button type="button">Sign in</button>`,
  'a job search box': `
    <label for="a">Search jobs</label><input id="a" name="q">
    <label for="b">City</label><input id="b" name="city">
    <label for="c">Country</label><input id="c" name="country">
    <button type="button">Search</button>`,
  'a contact-us form': `
    <label for="a">Your Name</label><input id="a" name="name">
    <label for="b">Email</label><input id="b" name="email" type="email">
    <label for="c">How can we help?</label><textarea id="c"></textarea>
    <button type="button">Send</button>`,
  'a support chat widget': `
    <label for="a">Name</label><input id="a" name="name">
    <button type="button">Start chat</button>`,
};

const shell = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body><form>${body}</form></body></html>`;

async function main() {
  const source = fs.readFileSync(path.join(root, 'src/content/autofill.js'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/autofill.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(source);
      return;
    }
    const negative = url.startsWith('/not/') && NOT_APPLICATIONS[decodeURIComponent(url.slice(5))];
    if (negative) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(shell(negative));
      return;
    }
    const system = SYSTEMS.find((s) => url === `/${encodeURIComponent(s.name)}`);
    const frameOf = SYSTEMS.find((s) => url === `/${encodeURIComponent(s.name)}/frame`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (frameOf) return res.end(shell(frameOf.frame));
    if (!system) return res.end('<html><body>?</body></html>');
    res.end(
      system.frame
        ? `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
             <h1>Apply</h1>
             <iframe id="icims_content_iframe" src="/${encodeURIComponent(system.name)}/frame"
                     style="width:600px;height:400px"></iframe>
           </body></html>`
        : shell(system.html),
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
  try {
    for (const system of SYSTEMS) {
      console.log(`\n${system.name}`);
      const page = await browser.newPage();
      await page.goto(`${base}/${encodeURIComponent(system.name)}`, { waitUntil: 'load' });

      // The form is where the fields are: in its own frame, for the systems
      // that serve it that way.
      const where = system.frame ? page.frames().find((f) => f.url().endsWith('/frame')) : page.mainFrame();
      if (!where) {
        check(`${system.name}: the form's frame was found at all`, false);
        await page.close();
        continue;
      }

      const out = await where.evaluate(
        async ({ b, profile, wants }) => {
          const m = await import(`${b}/autofill.js`);
          const report = m.fillForm(profile);
          return {
            values: Object.fromEntries(
              Object.keys(wants).map((sel) => [sel, document.querySelector(sel)?.value ?? '(no such field)']),
            ),
            filled: report.filled.map((f) => f.key),
            skipped: report.skipped.map((s) => ({ key: s.key, reason: s.reason })),
            questions: m.findQuestions().map((q) => q.question),
            wantsLetter: m.wantsCoverLetter(),
            isApplication: m.looksLikeApplicationForm(),
            // Which option of each radio group ended up chosen, and whether
            // anything ticked a checkbox it had no business ticking.
            chosen: Object.fromEntries(
              [...new Set([...document.querySelectorAll('input[type=radio]')].map((r) => r.name))].map((name) => [
                name,
                document.querySelector(`input[type=radio][name="${name}"]:checked`)?.value ?? '',
              ]),
            ),
            ticked: [...document.querySelectorAll('input[type=checkbox]:checked')].map((c) => c.name),
          };
        },
        { b: base, profile: PROFILE, wants: system.want },
      );

      const wrong = Object.entries(system.want).filter(([sel, value]) => out.values[sel] !== value);
      check(
        `${system.name}: fills the fields it should`,
        wrong.length === 0,
        wrong.map(([sel, want]) => `${sel} wanted "${want}", got "${out.values[sel]}"`).join('; '),
      );

      if (system.radios) {
        const wrongRadio = Object.entries(system.radios).filter(([name, v]) => out.chosen[name] !== v);
        check(
          `${system.name}: answers the yes/no questions`,
          wrongRadio.length === 0,
          wrongRadio.map(([n, want]) => `${n} wanted "${want}", got "${out.chosen[n]}"`).join('; '),
        );
      }
      if (system.neverGuesses) {
        check(
          `${system.name}: reports the question it cannot answer instead of reasoning about it`,
          out.skipped.some((s) => s.key === system.neverGuesses && s.reason === 'no matching option'),
          out.skipped.map((s) => `${s.key}:${s.reason}`).join(', ') || '(nothing reported)',
        );
      }
      for (const name of system.unchecked ?? []) {
        check(`${system.name}: does not tick "${name}" on anyone's behalf`, !out.ticked.includes(name));
      }

      for (const re of system.questions ?? []) {
        check(
          `${system.name}: offers "${String(re).slice(1, 34)}…"`,
          out.questions.some((q) => re.test(q)),
          out.questions.join(' | ') || '(none found)',
        );
      }
      check(
        `${system.name}: does not offer the cover letter box as a question`,
        !out.questions.some((q) => /cover\s*letter/i.test(q)),
        out.questions.join(' | '),
      );
      check(
        `${system.name}: reads whether a cover letter is wanted`,
        out.wantsLetter === system.wantsLetter,
        `got ${out.wantsLetter}`,
      );

      /*
       * In a frame, this decides whether the form is read or left alone. A
       * false negative here silently switches the extension off for that
       * system — so every one of them has to be recognised.
       */
      check(`${system.name}: is recognised as an application form`, out.isApplication === true);

      for (const key of system.reportsUnfillable ?? []) {
        check(
          `${system.name}: says it could not do "${key}" rather than passing over it`,
          out.skipped.some((s) => s.key === key),
          out.skipped.map((s) => `${s.key}:${s.reason}`).join(', ') || '(nothing reported)',
        );
      }

      await page.close();
    }

    /*
     * And the other side of it: the things that are not application forms but
     * collect the same fields. Every one of these turns up in a frame on a job
     * posting, and the cost of reading one is the user's details typed into
     * somebody else's form.
     */
    console.log('\nNot an application form');
    for (const [what, body] of Object.entries(NOT_APPLICATIONS)) {
      const page = await browser.newPage();
      await page.goto(`${base}/not/${encodeURIComponent(what)}`, { waitUntil: 'load' });
      const verdict = await page.evaluate(
        async (b) => (await import(`${b}/autofill.js`)).looksLikeApplicationForm(),
        base,
      );
      check(`${what} is left alone`, verdict === false);
      await page.close();
    }
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
