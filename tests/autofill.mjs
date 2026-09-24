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

  <!-- The same two declarations with the first put another way. "Able to
       work" is no wording the authorization pattern knows, so only the
       sponsorship half was seen, and answered the wrong way up. -->
  <label for="able">Are you able to work in the U.S. without sponsorship?</label>
  <select id="able" name="able_nosponsor"><option value="">--</option><option>Yes</option><option>No</option></select>
  <fieldset>
    <legend>Can you work in the United States without visa sponsorship?</legend>
    <label><input type="radio" name="able2" value="Yes"> Yes</label>
    <label><input type="radio" name="able2" value="No"> No</label>
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
 * Nothing in a ResumeM-M profile says how somebody prefers to work, how they
 * heard about the job, or whether they will relocate. They
 * are asked on every application, in all three control shapes, and they are
 * what the answer bank exists to stop being typed twice.
 *
 * Three of these must stay untouched however the rest goes. `dob-month` is
 * personal and is refused even with a matching row in the bank; `team` is
 * ordinary and simply has no row, and a tool that guessed at it would be
 * putting somebody on a team they did not pick; and `prev` is asked in the
 * same words by every employer while its answer belongs to one of them.
 */
const REMEMBERED = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form id="f">
  <label for="arr">Which working arrangement do you prefer?</label>
  <select id="arr" name="arrangement_q2">
    <option value="">Select...</option><option>Remote</option><option>Hybrid</option><option>On-site</option>
  </select>

  <!-- The same words on every form, and the answer given to somebody else. -->
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
 * Ashby's yes/no questions, as its application forms draw them — measured on
 * live boards at jobs.ashbyhq.com (Replit, OpenAI, Notion, Ramp, Ashby's
 * own). Each question is a `[data-field-path]` entry: a `<label>` whose `for`
 * names no element, then a container holding a `Yes` and a `No` `<button>`
 * with `aria-pressed` and `data-option`, no `type` and no role, and a
 * `display: none` checkbox with `tabindex="-1"` named after the field.
 *
 * What the page does, as measured there: a click presses that button and lets
 * go of the other, drawn a microtask after the click rather than during it;
 * pressing the pressed one lets go of it; the checkbox is checked for Yes
 * and unchecked for No; and clicking the checkbox presses Yes. There is no
 * `<form>`, and Submit is a button of its own.
 *
 * Not measured on Ashby, and here to be left alone: a short list of choices
 * drawn the same way (Remote, Hybrid, On-site), and an editor's toolbar of
 * `aria-pressed` Bold and Italic above a text box. `?ignores` is a page that
 * takes no notice of a press; `?answered` arrives with sponsorship already
 * answered No; `?ticked` with the work-authorisation checkbox ticked and
 * neither of its buttons pressed.
 */
const ashbyEntry = (path, question, options = ['Yes', 'No']) => `
  <div class="_fieldEntry ashby-application-form-field-entry" data-field-path="${path}">
    <label class="_heading _required" for="${path}">${question}</label>
    <div class="_container ${options.length === 2 ? '_yesno ashby-application-form-input-yesno' : '_choices'}">${options
      .map((o) => `<button class="_option" aria-pressed="false" data-option="${o.toLowerCase()}">${o}</button>`)
      .join('')}${options.length === 2 ? `<input type="checkbox" class="_input" tabindex="-1" name="${path}">` : ''}</div>
  </div>`;
const ASHBY_YES_NO = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Ashby</title>
<style>._input { display: none; }</style></head><body>
<div class="ashby-application-form-container">
  <div class="ashby-application-form-section-container">
    <div class="_fieldEntry ashby-application-form-field-entry" data-field-path="_systemfield_name">
      <label for="_systemfield_name">Name</label><input id="_systemfield_name" name="_systemfield_name" type="text"></div>
    ${ashbyEntry('office', 'Are you able to work from our NYC office 3 days per week?')}
    ${ashbyEntry('relocate', 'If not currently in the NYC area are you willing to relocate near our NYC Office?')}
    ${ashbyEntry('age', 'Are you at least 18 years of age?')}
    ${ashbyEntry('auth', 'Are you legally authorized to work in the United States?')}
    ${ashbyEntry('spon', 'Will you now, or in the future, require sponsorship for employment visa status (e.g. H-1B visa status)?')}
    ${ashbyEntry('arrangement', 'Which working arrangement do you prefer?', ['Remote', 'Hybrid', 'On-site'])}
    <div class="_fieldEntry ashby-application-form-field-entry" data-field-path="more">
      <label for="more">Anything else you would like us to know?</label>
      <div class="editor"><div role="toolbar"><button aria-pressed="false" id="bold">Bold</button><button aria-pressed="false" id="italic">Italic</button></div>
        <textarea id="more" name="more"></textarea></div></div>
  </div>
  <button class="ashby-application-form-submit-button" id="submit">Submit Application</button>
</div>
<script>
  window.__touched = [];
  window.__submitted = 0;
  document.getElementById('submit').addEventListener('click', () => __submitted++);
  const query = new URLSearchParams(location.search);
  for (const group of document.querySelectorAll('._container')) {
    const buttons = [...group.querySelectorAll('button')];
    const box = group.querySelector('input[type=checkbox]');
    // Drawn a microtask after the click, as React draws it; the pressed one again lets go.
    const press = (hit) => queueMicrotask(() => {
      const on = hit.getAttribute('aria-pressed') !== 'true';
      for (const b of buttons) b.setAttribute('aria-pressed', String(on && b === hit));
      if (box) box.checked = on && hit.dataset.option === 'yes';
    });
    for (const b of buttons) b.addEventListener('click', () => { if (!query.has('ignores')) press(b); });
    if (box) {
      for (const t of ['click', 'change', 'input']) box.addEventListener(t, () => __touched.push(box.name + ' ' + t));
      box.addEventListener('click', () => press(buttons[0]));
    }
  }
  for (const b of document.querySelectorAll('[role=toolbar] button')) b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
  if (query.has('answered')) document.querySelector('[data-field-path="spon"] [data-option="no"]').setAttribute('aria-pressed', 'true');
  if (query.has('ticked')) document.querySelector('input[name="auth"]').checked = true;
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
  <!-- The same shape said in the label, which is where most forms say it. -->
  <label for="glabel">Graduation date (MM/YYYY)</label><input id="glabel" name="grad_label">
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
  <!--
    "Name" after the company, which is how Greenhouse's custom questions and
    plenty of hand-built forms put it — and which the employment-history
    exclusion read as a past employer's name. The history rows below it must
    still read that way.
  -->
  <label for="ccn">Current Company Name</label><input id="ccn" name="q_1001">
  <label for="cen">Current employer's name</label><input id="cen" name="q_1002">
  <label for="mren">Most recent employer name</label><input id="mren" name="q_1003">
  <label for="pcn">Present company name</label><input id="pcn" name="q_1004">
  <fieldset><legend>Employment history</legend>
    <label for="hcn">Company Name</label><input id="hcn" name="q_2001">
    <label for="hen">Employer name</label><input id="hen" name="q_2002">
    <label for="hcc">Current company name</label><input id="hcc" name="q_2008">
  </fieldset>
  <label for="bcn">Company name</label><input id="bcn" name="q_2003">
  <label for="prn">Previous company name</label><input id="prn" name="q_2004">
  <label for="ncn">Not your current company name, the one before it</label><input id="ncn" name="q_2005">
  <label for="cca">Current company address</label><input id="cca" name="q_2006">
  <label for="ccl">Current employer location</label><input id="ccl" name="q_2007">
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
 * The right to work somewhere else.
 *
 * A profile's declaration is a sentence, and it names where it is true:
 * "Authorized to work in the US". A global employer's form asks it of the
 * country the job is in — "Are you authorized to work in the UK?" — and the
 * sentence says nothing about the UK.
 */
const ELSEWHERE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <label for="uk">Are you authorized to work in the UK?</label>
  <select id="uk" name="q_uk"><option value="">--</option><option>Yes</option><option>No</option></select>
  <!-- And the same question as a box to type in. -->
  <label for="ukt">Are you authorized to work in the United Kingdom?</label><input id="ukt" name="q_ukt">
  <fieldset>
    <legend>Are you legally authorized to work in Canada?</legend>
    <label><input type="radio" name="ca" value="Yes"> Yes</label>
    <label><input type="radio" name="ca" value="No"> No</label>
  </fieldset>
  <div role="radiogroup" aria-label="Will you require sponsorship to work in the United Kingdom?">
    <div role="radio" id="uks-y" aria-checked="false" tabindex="0">Yes</div>
    <div role="radio" id="uks-n" aria-checked="false" tabindex="0">No</div>
  </div>
  <!-- And the country the sentence is about, and a question that names none. -->
  <label for="us">Are you legally authorized to work in the United States?</label>
  <select id="us" name="q_us"><option value="">--</option><option>Yes</option><option>No</option></select>
  <fieldset>
    <legend>Will you now or in the future require sponsorship?</legend>
    <label><input type="radio" name="sp" value="Yes"> Yes</label>
    <label><input type="radio" name="sp" value="No"> No</label>
  </fieldset>
</form>
<script>
  for (const el of document.querySelectorAll('[role="radio"]')) {
    el.addEventListener('click', () => {
      for (const sib of el.parentElement.querySelectorAll('[role="radio"]')) sib.setAttribute('aria-checked', 'false');
      el.setAttribute('aria-checked', 'true');
    });
  }
</script></body></html>`;

/*
 * The two-declarations question on Workday's own control.
 *
 * Workday asks every yes/no as a button that opens a listbox, and
 * `fillComboboxes` drives those. `handBack` keeps the authorization-without-
 * sponsorship pair from being answered off one of its halves on a dropdown,
 * a radio group and a group of buttons — and it was never asked of these.
 * Below it, the plain question, which is answerable.
 */
const PAIRED_WIDGETS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Workday</title></head><body>
<form>
  <label id="l-both">Are you legally authorized to work in the United States without sponsorship?</label>
  <div><button type="button" id="w-both" aria-haspopup="listbox" aria-controls="lb-both" aria-labelledby="l-both">Select One</button>
    <input type="hidden" id="h-both"></div>
  <label id="l-able">Are you able to work in the U.S. without sponsorship?</label>
  <div><button type="button" id="w-able" aria-haspopup="listbox" aria-controls="lb-able" aria-labelledby="l-able">Select One</button>
    <input type="hidden" id="h-able"></div>
  <label id="l-auth">Are you legally authorized to work in the United States?</label>
  <div><button type="button" id="w-auth" aria-haspopup="listbox" aria-controls="lb-auth" aria-labelledby="l-auth">Select One</button>
    <input type="hidden" id="h-auth"></div>
</form>
<script>
  for (const name of ['both', 'able', 'auth']) {
    const button = document.getElementById('w-' + name);
    button.addEventListener('click', () => {
      if (document.getElementById('lb-' + name)) return;
      const list = document.createElement('ul');
      list.id = 'lb-' + name; list.setAttribute('role', 'listbox');
      for (const text of ['Yes', 'No']) {
        const o = document.createElement('li');
        o.setAttribute('role', 'option'); o.textContent = text;
        o.addEventListener('click', () => {
          button.textContent = text;
          document.getElementById('h-' + name).value = text;
          list.remove();
        });
        list.append(o);
      }
      button.after(list);
    });
  }
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
<form id="after">
  <!-- The Education fieldset has ended; the questions below it are not the degree's. -->
  <fieldset><legend>Education</legend>
    <label for="x-from">Start date</label><input id="x-from">
  </fieldset>
  <label for="x-avail">Available start date</label><input id="x-avail">
  <label for="x-notice">Notice period end date</label><input id="x-notice">
</form>
<form id="workday">
  <!-- Workday's education block asks for the years attended, in words none of the others use. -->
  <h3>Education</h3>
  <label for="wd-first">First Year Attended</label><input id="wd-first" role="spinbutton" data-automation-id="dateSectionYear-input">
  <label for="wd-last">Last Year Attended (Actual or Expected)</label><input id="wd-last" role="spinbutton" data-automation-id="dateSectionYear-input">
  <h3>Work Experience</h3>
  <label for="wd-jfirst">First Year Attended</label><input id="wd-jfirst">
</form>
<form id="wrapped">
  <!--
    One wrapper per section, headed by an h3 and no fieldset. The wrapper is
    where each heading's section ends: the Education block's heading is not
    the heading of the block after it, and the Work Experience heading —
    wrapped on its own in a header div — is.
  -->
  <div class="section"><h3>Personal information</h3>
    <label for="s-city">City</label><input id="s-city">
  </div>
  <div class="section"><h3>Education</h3>
    <label for="s-esy">Start date year</label><input id="s-esy">
  </div>
  <div class="section">
    <label for="s-avail">Available start date</label><input id="s-avail">
  </div>
  <div class="section"><div class="head"><h3>Work Experience</h3></div>
    <div class="body">
      <label for="s-wloc">Location</label><input id="s-wloc">
      <label for="s-wcity">City</label><input id="s-wcity">
    </div>
  </div>
  <div class="section">
    <label for="s-after">City</label><input id="s-after">
  </div>
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
  <!-- The same again as the global employers put it, whose "country … applying"
       is also how "Which country are you applying for?" begins. -->
  <fieldset>
    <legend>Are you legally authorized to work in the country to which you are applying?</legend>
    <label><input type="radio" name="applyin" value="y"> Yes</label>
    <label><input type="radio" name="applyin" value="n"> No</label>
  </fieldset>

  <!-- The same question put as employment rather than work. -->
  <fieldset>
    <legend>Are you currently eligible for employment in the US?</legend>
    <label><input type="radio" name="employ" value="y"> Yes</label>
    <label><input type="radio" name="employ" value="n"> No</label>
  </fieldset>

  <label for="ext">Phone extension</label><input id="ext" name="phone_ext">
  <label for="contact">Can we contact your current employer?</label><input id="contact" name="q_contact">
  <label for="empmail">Employer contact email</label><input id="empmail" name="emp_contact" type="email">
  <label for="tenure">Years at current company</label><input id="tenure" name="tenure">
  <label for="cpc">Country phone code</label><input id="cpc" name="cpc">
  <label for="say">Pronunciation of your name</label><input id="say" name="say">
  <label for="fulln">Full name</label><input id="fulln" name="fulln">
  <!-- The whole name asked for by its two halves. -->
  <label for="fl1">First and Last Name</label><input id="fl1" name="q_fl1">
  <label for="fl2">First & Last Name</label><input id="fl2" name="q_fl2">
  <label for="fl3">First Name and Last Name</label><input id="fl3" name="q_fl3">
  <!-- One half of it, named after the legal name it is part of. -->
  <label for="ln1">Legal name (First)</label><input id="ln1" name="q_ln1">
  <label for="ln2">Legal name (Last)</label><input id="ln2" name="q_ln2">
  <label for="ln3">Legal name (Middle)</label><input id="ln3" name="q_ln3">
  <label for="ln4">Full legal name (first, middle, last)</label><input id="ln4" name="q_ln4">

  <!-- Essay prompts that happen to say a profile word. -->
  <label for="e1">Tell us about a project you shipped at your current company</label><textarea id="e1" name="q_e1"></textarea>
  <label for="e2">What did you study in school and why?</label><textarea id="e2" name="q_e2"></textarea>
  <label for="e3">Do you have experience with state management libraries?</label><input id="e3" name="q_e3">
  <label for="e4">How did you first hear of us? (LinkedIn, etc.)</label><input id="e4" name="q_e4">
  <label for="e5">Which location are you applying for?</label><input id="e5" name="q_e5">
  <!-- And the facts, asked as short labels or plain questions, still filled. -->
  <label for="f1">LinkedIn profile</label><textarea id="f1" name="f1"></textarea>
  <label for="f2">Which university did you graduate from?</label><input id="f2" name="f2">

  <!-- The fields these words were mistaken for, still filled. -->
  <label for="st">State</label><input id="st" name="state">
  <!-- Both of them in one box. -->
  <label for="cs1">City, State</label><input id="cs1" name="q_cs1">
  <label for="cs2">City/State</label><input id="cs2" name="q_cs2">
  <label for="ctry">Country</label><input id="ctry" name="country">
  <label for="ph">Phone</label><input id="ph" name="phone">
  <label for="co">Current employer</label><input id="co" name="current_company">
</form></body></html>`;

/*
 * More labels that say a profile word about something that is not the
 * applicant. Each field is empty unless its check says otherwise, and every
 * one of them was filled — with a true fact about the applicant, given as the
 * answer to a question about somebody or something else.
 */
