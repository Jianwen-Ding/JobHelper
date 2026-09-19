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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
/*
 * Exported so the same thirteen shapes can be walked end to end with the
 * extension loaded, in `ats-journey.mjs`. This file drives `fillForm`
 * directly, which answers "does autofill understand this markup"; it does not
 * answer "does the whole thing work on a Greenhouse form", and those are
 * different questions.
 */
export const SYSTEMS = [
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
    /*
     * A react-select combobox, which is what half these systems have moved to.
     * Unlike Workday's button, this one *is* an input — so it can be typed
     * into, and typing into it does nothing at all: the value the form submits
     * lives in a hidden field that only the widget's own code sets. A form that
     * looks filled and is empty is worse than one that is plainly blank.
     */
    name: 'A combobox that is a text input',
    html: `
      <label for="cb-fn">First Name</label><input id="cb-fn" name="first_name" type="text">
      <label for="cb-em">Email</label><input id="cb-em" name="email" type="email">

      <label for="cb-country" id="cb-country-label">Country</label>
      <div class="select__control">
        <input id="cb-country" role="combobox" aria-autocomplete="list" aria-expanded="false"
               aria-labelledby="cb-country-label" autocomplete="off">
        <div class="select__placeholder">Select…</div>
      </div>
      <input type="hidden" name="country" id="cb-country-value">

      <label for="cb-school" id="cb-school-label">School</label>
      <div class="select__control">
        <input id="cb-school" role="combobox" aria-autocomplete="list"
               aria-labelledby="cb-school-label" autocomplete="off">
      </div>
      <input type="hidden" name="school" id="cb-school-value">`,
    want: {
      '#cb-fn': 'Jianwen',
      '#cb-em': 'ding.jianw@northeastern.edu',
      // Typing here submits nothing, so nothing is typed here.
      '#cb-country': '',
      '#cb-school': '',
    },
    reportsUnfillable: ['address_country', 'school'],
    questions: [],
    wantsLetter: false,
  },

  {
    /*
     * A form built out of web components, so every field is inside a shadow
     * root. `document.querySelectorAll` does not cross that boundary, so the
     * page looks to have no form on it whatsoever — nothing filled, nothing
     * asked, and in a frame, nothing even recognised as an application.
     */
    name: 'A form inside a shadow root',
    /*
     * The markup is encoded so that none of it is readable as the script's own
     * text. Written out in full it sits in `document.body.textContent`, and the
     * form is then recognised by the words in the source rather than by
     * anything reaching into the component — which is a passing test measuring
     * nothing.
     */
    html: `
      <div id="host"></div>
      <script>
        document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML =
          decodeURIComponent(escape(atob(${JSON.stringify(
            Buffer.from(
              '<label for="sd-fn">First Name</label><input id="sd-fn" name="first_name">' +
                '<label for="sd-ln">Last Name</label><input id="sd-ln" name="last_name">' +
                '<label for="sd-em">Email</label><input id="sd-em" name="email" type="email">' +
                '<label for="sd-ph">Phone</label><input id="sd-ph" name="phone">' +
                '<label for="sd-cl">Cover Letter</label><textarea id="sd-cl" name="cover_letter"></textarea>' +
                '<label for="sd-q1">Why do you want to work here?</label><textarea id="sd-q1"></textarea>' +
                '<button type="button">Submit Application</button>',
              'utf8',
            ).toString('base64'),
          )})));
      </script>`,
    shadowHost: '#host',
    want: {
      '#sd-fn': 'Jianwen',
      '#sd-ln': 'Ding',
      '#sd-em': 'ding.jianw@northeastern.edu',
      '#sd-ph': '555-0100',
    },
    questions: [/why do you want to work here/i],
    wantsLetter: true,
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

  /*
   * The four the classifier recognises by name and nothing had a form from.
   *
   * `ATS` in extract.ts lists nineteen hosts; thirteen of them had their
   * markup here. Claiming to handle a system and never having seen one of its
   * forms is the gap most likely to turn into "it noticed the page and then
   * did nothing", which is worse than not noticing.
   */
  {
    name: 'Rippling',
    // Rippling wraps each field in a div and labels by proximity, not `for`.
    html: `
      <div class="field"><div class="label">First name</div><input name="firstName" type="text"></div>
      <div class="field"><div class="label">Last name</div><input name="lastName" type="text"></div>
      <div class="field"><div class="label">Email</div><input name="email" type="email"></div>
      <div class="field"><div class="label">Phone</div><input name="phone" type="tel"></div>
      <div class="field"><div class="label">LinkedIn</div><input name="linkedinUrl" type="text"></div>
      <div class="field"><div class="label">Why are you a good fit?</div><textarea name="q_fit"></textarea></div>`,
    want: {
      'input[name="firstName"]': 'Jianwen',
      'input[name="lastName"]': 'Ding',
      'input[name="email"]': 'ding.jianw@northeastern.edu',
      'input[name="phone"]': '555-0100',
      'input[name="linkedinUrl"]': 'linkedin.com/in/jianwen',
    },
    questions: [/why are you a good fit/i],
    wantsLetter: false,
  },

  {
    name: 'Breezy',
    html: `
      <label for="bz-name">Full Name</label><input id="bz-name" name="name" type="text">
      <label for="bz-em">Email Address</label><input id="bz-em" name="email_address" type="email">
      <label for="bz-ph">Phone Number</label><input id="bz-ph" name="phone_number" type="tel">
      <label for="bz-cl">Cover Letter</label><textarea id="bz-cl" name="cover_letter"></textarea>
      <label for="bz-rs">Resume</label><input id="bz-rs" name="resume" type="file">`,
    want: {
      '#bz-name': 'Jianwen Ding',
      '#bz-em': 'ding.jianw@northeastern.edu',
      '#bz-ph': '555-0100',
    },
    questions: [],
    wantsLetter: true,
  },

  {
    name: 'Recruitee',
    // Recruitee uses aria-label where there is no visible label at all.
    html: `
      <input name="candidate[name]" type="text" aria-label="Your name">
      <input name="candidate[email]" type="email" aria-label="Your email">
      <input name="candidate[phone]" type="tel" aria-label="Your phone number">
      <div class="c-form__question">
        <span class="c-form__label">What draws you to this team?</span>
        <textarea name="open_question_1"></textarea>
      </div>`,
    want: {
      'input[name="candidate[name]"]': 'Jianwen Ding',
      'input[name="candidate[email]"]': 'ding.jianw@northeastern.edu',
      'input[name="candidate[phone]"]': '555-0100',
    },
    questions: [/what draws you to this team/i],
    wantsLetter: false,
  },

  {
    /*
     * The question Greenhouse forms ask more often than either half of it on
     * its own, and it is two declarations joined: authorized, *and* not needing
     * sponsorship. It was answered from `work_authorization` alone, so an
     * applicant who is authorized and does need sponsorship — anyone here on a
     * student visa — had their application state the opposite, and the card
     * counted it as a field filled. Handed back instead, and reported.
     */
    name: 'Authorization and sponsorship asked as one question',
    html: `
      <label for="one-fn">First Name <span class="asterisk">*</span></label>
      <input type="text" id="one-fn" name="job_application[first_name]">
      <label for="one-ln">Last Name <span class="asterisk">*</span></label>
      <input type="text" id="one-ln" name="job_application[last_name]">
      <label for="one-em">Email <span class="asterisk">*</span></label>
      <input type="text" id="one-em" name="job_application[email]">
      <label for="one-auth">
        Are you legally authorized to work in the United States without sponsorship,
        now or in the future? <span class="asterisk">*</span>
      </label>
      <select id="one-auth" name="job_application[answers_attributes][0][boolean_value]">
        <option value="">--</option><option value="1">Yes</option><option value="0">No</option>
      </select>`,
    want: {
      '#one-fn': 'Jianwen',
      '#one-ln': 'Ding',
      '#one-em': 'ding.jianw@northeastern.edu',
      // Neither "Yes" nor "No" is a thing this profile says.
      '#one-auth': '',
    },
    reportsUnfillable: ['work_authorization'],
    questions: [],
    wantsLetter: false,
  },

  {
    /*
     * References and an emergency contact, which Taleo and BrassRing ask for on
     * the same page as the applicant's own details — in fields with the same
     * words in them. Every one of these was filled with the applicant: a
     * referee whose email address and telephone number are the candidate's, an
     * emergency contact who is the person having the emergency.
     */
    name: 'A form that asks for references',
    html: `
      <table><tbody>
        <tr><td><label for="rr-fn">First Name</label></td><td><input id="rr-fn" name="TEXT1" type="text"></td></tr>
        <tr><td><label for="rr-ln">Last Name</label></td><td><input id="rr-ln" name="TEXT2" type="text"></td></tr>
        <tr><td><label for="rr-em">E-mail Address</label></td><td><input id="rr-em" name="TEXT3" type="text"></td></tr>
        <tr><td><label for="rr-ph">Home Phone</label></td><td><input id="rr-ph" name="TEXT4" type="text"></td></tr>
        <tr><td colspan="2"><b>Professional references</b></td></tr>
        <tr><td><label for="rr-rn">Reference 1 Full Name</label></td><td><input id="rr-rn" name="TEXT5" type="text"></td></tr>
        <tr><td><label for="rr-re">Reference 1 E-mail</label></td><td><input id="rr-re" name="TEXT6" type="text"></td></tr>
        <tr><td><label for="rr-rp">Reference 1 Home Phone</label></td><td><input id="rr-rp" name="TEXT7" type="text"></td></tr>
        <tr><td colspan="2"><b>In case of emergency</b></td></tr>
        <tr><td><label for="rr-en">Emergency Contact Name</label></td><td><input id="rr-en" name="TEXT8" type="text"></td></tr>
        <tr><td><label for="rr-ep">Emergency Contact Number</label></td><td><input id="rr-ep" name="TEXT9" type="text"></td></tr>
      </tbody></table>`,
    want: {
      '#rr-fn': 'Jianwen',
      '#rr-ln': 'Ding',
      '#rr-em': 'ding.jianw@northeastern.edu',
      '#rr-ph': '555-0100',
      '#rr-rn': '',
      '#rr-re': '',
      '#rr-rp': '',
      '#rr-en': '',
      '#rr-ep': '',
    },
    questions: [],
    wantsLetter: false,
  },

  {
    /*
     * The block at the foot of a Greenhouse form, which is on nearly every one
     * of them. Three of these fields read like fields autofill knows: the
     * signature line under "Voluntary Self-Identification of Disability" is a
     * box labelled "Your Name", which `full_name` matches, and "Country of
     * Birth" is a country dropdown like any other.
     *
     * Filling them is not a convenience. Typing the applicant's legal name
     * onto the signature line completes, in their name, a federal form whose
     * whole premise is that completing it is voluntary; and answering "Country
     * of Birth" from where they live now is false for anyone who has moved,
     * on the part of the form an employer hands to an immigration lawyer.
     */
    name: 'Voluntary self-identification',
    html: `
      <label for="vsi-fn">First Name <span class="asterisk">*</span></label>
      <input type="text" id="vsi-fn" name="job_application[first_name]">
      <label for="vsi-ph">Phone <span class="asterisk">*</span></label>
      <input type="text" id="vsi-ph" name="job_application[phone]">
      <label for="vsi-ctry">Country <span class="asterisk">*</span></label>
      <select id="vsi-ctry" name="job_application[country]">
        <option value="">Please select</option><option>United States</option><option>India</option>
      </select>

      <h3>U.S. Equal Opportunity Employment Information (Completion is voluntary)</h3>
      <label for="vsi-gender">Gender</label>
      <select id="vsi-gender" name="job_application[gender]">
        <option value="">Please select</option><option>Male</option><option>Female</option>
        <option>Decline To Self Identify</option>
      </select>
      <label for="vsi-birth">Country of Birth</label>
      <select id="vsi-birth" name="job_application[country_of_birth]">
        <option value="">Please select</option><option>United States</option><option>India</option>
      </select>

      <h3>Voluntary Self-Identification of Disability</h3>
      <label for="vsi-sig">Your Name</label>
      <input type="text" id="vsi-sig" name="job_application[disability_signature]">
      <label for="vsi-date">Today's Date</label>
      <input type="text" id="vsi-date" name="job_application[disability_date]">`,
    want: {
      // The application's own fields, filled as usual — including a country
      // dropdown two lines above one that must not be.
      '#vsi-fn': 'Jianwen',
      '#vsi-ph': '555-0100',
      '#vsi-ctry': 'United States',
      '#vsi-gender': '',
      '#vsi-birth': '',
      '#vsi-sig': '',
      '#vsi-date': '',
    },
    questions: [],
    wantsLetter: false,
  },

  {
    name: 'BrassRing',
    // Old-school: a table, and labels in the cell to the left.
    html: `
      <table>
        <tr><td><label for="br1">First Name</label></td><td><input id="br1" name="TEXT1" type="text"></td></tr>
        <tr><td><label for="br2">Last Name</label></td><td><input id="br2" name="TEXT2" type="text"></td></tr>
        <tr><td><label for="br3">E-mail Address</label></td><td><input id="br3" name="TEXT3" type="text"></td></tr>
        <tr><td><label for="br4">Home Phone</label></td><td><input id="br4" name="TEXT4" type="text"></td></tr>
      </table>`,
    want: {
      '#br1': 'Jianwen',
      '#br2': 'Ding',
      '#br3': 'ding.jianw@northeastern.edu',
      '#br4': '555-0100',
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
  /*
   * The two that got through, and what they cost.
   *
   * With the content script in every frame, these sit on a real posting beside
   * the real form. Both were filled: the user's name and city were typed into
   * a third party's inputs, and because setValue dispatches a bubbling `input`
   * event, the frame's own page script read them straight off it.
   *
   * The enquiry box passed by having four parts of a person, which was a route
   * needing no application-specific evidence at all. The advert passed on the
   * phrase "apply for this", which is a call to action any creative prints.
   */
  'a third party enquiry box': `
    <h3>Book a class</h3>
    <label for="a">Name</label><input id="a" name="name">
    <label for="b">Email</label><input id="b" name="email" type="email">
    <label for="c">Phone</label><input id="c" name="phone" type="tel">
    <label for="d">Town</label><input id="d" name="town">
    <button type="button">Send</button>`,
  'a sponsored job advert': `
    <p>Sponsored: Senior SRE at Hyperion. Apply for this role in 60 seconds.</p>
    <label for="a">Get job alerts by email</label><input id="a" name="email" type="email">
    <label for="b">Your name</label><input id="b" name="name">
    <button type="button">Subscribe</button>`,
  'a blog comment box': `
    <label for="a">Name</label><input id="a" name="name">
    <label for="b">Email</label><input id="b" name="email" type="email">
    <label for="c">Website</label><input id="c" name="url">
    <label for="d">Comment</label><textarea id="d"></textarea>
    <button type="button">Post</button>`,
};

const shell = (body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body><form>${body}</form></body></html>`;

/*
 * A form whose fields accept the value now and the browser refuses at the end.
 *
 * The check after a fill was that the value stuck, which catches the field
 * that throws it away. It missed the other half: `pattern` and `type` are
 * enforced when Submit is pressed, not when a value is assigned, so the field
 * holds the text happily, the card says "Filled 4 fields", and the form will
 * not go. Measured on this markup before the fix:
 *
 *   filled      : phone=(555) 555-5555, website=github.com/Jianwen-Ding
 *   skipped     : []
 *   phone field : valid false, "Please match the requested format."
 *   url field   : valid false, "Please enter a URL."
 *   form would submit: false
 *
 * Both constraints are ones the enterprise systems really impose — Workday,
 * Taleo and iCIMS all ship a digits-only phone pattern — and both answers are
 * the same answer written another way, which is the point: reformatting a
 * phone or adding a scheme to a link changes nothing about what was said.
 */
/* `shell` supplies the <form>; a nested one is dropped by the parser. */
const CONSTRAINED = `
  <label for="fn">First name</label>
  <input id="fn" name="first_name">
  <label for="tel">Phone</label>
  <input id="tel" type="tel" name="phone" pattern="\\d{10}" required>
  <label for="em">Email</label>
  <input id="em" type="email" name="email" required>
  <label for="site">Portfolio</label>
  <input id="site" type="url" name="website">
  <label for="li">LinkedIn</label>
  <input id="li" type="url" name="linkedin">
  <button type="submit">Submit Application</button>`;

async function main() {
  const source = fs.readFileSync(path.join(root, 'src/content/autofill.js'), 'utf8');
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/autofill.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(source);
      return;
    }
    if (url === '/constrained') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(shell(CONSTRAINED));
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
        async ({ b, profile, wants, host }) => {
          const m = await import(`${b}/autofill.js`);
          const report = m.fillForm(profile);
          // A form built from web components keeps its fields in a shadow
          // root, which is the whole point of that fixture.
          const find = (sel) =>
            host ? document.querySelector(host)?.shadowRoot?.querySelector(sel) : document.querySelector(sel);
          return {
            values: Object.fromEntries(
              Object.keys(wants).map((sel) => [sel, find(sel)?.value ?? '(no such field)']),
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
        { b: base, profile: PROFILE, wants: system.want, host: system.shadowHost ?? null },
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
    /*
     * The fields that take a value now and refuse it at Submit. See
     * `CONSTRAINED`. The assertion that matters is the last one: not whether
     * each box holds text, but whether the form would actually go.
     */
    console.log('\nA form whose fields have something to say about the format');
    {
      const page = await browser.newPage();
      await page.goto(`${base}/constrained`, { waitUntil: 'load' });
      const out = await page.evaluate(
        async ({ b, profile }) => {
          const { fillForm } = await import(`${b}/autofill.js`);
          const report = fillForm(profile);
          const look = (id) => {
            const el = document.getElementById(id);
            return { value: el.value, valid: el.checkValidity(), says: el.validationMessage };
          };
          /*
           * Every field the report claims, judged by the browser. Asserting
           * that nothing was skipped does not say this: in the broken build
           * nothing is skipped either, and two of the fields are invalid.
           */
          const claimed = [...document.querySelectorAll('input')]
            .filter((el) => report.filled.some((f) => f.value === el.value) && el.value)
            .map((el) => ({ id: el.id, valid: el.checkValidity(), says: el.validationMessage }));

          return {
            filled: report.filled.map((f) => `${f.key}=${f.value}`),
            skipped: report.skipped.map((s) => `${s.key}: ${s.reason}`),
            rejected: claimed.filter((c) => !c.valid).map((c) => `${c.id}: ${c.says}`),
            tel: look('tel'),
            site: look('site'),
            li: look('li'),
            em: look('em'),
            submits: document.querySelector('form').checkValidity(),
          };
        },
        {
          b: base,
          profile: {
            first_name: 'Jianwen',
            phone: '(555) 555-5555',
            email: 'ding.jianw@northeastern.edu',
            website: 'github.com/Jianwen-Ding',
            linkedin: 'linkedin.com/in/jianwen',
          },
        },
      );

      check('the phone is written in the shape the pattern demands', out.tel.value === '5555555555', out.tel.value);
      check('and the browser is content with it', out.tel.valid, out.tel.says);
      check(
        'a bare link is given the scheme a url field insists on',
        out.site.value === 'https://github.com/Jianwen-Ding',
        out.site.value,
      );
      check('for every link field, not just one', out.li.valid && out.li.value.startsWith('https://'), out.li.value);
      check('an address that was already fine is left alone', out.em.value === 'ding.jianw@northeastern.edu', out.em.value);
      check(
        'nothing was reported as filled that the browser will reject',
        out.rejected.length === 0,
        out.rejected.join(' | '),
      );
      check('and nothing had to be given up on', out.skipped.length === 0, out.skipped.join(' | '));
      check('and so the form would actually submit', out.submits === true);
      await page.close();
    }

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

/*
 * Only when run, not when imported.
 *
 * `ats-journey.mjs` imports `SYSTEMS` from here, and importing a module runs
 * it — so the whole of this suite executed as a side effect of that import,
 * printing its results in the middle of the other harness's output and doing
 * every check twice.
 */
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
