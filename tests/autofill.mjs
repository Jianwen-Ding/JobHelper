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

  <!-- The cover letter box: long-form and labelled, but the card has a whole
       step for it, so it must not also be offered as a question. -->
  <label for="cl">Cover Letter</label><textarea id="cl" name="cover_letter"></textarea>

  <!-- Questions: one short but plainly a question, one that is just a label. -->
  <label for="q1">Why us?</label><textarea id="q1"></textarea>
  <label for="q2">Describe a technical project you are proud of. *</label><textarea id="q2" required></textarea>
  <label for="q3">Notes</label><textarea id="q3"></textarea>
</form></body></html>`;

/*
 * Fields that carry one of autofill's patterns and belong to somebody else,
 * plus the question that is two questions.
 *
 * Every one of these was filled, from a profile, with the applicant's own
 * details: the referee's email address and telephone number were the
 * applicant's, so were the emergency contact's, and "Where did you hear about
 * this job?" was answered with their LinkedIn profile. The card counted all of
 * them as fields successfully filled. A blank field is a form to finish; a
 * field filled with the wrong answer is a false statement submitted in
 * somebody's name.
 */
const NOT_YOURS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Test</title></head><body>
<form>
  <label for="own-email">Email</label><input id="own-email" name="email" type="email">
  <label for="own-phone">Phone</label><input id="own-phone" name="phone" type="tel">

  <h3>References</h3>
  <label for="r-name">Reference 1 full name</label><input id="r-name" name="ref1_name">
  <label for="r-email">Reference 1 email</label><input id="r-email" name="ref1_email" type="email">
  <label for="r-phone">Reference 1 phone</label><input id="r-phone" name="ref1_phone" type="tel">
  <label for="mgr-email">Your current manager's email address</label><input id="mgr-email" name="mgr" type="email">

  <h3>Emergency contact</h3>
  <label for="ec-name">Emergency contact name</label><input id="ec-name" name="ec_name">
  <label for="ec-phone">Emergency contact number</label><input id="ec-phone" name="ec_phone" type="tel">

  <!--
    The same three questions again, with the context only in the legend.

    Every other block here repeats the disambiguating word onto each field —
    "Emergency contact number", "Reference 1 email" — which is what the
    exclusions read. Plenty of forms do not: the fieldset says whose details
    these are once, and each box under it is labelled "Name", "Phone",
    "Email" like any other.
  -->
  <fieldset>
    <legend>Emergency Contact</legend>
    <label for="fs-name">Name</label><input id="fs-name" name="q_88213">
    <label for="fs-phone">Phone</label><input id="fs-phone" name="q_88214" type="tel">
    <label for="fs-email">Email</label><input id="fs-email" name="q_88215" type="email">
  </fieldset>

  <!-- And the shape without a fieldset: a heading, then a group. -->
  <div role="group" aria-label="Reference 2">
    <label for="g-name">Full name</label><input id="g-name" name="q_90001">
    <label for="g-email">Email address</label><input id="g-email" name="q_90002" type="email">
  </div>

  <!-- A previous employer's address, from the employment-history section. -->
  <h3>Employment history</h3>
  <label for="emp-city">Employer City</label><input id="emp-city" name="emp_city">
  <!-- What Workday, Greenhouse and iCIMS all call the same field. -->
  <label for="emp-loc">Employer Location</label><input id="emp-loc" name="emp_loc">
  <label for="emp-mail">Company Email</label><input id="emp-mail" name="emp_mail" type="email">

  <label for="source">Where did you hear about this job? (LinkedIn, Indeed, referral)</label>
  <input id="source" name="source">

  <!-- Citizenship is not residence, and they take the same answers. -->
  <label for="citizenship">Country of citizenship</label>
  <select id="citizenship" name="citizenship">
    <option value="">--</option><option>United States</option><option>India</option>
  </select>
  <label for="residence">Country of residence</label>
  <select id="residence" name="residence">
    <option value="">--</option><option>United States</option><option>India</option>
  </select>

  <!-- Nor is where you were born, which anyone who has moved country answers
       differently again — and on the half of the form that goes to a lawyer. -->
  <label for="b-country">Country of Birth</label>
  <select id="b-country" name="birth_country">
    <option value="">--</option><option>United States</option><option>India</option>
  </select>
  <label for="b-city">City of Birth</label><input id="b-city" name="birth_city">

  <!-- The box beside a telephone number that wants "+1", not a number. -->
  <label for="cc">Phone Country Code</label><input id="cc" name="phone_country_code">

  <!-- "State" is a verb in this one, and address_state reads it as a noun. -->
  <label for="st">State</label><input id="st" name="state">
  <label for="sal">Please state your expected salary</label><input id="sal" name="expected_salary">

  <!-- Where you would like to work, asked both ways round, and where you
       would move to — none of which is where you live now. -->
  <label for="pref1">Preferred Work Location</label><input id="pref1" name="pref_loc">
  <label for="pref2">Location Preference</label><input id="pref2" name="loc_pref">
  <label for="reloc">Which city would you relocate to?</label><input id="reloc" name="reloc_city">
  <fieldset>
    <legend>Preferred work location</legend>
    <label><input type="radio" name="office" value="Boston, MA"> Boston, MA</label>
    <label><input type="radio" name="office" value="Remote"> Remote</label>
  </fieldset>

  <!-- The signature line on the voluntary forms, which is a "Your Name" box
       like any other and is a signature on a form nobody asked them for. -->
  <fieldset>
    <legend>Voluntary Self-Identification of Disability</legend>
    <label for="dis-sig">Your Name</label><input id="dis-sig" name="disability_signature_name">
  </fieldset>
  <fieldset>
    <legend>Voluntary Self-Identification</legend>
    <label for="eeo-sig">Your Name</label><input id="eeo-sig" name="eeo_self_identification_name">
  </fieldset>

  <!-- One half of that question on its own, which is answerable and must
       still be answered: the commonest phrasing there is. -->
  <label for="auth-any">Are you authorized to work in the US for any employer?</label>
  <select id="auth-any" name="auth_any"><option value="">--</option><option>Yes</option><option>No</option></select>

  <!-- Two declarations in one question, asked as a dropdown and as radios. -->
  <label for="both">Are you legally authorized to work in the United States without sponsorship?</label>
  <select id="both" name="auth_nosponsor"><option value="">--</option><option>Yes</option><option>No</option></select>
  <fieldset>
    <legend>Are you legally authorized to work in the US without requiring visa sponsorship?</legend>
    <label><input type="radio" name="auth2" value="Yes"> Yes</label>
    <label><input type="radio" name="auth2" value="No"> No</label>
  </fieldset>
</form></body></html>`;

/*
 * The same form as a framework would hold it.
 *
 * React installs its own `value`/`checked` setter on every control it renders
 * and drops any change event whose value matches what that setter last saw —
 * which is how it tells a keystroke from a no-op. The shim below is that
 * mechanism, reduced to the part that matters: `sawChange` is exactly the
 * question React asks before it will run an onChange handler.
 */
const REACT_FORM = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Test</title></head><body>
<form>
  <label for="rf-fn">First Name</label><input id="rf-fn" name="first_name">
  <label for="rf-country">Country</label>
  <select id="rf-country" name="country"><option value="">--</option><option value="US">United States</option></select>
  <fieldset>
    <legend>Are you legally authorized to work in the United States?</legend>
    <label><input type="radio" name="rf_auth" value="Yes"> Yes</label>
    <label><input type="radio" name="rf_auth" value="No"> No</label>
  </fieldset>
</form></body></html>`;

/* Option text padded the way the enterprise systems pad it, and Lever's
 * questions, which exist only as a placeholder. */
const AWKWARD = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Test</title></head><body>
<form>
  <label for="aw-country">Country</label>
  <select id="aw-country" name="country">
    <option value="">Select One</option>
    <option value="US">United&nbsp;States</option>
    <option value="CA">Canada</option>
  </select>
  <input type="text" name="name" placeholder="Full name">
  <textarea name="q1" placeholder="Why do you want to work at Lever?"></textarea>
</form></body></html>`;

/*
 * A consent question, and a declaration answered from a sentence.
 *
 * Both measured against the real filler. The first is a marketing group that
 * happens to say "sponsorship", which was answered from the applicant's visa
 * status — the shape reaches any pattern, because a consent question is free
 * to mention whatever it is consenting about. The second is the opposite
 * failure: "Are you legally authorized to work in the US?" beside Yes and No,
 * against a profile that holds a sentence, matched no option and was left
 * blank. That is the question most likely to get an application rejected
 * without a person reading it.
 */
const CONSENT = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <fieldset>
    <legend>Marketing: may we email you about sponsorship webinars?</legend>
    <label><input type="radio" name="mkt" value="yes"> Yes</label>
    <label><input type="radio" name="mkt" value="no"> No</label>
  </fieldset>

  <fieldset>
    <legend>Would you like to subscribe to our newsletter about visa status changes?</legend>
    <label><input type="radio" name="news" value="yes"> Yes</label>
    <label><input type="radio" name="news" value="no"> No</label>
  </fieldset>

  <fieldset>
    <legend>Are you legally authorized to work in the US?</legend>
    <label><input type="radio" name="auth" value="y"> Yes</label>
    <label><input type="radio" name="auth" value="n"> No</label>
  </fieldset>

  <fieldset>
    <legend>Will you now or in the future require sponsorship?</legend>
    <label><input type="radio" name="spon" value="y"> Yes</label>
    <label><input type="radio" name="spon" value="n"> No</label>
  </fieldset>

  <!-- Three answers, not two. Guessing between three is not this file's job. -->
  <label for="spon3">Will you now or in the future require sponsorship?</label>
  <select id="spon3" name="spon3">
    <option value="">Choose</option><option>Yes</option><option>No</option><option>Prefer not to say</option>
  </select>

  <!-- The applicant's own email, so none of this can pass by the filler
       having simply stopped touching the page. -->
  <label for="own">Email</label><input id="own" name="email">
</form></body></html>`;

/*
 * How a field says what it is, on the systems that do not use a plain label.
 *
 * Every one of these is how a real applicant tracking system marks its
 * fields, and a branch map of autofill.js against this suite found that none
 * of them was reached by any fixture: `aria-labelledby`, `aria-label`, and a
 * radio with a separate `label[for]` rather than a wrapping one. Untested
 * paths that real forms take are where the next bug is.
 *
 * Writing them down found one. The chain answered with the *empty string* for
 * a label that exists and is empty — an ordinary thing in generated markup: a
 * styling hook, an icon slot, a label whose text has not arrived. An empty
 * answer still counted as an answer, so it ended the search and everything
 * below it was unreachable on exactly the forms that use it.
 */
const LABELS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <!-- Workday: the question is in one node, the hint in another. -->
  <span id="q1">Email</span><span id="h1">Address</span>
  <input id="wd" name="f_0192" aria-labelledby="q1 h1">

  <!-- Named ids that are not there. Ought to fall through, not stop. -->
  <input id="gone" name="f_0193" aria-labelledby="no-such-node" aria-label="First Name">

  <!-- Pointing at itself, which happens. The plain label wins anyway, which
       is the behaviour worth pinning; the guard against self-reference in
       fromLabelledBy is defensive and this does not exercise it. -->
  <label for="selfref">Last Name</label>
  <input id="selfref" name="f_0194" aria-labelledby="selfref">

  <!-- The empty label. Without the fix it ends the search and the aria-label
       below it is never read. -->
  <label for="styled"></label>
  <input id="styled" name="f_0195" aria-label="GitHub">

  <!-- And a wrapping label holding only the field, which cleans to nothing. -->
  <label><input id="wrapped" name="f_0196" aria-label="Phone"></label>

  <!-- A radio group labelled the way SuccessFactors does it. -->
  <div id="auth-q">Are you legally authorized to work in the US?</div>
  <input type="radio" id="auth_y" name="auth" value="1" aria-labelledby="auth-q">
  <label for="auth_y">Yes</label>
  <input type="radio" id="auth_n" name="auth" value="0" aria-labelledby="auth-q">
  <label for="auth_n">No</label>
</form></body></html>`;


/*
 * Three shapes that filled nothing and said nothing, which is the worst
 * outcome this file has: a required box left blank on a form the card has
 * just reported as filled.
 */
const LEGACY = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <!-- The commonest wording of the right-to-work question on the hosted
       boards, which puts citizenship and sponsorship in one sentence. -->
  <fieldset>
    <legend>Are you a U.S. citizen or otherwise authorized to work in the United States for any employer without sponsorship?</legend>
    <label><input type="radio" name="citwork" value="Y"> Yes</label>
    <label><input type="radio" name="citwork" value="N"> No</label>
  </fieldset>

  <!-- The question the citizenship rule exists for, which must stay excluded. -->
  <label for="cob">Country of citizenship</label><input id="cob" name="citizenship">

  <!-- A telephone box that asks for the code inside its own label. -->
  <label for="ph1">Phone Number (include country code)</label><input id="ph1" name="phone" type="tel">

  <!-- And the box the dialling-code rule exists for, beside a real one. -->
  <label for="cc">Phone Country Code</label><input id="cc" name="phone_country_code">
  <label for="ph2">Mobile</label><input id="ph2" name="mobile" type="tel">