const MORE_MISREAD = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <!-- A yes-or-no question in a one-line box, which no profile value answers.
       First, so that no section heading above them is read as theirs. -->
  <label for="yn-deg">Do you have a bachelor's degree?</label><input id="yn-deg" name="q_y1">
  <label for="yn-sch">Did you graduate from a US university?</label><input id="yn-sch" name="q_y2">
  <label for="yn-gpa">Do you have a GPA of 3.0 or above?</label><input id="yn-gpa" name="q_y3">
  <label for="yn-ph">Can we text you at this phone number?</label><input id="yn-ph" name="q_y4">
  <label for="yn-city">Will you be located in New York City by the start date?</label><input id="yn-city" name="q_y5">
  <label for="yn-li">Do you have a LinkedIn profile?</label><input id="yn-li" name="q_y6">
  <label for="yn-ph2">Do you have a phone number? If so, please share it.</label><input id="yn-ph2" name="q_y8">
  <label for="yn-what">What is your cumulative GPA?</label><input id="yn-what" name="q_y7">

  <!-- Other people's contact details, under names the list did not have. -->
  <label for="refmail">Referrer's email</label><input id="refmail" name="q_r1" type="email">
  <label for="reflink">LinkedIn URL of your referrer</label><input id="reflink" name="q_r2">
  <label for="recmail">Recruiter email</label><input id="recmail" name="q_r3">
  <label for="profmail">Professor's email</label><input id="profmail" name="q_r4">
  <label for="parphone">Parent's phone number</label><input id="parphone" name="q_r5">

  <!-- Counts, which name what they are counting. -->
  <label for="count1">How many years of mobile development experience do you have?</label><input id="count1" name="q_c1">
  <label for="count2">How many years of college have you completed?</label><input id="count2" name="q_c2">
  <label for="count3">Years of GitHub Actions experience</label><input id="count3" name="q_c3">

  <!-- The password to a link, as the plain text box design roles ask for. -->
  <label for="pfpw">Portfolio password</label><input id="pfpw" name="q_pw1">
  <label for="webpw">Website password (if any)</label><input id="webpw" name="q_pw2">

  <!-- Where the school is, and the employer's website. -->
  <label for="schcity">School city</label><input id="schcity" name="q_s1">
  <label for="schstate">School state</label><input id="schstate" name="q_s2">
  <label for="unictry">University country</label><input id="unictry" name="q_s3">
  <label for="unicity">What city is your university located in?</label><input id="unicity" name="q_s4">
  <label for="coweb">Company website</label><input id="coweb" name="q_s5">

  <!-- A name the applicant used to have. -->
  <label for="prevln">Previous last name(s)</label><input id="prevln" name="q_n1">
  <label for="maiden">Maiden last name</label><input id="maiden" name="q_n2">
  <label for="formern">Former legal name</label><input id="formern" name="q_n3">
  <label for="prevused">Last name (previously used, if any)</label><input id="prevused" name="q_n4">

  <!-- A username, which is part of the URL the profile holds and not the URL. -->
  <label for="ghuser">GitHub username</label><input id="ghuser" name="q_u1">
  <label for="ghhandle">GitHub handle</label><input id="ghhandle" name="q_u2">
  <label for="liuser">Username on LinkedIn</label><input id="liuser" name="q_u3">
  <label for="gh-url">GitHub profile URL</label><input id="gh-url" name="q_u4">

  <!-- "Major" the adjective. -->
  <label for="majacc">Major accomplishment</label><input id="majacc" name="q_m1">
  <label for="majproj">Major project</label><input id="majproj" name="q_m2">
  <label for="majach">Your major achievements</label><input id="majach" name="q_m3">
  <label for="majcity">Nearest major city</label><input id="majcity" name="q_m6">
  <label for="majmetro">Closest major metropolitan area</label><input id="majmetro" name="q_m7">
  <label for="own-major">Major</label><input id="own-major" name="q_m4">
  <label for="int-major">Intended major</label><input id="int-major" name="q_m5">

  <!-- "Degree" the measure. -->
  <label for="degprof">Degree of proficiency in Spanish</label><input id="degprof" name="q_d1">
  <label for="degfam">To what degree are you familiar with SQL?</label><input id="degfam" name="q_d2">
  <label for="degfield">Field of degree</label><input id="degfield" name="q_d5">
  <label for="degfield2">Degree field</label><input id="degfield2" name="q_d6">
  <label for="degsubj">Subject of degree</label><input id="degsubj" name="q_d7">
  <label for="own-degree">Degree</label><input id="own-degree" name="q_d3">
  <label for="deg-pursue">What degree are you pursuing?</label><input id="deg-pursue" name="q_d4">

  <!-- The state that issued a licence, which is not where the applicant lives. -->
  <label for="licst1">State of licensure</label><input id="licst1" name="q_l1">
  <label for="licst2">License state</label><input id="licst2" name="q_l2">
  <label for="licst3">Driver's license issuing state</label><input id="licst3" name="q_l3">
  <label for="licst4">Issuing state</label><input id="licst4" name="q_l4">
  <label for="own-state">State/Province</label><input id="own-state" name="q_l5">

  <!-- When to ring, which is not the number to ring. -->
  <label for="phtime1">Best phone interview time</label><input id="phtime1" name="q_p1">
  <label for="phtime2">Best time to reach you by phone</label><input id="phtime2" name="q_p2">
  <label for="phtime3">Phone screen availability</label><input id="phtime3" name="q_p3">
  <label for="phbest">Best phone number to reach you</label><input id="phbest" name="q_p4">
  <label for="phint">Phone number for the phone interview</label><input id="phint" name="q_p5">

  <!-- A past job's place and telephone, and the school's, asked once in the group's name. -->
  <fieldset>
    <legend>Work Experience 1</legend>
    <label for="wx-loc">Location</label><input id="wx-loc" name="q_h1">
    <label for="wx-city">City</label><input id="wx-city" name="q_h2">
    <label for="wx-phone">Phone</label><input id="wx-phone" name="q_h3">
  </fieldset>
  <div role="group" aria-labelledby="eh-head"><h4 id="eh-head">Employment History</h4>
    <label for="eh-state">State</label><input id="eh-state" name="q_h4">
    <label for="eh-ctry">Country</label><input id="eh-ctry" name="q_h5">
  </div>
  <fieldset>
    <legend>Education</legend>
    <label for="ed-sch">School</label><input id="ed-sch" name="q_h6">
    <label for="ed-city">City</label><input id="ed-city" name="q_h7">
    <label for="ed-state">State</label><input id="ed-state" name="q_h8">
  </fieldset>
  <fieldset>
    <legend>Contact Information</legend>
    <label for="ci-city">City</label><input id="ci-city" name="q_h9">
    <label for="ci-loc">Location</label><input id="ci-loc" name="q_h10">
  </fieldset>

  <!-- One level of study named, against a profile whose degree is a bachelor's. -->
  <label for="lv-gsch">Graduate School</label><input id="lv-gsch" name="q_v1">
  <label for="lv-ggpa">Graduate GPA</label><input id="lv-ggpa" name="q_v2">
  <label for="lv-msch">Master's degree institution</label><input id="lv-msch" name="q_v3">
  <label for="lv-phd">PhD Institution</label><input id="lv-phd" name="q_v4">
  <fieldset>
    <legend>Graduate Education</legend>
    <label for="lv-gmaj">Major</label><input id="lv-gmaj" name="q_v5">
  </fieldset>
  <label for="lv-usch">Undergraduate School</label><input id="lv-usch" name="q_v6">
  <label for="lv-ugpa">Undergraduate GPA</label><input id="lv-ugpa" name="q_v7">
  <label for="lv-bmaj">Bachelor's Major</label><input id="lv-bmaj" name="q_v8">
  <label for="lv-deg">Degree (e.g. Master's, PhD)</label><input id="lv-deg" name="q_v9" placeholder="Master of Science">

  <!-- A second subject, a second degree, a second row, another school. -->
  <label for="sc-maj2">Second Major</label><input id="sc-maj2" name="q_x1">
  <label for="sc-dbl">Double major</label><input id="sc-dbl" name="q_x2">
  <label for="sc-add">Additional degree</label><input id="sc-add" name="q_x3">
  <label for="sc-sch1">School 1</label><input id="sc-sch1" name="q_x4">
  <label for="sc-sch2">School 2</label><input id="sc-sch2" name="q_x5">
  <label for="sc-maj-2">Major 2</label><input id="sc-maj-2" name="q_x6">
  <label for="sc-prev">Previous school</label><input id="sc-prev" name="q_x7">
  <label for="sc-trans">Transfer university</label><input id="sc-trans" name="q_x8">
  <label for="sc-other">School (if other)</label><input id="sc-other" name="q_x9">

  <!-- A typed signature, which signs whatever sits above it. -->
  <label for="sig1">Type your full name to sign</label><input id="sig1" name="q_g1">
  <label for="sig2">E-signature (type your name)</label><input id="sig2" name="q_g2">
  <label for="sig3">Full legal name (signature)</label><input id="sig3" name="q_g3">
  <fieldset>
    <legend>Applicant Signature</legend>
    <label for="sig4">Full Name</label><input id="sig4" name="q_g4">
  </fieldset>
  <label for="sig-in">Email you use to sign in</label><input id="sig-in" name="q_g5">

  <!-- Where the job is, and what kind of place it is, which is not where the applicant lives. -->
  <label for="jl1">Job location</label><input id="jl1" name="q_j1">
  <label for="jl2">Office location</label><input id="jl2" name="q_j2">
  <label for="jl3">Work location</label><input id="jl3" name="q_j3">
  <label for="jl4">Location of the role</label><input id="jl4" name="q_j4">
  <label for="jl5">Location type</label><input id="jl5" name="q_j5">
  <label for="jl-own">Current location</label><input id="jl-own" name="q_j6">

  <!-- What kind of phone, which scale, what status: about a field, not the field. -->
  <label for="kd1">Phone Type</label><input id="kd1" name="q_k1">
  <label for="kd2">Phone Device Type</label><input id="kd2" name="q_k2">
  <label for="kd3">Type of phone</label><input id="kd3" name="q_k3">
  <label for="kd4">Email type</label><input id="kd4" name="q_k4">
  <label for="kd5">GPA Scale</label><input id="kd5" name="q_k5">
  <label for="kd6">Degree Status</label><input id="kd6" name="q_k6">

  <!-- Where the applicant is, asked as a question. -->
  <label for="wh1">Where are you located?</label><input id="wh1" name="q_wh1">
  <label for="wh2">Where do you live?</label><input id="wh2" name="q_wh2">
  <label for="wh3">Where do you currently reside?</label><input id="wh3" name="q_wh3">
  <label for="wh4">Where would you like to be located?</label><input id="wh4" name="q_wh4">

  <!-- The applicant's own, still filled. -->
  <label for="own-ln">Last name</label><input id="own-ln" name="q_ln">
  <label for="own-legal">Legal name</label><input id="own-legal" name="q_legal">
  <label for="sch">School</label><input id="sch" name="q_sch">
  <label for="pf">Portfolio</label><input id="pf" name="q_pf">
  <label for="gradyear">Year of graduation</label><input id="gradyear" name="q_gy">
  <label for="own-email">Email</label><input id="own-email" name="email" type="email">
  <label for="own-phone">Phone</label><input id="own-phone" name="phone">
  <label for="own-li">LinkedIn</label><input id="own-li" name="li">
</form></body></html>`;

/*
 * Two widgets, and a profile that holds the state and not the country.
 *
 * The order of the patterns puts country above state because
 * "Country/Region" matches `region`; the widget report walked past country
 * when the profile had none and named the Country/Region widget as the state.
 * Having claimed the state there, it then had nothing to say about the State
 * widget below it, which is the one the person needed pointing at.
 */
const WIDGET_KEYS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Widget keys</title></head><body>
<form>
  <label id="l-cr">Country/Region</label>
  <button type="button" id="k-cr" aria-haspopup="listbox" aria-labelledby="l-cr">Select One</button>
  <label id="l-st">State</label>
  <button type="button" id="k-st" aria-haspopup="listbox" aria-labelledby="l-st">Select One</button>
  <label id="l-gs">Graduate School</label>
  <button type="button" id="k-gs" aria-haspopup="listbox" aria-labelledby="l-gs">Select One</button>
  <label id="l-us">Undergraduate School</label>
  <button type="button" id="k-us" aria-haspopup="listbox" aria-labelledby="l-us">Select One</button>
</form></body></html>`;

/*
 * A form that moves to its next step by re-rendering in place, as a React
 * form does when step two's component sits where step one's did: the same
 * `<textarea>` element, a new label beside it, the url unchanged.
 */
const STEPPED = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form id="f">
  <div class="q"><label id="q-label" for="q-box">Why do you want to work at Acme?</label>
    <textarea id="q-box" name="step1_why"></textarea></div>
  <div class="q"><label id="c-label" for="c-box">Tell us about a project you led. (500 characters remaining)</label>
    <textarea id="c-box" name="project"></textarea></div>
</form></body></html>`;

/*
 * The three ways a rich-text editor keeps what is typed into it, each as
 * small as it can be and still behave like the real thing towards a script.
 *
 * `controlled` is Draft.js (and Lexical, and Slate): the document is a model
 * the element is drawn from, anything that turns up in the element some other
 * way is drawn over on the next render, and where the caret is comes from
 * `selectionchange`. It takes pastes and typing through its own handlers.
 *
 * `reverting` is CKEditor 5: the same model, and a MutationObserver that puts
 * the element back the moment anything else changes it. Its root's
 * attributes are drawn from the model too, on every render — focusing it is
 * one — so an attribute somebody else put there does not last.
 *
 * `reading` is Quill 1, TinyMCE and ProseMirror's fallback: the browser edits
 * and the editor reads the result back one paragraph per block, with text in
 * an element collapsed the way HTML collapses it. It ignores a paste event
 * that has nothing behind it, as those do.
 *
 * What each would submit is `submitted(id)`, and it is the editor's answer,
 * not the element's.
 */
const EDITORS = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <div id="l-ctl">Why do you want to work at Acme?</div>
  <div id="ctl" contenteditable="true" aria-labelledby="l-ctl"></div>
  <div id="l-rev">Describe a project you are proud of.</div>
  <div id="rev" contenteditable="true" aria-labelledby="l-rev"></div>
  <div id="l-read">What would you change about our product?</div>
  <div id="read" contenteditable="true" aria-labelledby="l-read"><p><br></p></div>
</form>
<script>
  const models = {};
  window.submitted = (id) => models[id]();
  const draw = (root, paras) => root.replaceChildren(...paras.map((t) => {
    const p = document.createElement('p');
    if (t) p.textContent = t; else p.append(document.createElement('br'));
    return p;
  }));
  const spansAll = (root) => {
    const s = document.getSelection();
    return s.rangeCount > 0 && root.contains(s.anchorNode) && s.getRangeAt(0).toString() === root.textContent;
  };
  function modelled(root, { revert }) {
    let paras = [''];
    let all = false;
    let observer = null;
    const own = ['id', 'contenteditable', 'aria-labelledby'];
    const render = () => {
      observer?.disconnect();
      if (revert) for (const a of root.getAttributeNames()) if (!own.includes(a)) root.removeAttribute(a);
      draw(root, paras);
      observer?.observe(root, { childList: true, characterData: true, subtree: true });
    };
    const put = (text) => {
      const lines = text.split('\\n');
      paras = all ? lines : [...paras.slice(0, -1), paras[paras.length - 1] + lines[0], ...lines.slice(1)];
      render();
    };
    document.addEventListener('selectionchange', () => {
      if (root.contains(document.getSelection().anchorNode)) all = spansAll(root);
    });
    root.addEventListener('paste', (e) => { e.preventDefault(); put(e.clipboardData.getData('text/plain')); });
    root.addEventListener('beforeinput', (e) => {
      e.preventDefault();
      if (e.inputType === 'insertText') put(e.data ?? '');
      if (e.inputType === 'insertParagraph') put('\\n');
    });
    if (revert) {
      observer = new MutationObserver(render);
      root.addEventListener('focus', render);
    }
    else root.addEventListener('input', render);
    // Something already written in it, with the caret left at the end.
    paras = ['Old words the person typed.'];
    render();
    models[root.id] = () => paras;
  }
  modelled(document.getElementById('ctl'), { revert: false });
  modelled(document.getElementById('rev'), { revert: true });
  const read = document.getElementById('read');
  let readParas = [];
  new MutationObserver(() => {
    readParas = [...read.childNodes].map((n) => (n.textContent ?? '').replace(/\\s+/g, ' ').trim());
  }).observe(read, { childList: true, characterData: true, subtree: true });
  models.read = () => readParas;
</script>
</body></html>`;

/*
 * Quill 1 as it draws itself, with its own stylesheet's rules for the two
 * parts: the editor, and beside it the contenteditable it catches pastes in,
 * put 100000px off the left of the page. Something already typed into the
 * editor, which is the moment the question watcher reads the page again.
 */
const QUILL_ONE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title>
<style>
  .ql-container { position: relative; height: 100%; }
  .ql-clipboard { left: -100000px; height: 1px; overflow-y: hidden; position: absolute; top: 50%; }
</style></head><body>
<form>
  <label id="l-why">Why do you want to work at Acme?</label>
  <div id="editor" class="ql-container ql-snow">
    <div class="ql-editor" contenteditable="true" aria-labelledby="l-why"><p>I like the team and the mission.</p></div>
    <div class="ql-clipboard" contenteditable="true" tabindex="-1"></div>
  </div>
</form></body></html>`;

/*
 * CKEditor 5 put on two textareas, as it draws itself (the toolbar cut down to
 * one button): the page's label and the textarea it names, hidden, and
 * straight after it the editor, whose editing box has a label of its own that
 * is the same on every CKEditor there is. The second one is the cover letter.
 */
const CKEDITED = `<!doctype html><html><head><meta charset="utf-8"><title>Apply</title></head><body>
<form>
  <label for="why">Why do you want to work at Acme? *</label>
  <textarea id="why" name="why" style="display: none;"></textarea>
  <div class="ck ck-reset ck-editor ck-rounded-corners" role="application" aria-labelledby="ck-editor__label_1">
    <label class="ck ck-label ck-voice-label" id="ck-editor__label_1">Rich Text Editor</label>
    <div class="ck ck-editor__top ck-reset_all" role="presentation">
      <div class="ck ck-toolbar" role="toolbar" aria-label="Editor toolbar"><button class="ck ck-button" type="button"><span class="ck ck-button__label">Bold</span></button></div>
    </div>
    <div class="ck ck-editor__main" role="presentation">
      <div class="ck-blurred ck ck-content ck-editor__editable ck-rounded-corners ck-editor__editable_inline" lang="en" dir="ltr" role="textbox" aria-label="Editor editing area: main. Press Alt+0 for help." contenteditable="true"><p><br data-cke-filler="true"></p></div>
    </div>
  </div>
  <label for="cover">Cover Letter</label>
  <textarea id="cover" name="cover_letter" style="display: none;"></textarea>
  <div class="ck ck-reset ck-editor ck-rounded-corners" role="application" aria-labelledby="ck-editor__label_2">
    <label class="ck ck-label ck-voice-label" id="ck-editor__label_2">Rich Text Editor</label>
    <div class="ck ck-editor__main" role="presentation">
      <div class="ck-blurred ck ck-content ck-editor__editable ck-rounded-corners ck-editor__editable_inline" lang="en" dir="ltr" role="textbox" aria-label="Editor editing area: main. Press Alt+0 for help." contenteditable="true"><p><br data-cke-filler="true"></p></div>
    </div>
  </div>
</form></body></html>`;

/*
 * When the degree ends, in the words forms actually use for it. "Expected
 * degree completion" was taken for the degree itself and given "Bachelor of
 * Science"; "End date (graduation)" and "Class of" got nothing.
 */
const COMPLETION = `<!doctype html><form>
  <label for="c1">Expected degree completion</label><input id="c1">
  <label for="c2">Degree completion date</label><input id="c2">
  <label for="c3">End date (graduation)</label><input id="c3">
  <label for="c4">Class of</label><input id="c4">
  <label for="c5">Graduating class</label><input id="c5">
  <label for="c6">Project completion date</label><input id="c6">
  <label for="c7">Degree</label><input id="c7">
</form>`;

/*
 * A graduation date asked as a list. Campus recruiting forms ask by term —
 * "Spring 2027" — and others by number; May 2027 matched none of them.
 */
const TERMS = `<!doctype html><form>
  <label for="t1">Expected graduation</label>
  <select id="t1"><option value="">Select...</option><option>Fall 2026</option><option>Spring 2027</option><option>Summer 2027</option></select>
  <label for="t2">Graduation date</label>
  <select id="t2"><option value="">Select...</option><option>04/2027</option><option>05/2027</option><option>06/2027</option></select>
  <label for="t3">Anticipated graduation</label>
  <select id="t3"><option value="">Select...</option><option>Spring 2026</option><option>Fall 2027</option></select>
  <label for="t4">Graduation date</label>
  <select id="t4"><option value="">Select...</option><option>2027-04</option><option>2027-05</option></select>
</form>`;

/*
 * Link boxes that arrive holding the start of an address. Read as already
 * answered, they were left at "https://" — which submits as a LinkedIn
 * profile of nothing.
 */
const PREFIXED = `<!doctype html><form>
  <label for="p1">LinkedIn profile</label><input id="p1" value="https://">
  <label for="p2">LinkedIn URL</label><input id="p2" value="https://www.linkedin.com/in/">
  <label for="p3">GitHub</label><input id="p3" value="https://github.com/">
  <label for="p4">Website</label><input id="p4" value="https://someone-else.dev">
  <label for="p5">Phone</label><input id="p5" type="tel" value="+1">
  <label for="p6">Mobile number</label><input id="p6" type="tel" value="+1 617 555 0199">
</form>`;

/*
 * Workday's "My Information" step, in its own markup: every choice a button
 * that opens a listbox, the state's id `address--countryRegion` — Workday's
 * own name for it — and the phone's country code a multiselect already
 * holding "United States of America (+1)". Lists close on Escape, as
 * Workday's do.
 *
 * Reported: autofill "stalled at the country of the phone number", with State
 * and Phone Device Type still reading "Select One". Measured on this page, it
 * pressed the Country dropdown that already said "United States of America",
 * found no option spelled "United States" in time, reported the country as
 * one to pick by hand, and never tried the State at all — the id's "country"
 * made the box labelled State read as the country question.
 */
/*
 * Greenhouse's current education block, as its react-select behaves on the
 * live board (measured on job-boards.greenhouse.io/spacex): nothing is
 * offered until the menu is opened by a press on the control — typing into a
 * closed one changes nothing — the school list is a search against the
 * board's API that takes a moment to answer, and Degree and Discipline are
 * fixed lists that filter by what is typed, as react-select's do. So typing
 * "Bachelor of Science" into the degree filters out "Bachelor's Degree",
 * which is the answer spelled the form's way.
 *
 * Reported: "didn't correctly fill in university history". All three were
 * left on "Select...".
 *
 * Each box sits in a `select__input-container`, as the live board's does —
 * measured there — and without it this page passed while the board did not:
 * that empty wrapper says "select", was taken for the control, and every
 * choice made on the board was reported as still to pick.
 */
const GREENHOUSE_EDUCATION = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — SpaceX</title></head><body>
<form id="application-form">
  <label id="country-label" for="country">Country<span>*</span></label>
  <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <div class="select__input-container" data-value=""><input id="country" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="country-label" autocomplete="off"></div></div></div></div>
  <div class="education--form">
    <label id="school--0-label" for="school--0">School<span>*</span></label>
    <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
      <div class="select__input-container" data-value=""><input id="school--0" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="school--0-label" autocomplete="off"></div></div></div></div>
    <label id="degree--0-label" for="degree--0">Degree<span>*</span></label>
    <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
      <div class="select__input-container" data-value=""><input id="degree--0" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="degree--0-label" autocomplete="off"></div></div></div></div>
    <label id="discipline--0-label" for="discipline--0">Discipline<span>*</span></label>
    <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
      <div class="select__input-container" data-value=""><input id="discipline--0" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="discipline--0-label" autocomplete="off"></div></div></div></div>
  </div>
</form>
<script>
  function select(id, { search = null, fixed = null, delay = 0, shows = (text) => text }) {
    const input = document.getElementById(id);
    const control = input.closest('.select__control');
    let open = false;
    let list = null;
    let asked = 0;
    const close = () => { list?.remove(); list = null; open = false; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-controls'); };
    const render = (items) => {
      list?.remove();
      list = document.createElement('div');
      list.id = 'react-select-' + id + '-listbox';
      list.setAttribute('role', 'listbox');
      for (const text of items) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.className = 'select__option';
        o.textContent = text;
        o.addEventListener('mousedown', (e) => {
          e.preventDefault();
          control.querySelector('.select__placeholder')?.remove();
          let shown = control.querySelector('.select__single-value');
          if (!shown) {
            shown = document.createElement('div');
            shown.className = 'select__single-value';
            control.querySelector('.select__value-container').prepend(shown);
          }
          shown.textContent = shows(text);
          control.dataset.chosen = text;
          input.value = '';
          close();
        });
        list.append(o);
      }
      control.parentElement.append(list);
      input.setAttribute('aria-controls', list.id);
    };
    const load = (term) => {
      const mine = ++asked;
      if (fixed) return render(fixed.filter((t) => t.toLowerCase().includes(term)));
      list?.remove();
      setTimeout(() => { if (open && mine === asked) render(search(term)); }, delay);
    };
    control.addEventListener('mousedown', () => {
      if (open) return;
      open = true;
      input.setAttribute('aria-expanded', 'true');
      load('');
    });
    input.addEventListener('input', () => { if (open) load(input.value.toLowerCase()); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  const SCHOOLS = ['Acadia University', 'Adelphi University', 'University of Texas at Arlington', 'University of Texas at Austin', 'University of Texas at Dallas'];
  select('school--0', { search: (term) => (term ? SCHOOLS.filter((s) => s.toLowerCase().includes(term)) : SCHOOLS.slice(0, 2)), delay: 1200 });
  select('degree--0', { fixed: ['High School', "Associate's Degree", "Bachelor's Degree", "Master's Degree", 'Doctor of Philosophy (Ph.D.)'] });
  select('discipline--0', { fixed: ['Computer Engineering', 'Computer Science', 'Mechanical Engineering'] });
  // The country beside the phone, which Greenhouse lists with each dialling code.
  // Drawn, once chosen, as the dialling code alone — "+1" — as the live board draws it.
  select('country', { fixed: ['United States +1', 'Afghanistan +93', 'American Samoa +1', 'United States Minor Outlying Islands +1'], shows: (t) => t.replace(/^.*\\s(\\+\\d+)$/, '$1') });
</script>
</body></html>`;

/*
 * Stripe's Greenhouse embed (job-boards.greenhouse.io/embed/job_app?for=stripe),
 * as its react-select widgets behave there — each of these measured on it:
 *
 * - A choice is made on mousedown of an option, and only then: the
 *   placeholder "Select..." is replaced by a `select__single-value`, the box
 *   is emptied, the menu closes. Typed text is not a choice, and on blur the
 *   box is emptied again and the placeholder is back.
 * - School, Degree and Discipline are each fetched from the board's API when
 *   the menu first opens (`/education/degrees?page=1` and so on), and until
 *   the answer comes the control shows a spinner and the menu says
 *   "Loading...". Degrees took 450 to 900ms, schools about 500, disciplines
 *   about 350. Typing asks the API again with the term: "Bachelor of Science"
 *   finds nothing, since the entry is "Bachelor's Degree".
 * - The work-authorization and sponsorship questions are lists of a Yes and a
 *   No, each written out as a sentence.
 * - Under the education block, a plain box for a school the list does not
 *   have, labelled in exactly these words.
 *
 * `?ignored` makes the school's options close the menu on a press without
 * choosing anything — a press the widget did not act on, which is what the
 * read-back in `tookIt` exists to catch.
 */
const GREENHOUSE_STRIPE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Stripe</title></head><body>
<form id="application-form">
  <div class="education--form">
    <label id="school--0-label" for="school--0">School<span>*</span></label>
    <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
      <div class="select__input-container" data-value=""><input id="school--0" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="school--0-label" aria-required="true" autocomplete="off"></div></div><div class="select__indicators"></div></div></div>
    <label id="degree--0-label" for="degree--0">Degree<span>*</span></label>
    <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
      <div class="select__input-container" data-value=""><input id="degree--0" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="degree--0-label" aria-required="true" autocomplete="off"></div></div><div class="select__indicators"></div></div></div>
    <label id="discipline--0-label" for="discipline--0">Discipline<span>*</span></label>
    <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
      <div class="select__input-container" data-value=""><input id="discipline--0" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="discipline--0-label" aria-required="true" autocomplete="off"></div></div><div class="select__indicators"></div></div></div>
  </div>
  <div class="text-input-wrapper"><div class="input-wrapper">
    <label id="question_68843617-label" for="question_68843617">We are always aiming to keep our school list inclusive of all institutions. If you did not see your University listed in the previous question, please let us know your school name here.</label>
    <input id="question_68843617" type="text" maxlength="255" aria-required="false" aria-label="We are always aiming to keep our school list inclusive of all institutions. If you did not see your University listed in the previous question, please let us know your school name here.">
  </div></div>
  <label id="question_68702648-label" for="question_68702648">Are you currently eligible to work in the United States?<span>*</span></label>
  <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <div class="select__input-container" data-value=""><input id="question_68702648" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="question_68702648-label" aria-required="true" autocomplete="off"></div></div><div class="select__indicators"></div></div></div>
  <label id="question_68581559-label" for="question_68581559">Do you require visa sponsorship, now or in the future, to continue working in the United States?<span>*</span></label>
  <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <div class="select__input-container" data-value=""><input id="question_68581559" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="question_68581559-label" aria-required="true" autocomplete="off"></div></div><div class="select__indicators"></div></div></div>
</form>
<script>
  function select(id, { fetch, delay = 0, ignores = false }) {
    const input = document.getElementById(id);
    const control = input.closest('.select__control');
    const shell = control.parentElement;
    let open = false;
    let list = null;
    let asked = 0;
    const listbox = () => {
      if (!list) {
        list = document.createElement('div');
        list.id = 'react-select-' + id + '-listbox';
        list.setAttribute('role', 'listbox');
        shell.append(list);
        input.setAttribute('aria-controls', list.id);
      }
      list.replaceChildren();
      return list;
    };
    const spinner = (on) => {
      control.querySelector('.select__loading-indicator')?.remove();
      if (on) control.querySelector('.select__indicators').insertAdjacentHTML('afterbegin', '<div class="select__loading-indicator" aria-hidden="true">…</div>');
    };
    const close = () => { list?.remove(); list = null; open = false; spinner(false); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-controls'); };
    const choose = (text) => {
      control.querySelector('.select__placeholder')?.remove();
      let shown = control.querySelector('.select__single-value');
      if (!shown) {
        shown = document.createElement('div');
        shown.className = 'select__single-value';
        control.querySelector('.select__value-container').prepend(shown);
      }
      shown.textContent = text;
      input.value = '';
      close();
    };
    const render = (items) => {
      spinner(false);
      const l = listbox();
      if (!items.length) l.insertAdjacentHTML('beforeend', '<div class="select__menu-notice select__menu-notice--no-options">No options</div>');
      for (const text of items) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.className = 'select__option';
        o.textContent = text;
        o.addEventListener('mousedown', (e) => {
          e.preventDefault();
          if (ignores) return close();
          choose(text);
        });
        l.append(o);
      }
    };
    const load = (term) => {
      const mine = ++asked;
      spinner(true);
      listbox().insertAdjacentHTML('beforeend', '<div class="select__menu-notice select__menu-notice--loading">Loading...</div>');
      setTimeout(() => { if (open && mine === asked) render(fetch(term)); }, delay);
    };
    control.addEventListener('mousedown', () => {
      if (open) return;
      open = true;
      input.setAttribute('aria-expanded', 'true');
      load('');
    });
    input.addEventListener('input', () => { if (open) load(input.value.toLowerCase()); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    // react-select's input-blur: whatever was typed goes, and so does the menu.
    input.addEventListener('blur', () => { input.value = ''; close(); });
  }
  const search = (all, first) => (term) => (term ? all.filter((s) => s.toLowerCase().includes(term)) : all.slice(0, first));
  const SCHOOLS = ['Aalto University', 'Abilene Christian University', 'Acadia University', 'Northeastern Illinois University', 'Northeastern University', 'Northwestern University'];
  const DEGREES = ["Associate's Degree", "Bachelor's Degree", 'Doctor of Medicine (M.D.)', 'Doctor of Philosophy (Ph.D.)', "Engineer's Degree", 'High School', 'Juris Doctor (J.D.)', 'Master of Business Administration (M.B.A.)', "Master's Degree", 'Other'];
  const DISCIPLINES = ['Computer Engineering', 'Computer Science', 'Mechanical Engineering'];
  const ignored = new URLSearchParams(location.search).has('ignored');
  select('school--0', { fetch: search(SCHOOLS, 3), delay: 500, ignores: ignored });
  select('degree--0', { fetch: search(DEGREES, 10), delay: 900 });
  select('discipline--0', { fetch: search(DISCIPLINES, 3), delay: 350 });
  select('question_68702648', { fetch: () => ['Yes, I am currently eligible to work in the location where this role is based.', 'No, I am not currently eligible to work in the location where this role is based.'] });
  select('question_68581559', { fetch: () => ['Yes, I will require visa sponsorship now or in the future to continue working in the country where this role is based.', 'No, I do not require visa sponsorship now or in the future to continue working in the country where this role is based.'] });
</script>
</body></html>`;

/*
 * Greenhouse's Education section with its "Add another", as the new boards
 * draw it — measured on SpaceX, Stripe's embed, Twitch and Robinhood
 * (job-boards.greenhouse.io): one `education--container`, an `education--form`
 * per school headed by a `<p>Education</p>` (not a heading element), and
 * after the last one `<button type="button" class="add-another-button">`.
 * A block is School, Degree and Discipline as react-select widgets, a Start
 * date month widget and a Start date year `type=number` box, and the same two
 * for the end — Twitch's full set; ids `school--0`, `start-month--0`,
 * `start-year--0`, `end-year--0` and so on. Pressing the button appends a
 * block whose ids end `--1`, and so on.
 *
 * The widgets behave as `GREENHOUSE_STRIPE`'s do: nothing until the menu is
 * opened, a list that says "Loading..." until it arrives, a choice on
 * mousedown drawn as a `select__single-value`, and what was typed emptied on
 * blur. The delays are shorter than the board's, which only makes this page
 * quicker to fill.
 *
 * Above it, a work history with an "Add another" of its own, first on the
 * page — the button nothing here may press. `?levels` labels each block by
 * the level it asks about, the first "Undergraduate" and every one added
 * "Graduate"; `?chosen` arrives with a second block already showing a school
 * (Acadia University, or the one named), and `&degree=` a degree in it too.
 * `?first=` arrives with the first block's school already chosen, and
 * `?dated` with its Start date already January 2022.
 */
const GREENHOUSE_MORE_EDUCATION = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Twitch</title></head><body>
<form id="application-form">
  <label for="first_name">First Name</label><input id="first_name" type="text">
  <div class="employment--container">
    <div class="employment--form"><hr><div class="employment--header"><p class="body body--medium">Employment</p></div>
      <label for="company-name--0">Company name</label><input id="company-name--0" type="text">
      <label for="title--0">Title</label><input id="title--0" type="text">
    </div>
    <button class="add-another-button" type="button" id="employment-add">Add another</button>
  </div>
  <div class="education--container" id="education"><button class="add-another-button" type="button" id="education-add">Add another</button></div>
</form>
<script>
  window.__pressed = { education: 0, employment: 0 };
  function select(id, { fetch, delay = 0 }) {
    const input = document.getElementById(id);
    const control = input.closest('.select__control');
    const shell = control.parentElement;
    let open = false;
    let list = null;
    let asked = 0;
    const listbox = () => {
      if (!list) {
        list = document.createElement('div');
        list.id = 'react-select-' + id + '-listbox';
        list.setAttribute('role', 'listbox');
        shell.append(list);
        input.setAttribute('aria-controls', list.id);
      }
      list.replaceChildren();
      return list;
    };
    const spinner = (on) => {
      control.querySelector('.select__loading-indicator')?.remove();
      if (on) control.querySelector('.select__indicators').insertAdjacentHTML('afterbegin', '<div class="select__loading-indicator" aria-hidden="true">…</div>');
    };
    const close = () => { list?.remove(); list = null; open = false; spinner(false); input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-controls'); };
    const choose = (text) => {
      control.querySelector('.select__placeholder')?.remove();
      let shown = control.querySelector('.select__single-value');
      if (!shown) {
        shown = document.createElement('div');
        shown.className = 'select__single-value';
        control.querySelector('.select__value-container').prepend(shown);
      }
      shown.textContent = text;
      input.value = '';
      close();
    };
    const render = (items) => {
      spinner(false);
      const l = listbox();
      if (!items.length) l.insertAdjacentHTML('beforeend', '<div class="select__menu-notice select__menu-notice--no-options">No options</div>');
      for (const text of items) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.className = 'select__option';
        o.textContent = text;
        o.addEventListener('mousedown', (e) => { e.preventDefault(); choose(text); });
        l.append(o);
      }
    };
    const load = (term) => {
      const mine = ++asked;
      spinner(true);
      listbox().insertAdjacentHTML('beforeend', '<div class="select__menu-notice select__menu-notice--loading">Loading...</div>');
      setTimeout(() => { if (open && mine === asked) render(fetch(term)); }, delay);
    };
    control.addEventListener('mousedown', () => {
      if (open) return;
      open = true;
      input.setAttribute('aria-expanded', 'true');
      load('');
    });
    input.addEventListener('input', () => { if (open) load(input.value.toLowerCase()); });
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    input.addEventListener('blur', () => { input.value = ''; close(); });
    return choose;
  }
  const search = (all, first) => (term) => (term ? all.filter((s) => s.toLowerCase().includes(term)) : all.slice(0, first));
  const SCHOOLS = ['Aalto University', 'Acadia University', 'Boston College', 'Boston Latin School', 'Boston University', 'Northeastern Illinois University', 'Northeastern University'];
  const DEGREES = ["Associate's Degree", "Bachelor's Degree", 'Doctor of Philosophy (Ph.D.)', 'High School', "Master's Degree", 'Other'];
  const DISCIPLINES = ['Computer Engineering', 'Computer Science', 'Mechanical Engineering'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const query = new URLSearchParams(location.search);
  const widget = (id, label) => \`
    <div class="select"><div class="select__container"><label id="\${id}-label" for="\${id}" class="label select__label">\${label}</label>
      <div class="select-shell"><div><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
        <div class="select__input-container" data-value=""><input class="select__input" id="\${id}" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="\${id}-label" autocomplete="off"></div></div>
        <div class="select__indicators"><button type="button" class="icon-button icon-button--sm" aria-label="Toggle flyout" tabindex="-1">v</button></div></div></div>
        <input required tabindex="-1" aria-hidden="true" class="requiredInput" value=""></div></div></div>\`;
  const year = (id, label) => \`
    <div class="text-input-wrapper"><div class="input-wrapper"><label id="\${id}-label" for="\${id}" class="label">\${label}</label>
      <input id="\${id}" class="input input__single-line" aria-label="\${label}" type="number"></div></div>\`;
  function addBlock() {
    const n = document.querySelectorAll('.education--form').length;
    const level = query.has('levels') ? (n === 0 ? 'Undergraduate ' : 'Graduate ') : '';
    const block = document.createElement('div');
    block.className = 'education--form';
    block.innerHTML = '<hr><div class="education--header"><p class="body body--medium">Education</p></div>' +
      widget('school--' + n, level + 'School') + widget('degree--' + n, level + 'Degree') + widget('discipline--' + n, level ? level + 'Major' : 'Discipline') +
      '<div class="education--date-container">' + widget('start-month--' + n, 'Start date month') + year('start-year--' + n, 'Start date year') + '</div>' +
      '<div class="education--date-container">' + widget('end-month--' + n, 'End date month') + year('end-year--' + n, 'End date year') + '</div>';
    document.getElementById('education-add').before(block);
    const school = select('school--' + n, { fetch: search(SCHOOLS, 3), delay: 250 });
    const degree = select('degree--' + n, { fetch: search(DEGREES, 10), delay: 300 });
    select('discipline--' + n, { fetch: search(DISCIPLINES, 3), delay: 150 });
    const startMonth = select('start-month--' + n, { fetch: search(MONTHS, 12) });
    select('end-month--' + n, { fetch: search(MONTHS, 12) });
    return { school, degree, startMonth };
  }
  // The board adds the block a moment after the press, as React renders it.
  document.getElementById('education-add').addEventListener('click', () => { __pressed.education++; setTimeout(addBlock, 120); });
  document.getElementById('employment-add').addEventListener('click', () => {
    __pressed.employment++;
    const n = document.querySelectorAll('.employment--form').length;
    const form = document.querySelector('.employment--form').cloneNode(true);
    form.querySelectorAll('[id]').forEach((el) => { el.id = el.id.replace(/--\\d+$/, '--' + n); });
    form.querySelectorAll('[for]').forEach((el) => el.setAttribute('for', el.getAttribute('for').replace(/--\\d+$/, '--' + n)));
    document.getElementById('employment-add').before(form);
  });
  const first = addBlock();
  if (query.has('first')) first.school(query.get('first'));
  if (query.has('dated')) {
    first.startMonth('January');
    document.getElementById('start-year--0').value = '2022';
  }
  if (query.has('chosen')) {
    const begun = addBlock();
    begun.school(query.get('chosen') || 'Acadia University');
    if (query.get('degree')) begun.degree(query.get('degree'));
  }
</script>
</body></html>`;

const WORKDAY_MY_INFO = `<!doctype html><html><head><meta charset="utf-8"><title>My Information</title></head><body>
<div data-automation-id="applyFlowMyInfoPage">
<div data-automation-id="formField-country"><label for="country--country">Country<abbr>*</abbr></label>
  <button type="button" id="country--country" aria-haspopup="listbox" aria-label="Country United States of America Required">United States of America</button></div>
<h3>Address</h3>
<div data-automation-id="formField-addressLine1"><label for="address--addressLine1">Address Line 1<abbr>*</abbr></label><input id="address--addressLine1" type="text"></div>
<div data-automation-id="formField-city"><label for="address--city">City<abbr>*</abbr></label><input id="address--city" type="text"></div>
<div data-automation-id="formField-countryRegion"><label for="address--countryRegion">State<abbr>*</abbr></label>
  <button type="button" id="address--countryRegion" aria-haspopup="listbox" aria-label="State Select One Required">Select One</button></div>
<div data-automation-id="formField-postalCode"><label for="address--postalCode">Postal Code<abbr>*</abbr></label><input id="address--postalCode" type="text"></div>
<h3>Phone</h3>
<div data-automation-id="formField-phoneType"><label for="phoneNumber--phoneType">Phone Device Type<abbr>*</abbr></label>
  <button type="button" id="phoneNumber--phoneType" aria-haspopup="listbox" aria-label="Phone Device Type Select One Required">Select One</button></div>
<div data-automation-id="formField-countryPhoneCode"><label for="phoneNumber--countryPhoneCode">Country Phone Code<abbr>*</abbr></label>
  <div data-automation-id="multiSelectContainer"><div data-automation-id="multiselectInputContainer">
    <ul role="listbox" aria-label="items selected" data-automation-id="selectedItemList">
      <li role="presentation"><div role="option" aria-selected="true" data-automation-id="selectedItem" title="United States of America (+1)"><p data-automation-id="promptOption">United States of America (+1)</p></div></li>
    </ul>
    <input id="phoneNumber--countryPhoneCode" data-uxi-widget-type="selectinput" type="text" placeholder="Search" role="combobox" aria-expanded="false" autocomplete="off">
    <span data-automation-id="promptIcon" role="button" aria-label="select list">≡</span>
  </div></div></div>
<div data-automation-id="formField-phoneNumber"><label for="phoneNumber--phoneNumber">Phone Number<abbr>*</abbr></label><input id="phoneNumber--phoneNumber" type="text"></div>
</div>
<script>
  window.__log = [];
  const LISTS = {
    'country--country': ['Canada', 'United States of America'],
    'address--countryRegion': ['Texas', 'Virginia', 'Massachusetts'],
    'phoneNumber--phoneType': ['Home', 'Mobile', 'Work'],
  };
  const close = () => document.querySelector('#popup')?.remove();
  for (const id of Object.keys(LISTS)) {
    const btn = document.getElementById(id);
    btn.addEventListener('click', () => {
      __log.push('pressed ' + id);
      close();
      const ul = document.createElement('ul');
      ul.id = 'popup';
      ul.setAttribute('role', 'listbox');
      for (const text of LISTS[id]) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        li.textContent = text;
        li.addEventListener('click', () => { btn.textContent = text; close(); });
        ul.append(li);
      }
      document.body.append(ul);
    });
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  const code = document.getElementById('phoneNumber--countryPhoneCode');
  code.addEventListener('input', () => __log.push('typed into the country phone code: ' + code.value));
  code.addEventListener('focus', () => __log.push('focused the country phone code'));
</script>
</body></html>`;

/*
 * Workday's My Experience step, as far as a work history goes: a block per
 * job, each a group headed "Work Experience N", with Job Title, Company,
 * Location, "I currently work here", From and To as a month box and a year
 * box each, and Role Description. The ids are Workday's own shape.
 */
const workdayJob = (n, typed = {}) => `
  <div role="group" aria-labelledby="we-${n}" data-automation-id="workExperience-${n}">
    <h4 id="we-${n}">Work Experience ${n}</h4>
    <label for="workExperience-${n}--jobTitle">Job Title<abbr title="required">*</abbr></label>
    <input type="text" id="workExperience-${n}--jobTitle" value="${typed.title ?? ''}">
    <label for="workExperience-${n}--companyName">Company<abbr title="required">*</abbr></label>
    <input type="text" id="workExperience-${n}--companyName" value="${typed.company ?? ''}">
    <label for="workExperience-${n}--location">Location</label>
    <input type="text" id="workExperience-${n}--location">
    <input type="checkbox" id="workExperience-${n}--currentlyWorkHere">
    <label for="workExperience-${n}--currentlyWorkHere">I currently work here</label>
    ${['startDate', 'endDate'].map((d) => `
    <div><label id="workExperience-${n}--${d}-label">${d === 'startDate' ? 'From' : 'To'}<abbr title="required">*</abbr></label>
      <div role="group" aria-labelledby="workExperience-${n}--${d}-label">
        <input type="text" role="spinbutton" aria-label="Month" placeholder="MM" id="workExperience-${n}--${d}-month">
        <input type="text" role="spinbutton" aria-label="Year" placeholder="YYYY" id="workExperience-${n}--${d}-year">
      </div></div>`).join('')}
    <label for="workExperience-${n}--roleDescription">Role Description</label>
    <textarea id="workExperience-${n}--roleDescription">${typed.description ?? ''}</textarea>
  </div>`;
const WORKDAY_EXPERIENCE = `<!doctype html><html><head><meta charset="utf-8"><title>My Experience</title></head><body>
<h2>My Experience</h2>
<div role="group" aria-labelledby="we-head"><h3 id="we-head">Work Experience</h3>${workdayJob(1)}${workdayJob(2)}</div>
<label for="why">Why do you want to work on this team?</label><textarea id="why"></textarea>
</body></html>`;
const WORKDAY_EXPERIENCE_BEGUN = `<!doctype html><html><head><meta charset="utf-8"><title>My Experience</title></head><body>
<div role="group" aria-labelledby="we-head"><h3 id="we-head">Work Experience</h3>${workdayJob(1, { company: 'Acme' })}${workdayJob(2, { description: 'My own words about it.' })}${workdayJob(3, { company: 'Globex' })}</div>
<label for="project">Project description</label><textarea id="project"></textarea>
</body></html>`;
const JOBS = [
  {
    company: 'Vega Analytics',
    title: 'Backend Engineer',
    location: 'Boston, MA',
    start: { year: 2023, month: 6 },
    current: true,
    description: '• Built a Kafka pipeline handling 2M events/day\n• Cut latency from 900ms to 180ms',
  },
  {
    company: 'Acme Co.',
    title: 'Software Engineer Co-op',
    location: 'Boston, MA',
    start: { year: 2022, month: 7 },
    end: { year: 2022, month: 12 },
    current: false,
    description: '• Raised coverage from 41% to 88%',
  },
];

/*
 * The name *of* something, as Datadog's Greenhouse board asks it — measured
 * live on job-boards.greenhouse.io/embed/job_app?for=datadog, where the
 * applicant's own name was typed into the first of these. The others are the
 * same shape on the same kind of board: a thing's name, not a person's.
 */
const NAME_OF_A_THING = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Datadog</title></head><body>
<form id="application-form">
  <label for="first_name">First Name*</label><input id="first_name" type="text">
  <label for="question_69008301">Please share the full name of your major/final year specialization(s) as it would appear on your diploma.*</label>
  <input id="question_69008301" type="text" aria-required="true">
  <label for="q_school">Full name of your university (no abbreviations)</label><input id="q_school" type="text">
  <label for="q_company">Legal name of the company you work for now</label><input id="q_company" type="text">
  <label for="q_full">Full Legal Name*</label><input id="q_full" type="text">
  <label for="q_yours">Your name</label><input id="q_yours" type="text">
</form></body></html>`;

/*
 * A yes/no about a country the old list did not know, as Affirm's Greenhouse
 * board asks it (measured live, job-boards.greenhouse.io/affirm): the
 * sponsorship question as a react-select whose options are Yes and No, beside
 * the same question about the US on another board. The Spanish one was
 * answered "No" from a profile that only said it needs none in the US.
 */
const COUNTRY_NAMED = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Affirm</title></head><body>
<form id="application-form">
  <label id="q_es-label" for="q_es">Do you now or in the future require sponsorship for employment visa status in Spain?*</label>
  <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <div class="select__input-container" data-value=""><input id="q_es" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="q_es-label" autocomplete="off"></div></div></div></div>
  <label for="q_br">Are you authorized to work in Brazil?</label>
  <select id="q_br"><option value="">Select...</option><option>Yes</option><option>No</option></select>
  <label for="q_us">Are you legally authorized to work in the United States?</label>
  <select id="q_us"><option value="">Select...</option><option>Yes</option><option>No</option></select>
</form>
<script>
  // The react-select shape of GREENHOUSE_EDUCATION, with a fixed Yes/No list.
  const input = document.getElementById('q_es');
  const control = input.closest('.select__control');
  control.addEventListener('mousedown', () => {
    if (document.getElementById('q_es-listbox')) return;
    const list = document.createElement('div');
    list.id = 'q_es-listbox';
    list.setAttribute('role', 'listbox');
    for (const text of ['Yes', 'No']) {
      const o = document.createElement('div');
      o.setAttribute('role', 'option');
      o.textContent = text;
      o.addEventListener('mousedown', (e) => {
        e.preventDefault();
        control.querySelector('.select__placeholder')?.remove();
        const shown = document.createElement('div');
        shown.className = 'select__single-value';
        shown.textContent = text;
        control.querySelector('.select__value-container').prepend(shown);
        list.remove();
      });
      list.append(o);
    }
    control.parentElement.append(list);
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', list.id);
  });
</script>
</body></html>`;

/*
 * Recruitee's telephone box, as it arrives on a Dutch company's board
 * (measured live on jobs.channable.com and personio.recruitee.com): a country
 * button beside a `type=tel` box that already holds the employer's own
 * dialling code, "+31" or "+49". The applicant lives somewhere else.
 */
const EMPLOYERS_CODE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — Channable</title></head><body>
<form><fieldset><legend>My information</legend>
  <label for="input-candidate.name-3">Full name *</label><input type="text" id="input-candidate.name-3" name="candidate.name" required>
  <label for="input-candidate.phone-5">Phone number *</label>
  <div><button type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Select country calling code: Netherlands">Netherlands</button>
  <input type="tel" name="candidate.phone" id="input-candidate.phone-5" placeholder="Your phone number" value="+31" required></div>
</fieldset></form></body></html>`;

/*
 * The same answer asked twice on one Greenhouse board, in the react-select
 * shape of GREENHOUSE_EDUCATION. Each pair was measured live with a fake
 * profile, and the second of it left on "Select...": GitLab's and Chime's
 * country of residence under the phone's country picker, Anthropic's second
 * sponsorship question under its first, and — Affirm's shape — the phone's
 * country picker under nothing at all once a text box had taken the country.
 * The second School is Greenhouse's second education block, which is
 * `fillEducation`'s to fill from the resume and must not be given the first.
 */
const ASKED_TWICE = `<!doctype html><html><head><meta charset="utf-8"><title>Apply — GitLab</title></head><body>
<form id="application-form">
  <label for="question_text_country">What country do you live in?</label><input id="question_text_country" type="text">
  <fieldset><legend>Phone</legend>
  ${['country:Country*', 'question_residence:What is your current country of residence?*', 'question_sp1:Do you require visa sponsorship?*',
    'question_sp2:Will you now or will you in the future require employment visa sponsorship to work in the country in which the job you are applying for is located?*']
    .map((pair) => { const [id, label] = pair.split(':'); return `<label id="${id}-label" for="${id}">${label}</label>
  <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <div class="select__input-container" data-value=""><input id="${id}" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="${id}-label" autocomplete="off"></div></div></div></div>`; }).join('\n  ')}
  </fieldset>
  <!-- One question in the ARIA 1.1 shape: a combobox <div> around its own list box. -->
  <label id="question_wrapped-label">Will you need us to sponsor a work visa?*</label>
  <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <div id="question_wrapped_outer" role="combobox" aria-haspopup="listbox" aria-labelledby="question_wrapped-label">
    <input id="question_wrapped" class="select__input" aria-autocomplete="list" aria-expanded="false" aria-labelledby="question_wrapped-label" autocomplete="off"></div></div></div></div>
  ${[0, 1].map((n) => `<div class="education--form"><label id="school--${n}-label" for="school--${n}">School</label>
  <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
    <div class="select__input-container" data-value=""><input id="school--${n}" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="school--${n}-label" autocomplete="off"></div></div></div></div></div>`).join('\n  ')}
</form>
<script>
  function select(id, fixed) {
    const input = document.getElementById(id);
    const control = input.closest('.select__control');
    let list = null;
    const close = () => { list?.remove(); list = null; input.setAttribute('aria-expanded', 'false'); };
    const render = (items) => {
      list?.remove();
      list = document.createElement('div');
      list.id = 'react-select-' + id + '-listbox';
      list.setAttribute('role', 'listbox');
      for (const text of items) {
        const o = document.createElement('div');
        o.setAttribute('role', 'option');
        o.textContent = text;
        o.addEventListener('mousedown', (e) => {
          e.preventDefault();
          control.querySelector('.select__placeholder')?.remove();
          let shown = control.querySelector('.select__single-value');
          if (!shown) { shown = document.createElement('div'); shown.className = 'select__single-value'; control.querySelector('.select__value-container').prepend(shown); }
          shown.textContent = text;
          input.value = '';
          close();
        });
        list.append(o);
      }
      control.parentElement.append(list);
      input.setAttribute('aria-controls', list.id);
    };
    control.addEventListener('mousedown', () => { if (list) return; input.setAttribute('aria-expanded', 'true'); render(fixed); });
    input.addEventListener('input', () => { if (list) render(fixed.filter((t) => t.toLowerCase().includes(input.value.toLowerCase()))); });
  }
  select('country', ['Canada', 'United States']);
  select('question_residence', ['Canada', 'United States']);
  select('question_sp1', ['Yes', 'No']);
  select('question_sp2', ['Yes', 'No']);
  select('question_wrapped', ['Yes', 'No']);
  select('school--0', ['Acadia University', 'Northeastern University']);
  select('school--1', ['Acadia University', 'Northeastern University']);
</script>
</body></html>`;

const PAGES = { '/asked-twice': ASKED_TWICE, '/employers-code': EMPLOYERS_CODE, '/country-named': COUNTRY_NAMED, '/name-of-a-thing': NAME_OF_A_THING, '/prefixed': PREFIXED, '/terms': TERMS, '/completion': COMPLETION, '/ckedited': CKEDITED, '/quill-one': QUILL_ONE, '/editors': EDITORS, '/elsewhere': ELSEWHERE, '/paired-widgets': PAIRED_WIDGETS, '/stepped': STEPPED, '/widget-keys': WIDGET_KEYS, '/more-misread': MORE_MISREAD, '/loose-widgets': LOOSE_WIDGETS, '/academics': ACADEMICS, '/sections': SECTIONS, '/places': PLACES, '/widgets': WIDGETS, '/current': CURRENT, '/graduation': GRADUATION, '/apply': FORM, '/not-yours': NOT_YOURS, '/react': REACT_FORM, '/awkward': AWKWARD, '/consent': CONSENT, '/labels': LABELS, '/legacy': LEGACY, '/hidden': HIDDEN, '/unhidden': UNHIDDEN, '/submits-nothing': SUBMITS_NOTHING, '/flat': FLAT_QUESTIONS, '/styled': STYLED_RADIOS, '/phrases': PHRASE_ANSWERS, '/remembered': REMEMBERED, '/ashby-yes-no': ASHBY_YES_NO, '/misread': MISREAD, '/workday-info': WORKDAY_MY_INFO, '/greenhouse-education': GREENHOUSE_EDUCATION, '/greenhouse-stripe': GREENHOUSE_STRIPE, '/greenhouse-more-education': GREENHOUSE_MORE_EDUCATION, '/workday-experience': WORKDAY_EXPERIENCE, '/workday-experience-begun': WORKDAY_EXPERIENCE_BEGUN };

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
             'pref2', 'reloc', 'st', 'sal', 'dis-sig', 'eeo-sig', 'auth-any', 'both', 'able']
              .map((id) => [id, document.getElementById(id).value]),
          ),
          checked: document.querySelector('input[name="auth2"]:checked')?.value ?? '',
          able2: document.querySelector('input[name="able2"]:checked')?.value ?? '',
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
     * The same question with its first half in other words. Only the
     * sponsorship half matched, so it was answered as "do you need
     * sponsorship?" — and it asks the opposite. Measured against a profile
     * needing none: "Are you able to work in the U.S. without sponsorship?"
     * was answered "No", on the dropdown and on the radio buttons, telling
     * the employer the applicant cannot work there unsponsored. A profile
     * that does need sponsorship got "Yes", which is a false declaration of
     * the right to work.
     */
    check(
      'able to work without sponsorship is not answered from the sponsorship alone',
      mine.values.able === '' &&
        mine.skipped.some((s) => /^work_authorization:this one asks two things at once:.*able to work in the U\.S/.test(s)),
      `"${mine.values.able}"; ${mine.skipped.join(', ')}`,
    );
    check(
      'nor as radio buttons',
      mine.able2 === '' &&
        mine.skipped.some((s) => /^work_authorization:this one asks two things at once:.*Can you work/.test(s)),
      `checked "${mine.able2}"; ${mine.skipped.join(', ')}`,
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
          why: v('why'), why2: v('why2'), ext: v('ext'), contact: v('contact'), empmail: v('empmail'), tenure: v('tenure'), cpc: v('cpc'), say: v('say'), fulln: v('fulln'), fl1: v('fl1'), fl2: v('fl2'), fl3: v('fl3'), ln1: v('ln1'), ln2: v('ln2'), ln3: v('ln3'), ln4: v('ln4'), e1: v('e1'), e2: v('e2'), e3: v('e3'), e4: v('e4'), e5: v('e5'), f1: v('f1'), f2: v('f2'),
          st: v('st'), cs1: v('cs1'), cs2: v('cs2'), ctry: v('ctry'), ph: v('ph'), co: v('co'),
          auth: ticked('auth'), elig: ticked('elig'), applyin: ticked('applyin'), employ: ticked('employ'),
        };
      }, { b: base, profile: { ...PROFILE, address_state: 'MA', current_company: 'Acme', school: 'Northeastern University', location: 'Boston, MA' } }),
    );

    group('Words a pattern matches that are not asking for that field');
    check('"Please state your reason" is not given the applicant\'s state', misread.why === '', misread.why);
    check('nor is "State why you are interested"', misread.why2 === '', misread.why2);
    check('while a box labelled "State" still is', misread.st === 'MA', misread.st);
    /*
     * And a box asking for both. `city` came first and claimed it, so "City,
     * State" and "City/State" were given "Boston" — half of what was asked,
     * on a profile holding the other half.
     */
    check(
      '"City, State" is given the city and the state',
      misread.cs1 === 'Boston, MA' && misread.cs2 === 'Boston, MA',
      JSON.stringify([misread.cs1, misread.cs2]),
    );
    check(
      'the right-to-work question that says "country" is answered from the right to work',
      misread.auth === 'y',
      `ticked "${misread.auth}"`,
    );
    check('and so is "legally eligible to work"', misread.elig === 'y', `ticked "${misread.elig}"`);
    // Matched no key at all, so it was neither answered nor reported.
    check('and "eligible for employment in the US"', misread.employ === 'y', `ticked "${misread.employ}"`);
    /*
     * Read as "Which location are you applying for?", whose rule wants a place
     * and then "applying" a few words on, so the right-to-work question was
     * excluded — and an exclusion says nothing: a required question left blank
     * under a card that did not mention it.
     */
    check(
      'and "authorized to work in the country to which you are applying"',
      misread.applyin === 'y',
      `ticked "${misread.applyin}"`,
    );
    check('while a box labelled "Country" still gets the country', misread.ctry === 'United States', misread.ctry);
    check('a phone extension box is not given the whole number', misread.ext === '', misread.ext);
    check('while the phone box still is', misread.ph === '555-0100', misread.ph);
    check('"Can we contact your current employer?" is not given the employer', misread.contact === '', misread.contact);
    check('while "Current employer" still is', misread.co === 'Acme', misread.co);
    check('"Employer contact email" is not given the applicant\'s email', misread.empmail === '', misread.empmail);
    check('"Years at current company" is not given the employer', misread.tenure === '', misread.tenure);
    check('"Country phone code" is not given the whole number', misread.cpc === '', misread.cpc);
    check('"Pronunciation of your name" is not given the name', misread.say === '', misread.say);
    check('while "Full name" still is', misread.fulln === 'Jianwen Ding', misread.fulln);
    /*
     * One box asking for both halves. The first pattern to match claims a
     * field, and "First and Last Name" says "Last Name" whole, so it was given
     * the surname alone; "First Name and Last Name" the first name alone.
     */
    check(
      '"First and Last Name" is given the whole name, however the two are joined',
      [misread.fl1, misread.fl2, misread.fl3].every((v) => v === 'Jianwen Ding'),
      JSON.stringify([misread.fl1, misread.fl2, misread.fl3]),
    );
    /*
     * And one half of it, the half said in brackets after the name it belongs
     * to. "Legal name" claimed the box as the whole name, so "Legal name
     * (First)" and "Legal name (Last)" were both given "Jianwen Ding", and
     * "(Middle)" — which the profile does not hold — the whole name as well.
     */
    check(
      '"Legal name (First)" and "(Last)" are given their own half',
      misread.ln1 === 'Jianwen' && misread.ln2 === 'Ding',
      JSON.stringify([misread.ln1, misread.ln2]),
    );
    check('"Legal name (Middle)" is given nothing', misread.ln3 === '', misread.ln3);
    check('while a legal name asked for whole, parts listed, still is', misread.ln4 === 'Jianwen Ding', misread.ln4);
    check('an essay about "your current company" is not given the employer', misread.e1 === '', misread.e1);
    check('"What did you study in school and why?" is not given the school', misread.e2 === '', misread.e2);
    check('"experience with state management" is not given the state', misread.e3 === '', misread.e3);
    check('"How did you first hear of us? (LinkedIn…)" is not given the profile URL', misread.e4 === '', misread.e4);
    check('"Which location are you applying for?" is not given where the applicant lives', misread.e5 === '', misread.e5);
    check('while a box labelled "LinkedIn profile" still gets it, multi-line or not', misread.f1 === 'linkedin.com/in/x', misread.f1);
    check('and "Which university did you graduate from?" still gets the school', misread.f2 === 'Northeastern University', misread.f2);

    const more = await page.goto(`${base}/more-misread`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return Object.fromEntries([...document.querySelectorAll('input, select, textarea')].map((el) => [el.id, el.value]));
      }, { b: base, profile: { ...PROFILE, address_state: 'MA', location: 'Boston, MA', school: 'Northeastern University', website: 'jianwen.dev', graduation_year: '2027', major: 'Computer Science', degree: 'Bachelor of Science', gpa: '3.9' } }),
    );
    // The same form, against a profile that names no degree at all.
    const noLevel = await page.goto(`${base}/more-misread`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return Object.fromEntries([...document.querySelectorAll('input, select, textarea')].map((el) => [el.id, el.value]));
      }, { b: base, profile: { ...PROFILE, school: 'Northeastern University', gpa: '3.9' } }),
    );

    const completion = await page.goto(`${base}/completion`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.id, el.value]));
      }, { b: base, profile: { ...PROFILE, degree: 'Bachelor of Science', graduation_year: '2027', graduation_month: 'May', graduation_date: 'May 2027' } }),
    );
    const terms = await page.goto(`${base}/terms`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return Object.fromEntries([...document.querySelectorAll('select')].map((el) => [el.id, el.value]));
      }, { b: base, profile: { ...PROFILE, graduation_year: '2027', graduation_month: 'May', graduation_date: 'May 2027' } }),
    );
    const prefixed = await page.goto(`${base}/prefixed`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, profile }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(profile);
        return Object.fromEntries([...document.querySelectorAll('input')].map((el) => [el.id, el.value]));
      }, { b: base, profile: { ...PROFILE, website: 'jianwen.dev' } }),
    );
    group('A link box holding only the start of an address');
    check('"https://" is not an answer: the profile goes in', /linkedin\.com\/in\/x/.test(prefixed.p1), prefixed.p1);
    check('nor is the site\'s own prefix', /linkedin\.com\/in\/x/.test(prefixed.p2), prefixed.p2);
    check('nor GitHub\'s', /github\.com\/x/.test(prefixed.p3), prefixed.p3);
    check('while an address somebody typed is left alone', prefixed.p4 === 'https://someone-else.dev', prefixed.p4);
    // A dialling code on its own is the form's hint too — kept in front of the number.
    check('a phone box holding only "+1" gets the number after it', prefixed.p5 === '+1 555-0100', prefixed.p5);
    check('and one holding a whole number is left alone', prefixed.p6 === '+1 617 555 0199', prefixed.p6);

    group('A graduation date chosen from a list');
    check('May 2027 is "Spring 2027" on a list of terms', terms.t1 === 'Spring 2027', terms.t1);
    check('and "05/2027" on a list of numbers', terms.t2 === '05/2027', terms.t2);
    check('and nothing on a list where no term is its own', terms.t3 === '', terms.t3);
    check('and "2027-05" on a list written year first', terms.t4 === '2027-05', terms.t4);

    group('When the degree ends, however it is asked');
    check('"Expected degree completion" gets the date, not the degree', completion.c1 === 'May 2027', completion.c1);
    check('"Degree completion date" gets the date too', completion.c2 === 'May 2027', completion.c2);
    check('"End date (graduation)" gets it', completion.c3 === 'May 2027', completion.c3);
    check('"Class of" gets the year', completion.c4 === '2027', completion.c4);
    check('"Graduating class" gets the year', completion.c5 === '2027', completion.c5);
    check('"Project completion date" is nobody\'s graduation', completion.c6 === '', completion.c6);
    check('and a box that is just "Degree" still gets the degree', completion.c7 === 'Bachelor of Science', completion.c7);

    group('Somebody else\'s details, under names the list did not have');
    check('"Referrer\'s email" is not given the applicant\'s email', more.refmail === '', more.refmail);
    check('"LinkedIn URL of your referrer" is not given the applicant\'s profile', more.reflink === '', more.reflink);
    check('"Recruiter email" is not given the applicant\'s email', more.recmail === '', more.recmail);
    check('"Professor\'s email" is not given the applicant\'s email', more.profmail === '', more.profmail);
    check('"Parent\'s phone number" is not given the applicant\'s number', more.parphone === '', more.parphone);
    check(
      'while the applicant\'s own email, phone and LinkedIn still are',
      more['own-email'] === PROFILE.email && more['own-phone'] === PROFILE.phone && more['own-li'] === PROFILE.linkedin,
      `${more['own-email']} / ${more['own-phone']} / ${more['own-li']}`,
    );

    group('A count, which no profile field is');
    check('"How many years of mobile development experience" is not given the phone number', more.count1 === '', more.count1);
    check('"How many years of college have you completed?" is not given the school', more.count2 === '', more.count2);
    check('"Years of GitHub Actions experience" is not given the GitHub URL', more.count3 === '', more.count3);
    check('while "Year of graduation" still gets the year', more.gradyear === '2027', more.gradyear);

    group('The password to a link, which is not the link');
    check('"Portfolio password" is not given the portfolio URL', more.pfpw === '', more.pfpw);
    check('nor is "Website password (if any)"', more.webpw === '', more.webpw);
    check('while "Portfolio" still gets it', more.pf === 'jianwen.dev', more.pf);

    group('Where the school is, and whose website');
    check('"School city" is not given the school\'s name', more.schcity === '', more.schcity);
    check('"School state" is not given it either', more.schstate === '', more.schstate);
    check('nor "University country"', more.unictry === '', more.unictry);
    check('nor "What city is your university located in?"', more.unicity === '', more.unicity);
    check('"Company website" is not given the applicant\'s own site', more.coweb === '', more.coweb);
    check('while "School" still gets the school', more.sch === 'Northeastern University', more.sch);

    group('A name the applicant used to have');
    check('"Previous last name(s)" is not given the current surname', more.prevln === '', more.prevln);
    check('nor "Maiden last name"', more.maiden === '', more.maiden);
    check('"Former legal name" is not given the current name', more.formern === '', more.formern);
    check('nor "Last name (previously used, if any)"', more.prevused === '', more.prevused);
    check(
      'while "Last name" and "Legal name" still are',
      more['own-ln'] === 'Ding' && more['own-legal'] === 'Jianwen Ding',
      `${more['own-ln']} / ${more['own-legal']}`,
    );

    group('A username, which is not the profile URL');
    check('"GitHub username" is not given the whole URL', more.ghuser === '', more.ghuser);
    check('nor "GitHub handle"', more.ghhandle === '', more.ghhandle);
    check('nor "Username on LinkedIn"', more.liuser === '', more.liuser);
    check(
      'while "GitHub profile URL" and "LinkedIn" still get theirs',
      more['gh-url'] === PROFILE.github && more['own-li'] === PROFILE.linkedin,
      `${more['gh-url']} / ${more['own-li']}`,
    );

    group('"Major" the adjective, which is not the subject');
    check('"Major accomplishment" is not given the major', more.majacc === '', more.majacc);
    check('nor "Major project"', more.majproj === '', more.majproj);
    check('nor "Your major achievements"', more.majach === '', more.majach);
    check('"Nearest major city" is not given the major', more.majcity === '', more.majcity);
    check('nor "Closest major metropolitan area"', more.majmetro === '', more.majmetro);
    check(
      'while "Major" and "Intended major" still get it',
      more['own-major'] === 'Computer Science' && more['int-major'] === 'Computer Science',
      `${more['own-major']} / ${more['int-major']}`,
    );

    group('"Degree" the measure, which is not the qualification');
    check('"Degree of proficiency in Spanish" is not given the degree', more.degprof === '', more.degprof);
    check('nor "To what degree are you familiar with SQL?"', more.degfam === '', more.degfam);
    /*
     * And the subject of the degree is the major. "Field of degree", "Degree
     * field" and "Subject of degree" were given "Bachelor of Science" in a
     * box asking what it was in.
     */
    check(
      '"Field of degree", "Degree field" and "Subject of degree" get the major, not the degree',
      more.degfield === 'Computer Science' && more.degfield2 === 'Computer Science' && more.degsubj === 'Computer Science',
      `${more.degfield} / ${more.degfield2} / ${more.degsubj}`,
    );
    check(
      'while "Degree" and "What degree are you pursuing?" still get it',
      more['own-degree'] === 'Bachelor of Science' && more['deg-pursue'] === 'Bachelor of Science',
      `${more['own-degree']} / ${more['deg-pursue']}`,
    );

    group('The state that issued a licence');
    check('"State of licensure" is not given the home state', more.licst1 === '', more.licst1);
    check('nor "License state"', more.licst2 === '', more.licst2);
    check('nor "Driver\'s license issuing state"', more.licst3 === '', more.licst3);
    check('nor "Issuing state"', more.licst4 === '', more.licst4);
    check('while "State/Province" still gets it', more['own-state'] === 'MA', more['own-state']);

    group('When to ring, which is not the number');
    check('"Best phone interview time" is not given the phone number', more.phtime1 === '', more.phtime1);
    check('nor "Best time to reach you by phone"', more.phtime2 === '', more.phtime2);
    check('nor "Phone screen availability"', more.phtime3 === '', more.phtime3);
    check(
      'while "Best phone number to reach you" and "Phone number for the phone interview" still get it',
      more.phbest === PROFILE.phone && more.phint === PROFILE.phone,
      `${more.phbest} / ${more.phint}`,
    );

    /*
     * A form that asks about a past job, or the school, a section at a time
     * says whose it is once, on the group, and then asks "Location", "City",
     * "State" and "Phone" like any other box. Each of those was given the
     * applicant's own home and number — a false statement about where
     * somebody else's office or campus is, on every row of the history.
     */
    group('A past job\'s place, and the school\'s, named once on the group');
    check('"Location" under "Work Experience 1" is not given where the applicant lives', more['wx-loc'] === '', more['wx-loc']);
    check('nor "City" there', more['wx-city'] === '', more['wx-city']);
    check('nor is "Phone" there the applicant\'s number', more['wx-phone'] === '', more['wx-phone']);
    check('nor "State" and "Country" in a group labelled "Employment History"', more['eh-state'] === '' && more['eh-ctry'] === '', `${more['eh-state']} / ${more['eh-ctry']}`);
    check('nor "City" and "State" under "Education"', more['ed-city'] === '' && more['ed-state'] === '', `${more['ed-city']} / ${more['ed-state']}`);
    check('while "School" under "Education" still gets the school', more['ed-sch'] === 'Northeastern University', more['ed-sch']);
    check(
      'and "City" and "Location" under "Contact Information" still get the applicant\'s',
      more['ci-city'] === 'Boston' && more['ci-loc'] === 'Boston, MA',
      `${more['ci-city']} / ${more['ci-loc']}`,
    );

    /*
     * The profile holds one education, the newest, and a form that asks for
     * more than one says which level it means. Against a bachelor's, every
     * graduate field was given the bachelor's school, grade and subject.
     */
    group('A level of study the profile\'s degree is not at');
    check('"Graduate School" is not given the bachelor\'s university', more['lv-gsch'] === '', more['lv-gsch']);
    check('nor "Graduate GPA" its grade', more['lv-ggpa'] === '', more['lv-ggpa']);
    check('nor "Master\'s degree institution"', more['lv-msch'] === '', more['lv-msch']);
    check('nor "PhD Institution"', more['lv-phd'] === '', more['lv-phd']);
    check('nor "Major" under "Graduate Education"', more['lv-gmaj'] === '', more['lv-gmaj']);
    check(
      'while "Undergraduate School", "Undergraduate GPA" and "Bachelor\'s Major" still get the bachelor\'s',
      more['lv-usch'] === 'Northeastern University' && more['lv-ugpa'] === '3.9' && more['lv-bmaj'] === 'Computer Science',
      `${more['lv-usch']} / ${more['lv-ugpa']} / ${more['lv-bmaj']}`,
    );
    check('and an example in parentheses is not a level', more['lv-deg'] === 'Bachelor of Science', more['lv-deg']);
    check(
      'with no degree to compare, "Undergraduate School" is left blank and "School" is not',
      noLevel['lv-usch'] === '' && noLevel.sch === 'Northeastern University',
      `${noLevel['lv-usch']} / ${noLevel.sch}`,
    );

    /*
     * The profile holds one subject, one degree and one school, and a form
     * that asks for a second is asking about one the profile does not hold.
     * Each was given the first again — a second major in the same subject,
     * the same university as the previous school it transferred from.
     */
    group('A second major, a second degree, another school');
    check('"Second Major" is not given the major', more['sc-maj2'] === '', more['sc-maj2']);
    check('nor "Double major"', more['sc-dbl'] === '', more['sc-dbl']);
    check('"Additional degree" is not given the degree', more['sc-add'] === '', more['sc-add']);
    check('"School 2" is not given the school again', more['sc-sch2'] === '', more['sc-sch2']);
    check('nor "Major 2" the major', more['sc-maj-2'] === '', more['sc-maj-2']);
    check('"Previous school" is not given the current one', more['sc-prev'] === '', more['sc-prev']);
    check('nor "Transfer university"', more['sc-trans'] === '', more['sc-trans']);
    check(
      'while "School 1" and "School (if other)" still get it',
      more['sc-sch1'] === 'Northeastern University' && more['sc-other'] === 'Northeastern University',
      `${more['sc-sch1']} / ${more['sc-other']}`,
    );

    /*
     * A question that wants a yes or a no, asked in a one-line box, has no
     * profile value for an answer. Each was given whatever profile word it
     * mentioned: "Master of Science" as whether somebody has a bachelor's,
     * the city they live in as whether they will be in New York.
     */
    group('A yes-or-no question is not answered with a profile value');
    check('"Do you have a bachelor\'s degree?" is not given the degree', more['yn-deg'] === '', more['yn-deg']);
    check('nor "Did you graduate from a US university?" the school', more['yn-sch'] === '', more['yn-sch']);
    check('nor "Do you have a GPA of 3.0 or above?" the grade', more['yn-gpa'] === '', more['yn-gpa']);
    check('nor "Can we text you at this phone number?" the number', more['yn-ph'] === '', more['yn-ph']);
    check('nor "Will you be located in New York City by the start date?" the city', more['yn-city'] === '', more['yn-city']);
    check(
      'while "Do you have a phone number? If so, please share it.", "What is your cumulative GPA?" and "Do you have a LinkedIn profile?" still are',
      more['yn-ph2'] === PROFILE.phone && more['yn-what'] === '3.9' && more['yn-li'] === PROFILE.linkedin,
      `${more['yn-ph2']} / ${more['yn-what']} / ${more['yn-li']}`,
    );

    /*
     * A name typed into a signature box is a signature: it certifies the
     * attestation above it — "the information I have given is true", an
     * at-will acknowledgement, a background-check release — in the
     * applicant's name, before they have read it. Checkboxes are left for
     * the applicant for the same reason.
     */
    group('A typed signature is the applicant\'s to give');
    check('"Type your full name to sign" is left unsigned', more.sig1 === '', more.sig1);
    check('nor "E-signature (type your name)"', more.sig2 === '', more.sig2);
    check('nor "Full legal name (signature)"', more.sig3 === '', more.sig3);
    check('nor "Full Name" under "Applicant Signature"', more.sig4 === '', more.sig4);
    check(
      'while "Email you use to sign in" and "Legal name" still are',
      more['sig-in'] === PROFILE.email && more['own-legal'] === 'Jianwen Ding',
      `${more['sig-in']} / ${more['own-legal']}`,
    );

    /*
     * Where the job is, and whether it is remote, hybrid or on site, were each
     * given the city the applicant lives in — which answers "which office are
     * you applying to" with a place the employer may not have an office in.
     */
    group('Where the job is, which is not where the applicant lives');
    check('"Job location" is not given the applicant\'s location', more.jl1 === '', more.jl1);
    check('nor "Office location"', more.jl2 === '', more.jl2);
    check('nor "Work location"', more.jl3 === '', more.jl3);
    check('nor "Location of the role"', more.jl4 === '', more.jl4);
    check('nor "Location type"', more.jl5 === '', more.jl5);
    check('while "Current location" still gets it', more['jl-own'] === 'Boston, MA', more['jl-own']);

    /*
     * A question about a field is not the field. Workday asks "Phone Device
     * Type" beside the number, and "Phone Type" and "Email type" were given
     * the number and the address, "GPA Scale" the grade and "Degree Status"
     * the degree's name.
     */
    group('What kind, which scale, what status');
    check('"Phone Type" is not given the number', more.kd1 === '', more.kd1);
    check('nor "Phone Device Type"', more.kd2 === '', more.kd2);
    check('nor "Type of phone"', more.kd3 === '', more.kd3);
    check('"Email type" is not given the address', more.kd4 === '', more.kd4);
    check('"GPA Scale" is not given the grade', more.kd5 === '', more.kd5);
    check('"Degree Status" is not given the degree', more.kd6 === '', more.kd6);
    check(
      'while "Phone", "Email", "Degree" and "What is your cumulative GPA?" still are',
      more['own-phone'] === PROFILE.phone && more['own-email'] === PROFILE.email && more['own-degree'] === 'Bachelor of Science' && more['yn-what'] === '3.9',
      `${more['own-phone']} / ${more['own-email']} / ${more['own-degree']} / ${more['yn-what']}`,
    );

    /*
     * The commonest way a custom question asks for the applicant's location
     * matched nothing: only "Where are you based?" did.
     */
    group('Where the applicant is, asked as a question');
    check('"Where are you located?" gets the location', more.wh1 === 'Boston, MA', more.wh1);
    check('and "Where do you live?"', more.wh2 === 'Boston, MA', more.wh2);
    check('and "Where do you currently reside?"', more.wh3 === 'Boston, MA', more.wh3);
    check('while "Where would you like to be located?" does not', more.wh4 === '', more.wh4);

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
        const ids = ['gm', 'gm2', 'gy', 'gmonth', 'gslash', 'glabel', 'gwhen', 'guni', 'gprog', 'recent'];
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
        return Object.fromEntries(
          ['cc', 'ct', 'mre', 'hco', 'hti', 'cl', 'ccn', 'cen', 'mren', 'pcn', 'hcn', 'hen', 'hcc', 'bcn', 'prn', 'ncn', 'cca', 'ccl'].map(
            (id) => [id, document.getElementById(id).value],
          ),
        );
      }, { b: base }),
    );
    const widgetKeys = await page.goto(`${base}/widget-keys`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const named = (fields) =>
          m.fillForm(fields).skipped.filter((x) => /by hand/.test(x.reason)).map((x) => `${x.key}: ${x.description.split(' ')[0]}`);
        return {
          stateOnly: named({ address_state: 'MA' }),
          both: named({ address_state: 'MA', address_country: 'United States' }),
          levels: named({ school: 'Northeastern University', degree: 'Bachelor of Science' }),
        };
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
    const elsewhere = await page.goto(`${base}/elsewhere`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = {
          work_authorization: 'Authorized to work in the US',
          requires_sponsorship: 'I do not require sponsorship in the US',
        };
        const report = m.fillForm(fields);
        const ticked = (n) => document.querySelector(`input[name="${n}"]:checked`)?.value ?? '';
        const uk = document.getElementById('uk').value;
        const ca = ticked('ca');
        const us = document.getElementById('us').value;
        const sp = ticked('sp');
        // The buttons alone, because a key answered anywhere else on the form
        // is not answered again by a group of buttons.
        for (const el of document.querySelectorAll('form > :not([role="radiogroup"])')) el.remove();
        m.fillForm(fields);
        return {
          uk,
          ca,
          uks: [...document.querySelectorAll('[role="radio"]')].filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.id).join(','),
          us,
          sp,
          skipped: report.skipped.map((x) => `${x.key}:${x.reason}:${x.description}`),
        };
      }, { b: base }),
    );
    group('The right to work somewhere the profile does not say');
    /*
     * Measured before: all three answered from "Authorized to work in the US"
     * and "I do not require sponsorship in the US" — "Yes" to the UK and to
     * Canada, and "No" to needing UK sponsorship. Each is a declaration about
     * a country the applicant never made one about, and for most people a
     * false one.
     */
    check(
      'a US declaration does not answer the UK question',
      elsewhere.uk === '' && elsewhere.skipped.some((x) => /^work_authorization:.*another country.*UK/.test(x)),
      JSON.stringify(elsewhere),
    );
    check('nor the Canadian one, as radio buttons', elsewhere.ca === '', JSON.stringify(elsewhere));
    check('nor UK sponsorship, as buttons', elsewhere.uks === '', JSON.stringify(elsewhere));
    check(
      'while the US question and one naming no country are answered',
      elsewhere.us === 'Yes' && elsewhere.sp === 'No',
      JSON.stringify(elsewhere),
    );
    /*
     * And a declaration that names no country at all, which is what somebody
     * types into a box labelled "Work authorization": "Yes". It matched the
     * Yes option by its text before any country was looked at, so a profile
     * living in the United States ticked "Yes" to the UK and to Canada and
     * "No" to needing UK sponsorship. A bare answer is about where the
     * profile lives.
     */
    const bare = await page.goto(`${base}/elsewhere`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = { work_authorization: 'Yes', requires_sponsorship: 'No', address_country: 'United States' };
        const report = m.fillForm(fields);
        const ticked = (n) => document.querySelector(`input[name="${n}"]:checked`)?.value ?? '';
        const out = {
          uk: document.getElementById('uk').value,
          ukt: document.getElementById('ukt').value,
          ca: ticked('ca'),
          us: document.getElementById('us').value,
          sp: ticked('sp'),
          skipped: report.skipped.map((x) => `${x.key}:${x.reason}:${x.description}`),
        };
        for (const el of document.querySelectorAll('form > :not([role="radiogroup"])')) el.remove();
        m.fillForm(fields);
        out.uks = [...document.querySelectorAll('[role="radio"]')].filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.id).join(',');
        return out;
      }, { b: base }),
    );
    check(
      'a bare "Yes" from a US profile does not answer the UK question',
      bare.uk === '' && bare.skipped.some((x) => /^work_authorization:.*another country.*UK/.test(x)),
      JSON.stringify(bare),
    );
    check('nor the Canadian one, nor UK sponsorship', bare.ca === '' && bare.uks === '', JSON.stringify(bare));
    // Typed, it is the same declaration: "Yes" to the UK, in a box.
    check('nor the UK question asked as a box to type in', bare.ukt === '', JSON.stringify(bare));
    check('while it still answers the US question and one naming none', bare.us === 'Yes' && bare.sp === 'No', JSON.stringify(bare));
    // And Workday's dropdown, which picks an option by its text the same way.
    const bareWidget = await page.goto(`${base}/paired-widgets`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        for (const id of ['l-both', 'w-both', 'l-able', 'w-able']) document.getElementById(id).remove();
        document.getElementById('l-auth').textContent = 'Are you legally authorized to work in the United Kingdom?';
        const fields = { work_authorization: 'Yes', address_country: 'United States' };
        const report = await m.fillComboboxes(fields, m.fillForm(fields));
        return {
          auth: document.getElementById('h-auth').value,
          skipped: report.skipped.map((x) => `${x.key}:${x.reason}:${x.description}`),
        };
      }, { b: base }),
    );
    check(
      'nor, on a Workday dropdown, the UK question',
      bareWidget.auth === '' && bareWidget.skipped.some((x) => /^work_authorization:.*another country/.test(x)),
      JSON.stringify(bareWidget),
    );
    const paired = await page.goto(`${base}/paired-widgets`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = { work_authorization: 'Yes', requires_sponsorship: 'Yes' };
        const report = await m.fillComboboxes(fields, m.fillForm(fields));
        const read = (id) => document.getElementById(id).value;
        return {
          both: read('h-both'),
          able: read('h-able'),
          auth: read('h-auth'),
          skipped: report.skipped.map((x) => `${x.key}:${x.reason}:${x.description}`),
        };
      }, { b: base }),
    );
    group('The two-declarations question on a Workday dropdown');
    /*
     * Measured before: against a profile that is authorized and needs
     * sponsorship — anybody on a student visa — the first was answered "Yes"
     * from the authorization alone and the second "Yes" from the sponsorship
     * alone, both declaring a right to work unsponsored that the applicant
     * does not have. And the plain question under them, the one that could
     * be answered, was left blank: the first widget had claimed its key.
     */
    check(
      'authorized without sponsorship is not answered from one half',
      paired.both === '' && paired.skipped.some((x) => /^work_authorization:this one asks two things at once:.*without spons/.test(x)),
      JSON.stringify(paired),
    );
    check(
      'nor able to work without sponsorship',
      paired.able === '' && paired.skipped.some((x) => /^work_authorization:this one asks two things at once:.*able to work/.test(x)),
      JSON.stringify(paired),
    );
    check('while the plain question is answered', paired.auth === 'Yes', JSON.stringify(paired));
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
          address_city: 'Boston', location: 'Boston, MA',
        };
        m.fillForm(fields);
        const ids = ['e-sm', 'e-sy', 'e-em', 'e-ey', 'w-sm', 'w-sy', 'w-em', 'w-ey', 'f-from', 'f-to', 'j-sy', 'j-ey', 'wd-first', 'wd-last', 'wd-jfirst', 'x-from', 'x-avail', 'x-notice',
          's-city', 's-esy', 's-avail', 's-wloc', 's-wcity', 's-after'];
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
    /*
     * A legend names its own fieldset and nothing after it. Read as the
     * heading of everything below, it made "Available start date" the
     * degree's start and "Notice period end date" its graduation.
     */
    check(
      'below an Education fieldset, "Available start date" and "Notice period end date" are not the degree\'s',
      sections['x-avail'] === '' && sections['x-notice'] === '',
      JSON.stringify([sections['x-avail'], sections['x-notice']]),
    );
    check('while "Start date" inside it still is', sections['x-from'] === 'September 2022', sections['x-from']);
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
    /*
     * A heading with no fieldset, whose section is a wrapper of its own.
     *
     * The last heading before a field was its section to the end of the form,
     * so once an Education block had closed, "Available start date" in the
     * next block was given the degree's start; and a Work Experience block's
     * plain "Location" and "City" were given the applicant's own home, which
     * only a legend or a labelled group could prevent. The wrapper is the
     * edge now — and the flat `Employment history` heading in the not-yours
     * fixture, followed by the applicant's own country questions, is the
     * control for a form with no edge to read.
     */
    check(
      'a wrapped Education block still answers its start date',
      sections['s-esy'] === '2022',
      sections['s-esy'],
    );
    check(
      'but not "Available start date" in the block after it',
      sections['s-avail'] === '',
      sections['s-avail'],
    );
    check(
      'a wrapped Work Experience block\'s "Location" and "City" are not where the applicant lives',
      sections['s-wloc'] === '' && sections['s-wcity'] === '',
      JSON.stringify([sections['s-wloc'], sections['s-wcity']]),
    );
    check(
      'while "City" under Personal information, and in the block after, still is',
      sections['s-city'] === 'Boston' && sections['s-after'] === 'Boston',
      JSON.stringify([sections['s-city'], sections['s-after']]),
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

    /*
     * A GPA dropdown lists bands — "3.50 - 3.74", "3.75 - 4.00" — or
     * thresholds — "3.0+", "3.5 and above" — and the store holds the grade as
     * one number. "3.8" matched none of them, so the box was left empty.
     */
    const grades = await page.evaluate(async ({ b }) => {
      const m = await import(`${b}/autofill.js`);
      const pick = (value, options) => {
        document.body.innerHTML = `<form><label for="g">GPA</label><select id="g"><option value="">Select...</option>${options
          .map((o) => `<option>${o}</option>`)
          .join('')}</select></form>`;
        m.fillForm({ gpa: value });
        return document.getElementById('g').value;
      };
      const BANDS = ['Below 2.50', '2.50 - 2.99', '3.00 - 3.49', '3.50 - 3.74', '3.75 - 4.00'];
      return {
        top: pick('3.8', BANDS),
        edge: pick('3.74', BANDS),
        floor: pick('3.5', BANDS),
        low: pick('2.1', BANDS),
        thresholds: pick('3.8', ['2.5+', '3.0+', '3.5+']),
        between: pick('3.2', ['2.5 and above', '3.0 and above', '3.5 and above']),
        under: pick('2.7', ['Less than 3.0', '3.0 or higher']),
        dash: pick('3.6', ['3.0–3.49', '3.5–4.0']),
        point: pick('3.80', ['4.0', '3.9', '3.8', '3.7']),
        outOfTen: pick('9.1', BANDS),
        gap: pick('3.745', ['3.50 - 3.74', '3.75 - 4.00']),
        notRounded: pick('3.85', ['4.0', '3.9', '3.8']),
        // SpaceX's, measured on the live board: every grade out of 4.0.
        outOfFour: pick('3.8', ['Not applicable/Do not recall', '4.0 out of 4.0', '3.9 out of 4.0', '3.8 out of 4.0', '3.7 out of 4.0', 'Below 3.0 out of 4.0']),
        belowOutOfFour: pick('2.6', ['Not applicable/Do not recall', '3.1 out of 4.0', '3.0 out of 4.0', 'Below 3.0 out of 4.0']),
        slashed: pick('3.7', ['3.5/4.0 - 4.0/4.0', '3.0/4.0 - 3.49/4.0']),
        outOfFive: pick('3.8', ['3.8 out of 5.0', '4.0 out of 5.0']),
      };
    }, { b: base });
    /*
     * A phone box that keeps the digits and drops the rest, as Greenhouse's
     * intl-tel-input does to "(555) 010-0199" — to what a person types and to
     * what is filled alike. Filled, it was reported "would not take it".
     */
    const phones = await page.evaluate(async ({ b }) => {
      const m = await import(`${b}/autofill.js`);
      const fill = (reformat) => {
        document.body.innerHTML = '<form><label for="p">Phone</label><input id="p" type="tel"></form>';
        const box = document.getElementById('p');
        box.addEventListener('input', () => { box.value = reformat(box.value); });
        const report = m.fillForm({ phone: '(555) 010-0199' });
        return { value: box.value, filled: report.filled.some((x) => x.key === 'phone'), skipped: report.skipped.map((x) => x.reason) };
      };
      return {
        digits: fill((v) => v.replace(/\D/g, '')),
        // A box that keeps only some of them has not taken it.
        cut: fill((v) => v.replace(/\D/g, '').slice(0, 6)),
      };
    }, { b: base });
    /*
     * Work authorization asked as statements, not as yes or no — SpaceX's,
     * measured on the live board. Left for the person against a profile that
     * says "Authorized to work in the US" and no sponsorship.
     */
    const statements = await page.evaluate(async ({ b }) => {
      const m = await import(`${b}/autofill.js`);
      const SAID = ['I am authorized to work in the United States for any employer', 'I am authorized to work in the United States for my present employer only',
        'I require sponsorship to work in the United States', 'I am not authorized to work in the United States', 'My status to work in the United States is unknown'];
      const pick = (fields, options = SAID) => {
        document.body.innerHTML = `<form><label for="w">Are you legally authorized to work in the United States?</label><select id="w"><option value="">Select...</option>${options
          .map((o) => `<option>${o}</option>`).join('')}</select></form>`;
        m.fillForm(fields);
        return document.getElementById('w').value;
      };
      return {
        free: pick({ work_authorization: 'Authorized to work in the US', requires_sponsorship: 'No' }),
        sponsored: pick({ work_authorization: 'Authorized to work in the US', requires_sponsorship: 'Yes' }),
        unsaid: pick({ work_authorization: 'Authorized to work in the US' }),
        plain: pick({ work_authorization: 'Authorized to work in the US', requires_sponsorship: 'No' }, ['I am authorized to work in the United States', 'I am not authorized to work in the United States']),
      };
    }, { b: base });
    group('Work authorization asked as statements');
    check('authorized with no sponsorship: "for any employer"', statements.free === 'I am authorized to work in the United States for any employer', `"${statements.free}"`);
    check('needing sponsorship: the statement that says so', statements.sponsored === 'I require sponsorship to work in the United States', `"${statements.sponsored}"`);
    check('a plain "I am authorized" where nothing narrower is offered', statements.plain === 'I am authorized to work in the United States', `"${statements.plain}"`);
    check('and nothing where the profile does not say whether sponsorship is needed', statements.unsaid === '', `"${statements.unsaid}"`);

    /*
     * Lever's "Current location": a text box whose keystrokes search places
     * and draw them below it, and a hidden `selectedLocation` that only a
     * pick fills — measured on a live Lever form, where typing "Boston" drew
     * "Boston, MA, USA", "Boston, NY, USA" and more. Filled as text, the
     * hidden half stayed empty: a location Lever was never told was chosen.
     */
    const lever = await page.evaluate(async ({ b }) => {
      const m = await import(`${b}/autofill.js`);
      const PLACES = ['Boston, MA, USA', 'Boston, Lincolnshire, England, GBR', 'Boston, Davao Oriental, Davao Region, PHL', 'Boston, NY, USA'];
      const run = async (fields) => {
        document.body.innerHTML = `<form><ul><li class="application-question"><label><div class="application-label">Current location <span class="required">✱</span></div>
          <div class="application-field"><input class="location-input" id="location-input" type="text" name="location" required>
          <input id="selected-location" type="hidden" name="selectedLocation">
          <div class="dropdown-container"><div class="dropdown-results"></div></div></div></label></li></ul></form>`;
        const box = document.getElementById('location-input');
        const results = document.querySelector('.dropdown-results');
        let keyed = false;
        box.addEventListener('keydown', () => { keyed = true; });
        box.addEventListener('keyup', () => {
          if (!keyed) return;
          const term = box.value.split(',')[0].trim().toLowerCase();
          setTimeout(() => {
            results.innerHTML = '';
            for (const name of PLACES.filter((p) => p.toLowerCase().startsWith(term))) {
              const row = document.createElement('div');
              row.className = 'dropdown-location';
              row.textContent = name;
              row.addEventListener('click', () => {
                box.value = name;
                document.getElementById('selected-location').value = JSON.stringify({ name, id: `id-${name}` });
                results.innerHTML = '';
              });
              results.append(row);
            }
          }, 300);
        });
        const report = await m.fillComboboxes(fields, m.fillForm(fields));
        return { text: box.value, chosen: document.getElementById('selected-location').value, filled: report.filled.map((x) => x.key) };
      };
      return {
        ma: await run({ location: 'Boston, MA', address_city: 'Boston', address_state: 'MA', address_country: 'United States' }),
        ny: await run({ location: 'Boston, NY', address_city: 'Boston', address_state: 'NY', address_country: 'United States' }),
        noState: await run({ location: 'Boston', address_city: 'Boston', address_country: 'United States' }),
      };
    }, { b: base });
    group("Lever: Current location, chosen from what its search draws");
    check('the place whose city, state and country are the profile\'s', lever.ma.chosen.includes('"Boston, MA, USA"') && lever.ma.text === 'Boston, MA, USA', JSON.stringify(lever.ma));
    check('by the state the profile holds', lever.ny.chosen.includes('"Boston, NY, USA"'), JSON.stringify(lever.ny));
    check('and with no state, the typed text is left and nothing is chosen', lever.noState.chosen === '' && lever.noState.text === 'Boston', JSON.stringify(lever.noState));

    group('A phone box that keeps the digits and drops the formatting');
    check('is filled, and counted as filled', phones.digits.value === '5550100199' && phones.digits.filled, JSON.stringify(phones.digits));
    check('while one that drops digits is still reported', !phones.cut.filled && phones.cut.skipped.includes('the field would not take it'), JSON.stringify(phones.cut));

    group('A GPA against a list of bands');
    check(
      'a grade takes the band that holds it',
      grades.top === '3.75 - 4.00' && grades.edge === '3.50 - 3.74' && grades.floor === '3.50 - 3.74' && grades.low === 'Below 2.50',
      JSON.stringify(grades),
    );
    check(
      'the tightest of several thresholds, not the first that is true',
      grades.thresholds === '3.5+' && grades.between === '3.0 and above',
      JSON.stringify([grades.thresholds, grades.between]),
    );
    check('"less than", and a dash of any width', grades.under === 'Less than 3.0' && grades.dash === '3.5–4.0', JSON.stringify([grades.under, grades.dash]));
    check('a bare number, by its value', grades.point === '3.8', `"${grades.point}"`);
    check(
      'a grade written out of 4.0, as SpaceX lists them',
      grades.outOfFour === '3.8 out of 4.0' && grades.belowOutOfFour === 'Below 3.0 out of 4.0' && grades.slashed === '3.5/4.0 - 4.0/4.0',
      JSON.stringify([grades.outOfFour, grades.belowOutOfFour, grades.slashed]),
    );
    check('but never one out of anything else', grades.outOfFive === '', `"${grades.outOfFive}"`);
    check(
      'and nothing for a grade no band holds, one not out of four, or one that would have to be rounded',
      grades.outOfTen === '' && grades.gap === '' && grades.notRounded === '',
      JSON.stringify([grades.outOfTen, grades.gap, grades.notRounded]),
    );

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

    group('A widget is the question its label asks, whatever the profile holds');
    check(
      'a Country/Region widget is not named as the state when the profile has no country',
      JSON.stringify(widgetKeys.stateOnly) === JSON.stringify(['address_state: State']),
      JSON.stringify(widgetKeys.stateOnly),
    );
    check(
      'and with both, each widget is named as its own question',
      JSON.stringify(widgetKeys.both) === JSON.stringify(['address_country: Country/Region', 'address_state: State']),
      JSON.stringify(widgetKeys.both),
    );
    check(
      'a bachelor\'s school is named for the "Undergraduate School" widget, not the "Graduate School" one',
      JSON.stringify(widgetKeys.levels) === JSON.stringify(['school: Undergraduate']),
      JSON.stringify(widgetKeys.levels),
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
    /*
     * "Company name" is the employment-history exclusion's to keep — a past
     * employer's, one row per job — unless "current", "present" or "most
     * recent" sits directly in front of it, in which case it is this question
     * with "name" on the end.
     */
    check('"Current Company Name"', current.ccn === 'Helios', `"${current.ccn}"`);
    check('"Current employer\'s name"', current.cen === 'Helios', `"${current.cen}"`);
    check('"Most recent employer name"', current.mren === 'Helios', `"${current.mren}"`);
    check('"Present company name"', current.pcn === 'Helios', `"${current.pcn}"`);
    check(
      'a "Company Name" row under Employment history is still a past employer\'s',
      current.hcn === '' && current.hen === '' && current.hcc === '',
      `company "${current.hcn}", employer "${current.hen}", "current" "${current.hcc}"`,
    );
    check(
      'and so is a bare, previous or "not current" one',
      current.bcn === '' && current.prn === '' && current.ncn === '',
      JSON.stringify([current.bcn, current.prn, current.ncn]),
    );
    check(
      'the current employer\'s address and location are still not the applicant\'s',
      current.cca === '' && current.ccl === '',
      JSON.stringify([current.cca, current.ccl]),
    );

    group('When the degree ends, however the form asks');
    check('a month list that abbreviates', graduation.values.gm === '12', `value "${graduation.values.gm}"`);
    check('a month list that numbers', graduation.values.gm2 === '12', `value "${graduation.values.gm2}"`);
    check('a year list', graduation.values.gy === '2026', `value "${graduation.values.gy}"`);
    check('a month picker, which takes nothing but 2026-12', graduation.values.gmonth === '2026-12', `"${graduation.values.gmonth}"`);
    check('a box whose placeholder says MM/YYYY', graduation.values.gslash === '12/2026', `"${graduation.values.gslash}"`);
    check('and one whose label says it', graduation.values.glabel === '12/2026', `"${graduation.values.glabel}"`);
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
      { question: 'Which working arrangement do you prefer?', answer: 'Hybrid' },
      /*
       * Chosen on Acme's form, where it was true. The question matches this
       * form's word for word — which is why the store calls it confident —
       * and the answer is about Acme.
       */
      { question: 'Have you previously been employed by this company?', answer: 'Yes' },
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
            arr: val('arr'),
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
    check('a dropdown is answered from what was said last time', memory.arr === 'Hybrid', `"${memory.arr}"`);
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
    /*
     * Measured end to end before this was refused: "Yes" chosen on Acme's
     * form was banked, and Autofill on Helios's form put it into the same
     * question there — telling Helios the applicant used to work for them.
     */
    check(
      'whether you have worked here before is not answered from another employer’s form',
      memory.prev === '',
      `"${memory.prev}"`,
    );
    check(
      'and it is never even asked about',
      !memory.asked.some((q) => /employed/i.test(q)),
      memory.asked.filter((q) => /employed/i.test(q)).join(' | ') || `asked about ${memory.asked.length}`,
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
      memory.asked.length === 4 && memory.asked.every((q) => !/birth|employed/i.test(q)),
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
            arr: document.getElementById('arr').value,
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
      noBank.arr === '' && noBank.prev === '' && noBank.reloc === '' && noBank.filled === 0,
      `arr "${noBank.arr}", prev "${noBank.prev}", reloc "${noBank.reloc}", ${noBank.filled} filled`,
    );

    /* ---------------- Ashby: yes and no as two pressed buttons ---------------- */
    /*
     * Measured on Replit's live Ashby form before this was fixed: against a
     * profile saying "Authorized to work in the US" and "No", the work
     * authorisation and sponsorship questions were left unpressed and the
     * report said nothing about either — `skipped: []` — and `choiceQuestions`
     * did not list one of its five yes/no questions, so no answer given there
     * could ever be remembered. Filled the way content.js fills a document:
     * the bank asked first, then `fillForm`, then `fillComboboxes`.
     */
    const ASHBY_PROFILE = {
      full_name: 'Morgan Testwell', email: 'morgan.testwell@example.com',
      work_authorization: 'Authorized to work in the US', requires_sponsorship: 'No', address_country: 'United States',
    };
    const ASHBY_BANK = [
      { question: 'If not currently in the NYC area are you willing to relocate near our NYC Office?', answer: 'No' },
      { question: 'Which working arrangement do you prefer?', answer: 'Hybrid' },
      // Not one of the two buttons, so nothing is pressed for it.
      { question: 'Are you able to work from our NYC office 3 days per week?', answer: 'Sometimes' },
      // Personal: never asked about, never answered, whatever the bank holds.
      { question: 'Are you at least 18 years of age?', answer: 'Yes' },
      // Already pressed from the profile by the time the bank's turn comes, and a second press lets go.
      { question: 'Are you legally authorized to work in the United States?', answer: 'Yes' },
    ];
    const ashby = (query = '', bank = ASHBY_BANK) =>
      page.goto(`${base}/ashby-yes-no${query}`, { waitUntil: 'domcontentloaded' }).then(() =>
        page.evaluate(
          async ({ b, profile, bank }) => {
            const m = await import(`${b}/autofill.js`);
            const asked = m.choiceQuestions();
            const first = m.fillForm(profile, { remembered: bank.filter((row) => asked.includes(row.question)) });
            const before = {
              filled: first.filled.map((f) => f.key),
              byHand: first.skipped.filter((s) => /by hand/.test(s.reason)).map((s) => s.key),
            };
            const report = await m.fillComboboxes(profile, first);
            const pressed = (path) =>
              [...document.querySelectorAll(`[data-field-path="${path}"] button`)]
                .filter((el) => el.getAttribute('aria-pressed') === 'true')
                .map((el) => el.textContent)
                .join(',');
            return {
              asked,
              before,
              auth: pressed('auth'),
              spon: pressed('spon'),
              age: pressed('age'),
              office: pressed('office'),
              relocate: pressed('relocate'),
              arrangement: pressed('arrangement'),
              toolbar: pressed('more'),
              authTicked: document.querySelector('input[name="auth"]').checked,
              touched: window.__touched,
              submitted: window.__submitted,
              filled: report.filled.map((f) => (f.remembered ? `remembered: ${f.question}` : f.key)),
              skipped: report.skipped.map((s) => `${s.key}: ${s.reason}`),
            };
          },
          { b: base, profile: ASHBY_PROFILE, bank },
        ),
      );
    const onAshby = await ashby();
    const ignored = await ashby('?ignores');
    const answeredAlready = await ashby('?answered');
    const tickedOnly = await ashby('?ticked', []);
    group('Ashby: yes and no as two pressed buttons');
    check(
      'work authorisation asked as a Yes and a No button is answered by pressing Yes',
      onAshby.auth === 'Yes' && onAshby.filled.includes('work_authorization'),
      JSON.stringify({ auth: onAshby.auth, filled: onAshby.filled }),
    );
    check(
      'and sponsorship by pressing No',
      onAshby.spon === 'No' && onAshby.filled.includes('requires_sponsorship'),
      JSON.stringify({ spon: onAshby.spon, filled: onAshby.filled }),
    );
    check(
      'neither is counted as answered until the page shows the button pressed',
      !onAshby.before.filled.includes('work_authorization') && onAshby.before.byHand.includes('work_authorization') &&
        !onAshby.before.filled.includes('requires_sponsorship') && onAshby.before.byHand.includes('requires_sponsorship') &&
        !onAshby.skipped.some((s) => /^(work_authorization|requires_sponsorship):/.test(s)),
      JSON.stringify({ before: onAshby.before, after: onAshby.skipped }),
    );
    check(
      'a page that takes no notice of the press is left for the person, and never claimed',
      ignored.auth === '' && ignored.spon === '' && !ignored.filled.includes('work_authorization') && !ignored.filled.includes('requires_sponsorship') &&
        ignored.skipped.includes('work_authorization: the page did not take it — pick this one by hand') &&
        ignored.skipped.includes('requires_sponsorship: the page did not take it — pick this one by hand'),
      JSON.stringify({ filled: ignored.filled, skipped: ignored.skipped }),
    );
    check(
      'the hidden checkbox beside each pair is never touched',
      onAshby.touched.length === 0 && ignored.touched.length === 0 && tickedOnly.touched.length === 0,
      JSON.stringify([onAshby.touched, ignored.touched, tickedOnly.touched]),
    );
    check(
      'a ticked hidden checkbox under two unpressed buttons is not taken for an answer',
      tickedOnly.auth === 'Yes' && tickedOnly.filled.includes('work_authorization') && !tickedOnly.skipped.includes('work_authorization: already filled'),
      JSON.stringify({ auth: tickedOnly.auth, filled: tickedOnly.filled, skipped: tickedOnly.skipped }),
    );
    check(
      'an answer already pressed is not pressed again, which would let go of it',
      answeredAlready.spon === 'No' && answeredAlready.skipped.includes('requires_sponsorship: already filled'),
      JSON.stringify({ spon: answeredAlready.spon, skipped: answeredAlready.skipped }),
    );
    check(
      'the questions asked as buttons are the ones the bank is asked about, and not a personal one',
      ['office', 'relocate', 'auth', 'spon', 'arrangement'].length === onAshby.asked.length &&
        onAshby.asked.includes('If not currently in the NYC area are you willing to relocate near our NYC Office?') &&
        onAshby.asked.includes('Which working arrangement do you prefer?') &&
        onAshby.asked.includes('Are you legally authorized to work in the United States?') &&
        !onAshby.asked.some((q) => /18 years/.test(q)),
      onAshby.asked.join(' | '),
    );
    check(
      'the answer given last time is pressed, on a yes/no and on a short list of choices',
      onAshby.relocate === 'No' && onAshby.arrangement === 'Hybrid' &&
        onAshby.filled.includes('remembered: If not currently in the NYC area are you willing to relocate near our NYC Office?') &&
        onAshby.filled.includes('remembered: Which working arrangement do you prefer?'),
      JSON.stringify({ relocate: onAshby.relocate, arrangement: onAshby.arrangement, filled: onAshby.filled }),
    );
    check(
      'a question the profile has just pressed is not pressed again from the bank',
      onAshby.auth === 'Yes' && !onAshby.filled.includes('remembered: Are you legally authorized to work in the United States?'),
      JSON.stringify({ auth: onAshby.auth, filled: onAshby.filled }),
    );
    check(
      'an answer from last time that is neither button is left, and said so',
      onAshby.office === '' && onAshby.skipped.includes('remembered: the answer you gave before is not one of the options here'),
      JSON.stringify({ office: onAshby.office, skipped: onAshby.skipped }),
    );
    check('a personal question asked as buttons is not answered from the bank', onAshby.age === '', `"${onAshby.age}"`);
    check(
      "an editor's toolbar of pressed buttons is not a question, and Submit is never pressed",
      onAshby.toolbar === '' && !onAshby.asked.some((q) => /anything else/i.test(q)) && onAshby.submitted === 0,
      JSON.stringify({ toolbar: onAshby.toolbar, submitted: onAshby.submitted }),
    );

    /*
     * And the other half: a button the person presses is written down under
     * the same question the next form looks it up by, once the page has
     * shown it pressed — not when it lets go of one.
     */
    const ashbyWatched = await page.goto(`${base}/ashby-yes-no?answered`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const asked = m.choiceQuestions();
        const said = [];
        const stop = m.watchChoices((x) => said.push(x));
        document.querySelector('[data-field-path="office"] [data-option="yes"]').click();
        document.querySelector('[data-field-path="arrangement"] [data-option="remote"]').click();
        // Sponsorship is already No; pressing No again lets go of it.
        document.querySelector('[data-field-path="spon"] [data-option="no"]').click();
        await new Promise((r) => setTimeout(r, 50));
        stop();
        return { asked, said: said.map((x) => ({ question: x.question, answer: x.answer, keep: x.keep })) };
      }, { b: base }),
    );
    const office = ashbyWatched.said.find((x) => /NYC office/.test(x.question));
    check(
      'a button the person presses is kept for next time, under the question the next form looks up',
      office?.answer === 'Yes' && office.keep === true && ashbyWatched.asked.includes(office.question) &&
        ashbyWatched.said.some((x) => x.question === 'Which working arrangement do you prefer?' && x.answer === 'Remote'),
      JSON.stringify(ashbyWatched.said),
    );
    check(
      'letting go of a pressed answer is not written down as one',
      !ashbyWatched.said.some((x) => /sponsorship/.test(x.question)),
      JSON.stringify(ashbyWatched.said),
    );

    /*
     * "Insert into form" into a box that has since become another question.
     *
     * A question is found once, when the card goes up, and the box is marked
     * with an id the card keeps. A form that moves to its next step by
     * re-rendering in place keeps the same element for step two's box — the
     * mark is ours, so nothing takes it off — and the url does not change,
     * so nothing reads the questions again. Pressing Insert under "Why do you
     * want to work at Acme?" then wrote that answer into step two's "Describe
     * a time you failed", and said it had.
     */
    const stepped = await page.goto(`${base}/stepped`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const found = m.findQuestions();
        const why = found.find((q) => /Acme/.test(q.question));
        const project = found.find((q) => /project/.test(q.question));

        // Step two, drawn into step one's elements.
        document.getElementById('q-label').textContent = 'Describe a time you failed.';
        document.getElementById('q-box').name = 'step2_failure';
        // And the other box's counter ticking, which is not a new question.
        document.getElementById('c-label').textContent = 'Tell us about a project you led. (473 characters remaining)';

        const intoOther = await m.insertAnswer(why.fieldId, 'Because Acme builds rockets.', why.question);
        const intoSame = await m.insertAnswer(project.fieldId, 'I led the migration.', project.question);
        return {
          intoOther,
          other: document.getElementById('q-box').value,
          intoSame,
          same: document.getElementById('c-box').value,
        };
      }, { b: base }),
    );

    group('Inserting an answer into a box that has become another question');
    check(
      'the answer to one question is not written into the next step’s box',
      stepped.other === '' && stepped.intoOther === false,
      JSON.stringify(stepped),
    );
    check(
      'while a box whose label only counts characters still takes its answer',
      stepped.same === 'I led the migration.' && stepped.intoSame === true,
      JSON.stringify(stepped),
    );

    /*
     * CKEditor 5 labels every editing box it draws "Editor editing area:
     * main. Press Alt+0 for help.", and that was the question the card
     * offered — against the real editor, on a form whose label said "Why do
     * you want to work here?". So the draft was asked for against that
     * sentence, and an answer saved for next time was filed under a question
     * every CKEditor form asks in exactly the same words.
     */
    const ck = await page.goto(`${base}/ckedited`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const found = m.findQuestions();
        const why = found.find((q) => /Acme/.test(q.question));
        return {
          questions: found.map((q) => q.question),
          required: why ? m.isRequired(why.fieldId) : null,
          put: why ? await m.insertAnswer(why.fieldId, 'Because Acme builds rockets.', why.question) : null,
        };
      }, { b: base }),
    );
    group('A CKEditor put on a labelled textarea');
    check(
      'asks what the page’s label says, and the cover letter is not a question',
      JSON.stringify(ck.questions) === JSON.stringify(['Why do you want to work at Acme?']),
      JSON.stringify(ck.questions),
    );
    check('and Insert still knows the box asks it', ck.put === true, String(ck.put));
    /*
     * Required by the same label. Read off the editor's own box, the
     * asterisk on the page's label was never seen and the question came
     * back optional, so the finished card left an empty required answer
     * off its list of what the folder is missing.
     */
    check('and is required when the page’s label says so', ck.required === true, String(ck.required));

    /*
     * Quill 1's paste catcher is a second contenteditable with no label, so
     * the positional fallback took the editor beside it — whatever the person
     * had typed so far — as its question. Against the real Quill 1.3.7 with
     * the extension loaded: type "I like the team here." into the page's
     * editor and the card listed "I like the team here." as a new question,
     * redrawn as the typing went on.
     */
    const quill = await page.goto(`${base}/quill-one`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => (await import(`${b}/autofill.js`)).findQuestions().map((q) => q.question), { b: base }),
    );
    group('A Quill 1 editor with something typed in it');
    check(
      'is one question, not that and what was typed',
      JSON.stringify(quill) === JSON.stringify(['Why do you want to work at Acme?']),
      JSON.stringify(quill),
    );

    /*
     * "Insert into form" into a rich-text editor, read back from the editor.
     *
     * Insert wrote `textContent` and fired `input`, which puts the words in
     * the element and nowhere the form reads from. Against the real editors:
     * Draft.js submitted nothing, CKEditor 5 drew its empty paragraph back
     * over the answer, and Quill and ProseMirror kept one paragraph where
     * there were two — each while Insert said it had worked. The fixtures
     * are those three behaviours; see `EDITORS`.
     */
    const answer = 'First paragraph of the answer.\n\nSecond paragraph, after a blank line.';
    const edited = await page.goto(`${base}/editors`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, text }) => {
        const m = await import(`${b}/autofill.js`);
        const found = m.findQuestions();
        const out = {};
        for (const [id, asked] of [['ctl', /Acme/], ['rev', /project/], ['read', /change/]]) {
          const q = found.find((f) => asked.test(f.question));
          if (!q) {
            out[id] = { missing: found.map((f) => f.question) };
            continue;
          }
          const put = await m.insertAnswer(q.fieldId, text, q.question);
          await new Promise((r) => setTimeout(r, 50));
          out[id] = { put, submitted: window.submitted(id).filter(Boolean), q };
        }
        /*
         * And again, after the person has been in the box: an answer
         * corrected on the card and put in a second time.
         */
        const rev = document.getElementById('rev');
        rev.focus();
        rev.blur();
        if (out.rev.q) {
          out.again = {
            put: await m.insertAnswer(out.rev.q.fieldId, 'A corrected answer.', out.rev.q.question),
            submitted: window.submitted('rev').filter(Boolean),
          };
        }
        return out;
      }, { b: base, text: answer }),
    );
    const both = ['First paragraph of the answer.', 'Second paragraph, after a blank line.'];
    const holds = (r) => JSON.stringify(r?.submitted) === JSON.stringify(both);

    group('Inserting an answer into a rich-text editor');
    check(
      'an editor drawn from its own model (Draft.js) submits the answer, in place of what was there',
      edited.ctl?.put === true && holds(edited.ctl),
      JSON.stringify(edited.ctl),
    );
    check(
      'one that puts its own document back (CKEditor 5) keeps the answer',
      edited.rev?.put === true && holds(edited.rev),
      JSON.stringify(edited.rev),
    );
    /*
     * CKEditor 5 draws its root's attributes from its own model, so the mark
     * findQuestions puts on the box is gone the first time anybody clicks
     * in it. Against the real editor: click in, press Insert, and it refused
     * with "that box on the page is gone" with the box in plain view.
     */
    check(
      'and takes a corrected answer after the person has clicked in it',
      edited.again?.put === true && JSON.stringify(edited.again?.submitted) === '["A corrected answer."]',
      JSON.stringify(edited.again),
    );
    check(
      'one that reads the page back (Quill 1, TinyMCE) keeps both paragraphs',
      edited.read?.put === true && holds(edited.read),
      JSON.stringify(edited.read),
    );

    /* ---------------- Workday's My Information step ---------------- */
    const myInfo = await page.goto(`${base}/workday-info`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = { address_country: 'United States', address_state: 'VA', address_city: 'McLean', phone: '(703) 555-0100' };
        const began = performance.now();
        const report = await m.fillComboboxes(fields, m.fillForm(fields));
        return {
          ms: Math.round(performance.now() - began),
          state: document.getElementById('address--countryRegion').textContent,
          country: document.getElementById('country--country').textContent,
          byHand: report.skipped.filter((x) => /by hand/.test(x.reason)).map((x) => x.key),
          filled: report.filled.map((x) => x.key),
          pills: [...document.querySelectorAll('[data-automation-id="selectedItem"]')].map((p) => p.title),
          phone: document.getElementById('phoneNumber--phoneNumber').value,
          log: window.__log,
          open: Boolean(document.querySelector('#popup')),
        };
      }, { b: base }),
    );
    group('Workday: My Information');
    check('the state is chosen, though Workday names its box countryRegion', myInfo.state === 'Virginia', myInfo.state);
    check(
      'and counted as chosen: "Virginia" is what "VA" looks like once it has taken',
      myInfo.filled.includes('address_state') && !myInfo.byHand.includes('address_state'),
      JSON.stringify({ filled: myInfo.filled, byHand: myInfo.byHand }),
    );
    check(
      'a country already chosen is not pressed again',
      !myInfo.log.includes('pressed country--country') && myInfo.country === 'United States of America',
      JSON.stringify(myInfo.log),
    );
    check('nor reported as one to pick by hand', !myInfo.byHand.includes('address_country'), JSON.stringify(myInfo.byHand));
    check(
      'the country phone code is left as the form set it',
      JSON.stringify(myInfo.pills) === '["United States of America (+1)"]' &&
        !myInfo.log.some((l) => /country phone code/.test(l)),
      JSON.stringify({ pills: myInfo.pills, log: myInfo.log }),
    );
    check('the number goes in its own box', myInfo.phone === '(703) 555-0100', myInfo.phone);
    check('and nothing is left open, in well under the time a person would wait', !myInfo.open && myInfo.ms < 5000, `${myInfo.ms}ms`);

    /* ---------------- Greenhouse's education block ---------------- */
    const education = await page.goto(`${base}/greenhouse-education`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        const fields = { school: 'University of Texas at Austin', degree: 'Bachelor of Science', major: 'Computer Science', address_country: 'United States' };
        const began = performance.now();
        const report = await m.fillComboboxes(fields, m.fillForm(fields));
        const shown = (id) => document.getElementById(id).closest('.select__control').querySelector('.select__single-value')?.textContent ?? '';
        return {
          ms: Math.round(performance.now() - began),
          school: shown('school--0'),
          degree: shown('degree--0'),
          discipline: shown('discipline--0'),
          country: document.getElementById('country').closest('.select__control').dataset.chosen ?? '',
          countryShows: shown('country'),
          filled: report.filled.map((x) => x.key),
          byHand: report.skipped.filter((x) => /by hand/.test(x.reason)).map((x) => x.key),
        };
      }, { b: base }),
    );
    group('Greenhouse: the education block');
    check('the school, from a list that searches only once it is open', education.school === 'University of Texas at Austin', education.school);
    check('the degree, by its level, from a fixed list', education.degree === "Bachelor's Degree", education.degree);
    check('the discipline', education.discipline === 'Computer Science', education.discipline);
    check('the country, from a list that writes each one\'s dialling code after it', education.country === 'United States +1' && education.countryShows === '+1', `${education.country} (shows ${education.countryShows})`);
    check(
      'all three counted as chosen',
      ['school', 'degree', 'major'].every((k) => education.filled.includes(k)) && education.byHand.length === 0,
      JSON.stringify({ filled: education.filled, byHand: education.byHand, ms: education.ms }),
    );

    // The GPA bands again, drawn the way this form draws a dropdown.
    const gpaWidget = await page.goto(`${base}/greenhouse-education`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b }) => {
        const m = await import(`${b}/autofill.js`);
        document.querySelector('.education--form').insertAdjacentHTML(
          'beforeend',
          `<label id="gpa--0-label" for="gpa--0">GPA</label>
          <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
            <div class="select__input-container" data-value=""><input id="gpa--0" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="gpa--0-label" autocomplete="off"></div></div></div></div>`,
        );
        select('gpa--0', { fixed: ['Below 2.50', '2.50 - 2.99', '3.00 - 3.49', '3.50 - 3.74', '3.75 - 4.00'] });
        const fields = { gpa: '3.8' };
        const report = await m.fillComboboxes(fields, m.fillForm(fields));
        return {
          shown: document.getElementById('gpa--0').closest('.select__control').querySelector('.select__single-value')?.textContent ?? '',
          filled: report.filled.map((x) => x.key),
        };
      }, { b: base }),
    );
    check('a GPA widget takes the band that holds the grade', gpaWidget.shown === '3.75 - 4.00' && gpaWidget.filled.includes('gpa'), JSON.stringify(gpaWidget));

    /*
     * Greenhouse's "Location (City)": a search of places once something is
     * typed, answered — measured on the live SpaceX board, typing "Boston" —
     * with every Boston there is, none of them spelled "Boston". It was left
     * for the person.
     */
    const SUGGESTED = [
      'Boston, Massachusetts, United States', 'Boston District, England, United Kingdom', 'Boston, England, United Kingdom',
      'East Boston, Massachusetts, United States', 'Bostonia, California, United States', 'Boston, Davao Oriental, Philippines',
      'Boston, New York, United States', 'South Boston, Virginia, United States',
    ];
    const place = (fields) =>
      page.goto(`${base}/greenhouse-education`, { waitUntil: 'domcontentloaded' }).then(() =>
        page.evaluate(async ({ b, fields, places }) => {
          const m = await import(`${b}/autofill.js`);
          document.querySelector('.education--form').insertAdjacentHTML(
            'beforebegin',
            `<label id="candidate-location-label" for="candidate-location">Location (City)<span>*</span></label>
            <div class="select-shell"><div class="select__control"><div class="select__value-container"><div class="select__placeholder">Select...</div>
              <div class="select__input-container" data-value=""><input id="candidate-location" class="select__input" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="candidate-location-label" autocomplete="off"></div></div></div></div>`,
          );
          const town = (term) => term.split(',')[0].trim();
          select('candidate-location', { search: (term) => (town(term) ? places.filter((p) => p.toLowerCase().includes(town(term))) : []), delay: 500 });
          const report = await m.fillComboboxes(fields, m.fillForm(fields));
          return {
            shown: document.getElementById('candidate-location').closest('.select__control').querySelector('.select__single-value')?.textContent ?? '',
            filled: report.filled.map((x) => x.key),
            skipped: report.skipped.map((x) => `${x.key}: ${x.reason}`),
          };
        }, { b: base, fields, places: SUGGESTED }),
      );
    const byCode = await place({ address_city: 'Boston', address_state: 'MA', address_country: 'United States' });
    const byName = await place({ address_city: 'Boston', address_state: 'New York', address_country: 'United States' });
    const noState = await place({ address_city: 'Boston', address_country: 'United States' });
    group('Greenhouse: Location (City), a search of places');
    check(
      'the place whose city, state and country are the profile\'s',
      byCode.shown === 'Boston, Massachusetts, United States' && byCode.filled.includes('address_city'),
      JSON.stringify(byCode),
    );
    check('a state held by its name picks the Boston in that state', byName.shown === 'Boston, New York, United States', JSON.stringify(byName));
    check('and a city with no state to tell it from its namesakes is left for the person', noState.shown === '', JSON.stringify(noState));

    /* ---------------- Greenhouse: Stripe's board ---------------- */
    /*
     * Reported: "Greenhouse forms appear filled for a second then return to
     * not being filled" — School on "Select...", the Degree box showing the
     * typed words "Bachelor of Science" with the caret still in it. Every
     * answer here is read back the way the board keeps it: after the last box
     * has lost focus, from the drawn single value, which is the only thing a
     * react-select submits.
     */
    const stripe = (fields, query = '') =>
      page.goto(`${base}/greenhouse-stripe${query}`, { waitUntil: 'domcontentloaded' }).then(() =>
        page.evaluate(async ({ b, fields }) => {
          const m = await import(`${b}/autofill.js`);
          const report = await m.fillComboboxes(fields, m.fillForm(fields));
          document.activeElement?.blur?.();
          await new Promise((r) => setTimeout(r, 300));
          const shown = (id) => document.getElementById(id).closest('.select__control').querySelector('.select__single-value')?.textContent ?? '';
          return {
            school: shown('school--0'),
            degree: shown('degree--0'),
            discipline: shown('discipline--0'),
            eligible: shown('question_68702648'),
            sponsorship: shown('question_68581559'),
            typed: ['school--0', 'degree--0', 'discipline--0'].map((id) => document.getElementById(id).value).join(''),
            notListed: document.getElementById('question_68843617').value,
            filled: report.filled.map((x) => x.key + (x.widget ? '(widget)' : x.notListed ? '(not listed)' : '')),
            byHand: report.skipped.filter((x) => /by hand/.test(x.reason)).map((x) => x.key),
          };
        }, { b: base, fields }),
      );
    const STRIPE_PROFILE = {
      school: 'Northeastern University', degree: 'Bachelor of Science', major: 'Computer Science',
      work_authorization: 'Authorized to work in the US', requires_sponsorship: 'No', address_country: 'United States',
    };
    const onStripe = await stripe(STRIPE_PROFILE);
    const unlistedSchool = await stripe({ ...STRIPE_PROFILE, school: 'Wentworth Harbour College' });
    const ignoredPress = await stripe(STRIPE_PROFILE, '?ignored');
    group("Greenhouse: Stripe's board, read back once the fill has moved on");
    check(
      'a degree list still loading when the menu opens is waited for, not typed over',
      onStripe.degree === "Bachelor's Degree" && onStripe.filled.includes('degree(widget)'),
      JSON.stringify(onStripe),
    );
    check('the school and the discipline stay chosen too, with nothing left typed', onStripe.school === 'Northeastern University' && onStripe.discipline === 'Computer Science' && onStripe.typed === '', JSON.stringify(onStripe));
    check(
      'eligibility to work, offered as a Yes sentence and a No sentence, is answered Yes',
      onStripe.eligible.startsWith('Yes, I am currently eligible') && onStripe.filled.includes('work_authorization(widget)'),
      JSON.stringify(onStripe),
    );
    check(
      'and sponsorship, offered the same way, is answered No',
      onStripe.sponsorship.startsWith('No, I do not require') && onStripe.filled.includes('requires_sponsorship(widget)'),
      JSON.stringify(onStripe),
    );
    check(
      'the box for a school the list does not have is left empty when the list has it',
      onStripe.notListed === '' && !onStripe.filled.includes('school') && onStripe.filled.includes('school(widget)'),
      JSON.stringify(onStripe),
    );
    check(
      'and takes the school when the list does not, with the dropdown still said to be yours to pick',
      unlistedSchool.notListed === 'Wentworth Harbour College' && unlistedSchool.school === '' && unlistedSchool.byHand.includes('school'),
      JSON.stringify(unlistedSchool),
    );
    check(
      'a press that shuts the menu without choosing, the typed school still in the box, is not counted as a choice',
      ignoredPress.school === '' && !ignoredPress.filled.includes('school(widget)') && ignoredPress.byHand.includes('school'),
      JSON.stringify(ignoredPress),
    );

    /* ---------------- Greenhouse: more than one education ---------------- */
    /*
     * Reported: "ideally it should be able to add new entries here if I have
     * more than one education then autofill the two things separately". Filled
     * the way content.js fills a document — `fillForm`, then `fillComboboxes`,
     * then `fillEducation` with the resume's schools — and read back after the
     * last box has lost focus, from what each widget draws.
     */
    const educations = (fields, education, query = '') =>
      page.goto(`${base}/greenhouse-more-education${query}`, { waitUntil: 'domcontentloaded' }).then(() =>
        page.evaluate(async ({ b, fields, education }) => {
          const m = await import(`${b}/autofill.js`);
          const first = await m.fillComboboxes(fields, m.fillForm(fields));
          const report = await m.fillEducation(education, fields, first);
          document.activeElement?.blur?.();
          await new Promise((r) => setTimeout(r, 300));
          const shown = (el) => {
            const control = el.closest('.select__control');
            return control ? control.querySelector('.select__single-value')?.textContent ?? '' : el.value;
          };
          const blocks = [...document.querySelectorAll('.education--form')].map((form) =>
            Object.fromEntries([...form.querySelectorAll('input[id]')].map((el) => [el.id.replace(/--\d+$/, ''), shown(el)])),
          );
          return {
            blocks,
            pressed: window.__pressed,
            jobs: document.querySelectorAll('.employment--form').length,
            same: JSON.stringify(first) === JSON.stringify(report),
            // What `fillEducation` added to the report, and whether it left the rest of it alone.
            added: report.filled.slice(first.filled.length).map((x) => x.key),
            kept: JSON.stringify(report.filled.slice(0, first.filled.length)) === JSON.stringify(first.filled) &&
              JSON.stringify(report.skipped) === JSON.stringify(first.skipped),
            filled: report.filled.map((x) => x.key + (x.education ? `#${x.education}` : '')),
            skipped: report.skipped.map((x) => `${x.key}: ${x.reason}`),
          };
        }, { b: base, fields, education }),
      );
    const NEWEST = {
      first_name: 'Morgan', school: 'Boston University', degree: 'Master of Science', major: 'Computer Science',
      education_start_month: 'September', education_start_year: '2027', education_start_date: 'September 2027',
      graduation_month: 'May', graduation_year: '2028', graduation_date: 'May 2028',
    };
    const MASTERS = { school: 'Boston University', degree: 'Master of Science', major: 'Computer Science', start: { year: 2027, month: 9 }, end: { year: 2028, month: 5 } };
    const BACHELORS = { school: 'Northeastern University', degree: 'Bachelor of Science', major: 'Computer Science', start: { year: 2023, month: 9 }, end: { year: 2027, month: 5 } };
    // The one education most people have, as the store sends it: the profile's fields and the resume's one entry.
    const ONE = {
      first_name: 'Morgan', school: 'Northeastern University', degree: 'Bachelor of Science', major: 'Computer Science',
      education_start_month: 'September', education_start_year: '2023', education_start_date: 'September 2023',
      graduation_month: 'May', graduation_year: '2027', graduation_date: 'May 2027',
    };
    const two = await educations(NEWEST, [MASTERS, BACHELORS]);
    const oneOnly = await educations(ONE, [BACHELORS]);
    const oneDated = await educations(ONE, [BACHELORS], '?dated');
    // A profile without the discipline the resume's entry has: still only the dates.
    const oneNoMajor = await educations({ ...ONE, major: '' }, [BACHELORS]);
    const oneElsewhere = await educations(ONE, [BACHELORS], `?first=${encodeURIComponent('Acadia University')}`);
    const bachelorFirst = await educations(
      { first_name: 'Morgan', school: 'Northeastern University', degree: 'Bachelor of Science', major: 'Computer Science' },
      [BACHELORS, { school: 'Boston Latin School', degree: 'High School Diploma', end: { year: 2023, month: 6 } }],
      '?levels',
    );
    const alreadyChosen = await educations(NEWEST, [MASTERS, BACHELORS], '?chosen');
    const notOnTheResume = await educations({ ...NEWEST, school: 'Aalto University' }, [MASTERS, BACHELORS]);
    const begunSchool = await educations(NEWEST, [MASTERS, BACHELORS], `?chosen=${encodeURIComponent('Northeastern University')}&degree=Other`);
    const unlistedFirst = await educations(
      { ...NEWEST, school: 'Wentworth Harbour College' },
      [{ ...MASTERS, school: 'Wentworth Harbour College' }, BACHELORS],
    );
    group('Greenhouse: more than one education, from the resume being sent');
    check(
      'a second education gets a block of its own, added with the section\'s "Add another" and filled from it',
      two.blocks[1]?.school === 'Northeastern University' && two.blocks[1]?.degree === "Bachelor's Degree" && two.blocks[1]?.discipline === 'Computer Science',
      JSON.stringify(two.blocks[1] ?? two),
    );
    check(
      'with its own start and end, month and year',
      two.blocks[1]?.['start-month'] === 'September' && two.blocks[1]?.['start-year'] === '2023' &&
        two.blocks[1]?.['end-month'] === 'May' && two.blocks[1]?.['end-year'] === '2027',
      JSON.stringify(two.blocks[1] ?? two),
    );
    check(
      'the first block is still the newest education, and gets its dates too',
      two.blocks[0]?.school === 'Boston University' && two.blocks[0]?.degree === "Master's Degree" &&
        two.blocks[0]?.['start-year'] === '2027' && two.blocks[0]?.['end-month'] === 'May' && two.blocks[0]?.['end-year'] === '2028',
      JSON.stringify(two.blocks[0] ?? two),
    );
    check(
      'only as many blocks as there are educations, and the work history\'s "Add another" is never pressed',
      two.blocks.length === 2 && two.pressed.education === 1 && two.pressed.employment === 0 && two.jobs === 1,
      JSON.stringify({ blocks: two.blocks.length, pressed: two.pressed, jobs: two.jobs }),
    );
    /*
     * One education. Measured on Twitch's live board before this was fixed:
     * School, Degree and Discipline chosen, and the Start and End month and
     * year all left empty with nothing said about them, because the
     * one-education fill returned before reaching the dates the first pass
     * cannot read under a `<p>` heading.
     */
    check(
      'one education gets its start and end, month and year, in its one block',
      oneOnly.blocks[0]?.['start-month'] === 'September' && oneOnly.blocks[0]?.['start-year'] === '2023' &&
        oneOnly.blocks[0]?.['end-month'] === 'May' && oneOnly.blocks[0]?.['end-year'] === '2027' &&
        ['education_start_month', 'education_start_year', 'graduation_month', 'graduation_year'].every((k) => oneOnly.added.includes(k)),
      JSON.stringify({ block: oneOnly.blocks[0], added: oneOnly.added }),
    );
    check(
      'and nothing else changes: no block is added, and the rest of the report is the one it was',
      oneOnly.blocks.length === 1 && oneOnly.pressed.education === 0 && oneOnly.pressed.employment === 0 && oneOnly.kept &&
        oneOnly.added.every((k) => /^(education_start|graduation)_/.test(k)) &&
        oneOnly.blocks[0]?.school === 'Northeastern University' && oneOnly.blocks[0]?.degree === "Bachelor's Degree" && oneOnly.blocks[0]?.discipline === 'Computer Science' &&
        oneNoMajor.blocks[0]?.discipline === '' && oneNoMajor.kept && oneNoMajor.added.every((k) => /^(education_start|graduation)_/.test(k)) &&
        oneNoMajor.blocks[0]?.['end-year'] === '2027',
      JSON.stringify({ oneOnly, oneNoMajor }),
    );
    check(
      'a date already entered for the one education is not written over',
      oneDated.blocks[0]?.['start-month'] === 'January' && oneDated.blocks[0]?.['start-year'] === '2022' &&
        oneDated.blocks[0]?.['end-month'] === 'May' && oneDated.blocks[0]?.['end-year'] === '2027' &&
        !oneDated.added.includes('education_start_month') && !oneDated.added.includes('education_start_year'),
      JSON.stringify({ block: oneDated.blocks[0], added: oneDated.added }),
    );
    check(
      'a first block already showing another school is not given this one\'s dates',
      oneElsewhere.blocks.length === 1 && oneElsewhere.blocks[0]?.school === 'Acadia University' &&
        ['start-month', 'start-year', 'end-month', 'end-year'].every((k) => oneElsewhere.blocks[0]?.[k] === '') && oneElsewhere.same,
      JSON.stringify(oneElsewhere),
    );
    check(
      'a block asking about graduate school is not given a high school',
      bachelorFirst.blocks[0]?.school === 'Northeastern University' &&
        bachelorFirst.blocks.slice(1).every((block) => block.school === '' && block.degree === '' && block['end-year'] === '') &&
        bachelorFirst.skipped.some((s) => /level/.test(s)) && bachelorFirst.pressed.education <= 1,
      JSON.stringify(bachelorFirst),
    );
    check(
      'a block already showing a school the resume does not list is left as it was, and no third block is added',
      alreadyChosen.blocks.length === 2 && alreadyChosen.blocks[1]?.school === 'Acadia University' && alreadyChosen.blocks[1]?.degree === '' &&
        alreadyChosen.pressed.education === 0 && alreadyChosen.skipped.some((s) => /not on the resume/.test(s)),
      JSON.stringify(alreadyChosen),
    );
    check(
      'a first block from a school the resume does not list adds nothing, rather than risk the same school twice',
      notOnTheResume.blocks.length === 1 && notOnTheResume.pressed.education === 0 && notOnTheResume.same,
      JSON.stringify(notOnTheResume),
    );
    check(
      'a block somebody began is finished from its own school, keeping the degree they chose',
      begunSchool.blocks.length === 2 && begunSchool.pressed.education === 0 && begunSchool.blocks[1]?.school === 'Northeastern University' &&
        begunSchool.blocks[1]?.degree === 'Other' && begunSchool.blocks[1]?.discipline === 'Computer Science' && begunSchool.blocks[1]?.['end-year'] === '2027',
      JSON.stringify(begunSchool.blocks[1] ?? begunSchool),
    );
    check(
      'a school the first fill could not find in the list is not looked for again, and the next school still gets its block',
      unlistedFirst.skipped.filter((s) => s.startsWith('school:')).length === 1 && unlistedFirst.blocks[0]?.['end-year'] === '2028' &&
        unlistedFirst.blocks[1]?.school === 'Northeastern University',
      JSON.stringify(unlistedFirst),
    );

    /* ---------------- Workday's My Experience: a work history ---------------- */
    /*
     * Reported: the Role Description "should be filled with resume stuff".
     * Each block takes a job from the resume being sent — its title, company,
     * place, dates and the lines it prints — and nothing a model wrote.
     */
    const readJobs = () => {
      const v = (id) => document.getElementById(id);
      return [1, 2, 3].map((n) => (v(`workExperience-${n}--jobTitle`)
        ? {
            title: v(`workExperience-${n}--jobTitle`).value,
            company: v(`workExperience-${n}--companyName`).value,
            location: v(`workExperience-${n}--location`).value,
            current: v(`workExperience-${n}--currentlyWorkHere`).checked,
            from: `${v(`workExperience-${n}--startDate-month`).value}/${v(`workExperience-${n}--startDate-year`).value}`,
            to: `${v(`workExperience-${n}--endDate-month`).value}/${v(`workExperience-${n}--endDate-year`).value}`,
            description: v(`workExperience-${n}--roleDescription`).value,
          }
        : null)).filter(Boolean);
    };
    const experience = await page.goto(`${base}/workday-experience`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, jobs, read }) => {
        const m = await import(`${b}/autofill.js`);
        const before = m.findQuestions().map((q) => q.question);
        const bare = m.fillForm({ address_city: 'McLean' });
        const report = m.fillForm({ address_city: 'McLean' }, { history: jobs });
        return { before, bare: bare.filled.map((f) => f.key), filled: report.filled.map((f) => f.key), jobs: new Function(`return (${read})()`)() };
      }, { b: base, jobs: JOBS, read: readJobs.toString() }),
    );
    group('Workday: My Experience, from the resume being sent');
    check(
      'each job goes into a block of its own, in the resume\'s order',
      experience.jobs[0]?.company === 'Vega Analytics' && experience.jobs[0]?.title === 'Backend Engineer' &&
        experience.jobs[1]?.company === 'Acme Co.' && experience.jobs[1]?.title === 'Software Engineer Co-op',
      JSON.stringify(experience.jobs.map((j) => [j.company, j.title])),
    );
    check(
      'with the lines the resume prints for it as the Role Description',
      experience.jobs[0]?.description === JOBS[0].description && experience.jobs[1]?.description === JOBS[1].description,
      JSON.stringify(experience.jobs.map((j) => j.description)),
    );
    check(
      'the dates in the month and year boxes, and "I currently work here" for the one that is still going',
      experience.jobs[0]?.from === '06/2023' && experience.jobs[0]?.to === '/' && experience.jobs[0]?.current === true &&
        experience.jobs[1]?.from === '07/2022' && experience.jobs[1]?.to === '12/2022' && experience.jobs[1]?.current === false,
      JSON.stringify(experience.jobs.map((j) => [j.from, j.to, j.current])),
    );
    check('the job\'s place, not the applicant\'s home', experience.jobs.every((j) => j.location === 'Boston, MA'), JSON.stringify(experience.jobs.map((j) => j.location)));
    check('and nothing at all without a resume to fill it from', experience.bare.length === 0, JSON.stringify(experience.bare));
    check(
      'a Role Description is not offered as a question for the AI to write',
      JSON.stringify(experience.before) === '["Why do you want to work on this team?"]',
      JSON.stringify(experience.before),
    );

    const begun = await page.goto(`${base}/workday-experience-begun`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, jobs, read }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm({}, { history: jobs });
        return {
          jobs: new Function(`return (${read})()`)(),
          skipped: report.skipped.filter((x) => x.key === 'work_history').map((x) => x.description),
          questions: m.findQuestions().map((q) => q.question),
        };
      }, { b: base, jobs: JOBS, read: readJobs.toString() }),
    );
    check(
      'a block somebody has begun is filled for the job it names',
      begun.jobs[0]?.company === 'Acme' && begun.jobs[0]?.title === 'Software Engineer Co-op' && begun.jobs[0]?.description === JOBS[1].description,
      JSON.stringify(begun.jobs[0]),
    );
    check(
      'and the next empty one takes the job still left, keeping what was typed there',
      begun.jobs[1]?.company === 'Vega Analytics' && begun.jobs[1]?.description === 'My own words about it.',
      JSON.stringify(begun.jobs[1]),
    );
    check(
      'a job the resume does not list is left exactly as it was, and said so',
      begun.jobs[2]?.company === 'Globex' && begun.jobs[2]?.title === '' && begun.jobs[2]?.description === '' && JSON.stringify(begun.skipped) === '["Globex"]',
      JSON.stringify({ job: begun.jobs[2], skipped: begun.skipped }),
    );
    check(
      'while a description outside the work history is still a question',
      JSON.stringify(begun.questions) === '["Project description"]',
      JSON.stringify(begun.questions),
    );

    /* ---------------- Found filling live forms with a fake profile ---------------- */
    const SWEEP = {
      first_name: 'Morgan', last_name: 'Testwell', full_name: 'Morgan Testwell', email: 'morgan.testwell@example.com', phone: '(555) 010-0199',
      school: 'Northeastern University', degree: 'Bachelor of Science', major: 'Computer Science',
      address_city: 'Boston', address_state: 'MA', address_country: 'United States',
      work_authorization: 'Authorized to work in the US', requires_sponsorship: 'No',
    };
    const named = await page.goto(`${base}/name-of-a-thing`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, fields }) => {
        const m = await import(`${b}/autofill.js`);
        m.fillForm(fields);
        return Object.fromEntries(['first_name', 'question_69008301', 'q_school', 'q_company', 'q_full', 'q_yours'].map((id) => [id, document.getElementById(id).value]));
      }, { b: base, fields: SWEEP }),
    );
    group('The full name of something, which is not the applicant\'s name');
    check(
      'Datadog\'s "full name of your major" is given the subject, not the applicant\'s name',
      named.question_69008301 === 'Computer Science',
      JSON.stringify(named),
    );
    check(
      'the full name of a university is the school, and the legal name of a company is left alone',
      named.q_school === 'Northeastern University' && named.q_company === '',
      JSON.stringify(named),
    );
    check(
      '"Full Legal Name" and "Your name" are still the applicant\'s',
      named.q_full === 'Morgan Testwell' && named.q_yours === 'Morgan Testwell' && named.first_name === 'Morgan',
      JSON.stringify(named),
    );

    const countryNamed = await page.goto(`${base}/country-named`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, fields }) => {
        const m = await import(`${b}/autofill.js`);
        const report = await m.fillComboboxes(fields, m.fillForm(fields), { patience: 800 });
        return {
          es: document.querySelector('#q_es')?.closest('.select__control')?.querySelector('.select__single-value')?.textContent ?? '',
          br: document.getElementById('q_br').value,
          us: document.getElementById('q_us').value,
          skipped: report.skipped.map((s) => `${s.key}: ${s.reason}`),
        };
      }, { b: base, fields: SWEEP }),
    );
    group('A yes or a no about a country the profile says nothing about');
    check(
      'Affirm\'s "sponsorship … in Spain?" is not answered from a US declaration, and says why',
      countryNamed.es === '' && countryNamed.skipped.includes('requires_sponsorship: your answer is about another country'),
      JSON.stringify(countryNamed),
    );
    check(
      'nor is "authorized to work in Brazil?", while the US question beside them still is',
      countryNamed.br === '' && countryNamed.us === 'Yes',
      JSON.stringify(countryNamed),
    );

    const code = (fields) => page.goto(`${base}/employers-code`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, fields }) => {
        const m = await import(`${b}/autofill.js`);
        const report = m.fillForm(fields);
        return { phone: document.getElementById('input-candidate.phone-5').value, filled: report.filled.map((f) => f.key) };
      }, { b: base, fields }));
    const usCode = await code(SWEEP);
    const ukCode = await code({ ...SWEEP, phone: '020 7946 0000', address_country: 'United Kingdom' });
    const noCode = await code({ ...SWEEP, address_country: undefined });
    group('A telephone box the form began with its own country\'s code');
    check(
      'a US profile\'s number goes in behind +1, not behind the Dutch employer\'s +31',
      usCode.phone === '+1 (555) 010-0199' && usCode.filled.includes('phone'),
      JSON.stringify(usCode),
    );
    check('and a UK profile\'s behind +44', ukCode.phone === '+44 020 7946 0000', JSON.stringify(ukCode));
    check('with no country in the profile, the form\'s code is kept, as before', noCode.phone === '+31 (555) 010-0199', JSON.stringify(noCode));

    const twice = await page.goto(`${base}/asked-twice`, { waitUntil: 'domcontentloaded' }).then(() =>
      page.evaluate(async ({ b, fields }) => {
        const m = await import(`${b}/autofill.js`);
        const report = await m.fillComboboxes(fields, m.fillForm(fields), { patience: 800 });
        const shown = (id) => document.getElementById(id).closest('.select__control').querySelector('.select__single-value')?.textContent ?? '';
        return {
          text: document.getElementById('question_text_country').value,
          ...Object.fromEntries(['country', 'question_residence', 'question_sp1', 'question_sp2', 'school--0', 'school--1'].map((id) => [id, shown(id)])),
          handPicked: report.skipped.filter((s) => /by hand/.test(s.reason)).map((s) => s.description),
          wrapped: shown('question_wrapped'),
          sponsorships: report.filled.filter((f) => f.key === 'requires_sponsorship').length,
        };
      }, { b: base, fields: SWEEP }),
    );
    group('The same answer, asked twice on one form');
    check(
      'the country of residence is chosen under the phone\'s country picker, and the picker still is',
      twice.country === 'United States' && twice.question_residence === 'United States',
      JSON.stringify(twice),
    );
    check(
      'a text box that took the country first does not stop either picker',
      twice.text === 'United States' && twice.country === 'United States',
      JSON.stringify(twice),
    );
    check(
      'a second sponsorship question is answered as the first was',
      twice.question_sp1 === 'No' && twice.question_sp2 === 'No',
      JSON.stringify(twice),
    );
    check(
      'a second School is still not given the first school, and nothing chosen is left reported as still to pick',
      twice['school--0'] === 'Northeastern University' && twice['school--1'] === '' && twice.handPicked.length === 0,
      JSON.stringify(twice),
    );
    check(
      'a combobox around its own list box is one question, answered and counted once',
      twice.wrapped === 'No' && twice.sponsorships === 3,
      JSON.stringify(twice),
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