</form>

<!-- Taleo Classic: the question in a row header, the buttons in the cell. -->
<form><table><tbody>
  <tr>
    <th scope="row">Are you legally authorized to work in the United States?</th>
    <td>
      <label><input type="radio" name="q_998877" value="Y"> Yes</label>
      <label><input type="radio" name="q_998877" value="N"> No</label>
    </td>
  </tr>
</tbody></table></form>
</body></html>`;

/*
 * Hidden fields, where every framework actually puts them.
 *
 * A CSRF token, a Workday state blob, a phone country code: every real form
 * carries several, and they land wherever the framework likes — very often
 * immediately before the box a person types into. The fields here are named
 * the way the enterprise systems name them, so their label is the only signal
 * there is; the control below is the same markup with the hidden inputs taken
 * out, which is what says the hidden input is the cause.
 */
const HIDDEN = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <div>First Name</div>
  <input type="hidden" name="csrf" value="abc123">
  <input id="hfn" name="q_00281">

  <div>Email</div>
  <span><input type="hidden" name="state" value="x"></span>
  <input id="hem" name="q_00282">

  <div class="field">
    <label for="hph">Phone *</label>
    <input type="hidden" name="ph_country" value="1">
    <input id="hph" name="q_00283">
  </div>

  <!--
    A question whose only mark of being required is a star in a label that is
    not associated with it: no "for" attribute, and not wrapping it. Which is
    the shape that reaches the group walk at all — an associated label
    short-circuits it.
  -->
  <div class="field">
    <label>Why do you want to work here? *</label>
    <input type="hidden" name="q_meta" value="{}">
    <textarea id="hq" name="q_00284"></textarea>
  </div>
</form>
</body></html>`;
/** The same form with nothing hidden in it — the control. */
const UNHIDDEN = HIDDEN.replace(/<input type="hidden"[^>]*>/g, '').replace(/id="h/g, 'id="u');

/*
 * Forms that took the value and submitted nothing.
 *
 * Every shape here reported a field as filled while `FormData` — the thing the
 * employer actually receives — came back without it. That is the worst of the
 * failures this file hunts, because the card says the work is done: a form
 * left plainly blank at least gets looked at.
 *
 *  - a section inside `<fieldset disabled>`, which is how a form greys out the
 *    part you have not unlocked. `input.disabled` is false on every control in
 *    it, and the browser refuses all of them.
 *  - an option under a disabled `<optgroup>`: a country list with the places
 *    the company hires in one group and the rest greyed out below.
 *  - two options carrying the same value, the first of them the placeholder.
 *
 * Asserted through `new FormData(form)` rather than through `.value`, because
 * `.value` is exactly what was right in all three.
 */
const SUBMITS_NOTHING = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form id="locked">
  <fieldset disabled>
    <label for="lk-ph">Phone</label><input id="lk-ph" name="phone">
    <fieldset>
      <legend>Are you legally authorized to work in the United States?</legend>
      <label><input type="radio" name="lk_auth" value="Yes"> Yes</label>
      <label><input type="radio" name="lk_auth" value="No"> No</label>
    </fieldset>
  </fieldset>
</form>
<form id="greyed">
  <label for="gr-country">Country</label>
  <select id="gr-country" name="country" required>
    <option value="">Select a country…</option>
    <optgroup label="Where we are hiring"><option value="CA">Canada</option></optgroup>
    <optgroup label="Not currently hiring" disabled><option value="US">United States</option></optgroup>
  </select>
</form>
<form id="twinned">
  <label for="tw-country">Country</label>
  <select id="tw-country" name="country">
    <option value="">Select a country…</option>
    <option value="">United States</option>
    <option value="CA">Canada</option>
  </select>
</form>
</body></html>`;

/*
 * Several yes/no questions in one plain container, which is how a hand-rolled
 * careers form is written: question text, Yes, No, next question text, Yes,
 * No. No fieldset, no wrapper each.
 *
 * The group walk only counted fields that are *not* radios when deciding
 * whether a container was one question's own, so this looked like one — and
 * every group in it was labelled with the *first* question's words. Both were
 * answered from the sponsorship line, which is a false legal declaration
 * submitted over the applicant's own answer.
 */
const FLAT_QUESTIONS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form id="f"><div class="questions">
  <div class="label">Will you now or in the future require visa sponsorship? *</div>
  <label><input type="radio" name="q1" value="Yes"> Yes</label>
  <label><input type="radio" name="q1" value="No"> No</label>

  <div class="label">Are you legally authorized to work in the United States? *</div>
  <label><input type="radio" name="q2" value="Yes"> Yes</label>
  <label><input type="radio" name="q2" value="No"> No</label>
</div></form>
</body></html>`;

/*
 * The native radio hidden, and a styled span drawn in its place.
 *
 * This is how nearly every modern form does it — `display:none` on the input
 * and a `<span>` inside the `<label>` with the tick drawn on it. Asking the
 * input whether it occupies space therefore answered "no" about a control the
 * user is looking straight at, and the group was dropped before anything was
 * reported: `{filled: [], skipped: []}` on a visible work-authorisation
 * question, which reads exactly like a form with nothing to do.
 *
 * The second group is inside a collapsed step, which genuinely is not on
 * screen: neither the input nor its label has a box, and that one must still
 * be left alone.
 */
const STYLED_RADIOS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title>
<style>.opt input { display: none } .step.closed { display: none }</style></head><body>
<form id="f">
  <fieldset>
    <legend>Are you legally authorized to work in the United States?</legend>
    <label class="opt"><input type="radio" name="auth" value="Yes"><span class="dot"></span> Yes</label>
    <label class="opt"><input type="radio" name="auth" value="No"><span class="dot"></span> No</label>
  </fieldset>
  <div class="step closed">
    <fieldset>
      <legend>Will you now or in the future require visa sponsorship?</legend>
      <label class="opt"><input type="radio" name="spon" value="Yes"><span class="dot"></span> Yes</label>
      <label class="opt"><input type="radio" name="spon" value="No"><span class="dot"></span> No</label>
    </fieldset>
  </div>
</form>
</body></html>`;

/*
 * A phrase for an answer, against the two shapes the same question comes in.
 *
 * Both of these are legal declarations, and both were got wrong in a way that
 * looked like nothing: the radio pair was answered with the opposite of what
 * the profile said, and the dropdown was not answered at all.
 */
const PHRASE_ANSWERS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form id="f">
  <fieldset>
    <legend>Will you now or in the future require sponsorship?</legend>
    <label><input type="radio" name="spon" value="y"> Yes</label>
    <label><input type="radio" name="spon" value="n"> No</label>
  </fieldset>

  <!-- The same question Greenhouse asks as a dropdown, prompt and all. -->
  <label for="auth">Are you legally authorized to work in the United States?</label>
  <select id="auth" name="auth">
    <option value="">Select...</option><option>Yes</option><option>No</option>
  </select>

  <!-- A country select named for the ISO code it submits, which is
       idiomatic, beside a real dialling-code box that must stay excluded. -->
  <label for="ctry">Country</label>
  <select id="ctry" name="countryCode">
    <option value=""></option><option>United Kingdom</option><option>United States</option>
  </select>
  <label for="dial">Phone Country Code</label><input id="dial" name="phoneCountryCode">

  <!-- Three answers is still three answers, prompt or no prompt. -->
  <label for="three">Will you now or in the future require sponsorship?</label>
  <select id="three" name="three">
    <option value="">Choose</option><option>Yes</option><option>No</option><option>Prefer not to say</option>
  </select>
</form></body></html>`;

/**
 * The questions the profile cannot answer, which are the ones applying
 * actually repeats.
 *
 * Nothing in a ResumeM-M profile says whether somebody has worked here
 * before, how they heard about the job, or whether they will relocate. They
 * are asked on every application, in all three control shapes, and they are
 * what the answer bank exists to stop being typed twice.
 *
 * Two of these must stay untouched however the rest goes. `dob-month` is
 * personal and is refused even with a matching row in the bank; `team` is
 * ordinary and simply has no row, and a tool that guessed at it would be
 * putting somebody on a team they did not pick.
 */
const REMEMBERED = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form id="f">
  <label for="prev">Have you previously been employed by this company?</label>
  <select id="prev" name="prev_emp_q3">
    <option value="">Select...</option><option>Yes</option><option>No</option>
  </select>

  <fieldset>
    <legend>Are you willing to relocate for this role?</legend>
    <label><input type="radio" name="reloc" value="y"> Yes</label>
    <label><input type="radio" name="reloc" value="n"> No</label>
  </fieldset>

  <div role="radiogroup" aria-label="How did you hear about this position?">
    <div role="radio" id="h-li" aria-checked="false" tabindex="0">LinkedIn</div>
    <div role="radio" id="h-ref" aria-checked="false" tabindex="0">Employee referral</div>
  </div>

  <!-- Personal, and in the bank, and still not to be answered. -->
  <label for="dob-month">Month of birth</label>
  <select id="dob-month" name="dobm">
    <option value="">Select...</option><option>April</option><option>May</option>
  </select>

  <!-- Nothing in the bank looks like this, so it is left alone. -->
  <label for="team">Which team would you like to join?</label>
  <select id="team" name="team">
    <option value="">Select...</option><option>Platform</option><option>Growth</option>
  </select>

  <!-- Already answered by hand. The bank is a weaker claim than this. -->
  <label for="start">When could you start?</label>
  <select id="start" name="start">
    <option>Immediately</option><option>In two weeks</option>
  </select>
</form>
<script>
  // What a real component does, so the ARIA read-back has something to read.
  for (const el of document.querySelectorAll('[role="radio"]')) {
    el.addEventListener('click', () => {
      for (const sib of document.querySelectorAll('[role="radio"]')) sib.setAttribute('aria-checked', 'false');
      el.setAttribute('aria-checked', 'true');
    });
  }
  document.getElementById('start').value = 'In two weeks';
</script></body></html>`;

/*
 * When the degree ends, in every shape it is asked in.
 *
 * The store answers "December" and "2026" and "December 2026", and forms want
 * "Dec" from a list, "12" from another list, "2026-12" in a month picker and
 * "12/2026" in a box that says so. Each was a blank before. The last two
 * fields are the ones that must *not* be answered: a yes/no about being a
 * graduate is not a date question, and a label naming the university is still
 * about the date.
 */
const GRADUATION = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Graduation</title></head><body>
<form>
  <label for="gm">Expected graduation month</label>
  <select id="gm" name="grad_month"><option value="">Month</option>
    <option value="1">Jan</option><option value="2">Feb</option><option value="3">Mar</option><option value="4">Apr</option>
    <option value="5">May</option><option value="6">Jun</option><option value="7">Jul</option><option value="8">Aug</option>
    <option value="9">Sep</option><option value="10">Oct</option><option value="11">Nov</option><option value="12">Dec</option>
  </select>
  <label for="gm2">Graduation Month</label>
  <select id="gm2" name="grad_month_2"><option value="">--</option>
    <option>01</option><option>02</option><option>03</option><option>04</option><option>05</option><option>06</option>
    <option>07</option><option>08</option><option>09</option><option>10</option><option>11</option><option>12</option>
  </select>
  <label for="gy">Expected graduation year</label>
  <select id="gy" name="grad_year"><option value="">Year</option><option>2025</option><option>2026</option><option>2027</option></select>
  <label for="gmonth">Graduation date</label><input id="gmonth" type="month" name="grad_month_picker">
  <label for="gslash">Anticipated graduation</label><input id="gslash" name="grad_slash" placeholder="MM/YYYY">
  <label for="gwhen">When do you expect to graduate?</label><input id="gwhen" name="grad_when">
  <label for="guni">Graduation date from your university</label><input id="guni" name="grad_uni">
  <label for="gprog">Graduate program of interest</label><input id="gprog" name="grad_program">
  <label for="recent">Are you a recent graduate?</label>
  <select id="recent" name="recent"><option value="">--</option><option>Yes</option><option>No</option></select>
</form></body></html>`;

/*
 * The job somebody holds now, and the two questions that look like it. A
 * job-history section asks "Company" for every job in turn, and "Current
 * location" is an address — neither is this.
 */
const CURRENT = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Current</title></head><body>
<form>
  <label for="cc">Current company</label><input id="cc" name="current_company">
  <label for="ct">Current job title</label><input id="ct" name="current_title">
  <label for="mre">Most recent employer</label><input id="mre" name="most_recent_employer">
  <fieldset><legend>Work experience</legend>
    <label for="hco">Company</label><input id="hco" name="experience[0][company]">
    <label for="hti">Title</label><input id="hti" name="experience[0][title]">
  </fieldset>
  <label for="cl">Current location</label><input id="cl" name="current_location">
</form></body></html>`;

/*
 * Widgets that open a listbox, built to behave the way the real ones do.
 *
 * The react-select shape: a text box inside a control, a listbox rendered as
 * you type, an option chosen on mousedown, the choice written into a hidden
 * input and drawn in the control while the text box empties. The Workday
 * shape: a button that opens a listbox on click and draws its choice on
 * itself. Each one below proves one rule of `fillComboboxes`.
 */
const WIDGETS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Widgets</title></head><body>
<form>
  <label id="l-country">Country</label>
  <div class="select"><div class="select__control"><span class="single"></span>
    <input id="w-country" role="combobox" aria-autocomplete="list" aria-controls="lb-country" aria-labelledby="l-country" autocomplete="off">
  </div><input type="hidden" name="country" id="h-country"></div>

  <label id="l-school">School</label>
  <div class="wd"><button type="button" id="w-school" aria-haspopup="listbox" aria-controls="lb-school" aria-labelledby="l-school">Select One</button>
    <input type="hidden" name="school" id="h-school"></div>

  <label id="l-state">State</label>
  <div class="wd"><button type="button" id="w-state" aria-haspopup="listbox" aria-controls="lb-state" aria-labelledby="l-state">Select One</button>
    <input type="hidden" name="state" id="h-state"></div>

  <!-- No type: inside a form that makes it a submit button. -->
  <label id="l-auth">Work authorization</label>
  <div class="wd"><button id="w-auth" aria-haspopup="listbox" aria-labelledby="l-auth">Select One</button></div>

  <label id="l-degree">Degree</label>
  <div class="select"><div class="select__control"><span class="single"></span>
    <input id="w-degree" role="combobox" aria-autocomplete="list" aria-controls="lb-degree" aria-labelledby="l-degree" autocomplete="off">
  </div><input type="hidden" name="degree" id="h-degree"></div>

  <label id="l-major">Discipline</label>
  <div class="select"><div class="select__control"><span class="single"></span>
    <input id="w-major" role="combobox" aria-autocomplete="list" aria-controls="lb-major" aria-labelledby="l-major" autocomplete="off">
  </div><input type="hidden" name="major" id="h-major"></div>

  <label id="l-city">City</label>
  <div class="select"><div class="select__control"><span class="single"></span>
    <input id="w-city" role="combobox" aria-autocomplete="list" aria-controls="lb-city" aria-labelledby="l-city" autocomplete="off">
  </div><input type="hidden" name="city" id="h-city"></div>
</form>
<script>
  // Counted and stopped, so a press that would have submitted shows up here
  // instead of navigating the test away.
  window.submits = 0;
  document.querySelector('form').addEventListener('submit', (e) => { e.preventDefault(); window.submits += 1; });

  function reactSelect(name, options, { delay = 0, takes = true } = {}) {
    const input = document.getElementById('w-' + name);
    const hidden = document.getElementById('h-' + name);
    const holder = input.closest('.select');
    let list = null;
    const close = () => { list?.remove(); list = null; };
    input.addEventListener('input', () => {
      close();
      const typed = input.value.toLowerCase();
      if (!typed) return;
      setTimeout(() => {
        close();
        list = document.createElement('div');
        list.id = 'lb-' + name; list.setAttribute('role', 'listbox');
        for (const text of options.filter((o) => o.toLowerCase().includes(typed.slice(0, 4)))) {
          const o = document.createElement('div');
          o.setAttribute('role', 'option'); o.textContent = text;
          o.addEventListener('mousedown', (e) => {
            e.preventDefault();
            if (!takes) return;
            hidden.value = text;
            holder.querySelector('.single').textContent = text;
            input.value = '';
            close();
          });
          list.append(o);
        }
        holder.append(list);
      }, delay);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  reactSelect('country', ['United States Minor Outlying Islands', 'United States', 'United Kingdom']);
  // A near miss: another bachelor's degree, not this one and not a level.
  reactSelect('degree', ['Bachelor of Arts', 'Master of Science']);
  reactSelect('major', ['Computer Science', 'Computer Engineering'], { takes: false });
  reactSelect('city', ['Boston', 'Boston Heights'], { delay: 400 });

  // The Workday shape.
  const button = document.getElementById('w-school');
  button.addEventListener('click', () => {
    if (document.getElementById('lb-school')) return;
    const list = document.createElement('ul');
    list.id = 'lb-school'; list.setAttribute('role', 'listbox');
    for (const text of ['Northeastern Illinois University', 'Northeastern University', 'Northwestern University']) {
      const o = document.createElement('li');
      o.setAttribute('role', 'option'); o.textContent = text;
      o.addEventListener('click', () => {
        button.textContent = text;
        document.getElementById('h-school').value = text;
        list.remove();
      });
      list.append(o);
    }
    button.after(list);
  });

  // The same shape, but a release that chooses on a keypress: the click
  // lands, the list re-renders its options — the clicked node replaced, as
  // React does — the menu stays open showing the option, and nothing is set.
  const stubborn = document.getElementById('w-state');
  stubborn.addEventListener('click', () => {
    if (document.getElementById('lb-state')) return;
    const list = document.createElement('ul');
    list.id = 'lb-state'; list.setAttribute('role', 'listbox');
    const render = () => {
      list.replaceChildren(...['MA', 'NY'].map((text) => {
        const o = document.createElement('li');
        o.setAttribute('role', 'option'); o.textContent = text;
        o.addEventListener('click', render);
        return o;
      }));
    };
    render();
    stubborn.after(list);
  });
</script></body></html>`;

/*
 * The same place, spelled the list's way. The store says "MA" and "United
 * States", which is what the live payload sends; a State list says
 * "Massachusetts" with values that are names or numbers, and a Country list
 * says "United States of America". The last two lists are the refusals: a
 * State list with Maine and Maryland but no Massachusetts, and a Country list
 * with American territories but not the country.
 */
const PLACES = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Places</title></head><body>
<form>
  <label for="st-name">State</label>
  <select id="st-name"><option value="">Select</option><option value="Maine">Maine</option><option value="Massachusetts">Massachusetts</option></select>
  <label for="st-num">State/Province</label>
  <select id="st-num"><option value="0">--</option><option value="21">Massachusetts</option><option value="33">New York</option><option value="52">Ontario</option></select>
  <label for="co-long">Country</label>
  <select id="co-long"><option value="">Select</option><option value="CA">Canada</option><option value="US">United States of America</option></select>
  <label for="co-abbr">Country of residence</label>
  <select id="co-abbr"><option value="">Select</option><option>UK</option><option>USA</option></select>
</form>
<form id="widget">
  <label id="l-wdco">Country</label>
  <div class="wd"><button type="button" id="wd-co" aria-haspopup="listbox" aria-controls="lb-wdco" aria-labelledby="l-wdco">Select One</button>
    <input type="hidden" id="h-wdco"></div>
</form>
<form id="refusals">
  <label for="st-near">State</label>
  <select id="st-near"><option value="">Select</option><option>Maine</option><option>Maryland</option></select>
  <label for="co-near">Country</label>
  <select id="co-near"><option value="">Select</option><option>American Samoa</option><option>United States Minor Outlying Islands</option></select>
</form>
<script>
  const button = document.getElementById('wd-co');
  button.addEventListener('click', () => {
    if (document.getElementById('lb-wdco')) return;
    const list = document.createElement('ul');
    list.id = 'lb-wdco'; list.setAttribute('role', 'listbox');
    for (const text of ['Canada', 'United States of America']) {
      const o = document.createElement('li');
      o.setAttribute('role', 'option'); o.textContent = text;
      o.addEventListener('click', () => { button.textContent = text; document.getElementById('h-wdco').value = text; list.remove(); });
      list.append(o);
    }
    button.after(list);
  });
</script></body></html>`;

/*
 * The same four labels in two sections. Only the Education block's belong to
 * the degree; the Work Experience block asks them about a job, and a page
 * title that happens to say "Education" is not a section heading.
 */
const MONTH_OPTIONS = '<option value="">Month</option>' +
  ['January','February','March','April','May','June','July','August','September','October','November','December']
    .map((m) => `<option>${m}</option>`).join('');
// Abbreviated, as plenty of lists are, so the start month has to be matched
// across spellings the way the graduation month is.
const SHORT_MONTHS = '<option value="">Month</option>' +
  ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].map((m) => `<option>${m}</option>`).join('');
const SECTIONS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Sections</title></head><body>
<h1>Software Engineer, Education Technology</h1>
<form id="main">
  <h3>Education</h3>
  <label for="e-sm">Start date month</label><select id="e-sm">${SHORT_MONTHS}</select>
  <label for="e-sy">Start date year</label><input id="e-sy">
  <label for="e-em">End date month</label><select id="e-em">${MONTH_OPTIONS}</select>
  <label for="e-ey">End date year</label><input id="e-ey">
  <h3>Work Experience</h3>
  <label for="w-sm">Start date month</label><select id="w-sm">${MONTH_OPTIONS}</select>
  <label for="w-sy">Start date year</label><input id="w-sy">
  <label for="w-em">End date month</label><select id="w-em">${MONTH_OPTIONS}</select>
  <label for="w-ey">End date year</label><input id="w-ey">
</form>
<form id="legend">
  <!-- A sub-heading inside the section: the legend is still what it is. -->
  <fieldset><legend>Academic history</legend>
    <h4>Dates attended</h4>
    <label for="f-from">From (year)</label><input id="f-from">
    <label for="f-to">To (year)</label><input id="f-to">
  </fieldset>
</form>
<form id="jobsonly">
  <label for="j-sy">Start date year</label><input id="j-sy">
  <label for="j-ey">End date year</label><input id="j-ey">
</form>
<form id="workday">
  <!-- Workday's education block asks for the years attended, in words none of the others use. -->
  <h3>Education</h3>
  <label for="wd-first">First Year Attended</label><input id="wd-first" role="spinbutton" data-automation-id="dateSectionYear-input">
  <label for="wd-last">Last Year Attended (Actual or Expected)</label><input id="wd-last" role="spinbutton" data-automation-id="dateSectionYear-input">
  <h3>Work Experience</h3>
  <label for="wd-jfirst">First Year Attended</label><input id="wd-jfirst">
</form>
</body></html>`;

/*
 * Academic boxes whose labels name the institution, and school the profile
 * does not describe.
 *
 * `school` sat above `gpa` and `major`, and the first pattern to match claims
 * the field — so "College GPA" and "College major" were filled with
 * "Northeastern University". And the profile's education is the newest one,
 * a degree: a "High School" box was told the applicant went to high school
 * at a university, and "High school GPA" is the university's grade under any
 * order of the patterns.
 */
const ACADEMICS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Academics</title></head><body>
<form>
  <label for="a-uni">University</label><input id="a-uni">
  <label for="a-inst">Institute</label><input id="a-inst">
  <label for="a-aos">Area of study</label><input id="a-aos">
  <label for="a-cgpa">College GPA</label><input id="a-cgpa">
  <label for="a-maj">College major</label><input id="a-maj">
  <label for="a-hs">High School</label><input id="a-hs">
  <label for="a-hsgpa">High school GPA</label><input id="a-hsgpa">
  <fieldset><legend>Secondary school</legend>
    <label for="a-ss">Name of institution</label><input id="a-ss">
  </fieldset>
  <input id="a-fore" placeholder="Forename"><input id="a-sur" placeholder="Surname">
  <fieldset><legend>Name *</legend>
    <label for="a-first">First</label><input id="a-first">
    <label for="a-last">Last</label><input id="a-last">
  </fieldset>
  <fieldset><legend>Education</legend>
    <label for="a-from">From (Month/Year)</label><input id="a-from" placeholder="MM/YYYY">
    <label for="a-to">To (Month/Year)</label><input id="a-to" placeholder="MM/YYYY">
  </fieldset>
  <label for="a-grad">Graduation (month and year)</label><input id="a-grad">
  <label for="a-gm">Graduation month</label><input id="a-gm">
  <fieldset><legend>Interview availability</legend>
    <label for="a-f2">First</label><input id="a-f2">
  </fieldset>
  <label for="a-why">Why do you want to work here?</label><textarea id="a-why" maxlength="500"></textarea>
  <label for="a-proj">Tell us about a project you are proud of</label><textarea id="a-proj"></textarea>
</form>
</body></html>`;

/*
 * Widgets built the ways the libraries beyond react-select and Workday build
 * them, each proving one reading of whether the choice took.
 *
 *   - An MUI-style autocomplete: no hidden input, the clicked option gone
 *     once the menu closes, and the choice written into the text box itself.
 *     It was undone every time, because a box holding text read as typing.
 *     The same box ignoring the click, menu left open, is the refusal.
 *   - A bare button sitting straight in the form, beside a paragraph that
 *     happens to name the answer. Its click does nothing; the answer was
 *     "seen" in the paragraph, and reported as filled.
 *   - A closed menu kept mounted with `visibility: hidden`, as exit
 *     transitions leave them, beside a widget that names no listbox of its
 *     own. Two "visible" listboxes meant choosing was refused.
 */
const LOOSE_WIDGETS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Loose widgets</title></head><body>
<form>
  <p>Our downtown Boston office is next to the park.</p>
  <!-- Stamped on the first click, as analytics fields are: not the city's. -->
  <div class="tracking"><input type="hidden" name="started" id="started"></div>
  <label id="l-city">City</label>
  <button type="button" id="b-city" role="combobox" aria-haspopup="listbox" aria-labelledby="l-city">Choose a city</button>

  <div class="MuiAutocomplete-root"><div class="MuiFormControl-root"><label id="l-co">Country</label>
    <div class="MuiInputBase-root"><input id="m-country" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="m-lb-country" aria-labelledby="l-co"></div>
  </div></div>

  <div class="MuiAutocomplete-root"><div class="MuiFormControl-root"><label id="l-sc">School</label>
    <div class="MuiInputBase-root"><input id="m-school" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="m-lb-school" aria-labelledby="l-sc"></div>
  </div></div>

</form>
<!-- Its own form: the hidden menu would otherwise refuse the city's popup too, and hide whether the paragraph is read. -->
<form>
  <ul role="listbox" id="stale" style="visibility:hidden;position:absolute"><li role="option">Red</li></ul>
  <label id="l-st">State</label>
  <div><button type="button" id="b-state" aria-haspopup="listbox" aria-labelledby="l-st">Select</button><input type="hidden" name="state" id="h-state"></div>
</form>
<script>
  window.submits = 0;
  for (const f of document.querySelectorAll('form')) f.addEventListener('submit', (e) => { e.preventDefault(); window.submits += 1; });

  function popup(options, onPick) {
    const list = document.createElement('ul');
    list.setAttribute('role', 'listbox');
    for (const text of options) {
      const o = document.createElement('li');
      o.setAttribute('role', 'option'); o.textContent = text;
      o.addEventListener('click', () => onPick(text, list));
      list.append(o);
    }
    document.body.append(list);
    return list;
  }

  document.addEventListener('click', () => { document.getElementById('started').value ||= String(Date.now()); });

  // The click does nothing, and Escape closes it.
  const city = document.getElementById('b-city');
  let cityList = null;
  city.addEventListener('click', () => { cityList ??= popup(['Boston', 'Cambridge'], () => {}); });
  city.addEventListener('keydown', (e) => { if (e.key === 'Escape') { cityList?.remove(); cityList = null; } });

  function mui(id, options, takes) {
    const input = document.getElementById(id);
    let list = null;
    input.addEventListener('input', () => {
      list?.remove();
      list = popup(options, (text, l) => {
        if (!takes) return;
        input.value = text;
        l.remove(); list = null;
        input.setAttribute('aria-expanded', 'false');
      });
      list.id = input.getAttribute('aria-controls');
      input.setAttribute('aria-expanded', 'true');
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { list?.remove(); list = null; input.setAttribute('aria-expanded', 'false'); }
    });
  }
  mui('m-country', ['United States Minor Outlying Islands', 'United States'], true);
  mui('m-school', ['Northeastern University'], false);

  const state = document.getElementById('b-state');
  state.addEventListener('click', () => {
    popup(['MA', 'NY'], (text, l) => {
      state.textContent = text;
      document.getElementById('h-state').value = text;
      l.remove();
    });
  });
</script></body></html>`;

/*
 * Words a profile pattern matches that are not asking for that field.
 *
 * "State" is a verb as often as a place: a free-text "Please state your
 * reason for applying" was typed over with the applicant's state. "Country"
 * appears in the commonest wording of the right-to-work question, and
 * `address_country` sat above `work_authorization`, so the yes/no pair was
 * offered "United States", matched neither button and was left blank. A phone
 * extension box took the whole telephone number, and "Can we contact your
 * current employer?" took the employer's name.
 */
const MISREAD = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <label for="why">Please state your reason for applying</label><textarea id="why" name="q_why"></textarea>
  <label for="why2">State why you are interested in this role</label><input id="why2" name="q_why2">

  <fieldset>
    <legend>Are you authorized to work in this country?</legend>
    <label><input type="radio" name="auth" value="y"> Yes</label>
    <label><input type="radio" name="auth" value="n"> No</label>
  </fieldset>
  <fieldset>
    <legend>Are you legally eligible to work in the country where this job is located?</legend>
    <label><input type="radio" name="elig" value="y"> Yes</label>
    <label><input type="radio" name="elig" value="n"> No</label>
  </fieldset>

  <label for="ext">Phone extension</label><input id="ext" name="phone_ext">
  <label for="contact">Can we contact your current employer?</label><input id="contact" name="q_contact">
  <label for="empmail">Employer contact email</label><input id="empmail" name="emp_contact" type="email">

  <!-- The fields these words were mistaken for, still filled. -->
  <label for="st">State</label><input id="st" name="state">
  <label for="ctry">Country</label><input id="ctry" name="country">
  <label for="ph">Phone</label><input id="ph" name="phone">
  <label for="co">Current employer</label><input id="co" name="current_company">
</form></body></html>`;

const PAGES = { '/loose-widgets': LOOSE_WIDGETS, '/academics': ACADEMICS, '/sections': SECTIONS, '/places': PLACES, '/widgets': WIDGETS, '/current': CURRENT, '/graduation': GRADUATION, '/apply': FORM, '/not-yours': NOT_YOURS, '/react': REACT_FORM, '/awkward': AWKWARD, '/consent': CONSENT, '/labels': LABELS, '/legacy': LEGACY, '/hidden': HIDDEN, '/unhidden': UNHIDDEN, '/submits-nothing': SUBMITS_NOTHING, '/flat': FLAT_QUESTIONS, '/styled': STYLED_RADIOS, '/phrases': PHRASE_ANSWERS, '/remembered': REMEMBERED, '/misread': MISREAD };

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
  /*
   * And what it imports, at the path it imports it from — the privacy rule,
   * kept in its own file so it can be read without reading the rest. A server
   * that answers only `/autofill.js` fails the whole import with "failed to
   * fetch dynamically imported module", which names no module.
   */
  const shared = fs.readFileSync(path.join(root, 'src/shared/remembering.js'), 'utf8');
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/shared/remembering.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(shared);
      return;
    }
    if (req.url.startsWith('/autofill.js')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(source);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PAGES[req.url.split('?')[0]] ?? FORM);
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
      'and the cover letter box is not, since the card has a step for it',
      !asked.some((q) => /cover\s*letter/i.test(q)),
      asked.join(' | '),
    );
    check(
      'the required marker is read off the label',
      out.questions.find((q) => q.question.startsWith('Describe'))?.required === true,
    );
    check('the asterisk is stripped from the question itself', !asked.some((q) => q.includes('*')));
    check('but the form is still known to want one', out.wantsLetter === true);

    /* ------------------------------------------------------------------ */

    const mine = await page.goto(`${base}/not-yours`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        return {
          values: Object.fromEntries(
            ['own-email', 'own-phone', 'r-name', 'r-email', 'r-phone', 'mgr-email', 'ec-name', 'ec-phone',
             'fs-name', 'fs-phone', 'fs-email', 'g-name', 'g-email',
             'emp-city', 'emp-loc', 'emp-mail', 'source', 'citizenship', 'residence', 'b-country', 'b-city', 'cc', 'pref1',
             'pref2', 'reloc', 'st', 'sal', 'dis-sig', 'eeo-sig', 'auth-any', 'both']
              .map((id) => [id, document.getElementById(id).value]),
          ),
          checked: document.querySelector('input[name="auth2"]:checked')?.value ?? '',
          office: document.querySelector('input[name="office"]:checked')?.value ?? '',
          filled: report.filled.map((f) => f.key),
          // With the description, because two fields can be skipped for the
          // same reason under the same key and only the question tells them
          // apart — see the pair below.
          skipped: report.skipped.map((s) => `${s.key}:${s.reason}:${s.description}`),
        };
      }, {
        b: base,
        profile: { ...PROFILE, work_authorization: 'Yes', location: 'Boston, MA', address_state: 'MA' },
      }),
    );

    group('Fields that are about somebody else');
    // Paired with the applicant's own field of the same kind, so that this
    // cannot pass by autofill having simply stopped filling anything.
    check(
      "a referee's email address is not the applicant's",
      mine.values['own-email'] === PROFILE.email && mine.values['r-email'] === '',
      `own "${mine.values['own-email']}", referee's "${mine.values['r-email']}"`,
    );
    check(
      'nor their telephone number',
      mine.values['own-phone'] === PROFILE.phone && mine.values['r-phone'] === '',
      `own "${mine.values['own-phone']}", referee's "${mine.values['r-phone']}"`,
    );
    check("nor their name", mine.values['r-name'] === '', mine.values['r-name']);
    check(
      'an emergency contact is not the person having the emergency',
      mine.values['ec-phone'] === '' && mine.values['ec-name'] === '',
      `${mine.values['ec-name']} / ${mine.values['ec-phone']}`,
    );
    check("nor is the manager's email yours", mine.values['mgr-email'] === '', mine.values['mgr-email']);
    /*
     * And the same, said once above the boxes instead of on every one of
     * them. The exclusions read a field's own label and its own name and id,
     * and nothing else — so a fieldset whose legend is the only thing saying
     * "Emergency Contact", over boxes labelled "Name", "Phone" and "Email",
     * matched the ordinary patterns and was filled with the applicant's own
     * details. Reported as three fields filled, in green, as facts about
     * somebody they would call in an emergency.
     */
    check(
      'a legend is enough to say whose details these are',
      mine.values['fs-name'] === '' && mine.values['fs-phone'] === '' && mine.values['fs-email'] === '',
      `${mine.values['fs-name']} / ${mine.values['fs-phone']} / ${mine.values['fs-email']}`,
    );
    check(
      'and so is the label on a group that is not a fieldset',
      mine.values['g-name'] === '' && mine.values['g-email'] === '',
      `${mine.values['g-name']} / ${mine.values['g-email']}`,
    );
    /*
     * The employment-history exclusion listed city, town, state and postal
     * code but not `location` — which is the word Workday, Greenhouse and
     * iCIMS use — so one line per past job was filled in with the applicant's
     * own current city, as a stated fact about somebody else's office.
     */
    check("a past employer's location is not yours", mine.values['emp-loc'] === '', mine.values['emp-loc']);
    check("nor is a past employer's email", mine.values['emp-mail'] === '', mine.values['emp-mail']);
    check(
      "nor is a previous employer's town your own",
      mine.values['emp-city'] === '',
      mine.values['emp-city'],
    );
    check(
      'where you heard about the job is not your LinkedIn profile',
      mine.values.source === '',
      mine.values.source,
    );

    group('Questions that take the same answers and mean different things');
    // Each paired with the field it was being confused with, so none of these
    // can pass by autofill having stopped filling that kind of field at all.
    check(
      'the country you live in is not the country you are a citizen of',
      mine.values.residence === 'United States' && mine.values.citizenship === '',
      `residence "${mine.values.residence}", citizenship "${mine.values.citizenship}"`,
    );
    check(
      'nor the country you were born in',
      mine.values.residence === 'United States' && mine.values['b-country'] === '',
      `residence "${mine.values.residence}", birth "${mine.values['b-country']}"`,
    );
    check(
      'and the town you live in is not the town you were born in',
      mine.values['b-city'] === '',
      mine.values['b-city'],
    );
    check(
      'a dialling code is not a telephone number',
      mine.values['own-phone'] === PROFILE.phone && mine.values.cc === '',
      `phone "${mine.values['own-phone']}", code "${mine.values.cc}"`,
    );
    check(
      'where you want to work is not where you are — said either way round',
      mine.values.pref1 === '' && mine.values.pref2 === '',
      `"${mine.values.pref1}" / "${mine.values.pref2}"`,
    );
    check(
      'and the same question as radio buttons is not answered either',
      mine.office === '',
      mine.office,
    );
    check(
      'nor is the city you would move to the city you already live in',
      mine.values.reloc === '',
      mine.values.reloc,
    );
    /*
     * "Please state your expected salary" is `address_state` matching a verb,
     * and it wrote "MA" into the salary box. A number an employer reads as a
     * salary expectation, invented by an extension, is the most expensive
     * wrong value on this page — it is read before anyone is interviewed.
     */
    check(
      'and "please state" is not the state you live in',
      mine.values.st === 'MA' && mine.values.sal === '',
      `state "${mine.values.st}", salary "${mine.values.sal}"`,
    );
    check(
      'the signature line of a voluntary disability form is left unsigned',
      mine.values['dis-sig'] === '',
      mine.values['dis-sig'],
    );
    check(
      'and so is the one on the self-identification form',
      mine.values['eeo-sig'] === '',
      mine.values['eeo-sig'],
    );

    group('A question that is two questions');
    /*
     * "Legally authorized to work without sponsorship" was answered from
     * `work_authorization` alone, so an applicant who is authorized *and*
     * needs sponsorship — anyone on a student visa — had their form answered
     * "Yes". Handed back rather than guessed, and reported, so the card shows
     * it as one still for them.
     */
    check(
      'authorization-without-sponsorship is not answered from the authorization alone',
      mine.values.both === '',
      mine.values.both,
    );
    // Named by its own question, not merely by its key: the radio group below
    // reports under the same key for the same reason, so a check that only
    // counted keys would pass on either one of the two being handled.
    check(
      'and the dropdown is reported, by the question it could not answer',
      mine.skipped.some((s) =>
        /^work_authorization:this one asks two things at once:.*United States/.test(s),
      ),
      mine.skipped.join(', ') || '(nothing reported)',
    );
    check(
      'the same question as radio buttons is left alone too',
      mine.checked === '' &&
        mine.skipped.some((s) =>
          /^work_authorization:this one asks two things at once:.*US without requiri/.test(s),
        ),
      `checked "${mine.checked}"; ${mine.skipped.join(', ')}`,
    );
    /*
     * And the half-question that is answerable is still answered. Without this
     * the safe reading of everything above would be to stop touching work
     * authorization at all, which leaves a required question blank on nearly
     * every form — the failure this file exists to avoid.
     */
    check(
      'but one declaration on its own is still answered',
      mine.values['auth-any'] === 'Yes',
      `"${mine.values['auth-any']}"`,
    );

    /* ------------------------------------------------------------------ */

    const react = await page.goto(`${base}/react`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        /*
         * ReactDOM's `inputValueTracking`, reduced to the part that decides
         * whether a change event is a change: it shadows the element's own
         * value (or checked) setter, remembers what it last saw through it,
         * and drops any event whose value it has already seen.
         */
        const seen = new Map();
        const sawChange = {};
        const sawInput = {};
        const sawClick = {};
        for (const el of document.querySelectorAll('input, select')) {
          const prop = el.type === 'radio' || el.type === 'checkbox' ? 'checked' : 'value';
          const descriptor = Object.getOwnPropertyDescriptor(el.constructor.prototype, prop);
          seen.set(el, String(descriptor.get.call(el)));
          Object.defineProperty(el, prop, {
            configurable: true,
            get() { return descriptor.get.call(this); },
            set(v) { seen.set(el, String(v)); descriptor.set.call(this, v); },
          });
          const name = el.name || el.id;
          el.addEventListener('change', () => {
            // What React does on the event: a value it has already recorded
            // means nothing happened, and the handler never runs.
            sawChange[name] = sawChange[name] || String(descriptor.get.call(el)) !== seen.get(el);
          });
          // And separately, whether an `input` event arrived at all: the
          // widgets that wrap a native select listen for that one.
          el.addEventListener('input', () => { sawInput[name] = true; });
          /*
           * For a checkbox or a radio, React does not listen to `change` at
           * all — `shouldUseClickEvent` in its own event plugin routes those
           * two through **click**, because that is the event a person's tick
           * actually produces. So this is the question React asks about this
           * control, and `sawChange` is the question it asks about the others.
           */
          if (el.type === 'radio' || el.type === 'checkbox') {
            el.addEventListener('click', () => { sawClick[name] = true; });
          }
        }

        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return {
          sawChange,
          sawInput,
          sawClick,
          country: document.getElementById('rf-country').value,
          checked: document.querySelector('input[name="rf_auth"]:checked')?.value ?? '',
        };
      }, { b: base, profile: { ...PROFILE, work_authorization: 'Yes' } }),
    );


    /* ------------------------------------------------------------------ */

    const consent = await page.goto(`${base}/consent`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        const picked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
        return {
          mkt: picked('mkt'),
          news: picked('news'),
          auth: picked('auth'),
          spon: picked('spon'),
          spon3: document.getElementById('spon3').value,
          own: document.getElementById('own').value,
          skipped: report.skipped.map((s) => `${s.key}:${s.reason}`),
        };
      }, {
        b: base,
        // A sentence, which is what people type into a free-text box — and
        // the whole point of the second half of this group.
        profile: {
          ...PROFILE,
          work_authorization: 'Authorized to work in the US',
          requires_sponsorship: 'No, I do not need sponsorship',
        },
      }),
    );

    group('A consent question, which is not a fact about the applicant');
    check(
      'a marketing group that says "sponsorship" is not given the visa answer',
      consent.mkt === '',
      `checked "${consent.mkt}"`,
    );
    check(
      'nor is a newsletter question that says "visa status"',
      consent.news === '',
      `checked "${consent.news}"`,
    );
    // Paired with the real question, so this cannot pass by the filler having
    // stopped answering sponsorship at all.
    check(
      'while the question that really asks it is still answered',
      consent.spon === 'n',
      `checked "${consent.spon}"`,
    );
    check('and the applicant\'s own email is still filled', consent.own === PROFILE.email, consent.own);

    const misread = await page.goto(`${base}/misread`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        const v = (id) => document.getElementById(id).value;
        const ticked = (n) => document.querySelector(`input[name="${n}"]:checked`)?.value ?? '';
        return {
          why: v('why'), why2: v('why2'), ext: v('ext'), contact: v('contact'), empmail: v('empmail'),
          st: v('st'), ctry: v('ctry'), ph: v('ph'), co: v('co'),
          auth: ticked('auth'), elig: ticked('elig'),
        };
      }, { b: base, profile: { ...PROFILE, address_state: 'MA', current_company: 'Acme' } }),
    );

    group('Words a pattern matches that are not asking for that field');
    check('"Please state your reason" is not given the applicant\'s state', misread.why === '', misread.why);
    check('nor is "State why you are interested"', misread.why2 === '', misread.why2);
    check('while a box labelled "State" still is', misread.st === 'MA', misread.st);
    check(
      'the right-to-work question that says "country" is answered from the right to work',
      misread.auth === 'y',
      `ticked "${misread.auth}"`,
    );
    check('and so is "legally eligible to work"', misread.elig === 'y', `ticked "${misread.elig}"`);
    check('while a box labelled "Country" still gets the country', misread.ctry === 'United States', misread.ctry);
    check('a phone extension box is not given the whole number', misread.ext === '', misread.ext);
    check('while the phone box still is', misread.ph === '555-0100', misread.ph);
    check('"Can we contact your current employer?" is not given the employer', misread.contact === '', misread.contact);
    check('while "Current employer" still is', misread.co === 'Acme', misread.co);
    check('"Employer contact email" is not given the applicant\'s email', misread.empmail === '', misread.empmail);

    group('A declaration answered from a sentence');
    check(
      '"Authorized to work in the US" answers Yes beside a Yes/No pair',
      consent.auth === 'y',
      `checked "${consent.auth}"`,
    );
    /*
     * And not beside three. A wrong declaration about the right to work is
     * made in the applicant's name and is worse than a blank one, so a list
     * with a third answer is handed back rather than guessed at.
     */
    check(
      'but a three-answer list is left for the user, and reported',
      consent.spon3 === '' && consent.skipped.includes('requires_sponsorship:no matching option'),
      `"${consent.spon3}"; ${consent.skipped.join(', ')}`,
    );

    /*
     * And the answer is the answer, not the words around it.
     *
     * "Yes, but not until 2027" is a yes. Read by looking for negation words
     * it comes out a no, which is the wrong declaration about needing a visa
     * — made in the applicant's name, on the question an employer forwards to
     * an immigration lawyer. So a leading Yes or No wins over everything, and
     * this is the case where the two rules disagree.
     */
    const hedged = await page.goto(`${base}/consent`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return document.querySelector('input[name="spon"]:checked')?.value ?? '';
      }, {
        b: base,
        profile: { ...PROFILE, requires_sponsorship: 'Yes, but not until 2027' },
      }),
    );
    check('a hedged "Yes, but not until 2027" is still a yes', hedged === 'y', `checked "${hedged}"`);

    /*
     * A negation has to be about the thing being asked about.
     *
     * Reading the whole sentence for any negation word made a bag of words
     * out of it, and "Authorized to work in the US without sponsorship" — the
     * documented example value plus the commonest suffix people write — came
     * out No on the question about the right to work. Four of the phrasings
     * below ticked the wrong box, and one true-but-two-sided sentence was
     * reduced to a No it never said.
     *
     * A table, because the failure is not in any one phrasing: it is in how
     * the sentence is read, and only a spread of them shows that.
     */
    const declared = async (key, value, name) =>
      page.goto(`${base}/consent`, { waitUntil: 'domcontentloaded' }).then(() =>
        page.evaluate(async ({ b, k, v, n }) => {
          const m = await import(`${b}/autofill.js`);
          m.fillForm({ [k]: v });
          return document.querySelector(`input[name="${n}"]:checked`)?.value ?? '';
        }, { b: base, k: key, v: value, n: name }),
      );

    const AUTH = [
      ['Authorized to work in the US', 'y'],
      ['Authorized to work in the US without sponsorship', 'y'],
      ['Authorized to work in the US with no restrictions', 'y'],
      ['US citizen, no visa needed', 'y'],
      ['Permanent resident; does not require sponsorship', 'y'],
      ['Not authorized to work in the US', 'n'],
      ['I am not eligible to work in the US', 'n'],
      // Says two things. One box cannot hold it, so nothing is ticked and it
      // is left for the person — which is the whole rule here: a blank costs
      // them a moment, a wrong declaration costs them the application.
      ['I am not a US citizen but am authorized to work', ''],
      /*
       * The way a visa holder actually describes themselves, and the one
       * spelling that broke the reading of the whole sentence.
       *
       * `NEAR_NO` was bounded by `\b`, and a hyphen is a word boundary, so
       * the `non` inside `non-citizen` counted as a negation four words
       * deep — poisoning every concept word after it. Measured: this value
       * ticked "No" on the right to work, for somebody who had written that
       * they are authorised. `non-citizen` denies `citizen` and nothing
       * else, so the sentence now says two things and nothing is ticked.
       */
      ['I am a non-citizen, but authorized to work in the US without restriction.', ''],
      // And a sentence where both readings agree is still answered: the
      // prefix denies `citizen`, `not` denies `authorized`, both say no.
      ['Non-citizen. Not authorized to work in the US.', 'n'],
    ];
    for (const [value, want] of AUTH) {
      const got = await declared('work_authorization', value, 'auth');
      check(`right to work: ${JSON.stringify(value)}`, got === want, `ticked "${got}", wanted "${want}"`);
    }

    const SPON = [
      ['Not immediately, but I will need H-1B sponsorship in 2027', 'y'],
      ['I do not need it now but will require sponsorship later', 'y'],
      ['I do not require sponsorship', 'n'],
      ['No sponsorship needed', 'n'],
      // The same sentence as above, read for the other question, and it has
      // to come out the other way: "without" denies the sponsorship, not the
      // authorisation.
      ['Authorized to work in the US without sponsorship', 'n'],
      /*
       * The mirror image, and the one that was outright wrong rather than
       * merely unanswerable: `non-immigrant` made this read as a denial of
       * the sponsorship, so the form was filled in with "No, I do not
       * require sponsorship" for somebody who had written that they will.
       */
      ['I am a non-immigrant and will require sponsorship', 'y'],
    ];
    for (const [value, want] of SPON) {
      const got = await declared('requires_sponsorship', value, 'spon');
      check(`sponsorship: ${JSON.stringify(value)}`, got === want, `ticked "${got}", wanted "${want}"`);
    }


    /* ------------------------------------------------------------------ */

    const labels = await page.goto(`${base}/labels`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return {
          values: Object.fromEntries(
            ['wd', 'gone', 'selfref', 'styled', 'wrapped'].map((id) => [id, document.getElementById(id).value]),
          ),
          auth: document.querySelector('input[name="auth"]:checked')?.value ?? '',
        };
      }, { b: base, profile: { ...PROFILE, work_authorization: 'Authorized to work in the US' } }),
    );

    /* ------------------------------------------------------------------ */

    const phrases = await page.goto(`${base}/phrases`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        return {
          spon: document.querySelector('input[name="spon"]:checked')?.value ?? '',
          auth: document.getElementById('auth').value,
          three: document.getElementById('three').value,
          ctry: document.getElementById('ctry').value,
          dial: document.getElementById('dial').value,
          filled: report.filled.map((f) => f.key),
        };
      }, {
        b: base,
        profile: {
          ...PROFILE,
          requires_sponsorship: 'I do not at present require sponsorship',
          work_authorization: 'Authorized to work in the US',
        },
      }),
    );

    group('A phrase for an answer, on a question you sign your name under');
    /*
     * The negation and the word it denies are four words apart, and the
     * window that looks for it was three: what comes before a matched word
     * always ends in the space between them, so `split` produced a trailing
     * empty token and one of the four slots was spent on nothing. The profile
     * says the applicant does not need sponsorship; the form came out saying
     * they do, and it was counted as a field successfully answered.
     */
    check(
      'a denial with words in the middle is still a denial',
      phrases.spon === 'n',
      `"${phrases.spon}" (y is a false declaration)`,
    );
    /*
     * And the same question as a dropdown. `yesNoOption` wants a yes/no pair
     * and nothing else, and the list it was handed dropped only the
     * *disabled* options — so "Select…", which is almost never disabled, made
     * every real yes/no dropdown a three-answer question and it was refused.
     * The shape of the control was deciding whether the question got answered
     * at all.
     */
    check(
      'a dropdown with a prompt is still a yes/no question',
      phrases.auth === 'Yes',
      `"${phrases.auth}"`,
    );
    check(
      'and three answers are still three answers, so it declines to guess',
      phrases.three === '',
      `"${phrases.three}"`,
    );
    /*
     * The dialling-code exclusion reasons entirely about label wording and
     * was asked of the label *plus* the name and the id — so a country select
     * named `countryCode`, which is how anyone names the field that submits
     * an ISO code, was dropped as though it had asked for a dialling code.
     * Exclusions report nothing by design, so it was not in `skipped`
     * either: a required dropdown left empty with the card silent about it.
     */
    check(
      'a country select named for its code is still the country',
      phrases.ctry === 'United States',
      `"${phrases.ctry}"`,
    );
    check(
      'and a box that really does ask for a dialling code is still left alone',
      phrases.dial === '',
      `"${phrases.dial}"`,
    );

    group('Fields labelled the way the enterprise systems label them');
    check(
      'aria-labelledby naming two nodes is read as one question',
      labels.values.wd === PROFILE.email,
      `"${labels.values.wd}"`,
    );
    check(
      'an id that is not in the page falls through to the aria-label',
      labels.values.gone === PROFILE.first_name,
      `"${labels.values.gone}"`,
    );
    check(
      'and one naming the field itself falls through to the plain label',
      labels.values.selfref === PROFILE.last_name,
      `"${labels.values.selfref}"`,
    );
    /* The two the fix is actually for. */
    check(
      'an empty label does not hide the aria-label under it',
      labels.values.styled === PROFILE.github,
      `"${labels.values.styled}"`,
    );
    check(
      'nor does a wrapping label holding only the field',
      labels.values.wrapped === PROFILE.phone,
      `"${labels.values.wrapped}"`,
    );
    check(
      'a radio group labelled by a separate node is still answered',
      labels.auth === '1',
      `checked "${labels.auth}"`,
    );

    const legacy = await page.goto(`${base}/legacy`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        return {
          values: Object.fromEntries(
            ['cob', 'ph1', 'cc', 'ph2'].map((id) => [id, document.getElementById(id).value]),
          ),
          citwork: document.querySelector('input[name="citwork"]:checked')?.value ?? '',
          table: document.querySelector('input[name="q_998877"]:checked')?.value ?? '',
          filled: report.filled.map((f) => f.key),
          skipped: report.skipped.map((s) => `${s.key}:${s.reason}`),
        };
      }, { b: base, profile: PROFILE }),
    );

    const read = (path, ids) =>
      page.goto(`${base}${path}`, { waitUntil: 'domcontentloaded' }).then(() =>
        page.evaluate(async ({ b, profile, ids: which }) => {
          const m = await import(`${b}/autofill.js`);
          const report = m.fillForm(profile);
          return {
            values: Object.fromEntries(which.map((id) => [id, document.getElementById(id).value])),
            filled: report.filled.map((f) => f.key),
            questions: m.findQuestions().map((q) => ({ q: q.question, required: m.isRequired(q.fieldId) })),
          };
        }, { b: base, profile: PROFILE, ids }),
      );
    const graduation = await page.goto(`${base}/graduation`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm({
          graduation_month: 'December',
          graduation_year: '2026',
          graduation_date: 'December 2026',
          school: 'Northeastern University',
        });
        const ids = ['gm', 'gm2', 'gy', 'gmonth', 'gslash', 'gwhen', 'guni', 'gprog', 'recent'];
        return {
          values: Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value])),
          months: ['December', 'Dec', 'Dec.', 'Sept', '12', '01', '12 - December', 'Ma', 'Maybe', '13', ''].map((t) => [
            t,
            m.monthOf(t),
          ]),
          skipped: report.skipped.map((x) => `${x.key}:${x.reason}`),
        };
      }, { b: base }),
    );

    const current = await page.goto(`${base}/current`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm({ current_company: 'Helios', current_title: 'Software Engineer Intern', location: 'Boston, MA' });
        return Object.fromEntries(['cc', 'ct', 'mre', 'hco', 'hti', 'cl'].map((id) => [id, document.getElementById(id).value]));
      }, { b: base }),
    );
    const widgets = await page.goto(`${base}/widgets`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = {
          address_country: 'United States',
          school: 'Northeastern University',
          degree: 'Bachelor of Science',
          major: 'Computer Science',
          address_city: 'Boston',
          address_state: 'MA',
          work_authorization: 'Yes',
        };
        const first = m.fillForm(fields);
        const report = await m.fillComboboxes(fields, first);
        const read = (id) => document.getElementById(id);
        return {
          before: first.skipped.filter((x) => /by hand/.test(x.reason)).map((x) => x.key).sort(),
          country: [read('h-country').value, read('w-country').value],
          school: [read('h-school').value, read('w-school').textContent],
          degree: [read('h-degree').value, read('w-degree').value],
          major: [read('h-major').value, read('w-major').value],
          city: read('h-city').value,
          state: [read('h-state').value, read('w-state').textContent],
          filled: report.filled.filter((f) => f.widget).map((f) => f.key).sort(),
          stillByHand: report.skipped.filter((x) => /by hand/.test(x.reason)).map((x) => x.key).sort(),
          openLists: [...document.querySelectorAll('[role="listbox"]')].map((l) => l.id),
          submits: window.submits,
        };
      }, { b: base }),
    );
    const places = await page.goto(`${base}/places`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        // Exactly what the live payload sends.
        const fields = { address_state: 'MA', address_country: 'United States' };
        const read = (id) => document.getElementById(id);
        const forms = [...document.querySelectorAll('form')];
        // One pass per form, the others hidden, because each asks the same
        // questions and a key filled in one form is not driven in a widget.
        for (const shown of forms) {
          for (const f of forms) f.hidden = f !== shown;
          await m.fillComboboxes(fields, m.fillForm(fields));
        }
        for (const f of forms) f.hidden = false;
        return {
          stName: read('st-name').value,
          stNum: read('st-num').value,
          coLong: read('co-long').value,
          coAbbr: read('co-abbr').value,
          wd: read('h-wdco').value,
          stNear: read('st-near').value,
          coNear: read('co-near').value,
        };
      }, { b: base }),
    );
    const sections = await page.goto(`${base}/sections`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = {
          education_start_month: 'September', education_start_year: '2022', education_start_date: 'September 2022',
          graduation_month: 'May', graduation_year: '2026', graduation_date: 'May 2026',
        };
        m.fillForm(fields);
        const ids = ['e-sm', 'e-sy', 'e-em', 'e-ey', 'w-sm', 'w-sy', 'w-em', 'w-ey', 'f-from', 'f-to', 'j-sy', 'j-ey', 'wd-first', 'wd-last', 'wd-jfirst'];
        return Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value]));
      }, { b: base }),
    );
    group("The degree's own dates, and only the degree's");
    check(
      'an Education block answers its start and end',
      sections['e-sm'] === 'Sep' && sections['e-sy'] === '2022' && sections['e-em'] === 'May' && sections['e-ey'] === '2026',
      JSON.stringify([sections['e-sm'], sections['e-sy'], sections['e-em'], sections['e-ey']]),
    );
    check(
      'the same labels under Work Experience are left alone',
      ['w-sm', 'w-sy', 'w-em', 'w-ey'].every((id) => sections[id] === ''),
      JSON.stringify(['w-sm', 'w-sy', 'w-em', 'w-ey'].map((id) => sections[id])),
    );
    check('a fieldset whose legend says so, asked From and To', sections['f-from'] === '2022' && sections['f-to'] === '2026', JSON.stringify([sections['f-from'], sections['f-to']]));
    check(
      'Workday’s first and last year attended, under Education only',
      sections['wd-first'] === '2022' && sections['wd-last'] === '2026' && sections['wd-jfirst'] === '',
      JSON.stringify([sections['wd-first'], sections['wd-last'], sections['wd-jfirst']]),
    );
    check(
      'a page title that mentions education is not a section',
      sections['j-sy'] === '' && sections['j-ey'] === '',
      JSON.stringify([sections['j-sy'], sections['j-ey']]),
    );

    const academics = await page.goto(`${base}/academics`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm({
          first_name: 'Jianwen', last_name: 'Ding', school: 'Northeastern University', major: 'Computer Science', gpa: '3.8',
          education_start_month: 'September', education_start_year: '2023', education_start_date: 'September 2023',
          graduation_month: 'May', graduation_year: '2027', graduation_date: 'May 2027',
        });
        const limits = Object.fromEntries(m.findQuestions().map((q) => [q.question, q.limit ?? null]));
        const ids = ['a-uni', 'a-cgpa', 'a-maj', 'a-hs', 'a-hsgpa', 'a-ss', 'a-fore', 'a-sur', 'a-first', 'a-last', 'a-f2', 'a-from', 'a-to', 'a-grad', 'a-gm', 'a-inst', 'a-aos'];
        return { ...Object.fromEntries(ids.map((id) => [id, document.getElementById(id).value])), limits };
      }, { b: base }),
    );
    /*
     * A degree dropdown lists levels — Greenhouse's reads "Associate's
     * Degree", "Bachelor's Degree", "Master's Degree" — and the store words
     * the degree as it is written on the diploma. Nothing matched, so the box
     * was left empty on every Greenhouse form. A level option takes the degree
     * of that level; a specific one still has to be the same degree.
     */
    const degrees = await page.evaluate(async ({ b }) => {
      const m = await import(`${b}/autofill.js`);
      const pick = (value, options) => {
        document.body.innerHTML = `<form><label for="d">Degree</label><select id="d"><option value="">--</option>${options
          .map((o) => `<option>${o}</option>`)
          .join('')}</select></form>`;
        m.fillForm({ degree: value });
        return document.getElementById('d').value;
      };
      return {
        bs: pick('Bachelor of Science', ["Associate's Degree", "Bachelor's Degree", "Master's Degree"]),
        abbr: pick('B.S.', ["Associate's Degree", "Bachelor's Degree"]),
        ms: pick('Master of Science', ["Bachelor's Degree", 'Masters']),
        phd: pick('Doctor of Philosophy', ["Master's Degree", 'Doctorate']),
        notArts: pick('Bachelor of Science', ['Bachelor of Arts', "Master's Degree"]),
        notMba: pick('Master of Business Administration', ["Bachelor's Degree", "Master's Degree"]),
      };
    }, { b: base });
    group('A degree against a list of levels');
    check(
      'a degree takes the option for its level, however it is spelled',
      degrees.bs === "Bachelor's Degree" && degrees.abbr === "Bachelor's Degree" && degrees.ms === 'Masters' && degrees.phd === 'Doctorate',
      JSON.stringify(degrees),
    );
    check('but never a different specific degree', degrees.notArts === '', `"${degrees.notArts}"`);
    check('and an MBA is left for the person rather than guessed a master’s', degrees.notMba === '', `"${degrees.notMba}"`);

    group('Academic boxes that name the institution, and school the profile is not about');
    check('a University box still takes the school', academics['a-uni'] === 'Northeastern University', `"${academics['a-uni']}"`);
    check(
      '"Institute" and "Area of study", as Freshteam and Avature say them',
      academics['a-inst'] === 'Northeastern University' && academics['a-aos'] === 'Computer Science',
      JSON.stringify([academics['a-inst'], academics['a-aos']]),
    );
    check('"College GPA" takes the grade, not the school', academics['a-cgpa'] === '3.8', `"${academics['a-cgpa']}"`);
    check('"College major" takes the major, not the school', academics['a-maj'] === 'Computer Science', `"${academics['a-maj']}"`);
    check(
      'a high school is not the university',
      academics['a-hs'] === '' && academics['a-hsgpa'] === '' && academics['a-ss'] === '',
      JSON.stringify([academics['a-hs'], academics['a-hsgpa'], academics['a-ss']]),
    );
    check('"Forename" is the first name', academics['a-fore'] === 'Jianwen' && academics['a-sur'] === 'Ding', JSON.stringify([academics['a-fore'], academics['a-sur']]));
    check(
      '"First" and "Last" under a legend reading Name',
      academics['a-first'] === 'Jianwen' && academics['a-last'] === 'Ding',
      JSON.stringify([academics['a-first'], academics['a-last']]),
    );
    /*
     * A box asking for the month and the year together wants the date. It was
     * given the month alone, "September", into a box whose placeholder says
     * MM/YYYY, and reported as filled.
     */
    check(
      'a box asking for month and year at once gets the date',
      academics['a-from'] === '09/2023' && academics['a-to'] === '05/2027' && academics['a-grad'] === 'May 2027',
      JSON.stringify([academics['a-from'], academics['a-to'], academics['a-grad']]),
    );
    check('and one asking for the month still gets the month', academics['a-gm'] === 'May', `"${academics['a-gm']}"`);
    /*
     * A question box's own limit comes with the question, so the answer can
     * be written to fit: a script is not held to `maxlength`, and the form
     * refuses an over-long answer only when it is sent.
     */
    check(
      'a question carries its box’s limit, and one without a limit carries none',
      academics.limits['Why do you want to work here?'] === 500 &&
        academics.limits['Tell us about a project you are proud of'] === null,
      JSON.stringify(academics.limits),
    );
    check('but not a "First" under any other legend', academics['a-f2'] === '', `"${academics['a-f2']}"`);

    const loose = await page.goto(`${base}/loose-widgets`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = { address_city: 'Boston', address_country: 'United States', school: 'Northeastern University', address_state: 'MA' };
        // One pass per form, the other hidden: see the page.
        const forms = [...document.querySelectorAll('form')];
        const filled = [];
        const byHand = [];
        for (const shown of forms) {
          for (const f of forms) f.hidden = f !== shown;
          const report = await m.fillComboboxes(fields, m.fillForm(fields));
          filled.push(...report.filled.map((f) => f.key));
          byHand.push(...report.skipped.filter((s) => /by hand/i.test(s.reason)).map((s) => s.key));
        }
        const read = (id) => document.getElementById(id);
        return {
          filled: filled.sort(),
          byHand: byHand.sort(),
          city: read('b-city').textContent,
          country: read('m-country').value,
          school: read('m-school').value,
          state: read('h-state').value,
          submits: window.submits,
        };
      }, { b: base }),
    );
    group('Widgets from the other libraries, read the way each one shows a choice');
    check(
      'an autocomplete that writes the choice into its own box keeps it',
      loose.country === 'United States' && loose.filled.includes('address_country'),
      JSON.stringify([loose.country, loose.filled]),
    );
    check(
      'and one that ignores the click, menu still open, is emptied and handed back',
      loose.school === '' && !loose.filled.includes('school') && loose.byHand.includes('school'),
      JSON.stringify([loose.school, loose.byHand]),
    );
    // And not in some other field's hidden input changing under it.
    check(
      'an ignored click is not "seen" in a paragraph beside the widget',
      loose.city === 'Choose a city' && !loose.filled.includes('address_city') && loose.byHand.includes('address_city'),
      JSON.stringify([loose.city, loose.filled]),
    );
    check(
      'a closed menu kept mounted but hidden is not a second listbox',
      loose.state === 'MA' && loose.filled.includes('address_state'),
      JSON.stringify([loose.state, loose.byHand]),
    );
    check('and nothing was submitted', loose.submits === 0, String(loose.submits));

    group('The same place, spelled the way the list spells it');
    check('"MA" into a State list of names', places.stName === 'Massachusetts', `"${places.stName}"`);
    check('"MA" into a State list whose values are numbers', places.stNum === '21', `"${places.stNum}"`);
    check('"United States" into a list that says United States of America', places.coLong === 'US', `"${places.coLong}"`);
    check('and into one that says USA', places.coAbbr === 'USA', `"${places.coAbbr}"`);
    check('and into a Workday-style country widget', places.wd === 'United States of America', `"${places.wd}"`);
    check('never the nearest state: Maine and Maryland are not MA', places.stNear === '', `"${places.stNear}"`);
    check('nor a territory for the country', places.coNear === '', `"${places.coNear}"`);

    group('Widgets that open a list, chosen the way a person chooses');
    check(
      'fillForm alone can only name them',
      JSON.stringify(widgets.before) === JSON.stringify(['address_city', 'address_country', 'address_state', 'degree', 'major', 'school', 'work_authorization']),
      JSON.stringify(widgets.before),
    );
    check('a react-select country, typed and chosen', widgets.country[0] === 'United States' && widgets.country[1] === '', JSON.stringify(widgets.country));
    check(
      'the exact option, not the first that starts the same',
      widgets.country[0] !== 'United States Minor Outlying Islands',
      widgets.country[0],
    );
    check('a Workday-style button, clicked and chosen', widgets.school[0] === 'Northeastern University' && widgets.school[1] === 'Northeastern University', JSON.stringify(widgets.school));
    check('options that arrive late, as a fetched list does', widgets.city === 'Boston', `"${widgets.city}"`);
    /*
     * The refusals are the reason this is allowed to exist. No exact option
     * means no choice; a widget that shows options and ignores the click is
     * not answered — and in both cases what was typed is taken back out, so
     * the box is exactly as the person would have found it.
     */
    check('no exact option: nothing chosen, and the typing taken back out', widgets.degree[0] === '' && widgets.degree[1] === '', JSON.stringify(widgets.degree));
    check('a widget that ignores the click is not claimed as answered', widgets.major[0] === '' && widgets.major[1] === '', JSON.stringify(widgets.major));
    check(
      'nor a button whose menu stays open showing the option it ignored',
      widgets.state[0] === '' && widgets.state[1] === 'Select One',
      JSON.stringify(widgets.state),
    );
    /*
     * The one that matters most. A `<button>` with no type in a form submits
     * it, and a dropdown written that way is ordinary — pressing it to open
     * the list sent the application half-filled.
     */
    check('a dropdown that is really a submit button is never pressed', widgets.submits === 0, `${widgets.submits} submits`);
    check(
      'and all of these are still named for the person to pick',
      JSON.stringify(widgets.stillByHand) === JSON.stringify(['address_state', 'degree', 'major', 'work_authorization']),
      JSON.stringify(widgets.stillByHand),
    );
    check(
      'the ones chosen are reported as filled',
      JSON.stringify(widgets.filled) === JSON.stringify(['address_city', 'address_country', 'school']),
      JSON.stringify(widgets.filled),
    );
    /*
     * Escape is how every one of these closes, and the stubborn button does
     * not listen for it either — so its menu may stay. Nothing this chose is
     * left open, which is the part that is this code's to answer for.
     */
    check(
      'no list it chose from is left open',
      widgets.openLists.every((id) => id === 'lb-state'),
      JSON.stringify(widgets.openLists),
    );

    group('The job somebody holds now');
    check('"Current company"', current.cc === 'Helios', `"${current.cc}"`);
    check('"Current job title"', current.ct === 'Software Engineer Intern', `"${current.ct}"`);
    check('"Most recent employer"', current.mre === 'Helios', `"${current.mre}"`);
    check(
      'a job-history row is not asked about the current job',
      current.hco === '' && current.hti === '',
      `company "${current.hco}", title "${current.hti}"`,
    );
    check('"Current location" is still an address', current.cl === 'Boston, MA', `"${current.cl}"`);

    group('When the degree ends, however the form asks');
    check('a month list that abbreviates', graduation.values.gm === '12', `value "${graduation.values.gm}"`);
    check('a month list that numbers', graduation.values.gm2 === '12', `value "${graduation.values.gm2}"`);
    check('a year list', graduation.values.gy === '2026', `value "${graduation.values.gy}"`);
    check('a month picker, which takes nothing but 2026-12', graduation.values.gmonth === '2026-12', `"${graduation.values.gmonth}"`);
    check('a box whose placeholder says MM/YYYY', graduation.values.gslash === '12/2026', `"${graduation.values.gslash}"`);
    check('a plain box, the way a person would type it', graduation.values.gwhen === 'December 2026', `"${graduation.values.gwhen}"`);
    /*
     * The first pattern to match claims the field, and "university" is the
     * school's. Above it on purpose, so a date question naming the school is
     * still a date question.
     */
    check(
      'a date question that names the university is still about the date',
      graduation.values.guni === 'December 2026',
      `"${graduation.values.guni}"`,
    );
    check('"are you a recent graduate?" is not a date question', graduation.values.recent === '', `"${graduation.values.recent}"`);
    /*
     * The one that proves it for a text box. A dropdown of Yes and No cannot
     * take a date whatever claims it, so it stays blank either way; a box
     * takes anything, which is where a pattern matching the bare word
     * "graduate" would type December 2026 into a question about programmes.
     */
    check('nor is a box that merely says "graduate"', graduation.values.gprog === '', `"${graduation.values.gprog}"`);
    const months = Object.fromEntries(graduation.months);
    check(
      'reads a month however it is spelled',
      ['December', 'Dec', 'Dec.', '12', '12 - December'].every((t) => months[t] === 12) &&
        months.Sept === 9 &&
        months['01'] === 1,
      JSON.stringify(graduation.months),
    );
    check(
      'and refuses what is not one',
      months.Ma === null && months.Maybe === null && months['13'] === null && months[''] === null,
      JSON.stringify(graduation.months),
    );

    const hidden = await read('/hidden', ['hfn', 'hem', 'hph']);
    const unhidden = await read('/unhidden', ['ufn', 'uem', 'uph']);

    group('Hidden fields, where the frameworks put them');
    /*
     * Both walks that look for a label stop when they reach another field,
     * which is right — the label before that field belongs to it. A hidden
     * input is not a field anybody can see or label, and counting it as one
     * cost two of these three: only the box with a real `<label for>` was
     * filled, and nothing was reported, so it looked exactly like a form the
     * tool was never confident about.
     */
    check(
      'a CSRF token between a label and its box does not cost the label',
      hidden.values.hfn === 'Jianwen',
      hidden.values.hfn,
    );
    check(
      'nor does one wrapped in a span, as Workday writes them',
      hidden.values.hem === 'ding.jianw@northeastern.edu',
      hidden.values.hem,
    );
    check(
      'a country-code field inside the group does not hide the phone label',
      hidden.values.hph === '555-0100',
      hidden.values.hph,
    );
    /*
     * And the same rule in `isRequired`, which walks the field's group looking
     * for the label that carries the star. A hidden sibling made the group
     * look like it held two fields, so the walk stopped and the question came
     * out optional — on the one the employer will reject the application for
     * leaving blank.
     */
    const starred = hidden.questions.find((q) => /want to work here/.test(q.q));
    check(
      'a hidden sibling does not make a required question look optional',
      starred?.required === true,
      JSON.stringify(starred),
    );
    // The control: the same form without them fills exactly the same fields,
    // which is what makes the three above about hidden inputs and not about
    // opaque field names.
    check(
      'and the same form with nothing hidden fills no more than that',
      JSON.stringify(hidden.filled.sort()) === JSON.stringify(unhidden.filled.sort()),
      `${hidden.filled.join(',')} vs ${unhidden.filled.join(',')}`,
    );

    group('Three shapes that filled nothing and said nothing');
    /*
     * "Are you a U.S. citizen or otherwise authorized to work … without
     * sponsorship?" is the same two-declarations question as the one above,
     * and the word "citizen" in it matched the rule that keeps "Country of
     * citizenship" from being filled with where somebody lives. An exclusion
     * says nothing, by design, so the question disappeared: not filled, not
     * reported, not on the card — on the declaration most likely to have an
     * application rejected without a person reading it.
     */
    check(
      'a right-to-work question that mentions citizenship is handed back, not dropped',
      legacy.citwork === '' &&
        legacy.skipped.includes('work_authorization:this one asks two things at once'),
      `checked "${legacy.citwork}"; ${legacy.skipped.join(', ') || '(nothing reported)'}`,
    );
    // And the rule it was colliding with still holds, or the fix is a
    // different bug: this box asks which country somebody is a citizen of.
    check(
      'while country of citizenship is still not where they live',
      legacy.values.cob === '',
      `"${legacy.values.cob}"`,
    );

    /*
     * "Phone Number (include country code)" is asked for in exactly those
     * words because international applicants are expected to write the `+`.
     * It matched the rule for the little box that wants "+1" and nothing
     * else, so the telephone number — usually required — came out blank with
     * nothing said about it.
     */
    check(
      'a phone box that asks for the country code inside it is still the phone box',
      legacy.values.ph1 === PROFILE.phone,
      `"${legacy.values.ph1}"`,
    );
    check(
      'and the dialling-code box beside a real one is still left alone',
      legacy.values.cc === '' && legacy.values.ph2 === PROFILE.phone,
      `code "${legacy.values.cc}", mobile "${legacy.values.ph2}"`,
    );

    /*
     * Taleo Classic and its descendants lay a questionnaire out as a table:
     * the question in a row header, the buttons in the cell beside it.
     * `labelFor` learned to read a `th` for text boxes; radio groups had not,
     * so the group's whole description was a name like `q_998877`, it matched
     * nothing, and it was skipped in silence.
     */
    check(
      'a question in a table row header is read, and answered',
      legacy.table === 'Y',
      `checked "${legacy.table}"; filled ${legacy.filled.join(', ') || 'nothing'}`,
    );

    group('Values a framework will notice');
    // Only these two: the text input was already written through the
    // prototype's setter and passes either way. The dropdown and the radio
    // were not, so React discarded both change events, kept its own state and
    // put the empty value back at the next render.
    check(
      'a dropdown React controls sees a real change',
      react.sawChange.country === true && react.country === 'US',
      `saw ${react.sawChange.country}, value "${react.country}"`,
    );
    /*
     * A radio has to be *clicked*, and this used to ask the wrong question.
     *
     * `sawChange` is right for a text box and a dropdown and wrong here:
     * React routes checkboxes and radios through click, so a `change` event
     * it never listens for satisfied this check while React's own state
     * stayed empty. Measured against React 18 with a controlled group — the
     * button ticked, one unrelated keystroke re-rendered the form, the tick
     * vanished, and the work-authorisation question submitted blank under a
     * card reading "Filled 3 fields".
     */
    check(
      'and a radio button is clicked, which is the event React listens to',
      react.sawClick.rf_auth === true && react.checked === 'Yes',
      `click ${react.sawClick.rf_auth}, change ${react.sawChange.rf_auth}, checked "${react.checked}"`,
    );
    /*
     * Choosing from a dropdown by hand fires `input` and then `change`. A
     * script that fires only `change` is telling half the truth, and the
     * widgets that wrap a native select — react-select's plain-select mode,
     * Vue's `v-model` on a custom component — are the half that listens for
     * `input` and never hears it.
     */
    check(
      'and a dropdown is announced the way choosing from one is',
      react.sawInput.country === true,
      `input ${react.sawInput.country}, change ${react.sawChange.country}`,
    );

    /* ------------------------------------------------------------------ */

    const nothing = await page.goto(`${base}/submits-nothing`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        const sent = (id) => [...new FormData(document.getElementById(id))].map(([k, v]) => `${k}=${v}`);
        return {
          filled: report.filled.map((f) => f.key),
          skipped: report.skipped.map((s) => `${s.key}:${s.reason}`),
          locked: sent('locked'),
          greyed: sent('greyed'),
          twinned: sent('twinned'),
          // What a person would see, which is right in all three of these.
          shows: document.getElementById('tw-country').selectedOptions[0]?.textContent ?? '',
        };
      }, { b: base, profile: PROFILE }),
    );

    group('Forms that took the value and submitted nothing');
    /*
     * Asserted on `FormData`, not on `.value`. `.value` was correct in every
     * one of these — that is the whole difficulty: the page looked filled, the
     * card said filled, and the employer received an empty field.
     */
    check(
      'a section the form has greyed out is left alone, not filled invisibly',
      nothing.locked.length === 0 && !nothing.filled.includes('phone'),
      `filled ${nothing.filled.join(', ') || 'nothing'}; submitted ${nothing.locked.join(', ') || 'nothing'}`,
    );
    check(
      'and its work-authorisation buttons are left alone too',
      !nothing.filled.includes('work_authorization'),
      nothing.filled.join(', ') || 'nothing',
    );
    // `country=` with nothing after it is the placeholder still selected,
    // which is the honest outcome here: the control was never going to carry
    // this answer. What must not happen is the card claiming otherwise.
    check(
      'an option under a greyed-out group is not chosen, and is said to be',
      nothing.greyed.every((f) => f === 'country=') && nothing.skipped.some((s) => s.startsWith('address_country:')),
      `submitted ${nothing.greyed.join(', ') || 'nothing'}; skipped ${nothing.skipped.join(', ') || 'nothing'}`,
    );
    check(
      'a value two options share does not count as filled when it lands on the placeholder',
      nothing.twinned.every((f) => f === 'country=') && !nothing.filled.includes('address_country'),
      `shows "${nothing.shows}", submitted ${nothing.twinned.join(', ') || 'nothing'}, filled ${nothing.filled.join(', ') || 'nothing'}`,
    );

    /* ------------------------------------------------------------------ */

    const flat = await page.goto(`${base}/flat`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        return {
          filled: report.filled.map((f) => `${f.key}=${f.value}`),
          ticked: [...document.querySelectorAll('input[type=radio]:checked')].map((r) => `${r.name}=${r.value}`),
        };
      }, {
        b: base,
        // The two answers that disagree, which is what makes a borrowed label
        // visible: a question answered from its neighbour's words comes out
        // backwards rather than merely repeated.
        profile: { ...PROFILE, work_authorization: 'Yes', requires_sponsorship: 'No' },
      }),
    );

    group('Several questions in one plain container');
    /*
     * Question text, Yes, No, next question text, Yes, No — no fieldset and no
     * wrapper each, which is how a hand-rolled careers form is written. Both
     * groups used to be labelled from the first question, so both were
     * answered "No": a declaration that the applicant is not authorised to
     * work, submitted over their own answer, and never mentioned in the report.
     */
    check(
      'each group is answered from its own question, not from the one above it',
      flat.ticked.includes('q1=No') && flat.ticked.includes('q2=Yes'),
      flat.ticked.join(', ') || 'nothing ticked',
    );
    check(
      'and the report names both questions rather than one of them twice',
      flat.filled.includes('work_authorization=Yes') && flat.filled.includes('requires_sponsorship=No'),
      flat.filled.join(', ') || 'nothing',
    );

    /* ------------------------------------------------------------------ */

    const styled = await page.goto(`${base}/styled`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        return {
          filled: report.filled.map((f) => `${f.key}=${f.value}`),
          ticked: [...document.querySelectorAll('input[type=radio]:checked')].map((r) => `${r.name}=${r.value}`),
          sent: [...new FormData(document.getElementById('f'))].map(([k, v]) => `${k}=${v}`),
        };
      }, { b: base, profile: { ...PROFILE, work_authorization: 'Yes', requires_sponsorship: 'No' } }),
    );

    group('A radio the form draws itself');
    check(
      'a question whose native buttons are hidden is still answered',
      styled.ticked.includes('auth=Yes') && styled.sent.includes('auth=Yes'),
      `ticked ${styled.ticked.join(', ') || 'nothing'}; submitted ${styled.sent.join(', ') || 'nothing'}`,
    );
    check(
      'while a question in a step that is closed is left for later',
      !styled.ticked.some((t) => t.startsWith('spon=')),
      styled.ticked.join(', ') || 'nothing',
    );

    /* ------------------------------------------------------------------ */

    const awkward = await page.goto(`${base}/awkward`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(profile);
        return {
          country: document.getElementById('aw-country').value,
          questions: m.findQuestions().map((q) => q.question),
          skipped: report.skipped.map((s) => `${s.key}:${s.reason}`),
        };
      }, { b: base, profile: PROFILE }),
    );

    group('Markup that is nearly right');
    check(
      'an option padded with a non-breaking space is still the user\'s country',
      awkward.country === 'US',
      `value "${awkward.country}", skipped ${awkward.skipped.join(', ') || 'nothing'}`,
    );
    check(
      'a question that exists only as a placeholder is still offered',
      awkward.questions.some((q) => /why do you want to work at lever/i.test(q)),
      awkward.questions.join(' | ') || '(none found)',
    );
    /*
     * Which questions a model must not answer, swept over the phrasings forms
     * actually use.
     *
     * The plural is the whole reason this sweep exists rather than a single
     * case: "What are your salary expectations for this role?" is the
     * commonest phrasing on any form, and the first version of the rule
     * required `expectation` without the `s`, so it missed every one of them
     * while passing on "Desired salary". The false side matters as much —
     * "What compensation structures have you designed?" is an ordinary essay
     * question about the applicant's work, and withholding the draft button
     * there is a feature silently going missing.
     */
    const yoursCases = [
      ['What are your salary expectations for this role?', true],
      ['Desired salary', true],
      ['Please state your expected compensation', true],
      ['What is your minimum acceptable pay rate?', true],
      ['Do you require any accommodations for the interview process?', true],
      ['Voluntary self-identification of disability', true],
      ['Please describe your veteran status', true],
      ['Have you ever been convicted of a felony?', true],
      /*
       * The same two questions `yesNoFrom` refuses to guess at when they are
       * tick boxes, asked as a paragraph — which is how Greenhouse and Lever
       * custom questions ask them. Neither was on this list, so the draft
       * button was offered on the one answer this tool must never invent.
       */
      ['Please describe your current work authorization status.', true],
      ['If you will require visa sponsorship now or in the future, please explain.', true],
      ['Are you authorized to work in the United States? Please elaborate.', true],
      // And not the ordinary essay questions that happen to sit near them.
      ['Describe a project where you had to work around a legal constraint.', false],
      ['Why do you want to work here?', false],
      ['Tell us about a project you are proud of.', false],
      ['Describe a time you disagreed with a manager.', false],
      ['What compensation structures have you designed for teams you led?', false],
      ['How do you make engineering accessible to new joiners?', false],
    ];
    const verdicts = await page.evaluate(
      async ({ b, cases }) => {
        const m = await import(`${b}/autofill.js`);
        return cases.map(([q]) => Boolean(m.yoursToAnswer(q)));
      },
      { b: base, cases: yoursCases },
    );
    const wrong = yoursCases
      .map(([q, want], i) => (verdicts[i] === want ? null : `${verdicts[i] ? 'withheld' : 'offered'}: ${q}`))
      .filter(Boolean);
    check('every question is judged the right way round', wrong.length === 0, wrong.join(' | ') || `${yoursCases.length} phrasings`);

    /* ---------------- Answers kept from the last form ---------------- */

    /*
     * The bank as the worker hands it over: the store matched these questions
     * and echoed each one back beside its answer, so the pairing here is
     * string equality. `Month of birth` is in it deliberately — a bank is
     * older than the gate that now keeps such things out, and answers can be
     * typed into the Workspace by hand, so the reuse side has to refuse it
     * too rather than trust what it was given.
     */
    const BANK = [
      { question: 'Have you previously been employed by this company?', answer: 'No' },
      { question: 'Are you willing to relocate for this role?', answer: 'Yes' },
      { question: 'How did you hear about this position?', answer: 'LinkedIn' },
      { question: 'Month of birth', answer: 'April' },
      { question: 'When could you start?', answer: 'Immediately' },
    ];

    const memory = await page.goto(`${base}/remembered`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(
        async ({ b, profile, bank }) => {
          const m = await import(`${b}/autofill.js`);
          const asked = m.choiceQuestions();
          const report = m.fillForm(profile, { remembered: bank });
          const val = (id) => document.getElementById(id).value;
          return {
            asked,
            prev: val('prev'),
            dobMonth: val('dob-month'),
            team: val('team'),
            start: val('start'),
            reloc: document.querySelector('input[name="reloc"]:checked')?.value ?? '',
            heard: [...document.querySelectorAll('[role="radio"]')]
              .filter((el) => el.getAttribute('aria-checked') === 'true')
              .map((el) => el.id),
            fromMemory: report.filled.filter((f) => f.remembered).map((f) => `${f.question} = ${f.value}`),
            keys: report.filled.map((f) => f.key),
          };
        },
        { b: base, profile: PROFILE, bank: BANK },
      ),
    );

    group('Answers kept from the last form');
    /*
     * All three shapes, because the three fill paths are three different
     * pieces of code and a feature that works on dropdowns and silently not
     * on radio buttons is the kind of half-working nobody notices: the form
     * just comes out less filled than it should, which looks the same as a
     * tool that was never confident.
     */
    check('a dropdown is answered from what was said last time', memory.prev === 'No', `"${memory.prev}"`);
    check('so is a radio group', memory.reloc === 'y', `"${memory.reloc}"`);
    check(
      'and a group built out of buttons',
      memory.heard.join(',') === 'h-li',
      memory.heard.join(',') || 'nothing ticked',
    );
    /*
     * The two refusals, which are the half worth being sure about. A wrong
     * answer here is not a blank box somebody notices — it is a form that
     * looks finished and says something they did not say.
     */
    check(
      'a personal question is left alone even with a matching row in the bank',
      memory.dobMonth === '',
      `"${memory.dobMonth}"`,
    );
    check(
      'and it is never even asked about',
      !memory.asked.some((q) => /birth/i.test(q)),
      memory.asked.filter((q) => /birth/i.test(q)).join(' | ') || `asked about ${memory.asked.length}`,
    );
    check(
      'a question the bank has nothing for is left for the person',
      memory.team === '',
      `"${memory.team}"`,
    );
    check(
      'and an answer already on screen outranks the bank',
      memory.start === 'In two weeks',
      `"${memory.start}"`,
    );
    /*
     * And the questions it asks the bank about are the ones the profile
     * cannot answer. Asking about a name or an email address would be asking
     * the store to fuzzy-match something it already knows exactly.
     */
    check(
      'only the questions worth asking the bank are sent',
      memory.asked.length === 4 && memory.asked.every((q) => !/birth/i.test(q)),
      memory.asked.join(' | '),
    );
    check(
      'the report says which answers came from memory',
      memory.fromMemory.length === 3,
      memory.fromMemory.join(' | ') || 'none',
    );
    /*
     * And nothing changes when there is no bank, which is every first
     * application and every session with the store switched off.
     */
    const noBank = await page.goto(`${base}/remembered`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(
        async ({ b, profile }) => {
          const m = await import(`${b}/autofill.js`);
          const report = m.fillForm(profile);
          return {
            prev: document.getElementById('prev').value,
            reloc: document.querySelector('input[name="reloc"]:checked')?.value ?? '',
            filled: report.filled.length,
          };
        },
        { b: base, profile: PROFILE },
      ),
    );
    check(
      'with no bank the form is exactly as it was',
      noBank.prev === '' && noBank.reloc === '' && noBank.filled === 0,
      `prev "${noBank.prev}", reloc "${noBank.reloc}", ${noBank.filled} filled`,
    );
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
