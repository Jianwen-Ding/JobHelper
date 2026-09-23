/**
 * Fills an application form from the profile already stored in ResumeM-M.
 *
 * Deliberately conservative: it only fills fields it is confident about, never
 * overwrites something already typed, and always reports what it touched. A
 * form filled wrongly costs more than a form filled by hand.
 */

/*
 * The privacy rule lives on its own, away from everything that reads a form,
 * because it is the part that has to be reviewable without reading this file.
 */
import { neverRemember, worthRemembering } from '../shared/remembering.js';

/** Map a stored profile key to the label/name patterns that mean it. */
const FIELD_PATTERNS = [
  ['first_name', /\b(first[\s_-]?name|given[\s_-]?name|forename|fname)\b/i],
  ['last_name', /\b(last[\s_-]?name|family[\s_-]?name|surname|lname)\b/i],
  ['full_name', /\b(full[\s_-]?name|your[\s_-]?name|candidate[\s_-]?name|legal[\s_-]?name)\b/i],
  ['email', /\b(e-?mail)\b/i],
  /*
   * "Number" on its own is far too broad — requisition number, employee
   * number, number of years of experience — but the enterprise systems rarely
   * say "phone" at all: Taleo asks for a "Primary Number", and its siblings
   * are "Home Number" and "Mobile Number". So it counts only behind a word
   * that makes it a telephone.
   */
  ['phone', /\b(phone|mobile|telephone|cell)\b|\b(primary|contact|day(?:time)?|home|work|alternate)[\s_-]*number\b/i],
  ['linkedin', /\b(linked-?in)\b/i],
  ['github', /\b(git-?hub)\b/i],
  ['website', /\b(website|portfolio|personal[\s_-]?site|homepage)\b/i],
  /*
   * The job somebody holds now. Only with "current", "present" or "most
   * recent" in front: a bare "Company" is a row of a job-history section,
   * which asks about every job in turn and is not this question. Lever's is
   * `name="org"` with "Current company" as its only label, and it read as
   * nothing at all.
   */
  ['current_company', /\b(current|present|most[\s_-]*recent)[\s_-]*(company|employer|organi[sz]ation|org)\b/i],
  ['current_title', /\b(current|present|most[\s_-]*recent)[\s_-]*(job[\s_-]*)?(title|role|position)\b/i],
  /*
   * When the degree ends. Above school and degree on purpose: the first
   * pattern to match claims the field, and "Graduation date from your
   * university" or "Expected degree completion" would otherwise be taken as
   * the school's name or the degree's.
   *
   * Month and year before the date, because "Expected graduation year" is
   * asking for the year alone. Nothing here fires on a bare "graduate" — "Are
   * you a recent graduate?" is a yes/no question, and a date is not its answer.
   */
  ['graduation_month', /(\bgrad\b|\bgraduat\w*|\bcompletion\b).{0,40}\bmonth\b|\bmonth\b.{0,40}\bgraduat/i],
  ['graduation_year', /(\bgrad\b|\bgraduat\w*|\bcompletion\b).{0,40}\byear\b|\byear\b.{0,40}\bgraduat|\bclass\s*year\b/i],
  [
    'graduation_date',
    /\bgrad(uation)?\s*date\b|\bdate\s*of\s*graduation\b|\b(expected|anticipated)\s*grad(uation)?\b|\bwhen\s+(do|will)\s+you\s+(expect\s+to\s+)?graduate\b/i,
  ],
  /*
   * The grade and the subject above the school, for the reason graduation is:
   * "College GPA" and "University major" name the institution, and with
   * `school` first they were filled with its name.
   */
  ['gpa', /\bgpa\b/i],
  ['major', /\b(major|discipline|field[\s_-]?of[\s_-]?study|(course|area)[\s_-]?of[\s_-]?study)\b/i],
  ['school', /\b(school|university|college|institution|institute)\b/i],
  ['degree', /\b(degree)\b/i],
  /*
   * The two declarations above every address field. "Are you authorized to
   * work in this country?" is the commonest wording of the right-to-work
   * question, and with `address_country` first it claimed the question: the
   * yes/no pair was offered "United States", matched neither button, and the
   * required question was left blank. No address label says "authorized to
   * work" or "sponsor", so nothing moves the other way. "Eligible to work" is
   * the same question and matched nothing.
   */
  /*
   * `\w*` where a stem was truncated. These two read as if they matched
   * anything starting with the stem, and matched nothing at all: a trailing
   * \b after "authoriz" demands a word boundary between "z" and "a", so
   * "work authorization" — the words every form actually uses — never matched,
   * and neither did "sponsorship".
   */
  /*
   * `authoriz\w+ to work` as well, because that is how the question is put
   * when it is not put as two nouns: "Are you authorized to work in the US for
   * any employer?" is the commonest phrasing on the hosted boards and matched
   * none of the three above — the required question came out blank and, having
   * matched no key at all, was not reported either. The conjunction with
   * sponsorship is still refused; see `asksBothAtOnce`.
   */
  [
    'work_authorization',
    /\b(work[\s_-]?authoriz\w*|legally[\s_-]?authorized|authoriz\w+[\s_-]+to[\s_-]+work|eligib\w*[\s_-]+to[\s_-]+work|right[\s_-]?to[\s_-]?work)\b/i,
  ],
  ['requires_sponsorship', /\b(sponsor\w*|visa[\s_-]?status)\b/i],
  ['address_city', /\b(city|town)\b/i],
  /*
   * Country before state, because the first pattern to match wins and
   * "Country/Region" — which is what SuccessFactors, Workday and most of the
   * enterprise systems call the field — matches `region`. It was being filled
   * with a state, finding no such option, and reporting that the country had
   * no matching option while leaving a required field empty.
   */
  ['address_country', /\b(country)\b/i],
  /*
   * "State" the noun, not the verb: "Please state your reason for applying"
   * is a free-text question, and it was typed over with the applicant's state.
   */
  [
    'address_state',
    /(?<!\bplease[\s_-]+)\b(state|province|region)\b(?![\s_-]+(?:your|why|how|what|whether|if|the|any|briefly|clearly|below)\b)/i,
  ],
  ['location', /\b(location|where.*based)\b/i],
];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

/**
 * Fields that carry one of the patterns above and are not about the applicant.
 *
 * Every one of these was measured: with a profile loaded, "Reference 1 email"
 * was filled with the applicant's own address, "Emergency contact number" and
 * "Reference 1 phone" with their own telephone number, "Reference 1 full name"
 * with their own name, and "Where did you hear about this job? (LinkedIn,
 * Indeed, referral)" with their LinkedIn URL. Each is a wrong answer rather
 * than a missing one — a referee who is really the candidate, an emergency
 * contact who is the person having the emergency — and the card counted them
 * as fields successfully filled.
 *
 * Citizenship is the same mistake about a different thing: `address_country`
 * is where the applicant lives, and "Country of citizenship" was being filled
 * from it. Someone living in the United States on a visa was having their
 * application state that they are a US citizen. Birth is a third question
 * with the same answers again — "Country of Birth", "City of Birth" and
 * "State/Province of Birth" were being filled with where the applicant lives
 * now, which for anyone who has moved country is simply false, and false on
 * the part of the form an employer passes to an immigration lawyer.
 *
 * Salary matches nothing here today. It is listed because the cost of that
 * changing is a lie about money, and the cost of naming it now is a line of
 * regex. The self-identification line is not in that position: a signature
 * box on a voluntary EEO or disability form is labelled "Your Name", which
 * `full_name` matches, so the applicant's legal name was being typed onto the
 * signature line of a form they had not chosen to complete.
 */
const NOT_ABOUT_YOU = [
  // Somebody else's name, telephone number or address.
  /\b(references?|referee|emergency|next[\s_-]?of[\s_-]?kin|guardian|spouse|supervisor|manager'?s?|recommender)\b/i,
  /*
   * A previous employer's address, which the employment-history sections of
   * Taleo and BrassRing ask for field by field. "Employer City" matched
   * `address_city` and was filled with the applicant's own town.
   *
   * `location` and `email` were missing from the list, and "Employer
   * Location" is what Workday, Greenhouse and iCIMS all call that field —
   * one line per past job, filled in with the applicant's own current city as
   * a stated fact about where somebody else's office was. Exactly the case
   * above, on the word those three happen to use.
   */
  /\b(employer|company|organi[sz]ation)['’]?s?[\s_-]+(name|address|location|city|town|state|province|country|phone|telephone|email|zip|postal)\b/i,
  /*
   * Permission to contact an employer, which is a yes or a no and not the
   * employer's name — "Can we contact your current employer?" took
   * `current_company` — and the employer's own contact, which "Employer
   * contact email" gave the applicant's address.
   */
  /\bcontact\b[\s\S]{0,30}\bemployers?\b|\bemployers?\b[\s\S]{0,20}\bcontact\b/i,
  /*
   * How long, not who. "Years at current company" matched `current_company`
   * and was given the employer's name in a box asking for a number.
   */
  /\b(years?|months?|how[\s_-]long|tenure|duration)\b[\s\S]{0,24}\b(current|present|most[\s_-]recent)\b/i,
  // How to say a name, which is not the name: "Pronunciation of your name".
  /\b(pronunc\w*|phonetic\w*)\b/i,
  // Where you heard about the job, which is not a profile of yours.
  /\b(did[\s_-]you[\s_-](?:first[\s_-])?hear|hear[\s_-](?:about|of)[\s_-](us|this)|referral)\b/i,
  // Citizenship, birth and residence are different questions with the same
  // answers.
  /\b(citizen\w*|nationality|passport)\b/i,
  /\b(birth|born)\b/i,
  /*
   * A preference about the job, not a fact about the applicant — in either
   * order, because the forms put it both ways: "Preferred Work Location" and
   * "Location Preference" are the same question, and only the first was
   * caught. Both were filled with where the applicant lives, which turns
   * "where I am" into "where I want to be" without being asked.
   */
  /\b(prefer\w*|desired|requested)\b[\s\S]{0,24}\b(location|city|town|country|office|site)\b/i,
  // "Which location are you applying for?" is the same question again.
  /\b(location|city|town|country|office|site)\b[\s\S]{0,24}\b(prefer\w*|desired|requested|applying)\b/i,
  // Relocation is about somewhere you are not. "Which city would you relocate
  // to?" was answered with the city the applicant already lives in.
  /\brelocat\w*/i,
  /\b(salary|compensation|wage|pay[\s_-]?rate|hourly[\s_-]?rate|bonus)\b/i,
  /\b(gender|race|ethnicit\w*|hispanic|latin[ox]|veteran|disabilit\w*|sexual[\s_-]orientation|pronouns)\b/i,
  /\b(eeoc?|self[\s_-]?identification|equal[\s_-]employment)\b/i,
  /*
   * School before the degree. The profile's education is the newest one, and
   * a "High School" box was being told the applicant went to high school at
   * their university — with "High school GPA" given the university's grade.
   */
  /\b(high|secondary)[\s_-]?school\b/i,
  /*
   * A consent question, which is not a fact about the applicant at all — it
   * is a decision about what the employer may send them.
   *
   * Measured: a group headed "Marketing: may we email you about sponsorship
   * webinars?" was answered "No", from `requires_sponsorship`, because
   * `sponsor\w*` matched the word "sponsorship" in it. That is the visa
   * answer written onto a mailing-list question — and the same shape reaches
   * any of these patterns, because a consent question is free to mention
   * whatever it is consenting about.
   *
   * Two rules rather than one long list of words, and both are deliberately
   * narrow. The nouns are ones no profile field is ever called. The second
   * wants "may we"/"can we" *and* an "about" within a phrase of it, so it
   * catches "may we email you about openings" and not "How can we contact
   * you?", which is the heading over a real email box.
   */
  /\b(marketing|newsletter|mailing[\s_-]?list|promotional?|webinars?|subscribe|unsubscribe|opt[\s_-]?(?:in|out)|communications?[\s_-]?preferences?)\b/i,
  /\b(?:may|can)[\s_-]we\b[\s\S]{0,40}\babout\b/i,
];

/**
 * The box beside a telephone number that wants "+1", not a telephone number.
 *
 * `phone` matched "Phone Country Code" first and wrote the whole number into
 * it; where the word "phone" was absent, `address_country` matched and wrote
 * "United States". Neither is a dialling code, and a telephone number an
 * employer cannot ring is worse than a blank one.
 *
 * Read with the parentheses taken out, and kept out of the list above for
 * that reason alone. A parenthetical is an instruction about how to answer,
 * not a change of subject: "Phone Number (include country code)" is the
 * telephone box — asked for in exactly those words because international
 * applicants are expected to write the `+` — and excluding it left the
 * number, usually a required field, blank with nothing said about it. "Phone
 * Country Code" still reads as the code box, because nothing there is an
 * aside.
 *
 * Only parentheses. "Phone number, including country code" is still read as
 * the code box and still goes unfilled; that shape is rarer, and guessing at
 * where a label stops being its subject is how the first version of this
 * went wrong.
 */
/*
 * And the extension box beside it, which took the whole telephone number the
 * same way. Read with the parentheses out for the same reason: "Phone (ext.
 * optional)" is the telephone box.
 */
const DIALLING_CODE = /\b(country|area|dial(?:l?ing)?)[\s_-]?(?:phone[\s_-]?)?code\b|\bext(?:ension)?\b/i;

/*
 * A label that is only "Country", whatever the field is named underneath.
 *
 * The exclusion above reasons entirely about label wording — every line of
 * its note is about what a label says — and it was being asked of the whole
 * description, which is the label *plus* the name, the id and the
 * placeholder. `[\s_-]?` allows no separator at all, so a `<select
 * name="countryCode">` matched it, and naming a country select for the ISO
 * code it submits is idiomatic. So a required dropdown labelled, plainly,
 * "Country" was dropped as though it had asked for a dialling code — and
 * exclusions report nothing, by design, so it was not in `skipped` either:
 * an empty required field with the card saying nothing about it.
 *
 * The name is still read for every field whose label does not settle it,
 * which is what keeps a `phone_country_code` box with no label out of the
 * applicant's full telephone number.
 */
const PLAIN_COUNTRY = /^\s*country(\s+of\s+(residence|citizenship))?\s*[*:]*\s*$/i;

const asksForADiallingCode = (description, label) =>
  DIALLING_CODE.test(description.replace(/\([^)]*\)/g, ' ')) && !PLAIN_COUNTRY.test(label ?? '');

/**
 * What the form says about a field somewhere other than on the field.
 *
 * Every exclusion above reads `describeField`, which is a field's own label
 * plus its own `name`, `id` and `placeholder`. That is enough whenever the
 * form repeats the disambiguating word onto each box — "Emergency contact
 * number", "Reference 1 email" — and plenty of forms do not. They say it once:
 *
 *   <fieldset>
 *     <legend>Emergency Contact</legend>
 *     <label for="ec_phone">Phone</label><input id="ec_phone" name="q_88214">
 *
 * There the field describes itself as "Phone q 88214", matches the ordinary
 * `phone` pattern, and was filled with the applicant's own number — reported
 * as a field filled, in green, as a fact about the person they would call in
 * an emergency. The same three boxes with the word on each of them were
 * correctly left alone, so the rule held exactly where the markup was kind.
 *
 * The nearest fieldset only, and the nearest labelled group: a legend two
 * levels up is about the section, and a form that wraps everything in one
 * fieldset would otherwise have every field in it excluded by a single word.
 *
 * Used for the exclusions and nowhere else. It never reaches `describeField`,
 * because a legend reading "Contact Information" over an ordinary email box
 * is context for whether the box is yours and not evidence about which field
 * it is — and anything that matched before has to go on matching.
 */
function surroundingWords(input) {
  const said = [];
  const legend = clean(input.closest('fieldset')?.querySelector('legend')?.textContent);
  if (legend) said.push(legend);

  const group = input.closest('[role="group"], [role="radiogroup"]');
  if (group) {
    const named = clean(group.getAttribute('aria-label')) || clean(fromLabelledBy(group));
    if (named) said.push(named);
  }
  return clean(said.join(' ')).slice(0, 200);
}

/**
 * `around` is joined to the description rather than tested beside it, because
 * the two halves of a phrase can be on either side of the boundary: the
 * employment-history rule wants "Employer" next to "Location", and a form
 * that puts the first in the legend and the second on the label has written
 * the same question as one that puts both on the label.
 */
const isNotAboutYou = (description, label, around = '') => {
  const about = around ? `${around} ${description}` : description;
  return asksForADiallingCode(description, label) || NOT_ABOUT_YOU.some((re) => re.test(about));
};

/*
 * "Are you legally authorized to work in the United States without
 * sponsorship?" is two declarations in one, and was answered from the first
 * alone: `work_authorization` matches, so an applicant storing "authorized:
 * yes" and "needs sponsorship: yes" — which is most people on a student visa —
 * had their form answered "Yes". That is a false statement about their right
 * to work, made in their name, and counted as a field filled.
 *
 * Answering it means resolving a conjunction between two stored declarations,
 * and either way round the answer can be a lie. This file's rule for exactly
 * this pair is that an extension should not be the one deciding them, so the
 * question is handed back instead — reported, so the card shows it as one
 * still for the user, rather than passed over in silence.
 */
const AUTHORIZATION = FIELD_PATTERNS.find(([key]) => key === 'work_authorization')[1];
const SPONSORSHIP = FIELD_PATTERNS.find(([key]) => key === 'requires_sponsorship')[1];
const asksBothAtOnce = (description) =>
  AUTHORIZATION.test(description) && SPONSORSHIP.test(description);

/**
 * Handing it back, wherever it turns up.
 *
 * Asked before `isNotAboutYou`, because the commonest wording of this
 * question is
 *
 *   Are you a U.S. citizen or otherwise authorized to work in the United
 *   States for any employer without sponsorship?
 *
 * and the word "citizen" in it matched the pattern that keeps "Country of
 * citizenship" from being filled with where somebody lives. An exclusion
 * says nothing — deliberately, because an excluded field is not the user's
 * to fill — so this one disappeared: not filled, not reported, not on the
 * card. The same sentence with the word "citizen" taken out was handed back
 * properly, which is what this restores. A question about the applicant's own
 * right to work is theirs however it is phrased.
 */
const handBack = (description, skipped) => {
  if (!asksBothAtOnce(description)) return false;
  skipped.push({
    key: 'work_authorization',
    reason: 'this one asks two things at once',
    description: description.slice(0, 60),
  });
  return true;
};

/**
 * A label that is just "Name" wants the whole name.
 *
 * It cannot be written as a pattern over the description, because the
 * description also carries the field's name and id attributes — so it is asked
 * of the label alone, and kept here so that everything asking "which profile
 * field is this" agrees.
 */
const BARE_NAME = /^(full\s+)?name$/i;

/**
 * A label without the punctuation a form puts round it.
 *
 * `Name *` and `Name:` are how a required field and a colon-styled form
 * write the commonest label on the page, and `BARE_NAME` is anchored at both
 * ends — so the applicant's name was left out of every form that marks its
 * required fields, silently, because no key matched and nothing that matches
 * no key is reported. `cleanQuestion` has stripped exactly this from question
 * text all along; the label handed to `BARE_NAME` never went through it.
 */
const withoutMarkers = (label) => clean(label).replace(/^[*:\s]+/, '').replace(/[*:\s]+$/, '');

/**
 * A box that asks for writing, not for a fact from the profile.
 *
 * The patterns read single words, and an essay prompt is free to use any of
 * them: "Tell us about a project you shipped at your current company" matched
 * `current_company`, "What did you study in school and why?" matched `school`,
 * and "Do you have experience with state management libraries?" matched
 * `address_state` — each box was typed over with a profile value, as though
 * the employer's name were an answer to the question. These are the card's
 * questions, not autofill's.
 *
 * Read off the field's own label, never the name or id. A multi-line box is
 * writing unless its label is a short noun phrase ("LinkedIn profile"); a
 * single-line one only when the label opens the way a prompt does, so "Which
 * university did you graduate from?" is still the school.
 */
const ESSAY_PROMPT =
  /^(?:please\s+)?(?:describe|tell\s+us|explain|elaborate|why\b|walk\s+us\s+through|give\s+(?:us\s+)?an?\s+example|share\s+(?:a\s+time|an?\s+example|your\s+(?:experience|thoughts))|what\s+(?:excites|interests|motivates|makes|would\s+you|did\s+you)|how\s+(?:does|do|would|did|will)\s+your?\b)|\bexperience\s+(?:with|using|in)\b/i;

function asksForWriting(input) {
  const label = withoutMarkers(labelFor(input));
  if (!label) return false;
  if (input instanceof HTMLTextAreaElement) return /\?$/.test(label) || label.split(/\s+/).length > 5;
  return ESSAY_PROMPT.test(label);
}

/**
 * "First" and "Last" under a legend that says "Name".
 *
 * A form that groups the name in a fieldset labels its halves with one word
 * each, and neither the patterns above nor `BARE_NAME` reads "First" as a
 * name: both boxes were left empty, and unreported. Only under a legend that
 * is the name and nothing else — "First" under "Interview availability" is
 * some other question.
 */
function nameHalf(input) {
  if (!/^(?:(?:your|full|legal)\s+)?name$/i.test(withoutMarkers(surroundingWords(input)))) return null;
  const label = withoutMarkers(labelFor(input));
  if (/^(first|given)$/i.test(label)) return 'first_name';
  if (/^(last|family)$/i.test(label)) return 'last_name';
  return null;
}

/**
 * The whole date, where a box asks for the month and the year at once.
 *
 * "From (Month/Year)" matched `month` first and was given "September" — into
 * a box whose placeholder said MM/YYYY — and reported as filled. A dropdown
 * keeps the key it matched: its options are one or the other.
 */
function wholeDateKey(input, key, description) {
  if (input instanceof HTMLSelectElement) return key;
  if (!/^(graduation|education_start)_(month|year)$/.test(key)) return key;
  if (!(/\bmonth\b/i.test(description) && /\byear\b/i.test(description))) return key;
  return key.replace(/_(month|year)$/, '_date');
}

/**
 * Every document this page is really made of.
 *
 * `querySelectorAll` stops at a shadow boundary, so a careers site built out of
 * web components looked to have no form on it at all — nothing to fill, nothing
 * to ask, and in a frame, nothing to recognise it as an application by. Open
 * roots are readable; closed ones are not, and a site using those has decided
 * nobody may look.
 */
/*
 * Except our own.
 *
 * The card is a shadow root on the page like any other, so the walk below
 * went straight into it — and everything in it is a box with a label. Its
 * feedback field, "Anything to change? e.g. …", came back as an application
 * question and was listed under "Application questions" with an offer to
 * draft an answer to it. The letter box and the answer boxes are the same
 * shape, so a form with three questions could grow three more out of the card
 * that was showing them.
 *
 * By id rather than by a marker on the element, because this has to hold for
 * the host before `createCard` has finished putting anything in it.
 */
const OURS = 'jobhelper-card-host';

function allRoots(root = document, out = [root]) {
  for (const element of root.querySelectorAll('*')) {
    if (element.id === OURS) continue;
    if (element.shadowRoot) {
      out.push(element.shadowRoot);
      allRoots(element.shadowRoot, out);
    }
  }
  return out;
}

/** The same query, asked of the page and of everything nested inside it. */
function deepQueryAll(selector, root = document) {
  return allRoots(root).flatMap((where) => [...where.querySelectorAll(selector)]);
}

/**
 * The text of the page, including what is inside components.
 *
 * `document.body.textContent` does not reach into a shadow root, so a form
 * built that way reads as a blank page.
 */
function deepText(limit = 40_000) {
  let text = document.body?.textContent ?? '';
  for (const root of allRoots().slice(1)) {
    if (text.length >= limit) break;
    text += ` ${root.textContent ?? ''}`;
  }
  return text.slice(0, limit);
}

/** The document or shadow root a field actually lives in. */
const rootOf = (node) => {
  const root = node.getRootNode?.();
  return root?.querySelector ? root : document;
};

/**
 * Find the label that belongs to a field.
 *
 * Getting this wrong is worse than not filling at all: an earlier version
 * appended "the first label found in the enclosing container", which on a form
 * inside one big <div> meant every field inherited the first field's label and
 * the email box got filled with a first name. So an explicit association wins
 * outright, and the positional fallback only looks at what immediately precedes
 * the field.
 */
/**
 * What `aria-labelledby` points at, as one piece of text.
 *
 * Its own function because a radio needs it and cannot use `labelFor`: a
 * radio's own `label[for]` is its *answer* — "Yes" — and the question is
 * somewhere else entirely, so the chain that is right for a text box gives
 * exactly the wrong string for a group.
 */
function fromLabelledBy(element) {
  const ids = element.getAttribute?.('aria-labelledby');
  if (!ids) return '';
  const text = ids
    .split(/\s+/)
    /*
     * Never the field itself, which `aria-labelledby` does sometimes name.
     *
     * Defensive rather than fixing anything measured, and worth being plain
     * about: an `<input>` has no `textContent`, so on the field this is
     * really about it changes nothing, and no test here falsifies it. It
     * earns its line on a `<textarea>`, whose `textContent` is whatever the
     * applicant typed — labelling a field with its own contents is not a
     * description of anything.
     */
    .filter((id) => id !== element.id)
    // Scoped to this field's own root: ids inside a component are not in the
    // document's id map, so Workday-style labelling breaks there otherwise.
    .map((id) => rootOf(element).getElementById?.(id)?.textContent
      ?? rootOf(element).querySelector(`#${CSS.escape(id)}`)?.textContent
      ?? '')
    .join(' ');
  return clean(text);
}

/**
 * A field that could own a label of its own — which a hidden input cannot.
 *
 * Both walks in `labelFor`, and the one in `isRequired`, stop when they reach
 * another field: the label before it belongs to that field, not to this one,
 * and stepping over it is how somebody's first name gets typed into a
 * reference-code box. That rule is right and it must not count hidden inputs,
 * because a hidden input is not a field anybody can see, label or fill.
 *
 * Every real application form carries several — a CSRF token, a Workday state
 * blob, a phone country code, a Greenhouse tracking id — and the framework
 * puts them wherever it likes, which is very often immediately before the box
 * a person types into. Measured, on a form whose fields are named `q_00281`
 * and labelled only by a preceding `<div>`: one `<input type=hidden>` between
 * the label and the box, and the first-name and email fields came out empty.
 * Take the hidden inputs out of the same form and all three fill. Nothing is
 * reported, because from the outside it looks exactly like a form the tool was
 * never confident about.
 */
const ANOTHER_FIELD = 'input:not([type=hidden]), textarea, select';

function labelFor(input) {
  /*
   * Each of these answers only when it has something to say.
   *
   * `if (label) return clean(label.textContent)` returned the empty string
   * for a label that exists and is empty — and an empty `<label for=…>` is
   * ordinary markup: a styling hook, an icon slot, a label a framework
   * renders before its text arrives. Returning it ended the search, so
   * `aria-labelledby` and `aria-label` below were never reached on exactly
   * the forms that use them, and the field was described by its `name`
   * attribute alone. On a system whose names are `field_0192` that is no
   * description at all.
   *
   * A wrapping `<label>` has the same shape: one that holds only the input
   * cleans down to nothing.
   */
  if (input.id) {
    const label = rootOf(input).querySelector(`label[for="${CSS.escape(input.id)}"]`);
    const said = clean(label?.textContent);
    if (said) return said;
  }

  const wrapping = clean(input.closest('label')?.textContent);
  if (wrapping) return wrapping;

  const described = fromLabelledBy(input);
  if (described) return described;

  const aria = clean(input.getAttribute('aria-label'));
  if (aria) return aria;

  /*
   * Positional fallback: the nearest preceding element that reads like a label.
   *
   * Stop at another field, and a bare <input> *is* another field. Testing only
   * for a descendant field stepped straight over one — it has no descendants —
   * so `<label for=fn>First Name</label><input id=fn><input name=ref_code>`
   * gave the unlabelled box the label "First Name", and the user's first name
   * was typed into it. The same walk put their email address in the unlabelled
   * box after the email field. That is precisely the failure the note at the
   * top of this function says was fixed.
   */
  let node = input.previousElementSibling;
  for (let i = 0; i < 3 && node; i++, node = node.previousElementSibling) {
    if (node.matches?.(ANOTHER_FIELD) || node.querySelector?.(ANOTHER_FIELD)) break;
    const text = clean(node.textContent);
    if (text && text.length < 160) return text;
  }

  /*
   * Last resort: the nearest ancestor holding this field and nothing else
   * fillable.
   *
   * Climbing is the point. This looked in one container and gave up, which
   * misses the two shapes that matter most in practice: Lever wraps the field
   * in its own div and puts the question in a sibling div above it, and Taleo
   * lays the form out as a table with the label in the cell before. In both,
   * the label is nowhere near the box the field sits in — it is one level up.
   *
   * "Nothing else fillable" is what keeps this safe: the moment an ancestor
   * holds a second field, it is the form rather than this field's own group,
   * and whatever label it holds belongs to something else.
   */
  let group = input.parentElement;
  for (let i = 0; i < 4 && group; i++, group = group.parentElement) {
    if (group.querySelectorAll(ANOTHER_FIELD).length !== 1) break;
    const heading = group.querySelector('label,legend,th,.label,[class*="label"]');
    if (heading && !heading.contains(input)) return clean(heading.textContent);
  }
  return '';
}

/**
 * Everything a field's label might be hiding in. The explicit label leads, so
 * that a pattern matching on it wins over an incidental match in an attribute.
 */
function describeField(input) {
  const label = labelFor(input);
  const attrs = [input.name, input.id, input.placeholder].flatMap(alsoAsWords).filter(Boolean);
  return clean([label, ...attrs].filter(Boolean).join(' ')).slice(0, 300);
}

/**
 * An attribute value as the words it is made of.
 *
 * `\b` counts an underscore as a word character, so every pattern here that
 * names a word failed against the snake_case half these systems use:
 * `/\breferences?\b/` does not match `reference_email`, and
 * `/\b(emergency|...)\b/` does not match `emergency_contact_phone`. The
 * hyphenated spelling matched all along, which is what made the exclusion
 * look covered — `reference-email` is kept out and `reference_email` was
 * filled with the applicant's own address.
 *
 * camelCase for the same reason and the same systems: `referenceEmail` is one
 * word to a regular expression and two to everybody else.
 *
 * Splitting can only add word boundaries, so nothing that matched before
 * stops matching. What changes is that a name written the way a programmer
 * writes it now reads the way its label does.
 */
const asWords = (value) => clean(String(value ?? '').replace(/_+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2'));

/**
 * Both spellings, because splitting is not always right either.
 *
 * `urls[LinkedIn]` is Lever's name for the LinkedIn box, and the pattern for
 * it is `/\b(linked-?in)\b/` — a hyphen is allowed and a space is not, so
 * splitting the camel case and keeping only the split turned a field that had
 * always been filled into one that never was. Measured:
 *
 *   FAIL  Lever: fills the fields it should
 *         input[name="urls[LinkedIn]"] wanted "linkedin.com/in/jianwen", got ""
 *
 * A description is a bag of words rather than a sentence, so the answer is to
 * carry both: the name as written, which every pattern was designed against,
 * and the name as words, which is what the exclusions need. Nothing that
 * matched before can stop matching, which is the property worth having here.
 */
const alsoAsWords = (value) => {
  const raw = clean(value);
  const split = asWords(value);
  return split && split !== raw ? [raw, split] : [raw];
};

/** The label alone, for cases where attribute noise would mislead. */
function questionFor(input) {
  return labelFor(input);
}

/** A choice dressed as something else: a button, or a text box that is a list. */
function isWidgetChoice(element) {
  if (element instanceof HTMLSelectElement) return false;
  const role = element.getAttribute?.('role');
  return (
    role === 'combobox' ||
    role === 'listbox' ||
    element.getAttribute?.('aria-haspopup') === 'listbox' ||
    ['list', 'both'].includes(element.getAttribute?.('aria-autocomplete'))
  );
}

/**
 * Would the browser refuse this control, whoever turned it off?
 *
 * `matches` because a disabled `<fieldset>` disables everything inside it
 * without touching a single descendant's own `disabled` attribute, and an
 * `<option>` inside a disabled `<optgroup>` is the same trick one level down.
 * Guarded because `matches` is not on every node this file walks — a widget's
 * `<div>` reaches `looksLikePlaceholder` too.
 */
function isDisabled(node) {
  return typeof node?.matches === 'function' ? node.matches(':disabled') : Boolean(node?.disabled);
}

function isFillable(input) {
  /*
   * `:disabled`, not `.disabled`.
   *
   * The property reflects the element's own attribute and nothing else, so a
   * control inside `<fieldset disabled>` reads `false` while the browser
   * treats it as disabled in every way that counts. Forms use that fieldset
   * for the section you have not unlocked yet — "US applicants only", a step
   * you have not reached — and the whole section was filled, reported as
   * filled, and then submitted as nothing at all: `FormData` skips a disabled
   * control. "Filled 3 fields", three empty fields.
   */
  if (isDisabled(input) || input.readOnly) return false;
  if (input.type === 'hidden' || input.type === 'file' || input.type === 'password') return false;
  // Radios are answered as a group, below; checkboxes are consent and are
  // nobody's to tick but the applicant's.
  if (input.type === 'radio' || input.type === 'checkbox') return false;
  /*
   * A combobox is a text input that is not a text field. Half these systems
   * have moved to react-select and its kind, where what the form submits lives
   * in a hidden field only the widget's own code sets — so typing into the
   * visible box fills nothing while looking like it filled something, which is
   * worse than leaving it plainly blank. Reported instead, further down.
   */
  if (isWidgetChoice(input)) return false;
  // `offsetParent` is null for anything positioned fixed, visible or not, and
  // forms inside a fixed modal are ordinary. Whether it occupies space on the
  // page is the question actually being asked.
  if (input.getClientRects().length === 0) return false;
  return true;
}

/**
 * Has this dropdown actually been answered?
 *
 * `value` is the wrong question for a select: it is never empty in practice,
 * because the first option is usually a placeholder with a value of its own —
 * "none", "-1", "Select an option". Every such field was being skipped as
 * already filled, which on a real form is most of them.
 */
const PLACEHOLDER = /^(|-+|—+|select.*|choose.*|pick.*|please\b.*|--.*--)$/i;

/*
 * "None" and "N/A" are two things at once.
 *
 * In the slot a browser shows before anyone has chosen, they are a prompt. Two
 * lines down a list, they are an answer — and a true one. Treated as a prompt
 * wherever they sat, "Highest degree completed: None" was quietly replaced with
 * "Bachelor of Science", and a sponsorship question answered "N/A" was
 * overwritten too: a false statement about the applicant, submitted to an
 * employer, and reported as a field successfully filled.
 */
const NONE = /^(none|n\/?a)$/i;

function looksLikePlaceholder(option, select) {
  if (option.disabled) return true;
  const value = String(option.value ?? '').trim();
  const text = (option.textContent ?? '').trim();
  if (PLACEHOLDER.test(value) || PLACEHOLDER.test(text)) return true;
  const first = select?.options?.[0] ?? option.parentElement?.querySelector?.('option');
  return (NONE.test(value) || NONE.test(text)) && first === option;
}

/*
 * Whether it is answered is a question about what is showing, not about which
 * index that is. A select with no placeholder shows its first option from the
 * start — "Canada", say — and overwriting that would be taking a visible
 * answer away; a select showing "Select a city…" has not been answered
 * whatever its index says.
 */
function selectIsAnswered(select) {
  const option = select.selectedOptions?.[0];
  if (!option) return false;
  return !looksLikePlaceholder(option, select);
}

/**
 * Set a property the way the browser does, rather than the way a script does.
 *
 * React puts its own `value` (and, on a radio, `checked`) setter on the element
 * and remembers the last value it saw through it; when an event arrives it
 * compares the two and drops the event if they agree. An ordinary assignment
 * goes through that setter, so React updated its memory and then discarded the
 * change event as a no-op — the control showed the new value until the next
 * render, when React wrote its own state back over it and the form submitted
 * the old one. Reaching past it to the prototype's setter leaves React's memory
 * stale, which is how it tells a real keystroke from nothing having happened.
 *
 * Text inputs already did this. Selects and radios did not, and a fixture
 * carrying React's own value tracker shows the difference: the country dropdown
 * and the work-authorization radio both reported "react-ignores".
 */
function nativeSet(element, property, value) {
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement
        : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, property)?.set;
  if (setter) setter.call(element, value);
  else element[property] = value;
}

/** Set a value in a way React and friends actually notice. */
function setValue(input, value) {
  nativeSet(input, 'value', value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * A value the field took now and the browser will refuse at the end.
 *
 * The check after a fill was that the value stuck, which catches the field
 * that throws it away — a phone number assigned to `type=number` leaves the
 * box empty, and that is reported rather than claimed. It does not catch the
 * other half: a field that accepts the text and then fails constraint
 * validation when Submit is pressed.
 *
 *   <input type="tel" pattern="\d{10}" required>  <- Workday, Taleo, iCIMS
 *   profile phone: "(555) 555-5555"
 *
 * `input.value` is exactly what was written, so the old check passes and the
 * card says "Filled 5 fields". Press Submit and the browser refuses the form
 * with "Please match the requested format" against a field the tool said it
 * had done — and `refusedByTheBrowser` in sending.js then correctly declines
 * to record a send, so the application quietly goes nowhere.
 *
 * Read off `validity` rather than `checkValidity()`, which dispatches an
 * `invalid` event the page can see and act on; filling a form must not be
 * something the page can notice.
 *
 * Only the flags this fill could have caused. `valueMissing` cannot be one of
 * them — something was just written — and `customError` belongs to the page,
 * which may have set it before anything here ran.
 */
function browserWouldRefuse(input) {
  const v = input.validity;
  if (!input.willValidate || !v) return false;
  return Boolean(
    v.patternMismatch ||
      v.typeMismatch ||
      v.tooShort ||
      v.stepMismatch ||
      v.rangeOverflow ||
      v.rangeUnderflow ||
      v.badInput,
  );
}

/**
 * The same phone number, written the other ways forms ask for it.
 *
 * Only phones, and deliberately: "(555) 555-5555" and "5555555555" are the
 * same ten digits and every form wants its own punctuation, so rewriting is
 * reading the field's mind rather than changing the answer. An email or a URL
 * that fails validation is wrong rather than punctuated wrong, and guessing at
 * one would put a different address on the application.
 */
const LINKS = new Set(['linkedin', 'github', 'website']);

function otherWaysToWrite(key, value) {
  const said = String(value).trim();

  /*
   * A link, with the scheme a `type=url` field insists on.
   *
   * A profile stores "github.com/Jianwen-Ding", because that is what goes on
   * a resume — nobody prints the https://. A `type=url` input refuses it, and
   * before this the field was filled, reported as filled, and then blocked the
   * submit. Adding the scheme does not change where the link goes.
   */
  if (LINKS.has(key)) {
    return /^[a-z][a-z0-9+.-]*:/i.test(said) ? [] : [`https://${said}`];
  }

  if (key !== 'phone') return [];
  const digits = said.replace(/\D+/g, '');
  if (!digits || digits === said) return [];
  const out = [digits];
  // A number stored with a country code keeps it where the form takes one.
  if (said.startsWith('+')) out.unshift(`+${digits}`);
  // And without it, for the forms that want exactly ten.
  if (digits.length === 11 && digits.startsWith('1')) out.push(digits.slice(1));
  return out;
}

/**
 * Which section of the form a field sits in, as its heading says.
 *
 * The fieldset's legend where there is one, since that is the section saying
 * so outright. Otherwise the last heading before the field — and only
 * headings inside the same form, because the page's own title is not a
 * section: a posting for "Software Engineer, Education Technology" would
 * otherwise make every date on its job-history step an education date.
 */
const HEADING = 'h1, h2, h3, h4, h5, h6, legend, [role="heading"]';
function sectionOf(input) {
  const legend = input.closest?.('fieldset')?.querySelector(':scope > legend');
  if (legend) return clean(legend.textContent);
  const scope = input.closest?.('form') ?? null;
  if (!scope) return '';
  let found = '';
  for (const heading of scope.querySelectorAll(HEADING)) {
    if (!(heading.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    found = heading.textContent;
  }
  return clean(found);
}

const EDUCATION_SECTION = /\b(education|academic\w*|schools?|degrees?)\b/i;

/**
 * "Start date" and "End date", when they are the degree's.
 *
 * The Education block of a Greenhouse form asks for both ends of the degree in
 * words that say nothing about education — "Start date month", "End date year"
 * — and a job-history block asks the same words about every job. Read on their
 * own they are unanswerable; read with the section's heading they are the
 * start of the degree and its graduation. Anywhere that is not plainly an
 * education section they are left alone, exactly as before.
 */
function educationDateKey(input, description) {
  if (!/\b(date|month|year)\b/i.test(description)) return null;
  /*
   * Workday says neither: its education block asks for the "First Year
   * Attended" and the "Last Year Attended (Actual or Expected)", and both were
   * left empty. First and last only beside "attended", so "First name" and a
   * "Last updated" note are not dates of a degree.
   */
  const which = /\b(start\w*|from|began|begin\w*)\b|\bfirst\b.{0,20}\battend/i.test(description)
    ? 'start'
    : /\b(end\w*|to|until|finish\w*|complet\w*)\b|\blast\b.{0,20}\battend/i.test(description)
      ? 'end'
      : null;
  if (!which) return null;
  if (!EDUCATION_SECTION.test(sectionOf(input))) return null;
  const part = /\bmonth\b/i.test(description) ? 'month' : /\byear\b/i.test(description) ? 'year' : 'date';
  return which === 'start' ? `education_start_${part}` : `graduation_${part}`;
}

/** Two option labels are the same answer if they read the same. */
const sameOption = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Which month an option means, however it is spelled: "December", "Dec",
 * "Dec.", "Sept", "12", "01", "12 - December". Null for anything else.
 *
 * A month dropdown is the one list where the same answer has four common
 * spellings and every form picks a different one, so matching the store's
 * "December" as text found nothing on a form listing "Dec" and the box was
 * left empty. Three letters at least, so "Ma" is not taken for March or May.
 */
export function monthOf(text) {
  const said = clean(text).toLowerCase();
  if (!said) return null;
  const number = /^0?(\d{1,2})(?!\d)/.exec(said);
  if (number) {
    const n = Number(number[1]);
    return n >= 1 && n <= 12 ? n : null;
  }
  const word = /^[a-z]+/.exec(said)?.[0] ?? '';
  if (word.length < 3) return null;
  const at = MONTH_NAMES.findIndex((m) => m.startsWith(word));
  return at === -1 ? null : at + 1;
}

/*
 * The same place, spelled the ways lists spell it.
 *
 * A store holds "MA" and "United States"; a State list says "Massachusetts" and
 * a Country list says "United States of America", which is Workday's spelling
 * and plenty of others'. Exact matching found neither, so the two most-asked
 * dropdowns on a US application were left for the person on most forms.
 *
 * A table rather than anything fuzzier, because these are facts with a closed
 * list of answers: the fifty states, DC and Puerto Rico, Canada's provinces and
 * territories, and the handful of countries whose long official names are what
 * the lists use. Nothing outside the table is treated as the same.
 */
const REGIONS = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado',
  CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky',
  LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  AB: 'Alberta', BC: 'British Columbia', MB: 'Manitoba', NB: 'New Brunswick', NL: 'Newfoundland and Labrador',
  NS: 'Nova Scotia', NT: 'Northwest Territories', NU: 'Nunavut', ON: 'Ontario', PE: 'Prince Edward Island',
  QC: 'Quebec', SK: 'Saskatchewan', YT: 'Yukon',
};
const REGION_BY_NAME = Object.fromEntries(Object.entries(REGIONS).map(([code, name]) => [name.toLowerCase(), code]));

const COUNTRY_SPELLINGS = [
  ['united states', 'united states of america', 'usa', 'u.s.a.', 'us', 'u.s.'],
  ['united kingdom', 'united kingdom of great britain and northern ireland', 'uk', 'u.k.', 'great britain'],
  ['south korea', 'korea, republic of', 'republic of korea'],
];

/** One spelling for everything the table says is the same place. */
function placeKey(key, text) {
  const said = clean(text).toLowerCase().replace(/\s*\([^)]*\)\s*$/, '');
  if (key === 'address_state') {
    const code = said.toUpperCase();
    if (REGIONS[code]) return code;
    return REGION_BY_NAME[said] ?? null;
  }
  if (key === 'address_country') {
    const group = COUNTRY_SPELLINGS.findIndex((names) => names.includes(said));
    return group === -1 ? null : `country:${group}`;
  }
  return null;
}

/**
 * The level a degree is at, from however it is written — or nothing.
 *
 * An MBA is left out on purpose: it is a master's, and a list offering both
 * "Master's Degree" and "MBA" means the person should say which.
 */
const DEGREE_LEVELS = [
  ['associate', /\bassociate\b|\bassociate'?s\b/i],
  ['bachelor', /\bbachelor|\bundergraduate\b|\bb\.?\s?(?:s|a|sc|eng|e)\.?(?=\s|,|$)/i],
  ['master', /\bmaster|\bm\.?\s?(?:s|a|sc|eng)\.?(?=\s|,|$)/i],
  ['doctorate', /\bph\.?\s?d\b|\bdoctor of philosophy\b|\bdoctora(?:te|l)\b/i],
];
function degreeLevel(text) {
  const said = clean(text);
  if (/business administration|\bm\.?\s?b\.?\s?a\b/i.test(said)) return null;
  return DEGREE_LEVELS.find(([, re]) => re.test(said))?.[0] ?? null;
}

/**
 * An option that names a level and nothing else: "Bachelor's Degree",
 * "Masters", "Doctorate", "Undergraduate degree". Only these take a degree by
 * its level — "Bachelor of Arts" is a degree of its own, and a Bachelor of
 * Science is not it.
 */
const LEVEL_ONLY =
  /^(?:associate|bachelor|master|doctorate|doctoral|ph\.?\s?d\.?|undergraduate)(?:'?s)?(?:\s+degree)?$/i;

/**
 * Whether an option is this answer under a different spelling — for the
 * fields where a spelling table exists, and only those. Consulted after an
 * exact match has failed, never instead of one.
 */
function sameAnswerSpelledOtherwise(key, option, value) {
  /*
   * A degree against a list of levels, which is what Greenhouse asks with:
   * "Associate's Degree", "Bachelor's Degree", "Master's Degree". The store
   * words the degree as the diploma does, so nothing matched and the box was
   * left empty on every Greenhouse form.
   */
  if (key === 'degree') {
    const level = degreeLevel(value);
    return Boolean(level) && LEVEL_ONLY.test(clean(option).replace(/[’]/g, "'")) && degreeLevel(option) === level;
  }
  if (key === 'graduation_month' || key === 'education_start_month') {
    const month = monthOf(value);
    return Boolean(month) && month === monthOf(option);
  }
  const wanted = placeKey(key, value);
  return Boolean(wanted) && wanted === placeKey(key, option);
}

/**
 * "December 2026" written the way this particular box wants it.
 *
 * A `type=month` input takes "2026-12" and nothing else — assigning the
 * readable form leaves it empty and raises nothing. A box whose placeholder
 * says MM/YYYY will usually be checked against that shape when the form is
 * sent. Anything else gets the readable form, which a person would type.
 * Never a day: `type=date` wants one, and a guessed day is a guess.
 */
export function graduationFor(input, value) {
  const hit = /^([a-z]+)\s+(\d{4})$/i.exec(String(value).trim());
  const month = hit ? monthOf(hit[1]) : null;
  if (!month) return value;
  const year = hit[2];
  const mm = String(month).padStart(2, '0');
  if (input.type === 'month') return `${year}-${mm}`;
  const hint = `${input.placeholder ?? ''} ${input.getAttribute?.('aria-label') ?? ''}`.toLowerCase();
  if (/yyyy\s*-\s*mm/.test(hint)) return `${year}-${mm}`;
  if (/mm\s*\/\s*yyyy/.test(hint)) return `${mm}/${year}`;
  if (/mm\s*\/\s*yy\b/.test(hint)) return `${mm}/${year.slice(2)}`;
  return value;
}

/**
 * Reading a yes/no answer out of a profile that holds a sentence.
 *
 * Measured, and it is the worst miss in the file: a form asking "Are you
 * legally authorized to work in the US?" with Yes and No beside it, against a
 * profile whose `work_authorization` reads "Authorized to work in the US",
 * matched no option and was left blank. That is the one question most likely
 * to get an application rejected without a person reading it, and it was
 * being skipped on every form that asks it as a choice rather than a box —
 * which is nearly all of them, because it is a legal declaration.
 *
 * The profile holds a sentence because the field is a free-text box and a
 * sentence is what people type in one.
 *
 * Deliberately narrow, because the cost here is not a blank field but a false
 * declaration about the applicant's right to work, made in their name:
 *
 *   Only where the options really are a yes/no pair. A three-way list, or a
 *   list of visa categories, is not this question and is left alone.
 *
 *   Only for the two keys that *are* yes/no questions. Nothing else in the
 *   profile is a declaration, and a city is never "yes".
 *
 *   A leading Yes or No wins over everything, because that is the answer and
 *   the rest of the sentence is its explanation. "Yes, but not until 2027"
 *   is a yes; read for negation words instead it comes out a no.
 *
 *   Then the negation has to be *about the thing being asked about*. A
 *   sentence is not a bag of words: scanning the whole of one for any
 *   negation word read "Authorized to work in the US without sponsorship" —
 *   the documented example value plus the commonest suffix people write — as
 *   a No, and ticked No on the question about their right to work. That is
 *   the false declaration this comment says it exists to prevent, made in
 *   their name, on the form most likely to be rejected without a person
 *   reading it. It went wrong in both directions at once: "without" negates
 *   the sponsorship, and the sponsorship question then read the same phrase
 *   as needing it.
 *
 *   A phrase that is neither, or that says both, is skipped and reported —
 *   "it needs you" is a fine answer and a wrong declaration is not, and so is
 *   "I am not a citizen but am authorized to work", which is a true sentence
 *   this has no business reducing to one box.
 */
const YES_NO_KEYS = new Set(['work_authorization', 'requires_sponsorship']);

/**
 * The thing each question is actually about.
 *
 * The answer turns on whether *this* is affirmed or denied, and nothing else
 * in the sentence can settle it. Keeping the two lists apart is half the fix:
 * "sponsorship" says nothing about a right to work, and "citizen" says
 * nothing about needing a visa, so neither key can be decided by a word that
 * belongs to the other.
 */
const CONCEPT = {
  work_authorization:
    /\b(unauthori[sz]ed|ineligible|authori[sz]ed|eligible|permitted|allowed|citizen|permanent[\s_-]resident|green[\s_-]card|work[\s_-]permit|right[\s_-]to[\s_-]work)\b/g,
  requires_sponsorship: /\b(sponsorship|sponsored|sponsor|visa|h-?1b)\b/g,
};

/** Words that are their own denial, with no separate negation to find. */
const FUSED_NO = /^(unauthori[sz]ed|ineligible)$/;

/**
 * A denial fixed to the front of the word it denies: "non-citizen".
 *
 * Its own case, because it is not a word in the sentence — it is part of the
 * word that was matched, and it denies that word and nothing else. Read as a
 * loose negation it poisoned everything after it; not read at all, it would
 * make "non-citizen" an affirmation of citizenship.
 */
const FUSED_PREFIX = /(?:^|[^\w-])non-?$/i;

/**
 * A denial close enough in front of a word to be about that word.
 *
 * Bounded by `[^\w-]` rather than `\b`, because `\b` is a transition between
 * a word character and anything else — and a hyphen is anything else. So
 * `\bnon\b` matched the `non` inside `non-citizen`, and the window is four
 * words wide, so one of those poisoned every concept word after it. Measured,
 * running this function as written:
 *
 *   "I am a non-citizen, but authorized to work in the US without
 *    restriction."                                            => no
 *   "I am a non-immigrant and will require sponsorship."       => no
 *
 * The first says the applicant is not authorised to work, and the second says
 * they do not need sponsorship. Both are the opposite of what was written,
 * both are declarations made in somebody's name on a submitted form, and both
 * are the exact failure the note above this function exists to prevent —
 * arriving through the one spelling a visa holder is most likely to use about
 * themselves. `non-citizen`, `non-immigrant`, `non-resident`.
 */
const NEAR_NO = /(?<![\w-])(no|not|never|non|cannot|can't|don'?t|doesn'?t|without|nor|neither)(?![\w-])/i;

/** How much of what comes before a word can be said to be about it. */
const LOOK_BACK_WORDS = 4;

/**
 * Yes, no, or "cannot tell" — for a value against a yes/no pair.
 *
 * `key` decides which words count, so this cannot be asked in the abstract.
 */
function yesNoFrom(value, key) {
  const said = clean(value).toLowerCase();
  if (!said) return undefined;

  /*
   * A leading Yes or No wins over everything, because that is the answer and
   * the rest of the sentence is its explanation. "Yes, but not until 2027"
   * is a yes; read for negation words instead it comes out a no.
   */
  const lead = /^(yes|no)\b/i.exec(said)?.[1]?.toLowerCase();
  if (lead) return lead;

  const concept = CONCEPT[key];
  if (!concept) return undefined;

  const verdicts = new Set();
  for (const hit of said.matchAll(concept)) {
    if (FUSED_NO.test(hit[1])) {
      verdicts.add('no');
      continue;
    }
    /*
     * Only the few words in front of it: a denial further away than that is
     * about some other clause. "…does not require sponsorship" denies the
     * sponsorship; "I do not need it now but will require sponsorship in
     * 2027" does not.
     *
     * Trimmed first, and that is the whole of this line's history. What comes
     * before a matched word always ends in the space that separates them, so
     * `split(/\s+/)` produced a trailing empty token and the window spent one
     * of its four slots on it — three real words, not four. "I do not at
     * present require sponsorship" put `not` one word outside a window that
     * should have held it and came back `yes`, so the form was filled in with
     * "Yes, I require sponsorship" for somebody who had written the opposite,
     * and counted as a field successfully answered. That is the false legal
     * declaration the note above this function exists to prevent, made by the
     * function written to prevent it.
     */
    const upTo = said.slice(0, hit.index);
    // "non-citizen" is a denial of *this* word, wherever the rest of the
    // sentence goes. See `FUSED_PREFIX`.
    if (FUSED_PREFIX.test(upTo)) {
      verdicts.add('no');
      continue;
    }
    const before = upTo.trim().split(/\s+/).slice(-LOOK_BACK_WORDS).join(' ');
    verdicts.add(NEAR_NO.test(before) ? 'no' : 'yes');
  }

  // Nothing about this question in the sentence, or the sentence says both.
  // Either way it is not this tool's to decide. See the note above.
  return verdicts.size === 1 ? [...verdicts][0] : undefined;
}

/**
 * The option that answers a yes/no question, where the labels are yes and no
 * and the profile's answer is a phrase. `undefined` unless all of that holds.
 */
function yesNoOption(key, value, options) {
  if (!YES_NO_KEYS.has(key)) return undefined;

  const labelled = options.map((o) => ({ o, said: clean(o.label).toLowerCase() }));
  const yes = labelled.find((x) => x.said === 'yes');
  const no = labelled.find((x) => x.said === 'no');
  // A yes/no *pair* and nothing else. "Yes / No / Prefer not to say" is a
  // different question with a third answer, and guessing between three is
  // exactly what this file does not do.
  if (!yes || !no || labelled.length !== 2) return undefined;

  const answer = yesNoFrom(value, key);
  return answer === 'yes' ? yes.o : answer === 'no' ? no.o : undefined;
}

/**
 * Fill what we can. Returns a report of what was filled and what was skipped,
 * so the user can see the difference between "done" and "done silently wrong".
 */
export function fillForm(fields, { overwrite = false, remembered = [] } = {}) {
  const filled = [];
  const skipped = [];

  const inputs = deepQueryAll('input, textarea, select');
  for (const input of inputs) {
    if (!isFillable(input)) continue;

    const description = describeField(input);
    if (!description) continue;
    // Somebody else's details, or a question this profile does not answer —
    // see `NOT_ABOUT_YOU`. Not reported: there is nothing here for the user to
    // do about it, and naming it would imply the field is theirs to fill.
    // Before the exclusions, which say nothing, and before the match, which
    // this question does not need. See `handBack`.
    if (handBack(description, skipped)) continue;
    if (isNotAboutYou(description, clean(labelFor(input)), surroundingWords(input))) continue;
    if (asksForWriting(input)) continue;

    /*
     * The first pattern that matches, and then whether the profile has it —
     * not the first pattern that matches *and* has a value.
     *
     * The order of `FIELD_PATTERNS` is load-bearing and says so: country sits
     * above state precisely because "Country/Region" matches `region`. But
     * `&& fields[key]` made the search walk past a pattern whose key the
     * profile happened to be missing, so on a profile with a state and no
     * country — an ordinary partial profile — "Country/Region" fell through
     * to `address_state` and a Californian's application said Canada, the
     * value "CA" having found `<option value="CA">Canada</option>`. Reported
     * as filled, in green.
     *
     * What a field is asking for does not depend on what this profile
     * happens to hold. Nothing here fills a field it has no value for; it
     * simply no longer goes looking for a different question to answer.
     */
    // The degree's dates first: see `educationDateKey`. They read as nothing
    // at all to the patterns, so this can only claim what was going unclaimed.
    const dated = educationDateKey(input, description);
    const named = dated ? [dated] : FIELD_PATTERNS.find(([, re]) => re.test(description));
    let match = named && fields[named[0]] ? named : undefined;

    if (!match && fields.full_name && BARE_NAME.test(withoutMarkers(labelFor(input)))) {
      match = ['full_name'];
    }
    if (!match) {
      const half = nameHalf(input);
      if (half && fields[half]) match = [half];
    }
    if (!match) continue;

    const key = wholeDateKey(input, match[0], description);
    if (!fields[key]) continue;
    let value = fields[key];

    const answered = input instanceof HTMLSelectElement ? selectIsAnswered(input) : Boolean(input.value);
    if (answered && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }

    if (input instanceof HTMLSelectElement) {
      /*
       * Only pick an option that plainly matches; never guess on a dropdown.
       * Compared through `clean` because the enterprise systems pad their
       * option text — a country list whose entry was `United&nbsp;States`
       * matched nothing under a plain `trim`, and a required country dropdown
       * was reported as having no option for the user's country while sitting
       * two lines above the one that did.
       */
      /*
       * Only the ones the control would actually let a person choose.
       *
       * A disabled `<option>`, and every option under a disabled
       * `<optgroup>`, is in `input.options` and reads `value` like any other —
       * but `FormData` takes nothing from a select sitting on one. Country
       * lists do this: the places a company is hiring in one group, the rest
       * greyed out underneath. Setting the greyed-out one left the dropdown
       * reading "United States" on screen, the form reporting itself valid,
       * and the country submitted as nothing.
       */
      const choosable = [...input.options].filter((o) => !isDisabled(o));
      const option =
        choosable.find((o) => sameOption(o.textContent, value) || sameOption(o.value, value)) ??
        /*
         * The same answer spelled the list's way: a month as "Dec" or "12", a
         * state as its name or its code, a country by its long name. Only for
         * those fields — "12" is a perfectly good option in plenty of other
         * lists — and only after the exact match has failed.
         */
        choosable.find(
          (o) => sameAnswerSpelledOtherwise(key, o.textContent, value) || sameAnswerSpelledOtherwise(key, o.value, value),
        ) ??
        /*
         * And, failing that, a yes/no pair against a phrase. See
         * `yesNoOption`, which wants a pair and nothing else — so the prompt
         * has to come off first.
         *
         * `choosable` drops only the *disabled* options, and a dropdown's
         * "Select…" is usually not disabled: every real yes/no `<select>`
         * therefore arrived as three answers and was refused as a question
         * with a third answer. So Greenhouse's work-authorisation dropdown
         * was left blank against a profile saying "Authorized to work in the
         * US", while the identical question asked as radio buttons on the
         * same form was answered — the shape of the control decided whether
         * the question got an answer. `looksLikePlaceholder` was already here
         * and already knew what a prompt looks like.
         */
        yesNoOption(
          key,
          value,
          choosable.filter((o) => !looksLikePlaceholder(o, input)).map((o) => ({ label: o.textContent, el: o })),
        )?.el;
      if (option) {
        nativeSet(input, 'value', option.value);
        /*
         * Check it went in, exactly as the text path below does.
         *
         * Setting `value` selects the *first* option carrying it, and two
         * options sharing a value is ordinary — a placeholder with `value=""`
         * above a real entry whose value the form fills in later. The write
         * then lands on the placeholder, the dropdown still reads "Select a
         * country…", and the card says it filled it.
         */
        if (input.selectedOptions[0] !== option) {
          skipped.push({ key, reason: 'the field would not take it', description: description.slice(0, 60) });
          continue;
        }
        // Both, because choosing from a list fires both. `change` alone is
        // what a script fires, and some widgets only listen for `input`.
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        filled.push({ key, value });
      } else {
        skipped.push({ key, reason: 'no matching option', description: description.slice(0, 60) });
      }
      continue;
    }

    const before = input.value;
    /*
     * A month picker holds a month *and* a year, so whichever graduation key
     * claimed it — a label saying "date", a name saying `graduation_month` —
     * the only thing it can take is the whole date. Given the month alone it
     * stays empty and says it would not take it.
     */
    if (key.startsWith('graduation_') && input.type === 'month' && fields.graduation_date) {
      value = graduationFor(input, fields.graduation_date);
    } else if (key.startsWith('education_start_') && input.type === 'month' && fields.education_start_date) {
      value = graduationFor(input, fields.education_start_date);
    } else if (key === 'graduation_date' || key === 'education_start_date') {
      value = graduationFor(input, value);
    }
    setValue(input, value);
    /*
     * Check it went in. Assigning a value a typed input will not accept — a
     * phone number to `type=number`, a city to `type=date`, and both are shapes
     * real forms use — leaves the field empty and raises nothing. Reported as
     * filled anyway, the card said "Filled 4 fields" while two of them were
     * blank, and the user submitted a form missing a required phone number
     * having been told it was done.
     */
    if (input.value !== String(value)) {
      skipped.push({ key, reason: 'the field would not take it', description: description.slice(0, 60) });
      continue;
    }

    /*
     * And that the browser will still take it when Submit is pressed. See
     * `browserWouldRefuse`: a `pattern` is checked then, not now, so a value
     * the field holds happily can still stop the form going. Where the same
     * answer can be written another way, write it that way; where it cannot,
     * put the field back as it was rather than leave a value that blocks the
     * submit, and say so.
     */
    if (browserWouldRefuse(input)) {
      const took = otherWaysToWrite(key, value).find((spelling) => {
        setValue(input, spelling);
        return input.value === spelling && !browserWouldRefuse(input);
      });
      if (took === undefined) {
        setValue(input, before);
        skipped.push({
          key,
          reason: 'the field would not accept it in that form',
          description: description.slice(0, 60),
        });
        continue;
      }
      filled.push({ key, value: took });
      continue;
    }
    filled.push({ key, value });
  }

  const radios = answerRadioGroups(fields, overwrite);
  const buttons = answerChoiceButtons(fields, overwrite, [...filled, ...radios.filled]);

  /*
   * Last, over what the profile could not answer. The profile has had every
   * chance by here, so anything still unanswered is a question only the
   * person applying knows — which is the only kind the bank holds.
   */
  const memory = answerFromMemory(remembered);
  const done = [...filled, ...radios.filled, ...buttons.filled, ...memory.filled];

  /*
   * A control the memory pass answered is not still waiting, whatever an
   * earlier pass said about it. `fillForm` reports a select it matched but
   * could not find an option for as "no matching option", and the bank quite
   * often *does* have an option for it — leaving both rows in said "filled 5
   * fields, 1 still for you to answer" about a form with nothing left on it,
   * which sends somebody back to hunt for a question that is answered.
   */
  const answered = new Set(memory.filled.map((f) => f.description));
  const waiting = [...skipped, ...radios.skipped, ...buttons.skipped].filter(
    (s) => !answered.has(s.description),
  );

  return {
    filled: done,
    skipped: [...waiting, ...memory.skipped, ...unfillableChoices(fields, done)],
  };
}

/* ------------------- Choices that are buttons, not inputs ------------------- */

/**
 * The same questions, asked with ARIA instead of with `<input type=radio>`.
 *
 * `answerRadioGroups` finds the native shape and `unfillableChoices` reports
 * the popup shape as one to pick by hand. Between them is a third that is
 * neither: a group whose options are already on the page and are `<div>`s or
 * `<button>`s wearing `role="radio"` or `role="option"`. Every modern
 * component library builds a segmented yes/no that way — it is what an
 * accessible custom control is *supposed* to look like — and nothing here
 * could see one, so a required work-authorisation question went out blank
 * under a card reporting the form done.
 *
 * Only groups whose options are on screen. A `role="listbox"` that is the
 * popup half of a combobox is a different thing: opening it, waiting for it
 * and choosing inside it is fragile in a way that ends with the wrong answer
 * ticked, and `unfillableChoices` already says those have to be picked by
 * hand. This does not widen that promise.
 */

/**
 * Every ARIA group on the page that is a real, answerable choice.
 *
 * Pulled out of `answerChoiceButtons` because the remembered-answer pass has
 * to walk exactly the same set. Two walks that agree by having been written
 * to look alike do not stay agreeing: the popup exclusions below were added
 * once, to one of them, and a second copy would have gone on opening
 * comboboxes for ever. One function, two callers, no drift.
 */
function ariaChoiceGroups() {
  const visible = (el) => el.getClientRects().length > 0;
  const found = [];

  for (const group of deepQueryAll('[role="radiogroup"], [role="listbox"], [role="group"]')) {
    if (isDisabled(group) || !visible(group)) continue;
    /*
     * The popup half of a combobox, which is somebody else's to open. A
     * listbox a combobox owns says so — through `aria-controls`,
     * `aria-owns`, or by sitting under a control that has
     * `aria-haspopup="listbox"` — and those go to `unfillableChoices`.
     */
    if (group.closest('[aria-haspopup="listbox"]')) continue;
    const id = group.getAttribute('id');
    if (id && deepQueryAll(`[aria-controls="${CSS.escape(id)}"], [aria-owns="${CSS.escape(id)}"]`).length > 0) continue;

    const options = [...group.querySelectorAll('[role="radio"], [role="option"]')].filter(
      (el) => visible(el) && !isDisabled(el),
    );
    // One option is not a choice, and nothing on this page asked a question
    // with it. Two is the yes/no pair this exists for.
    if (options.length < 2) continue;

    const question = choiceQuestionFor(group);
    const description = clean([question, group.getAttribute('aria-label'), id].filter(Boolean).join(' '));
    if (!description) continue;

    found.push({ group, options, question, description });
  }
  return found;
}

function answerChoiceButtons(fields, overwrite, already) {
  const filled = [];
  const skipped = [];
  const taken = new Set(already.map((f) => f.key));

  for (const { group, options, question, description } of ariaChoiceGroups()) {
    // The same three gates, in the same order, as `fillForm` and
    // `answerRadioGroups`. See `handBack`.
    if (handBack(description, skipped)) continue;
    if (isNotAboutYou(description, clean(question), surroundingWords(group))) continue;

    // Only the keys that are a choice between options, as in
    // `answerRadioGroups` — see `CHOOSABLE` there.
    const named = FIELD_PATTERNS.find(([key, re]) => CHOOSABLE.has(key) && re.test(description));
    const match = named && fields[named[0]] && !taken.has(named[0]) ? named : undefined;
    if (!match) continue;

    const [key] = match;
    const value = fields[key];
    const chosen = (el) => el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';

    if (options.some(chosen) && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }

    const labelOf = (el) => clean(el.getAttribute('aria-label') || el.textContent);
    const wanted =
      options.find((el) => sameOption(labelOf(el), value)) ??
      // And a yes/no pair against a phrase, on the same terms as a radio's.
      yesNoOption(key, value, options.map((el) => ({ label: labelOf(el), el })))?.el;
    if (!wanted) {
      skipped.push({ key, reason: 'no matching option', description: description.slice(0, 60) });
      continue;
    }

    /*
     * Clicked, and then read back — which for these is the whole difficulty.
     *
     * A native radio answers "did that take" itself: `checked` is the
     * browser's, and setting it is the last resort when a click is cancelled.
     * These have no such thing. `aria-checked` is an attribute the page
     * writes, and writing it here would be writing the appearance of an
     * answer onto a control whose own state is a variable in somebody's
     * component — the form would submit blank under a green tick, which is
     * the worst outcome this file has.
     *
     * So: click, which is what a person does and what every framework is
     * listening for, and then believe the page. If it did not mark the option
     * chosen, it is reported as needing a hand rather than claimed.
     */
    wanted.click();
    if (chosen(wanted)) {
      filled.push({ key, value });
      taken.add(key);
    } else {
      skipped.push({
        key,
        reason: 'the page did not take it — pick this one by hand',
        description: description.slice(0, 60),
      });
      taken.add(key);
    }
  }
  return { filled, skipped };
}

/**
 * What an ARIA group is asking.
 *
 * Its own label first, because a group that wears `role="radiogroup"` is
 * built by somebody who knows to name it — that is most of the reason the
 * role is there. Then the same fallbacks a native group gets: the row header
 * on a questionnaire laid out as a table, and the nearest heading above.
 */
function choiceQuestionFor(group) {
  const said = fromLabelledBy(group) || clean(group.getAttribute('aria-label'));
  if (said) return said;

  const legend = clean(group.closest('fieldset')?.querySelector('legend')?.textContent);
  if (legend) return legend;

  const header = clean(group.closest('tr')?.querySelector('th')?.textContent);
  if (header) return header;

  /*
   * And failing all of that, the text immediately above it — bounded, because
   * an unbounded climb reaches the whole form and reads every other question
   * as part of this one.
   */
  for (let at = group.parentElement, up = 0; at && up < 3; at = at.parentElement, up++) {
    const heading = clean(at.querySelector('label, legend, h1, h2, h3, h4, h5, h6, .label')?.textContent);
    if (heading) return heading;
  }
  return '';
}

/* ---------------------------- Radio groups ---------------------------- */

/**
 * The label a whole group of radios shares.
 *
 * Nothing about an individual radio says what is being asked: the question
 * belongs to the group and each button's label is one of the answers. A
 * fieldset says so outright; failing that, the smallest ancestor that holds the
 * whole group and nothing else is the group, and whatever heading it carries is
 * the question.
 */
function groupLabelFor(radios) {
  const first = radios[0];
  const legend = clean(first.closest('fieldset')?.querySelector('legend')?.textContent);
  if (legend) return legend;

  /*
   * Then whatever the buttons themselves point at, which is how the
   * enterprise systems mark a radio question: no fieldset, no heading inside
   * a wrapper, just `aria-labelledby` on each button naming the div that
   * holds the question. Read from `labelFor` so the same chain — several
   * ids, a missing one, one naming the field itself — applies here too.
   *
   * Only the parts every button agrees on, because each one also carries its
   * own answer: taking the first button's whole label would make the question
   * "Are you legally authorized to work in the US? Yes".
   */
  const shared = radios.map((radio) => radio.getAttribute('aria-labelledby')).filter(Boolean);
  if (shared.length === radios.length && new Set(shared).size === 1) {
    const said = fromLabelledBy(first);
    if (said) return said;
  }
  /*
   * Not the first button's own `aria-label`, which this used to take.
   *
   * The paragraph above says why the shared `aria-labelledby` is read and the
   * first button's own label is not: "each one also carries its own answer".
   * An `aria-label` is that own answer — on the markup every framework
   * generates for an accessible radio group, `aria-label="Yes"` and
   * `aria-label="No"` are the two buttons. Taking the first made the
   * question "Yes", so the group's whole description was "Yes auth_q", no
   * pattern matched, and `if (!match) continue` dropped it without even
   * reporting it skipped: a required work-authorization question left blank
   * under a card saying the form was done. It also returned before the `<th>`
   * route and the ancestor climb below, which are the two branches written to
   * find the real question.
   *
   * A row header, which is how the older enterprise systems lay out a
   * questionnaire: the question in a `<th scope="row">`, the buttons in the
   * `<td>` beside it. `labelFor` learned this for text boxes — see the `th`
   * in its ancestor search — and groups had not, so the question came back
   * empty, the group's whole description was a name like `q_998877`, and it
   * matched nothing. Skipped in silence, on the question most likely to
   * matter.
   *
   * Taken from this row rather than added to the climb below, which would
   * reach the table and could take a column heading from some other row as
   * the question for this one.
   */
  const header = clean(first.closest('tr')?.querySelector('th')?.textContent);
  if (header) return header;

  let group = first.parentElement;
  for (let i = 0; i < 5 && group; i++, group = group.parentElement) {
    if (!radios.every((radio) => group.contains(radio))) continue;
    // Another field in here means this is the form, not this question.
    if (group.querySelectorAll('input:not([type=radio]):not([type=hidden]), textarea, select').length > 0) break;
    const headings = [...group.querySelectorAll('label,legend,.label,[class*="label"]')].filter(
      (el) => !el.querySelector('input, textarea, select'),
    );
    /*
     * Somebody else's buttons are in here too.
     *
     * The guard above only counts fields that are *not* radios, so a plain
     * `<div>` holding several yes/no questions one after another — question
     * text, Yes, No, next question text, Yes, No, with no fieldset and no
     * wrapper each, which is how hand-rolled career forms are written — looks
     * exactly like one question's own group. Taking the first heading then
     * gave every group in it the *first* question's words.
     *
     * Measured: sponsorship asked first and work authorisation second, profile
     * saying "may not need sponsorship" and "yes, authorised". Both groups
     * were labelled "require visa sponsorship", both were answered No, and the
     * form submitted "No, I am not legally authorised to work in the United
     * States" over the applicant's own answer. The report never mentioned the
     * question at all — it listed sponsorship twice.
     *
     * So when the container is shared, take the nearest heading *above* these
     * buttons instead: the question text a person reads them under.
     */
    const shared = [...group.querySelectorAll('input[type=radio]')].some((el) => !radios.includes(el));
    const heading = shared
      ? headings.filter((el) => el.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING).pop()
      : headings[0];
    if (heading) return clean(heading.textContent);
  }
  return '';
}

/**
 * Can a person see this button — the button, or the thing drawn in its place?
 *
 * Nearly every modern form hides the native radio (`display:none`,
 * `appearance:none`, a 1px clip) and styles a `<span>` inside its `<label>`
 * instead. Asking the input alone whether it occupies space therefore
 * answers "no" about a control the user is looking straight at, and the whole
 * group was skipped before anything was reported: `{filled: [], skipped: []}`
 * on a visible work-authorisation question, which reads exactly like a form
 * with nothing to do. Clicking a hidden input works perfectly well, so the
 * only thing the old test bought was silence.
 *
 * The label still has to be somewhere, though. A group inside a closed
 * accordion or an unmounted step is not this question yet, and both the
 * input and its label have no box at all.
 */
function onScreen(radio) {
  if (radio.getClientRects().length > 0) return true;
  const label = radio.closest('label');
  return Boolean(label && label.getClientRects().length > 0);
}

/** What one button of a group means, which is what a human reads beside it. */
function optionLabelFor(radio) {
  const wrapping = radio.closest('label');
  if (wrapping) return clean(wrapping.textContent);
  if (radio.id) {
    const label = rootOf(radio).querySelector(`label[for="${CSS.escape(radio.id)}"]`);
    if (label) return clean(label.textContent);
  }
  return clean(radio.value);
}

/**
 * Answer the yes/no questions, which on a great many forms are radios rather
 * than a dropdown — Workable, Teamtailor, and most hand-rolled career sites.
 *
 * These were invisible twice over: skipped by the main pass because a radio
 * always has a value and so looked answered, and never reported, so the form
 * came out with its required work-authorization question blank and the card
 * said everything was done.
 *
 * Nothing is inferred. If the stored answer is "Authorized to work in the US"
 * and the buttons say Yes and No, that is reported rather than guessed:
 * sponsorship and work authorization are declarations with consequences, and
 * an extension should not be the one deciding them.
 */
/** The answers a form offers as options rather than asking you to type. */
const CHOOSABLE = new Set([
  'work_authorization',
  'requires_sponsorship',
  'address_country',
  'address_state',
  'degree',
  'location',
]);

/**
 * The radio groups on the page, scoped the way a browser scopes them.
 *
 * Pulled out for the same reason as `ariaChoiceGroups`: the remembered-answer
 * pass has to see the same groups, and the form-scoping below is exactly the
 * sort of hard-won detail a second copy would be written without.
 */
function radioGroups() {
  /*
   * A radio group is scoped to its form, and so is the grouping here.
   *
   * Keyed on `name` alone, every radio called "country" on the page became one
   * group — and pages carry more than one form. A job-alerts box above the
   * application, both asking "country", merged into a single group that took
   * its question from the marketing form's legend and ticked the marketing
   * form's option. The application's own country question stayed blank, and the
   * card reported it filled. The reverse happened too: an option the user had
   * already ticked in the unrelated form made the real sponsorship question
   * report "already filled" and stay empty. Either way an application is
   * submitted with a required question blank, after being told it was answered.
   */
  const formKeys = new WeakMap();
  let nextForm = 0;
  const scopeOf = (radio) => {
    const form = radio.form;
    if (!form) return 'doc';
    if (!formKeys.has(form)) formKeys.set(form, `f${nextForm++}`);
    return formKeys.get(form);
  };

  const groups = new Map();
  for (const radio of deepQueryAll('input[type=radio]')) {
    if (isDisabled(radio) || !onScreen(radio)) continue;
    const key = radio.name ? `${scopeOf(radio)}\u0000${radio.name}` : radio.closest('fieldset');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(radio);
  }
  return [...groups.values()];
}

function answerRadioGroups(fields, overwrite) {
  const filled = [];
  const skipped = [];

  for (const radios of radioGroups()) {
    const description = clean([groupLabelFor(radios), radios[0].name].filter(Boolean).join(' '));
    if (!description) continue;
    // Before the exclusions and before the match, as in `fillForm`. Radios
    // are the commoner shape for this question: Workable and Teamtailor ask
    // "legally authorized to work without sponsorship" as a pair of buttons.
    if (handBack(description, skipped)) continue;
    // The group's own words, on the same terms as `fillForm`.
    if (isNotAboutYou(description, clean(groupLabelFor(radios)), surroundingWords(radios[0]))) continue;

    /*
     * Only the keys that are a choice between options. A name, an email address
     * or a phone number is typed, never picked from two radio buttons, so a
     * pattern matching one of those against a radio group has matched a word in
     * a sentence rather than a field: "Marketing: may we email you about
     * sponsorship webinars?" matched `email` and was reported as a field
     * waiting for the user.
     */
    // The first choosable pattern that matches, then whether the profile has
    // it — see the same change in `fillForm` for why the two are separate.
    const named = FIELD_PATTERNS.find(([key, re]) => CHOOSABLE.has(key) && re.test(description));
    const match = named && fields[named[0]] ? named : undefined;
    if (!match) continue;

    const [key] = match;
    const value = fields[key];

    if (radios.some((radio) => radio.checked) && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }

    const wanted =
      radios.find(
        (radio) => sameOption(optionLabelFor(radio), value) || sameOption(radio.value, value),
      ) ??
      // And, failing that, a yes/no pair against a phrase. See `yesNoOption`.
      yesNoOption(
        key,
        value,
        radios.map((radio) => ({ label: optionLabelFor(radio), el: radio })),
      )?.el;
    if (!wanted) {
      skipped.push({ key, reason: 'no matching option', description: description.slice(0, 60) });
      continue;
    }

    /*
     * Clicked, not set.
     *
     * A text input is filled through the prototype's setter and told about it
     * with `input`/`change` (see `nativeSet`), and doing the same to a radio
     * looked right and was not: React listens for **click** on checkboxes and
     * radios, not change — `shouldUseClickEvent` in its own event plugin — so
     * `onChange` never ran, the component's state stayed empty, and its next
     * render put `checked` back to what its state said. Measured against React
     * 18 with a controlled group: the button ticked, one unrelated keystroke
     * re-rendered the form, the tick vanished, and the work-authorisation
     * question submitted blank. The card said "Filled 3 fields".
     *
     * A click is what a person does, so every framework is listening for it.
     * The setter stays as the way back for a form that cancels the click:
     * ticking the box is better than nothing, and it is what used to happen.
     */
    wanted.click();
    if (!wanted.checked) {
      nativeSet(wanted, 'checked', true);
      wanted.dispatchEvent(new Event('input', { bubbles: true }));
      wanted.dispatchEvent(new Event('change', { bubbles: true }));
    }
    filled.push({ key, value: fields[key] });
  }

  return { filled, skipped };
}

/* -------------------- Answers kept from the last form -------------------- */

/**
 * Every choice on this page that nothing in the profile answers.
 *
 * These are the questions the answer bank is for. The profile knows a name,
 * an email address and a country; it does not know whether you have worked
 * here before, how you heard about the job, or whether you are willing to
 * relocate — and those are asked on every application, worded slightly
 * differently each time, and answered by hand every time.
 *
 * The *question* is what travels, not the description. A description is a bag
 * of words built for regular expressions — label plus `name` plus `id` — and
 * matching "Have you previously been employed by Acme?" against
 * "have you previously been employed by acme prev_emp_q3 q3" is matching
 * against noise. The bank is keyed on what a person reads.
 */
function rememberableChoices() {
  const found = [];
  const add = (question, description, el, answered, choose) => {
    const asked = clean(question);
    // Too short to recognise on the next form. The same bar the bank itself
    // applies on the way in — see `worthRemembering`.
    if (asked.length < 8) return;
    found.push({ question: asked, description, el, answered, choose });
  };

  for (const select of deepQueryAll('select')) {
    if (!isFillable(select)) continue;
    const description = describeField(select);
    if (!description) continue;
    add(
      questionFor(select),
      description,
      select,
      () => selectIsAnswered(select),
      (answer) => chooseInSelect(select, answer),
    );
  }

  for (const radios of radioGroups()) {
    const description = clean([groupLabelFor(radios), radios[0].name].filter(Boolean).join(' '));
    if (!description) continue;
    add(
      groupLabelFor(radios),
      description,
      radios[0],
      () => radios.some((radio) => radio.checked),
      (answer) => chooseInRadios(radios, answer),
    );
  }

  for (const { group, options, question, description } of ariaChoiceGroups()) {
    add(
      question,
      description,
      group,
      () => options.some(isMarkedChosen),
      (answer) => chooseInAria(options, answer),
    );
  }

  return found;
}

/** The questions on this page worth asking the bank about. */
export function choiceQuestions() {
  const out = new Set();
  for (const choice of rememberableChoices()) {
    if (choice.answered()) continue;
    // Never ask the bank about these, so that nothing puts one in it and
    // nothing takes one out. See `NEVER_REMEMBER`.
    if (neverRemember(choice.question)) continue;
    out.add(choice.question);
  }
  return [...out];
}

/**
 * Put back the answers this person gave the last form that asked.
 *
 * `remembered` is `[{ question, answer }]` where each `question` is one of
 * the strings `choiceQuestions` handed out — the matching was done by the
 * store, which owns the only similarity function either product has, and the
 * question comes back echoed so that the comparison here is string equality.
 * A second fuzzy matcher living in the extension would drift away from the
 * first one silently, and the drift would show up as an application answered
 * wrongly rather than as a failing test.
 *
 * Three rules, and each is a refusal:
 *
 * - Nothing already answered is touched, `overwrite` or not. Overwrite is a
 *   thing the person asked of their *profile*; the bank is a weaker claim
 *   than the profile and a far weaker one than an answer already on screen.
 * - Nothing personal, even if the bank holds it. `worthRemembering` keeps
 *   these out on the way in, but the bank is older than that gate and the
 *   Workspace lets answers be typed in by hand. A date of birth sitting in
 *   the bank must not be typed into a form by a machine.
 * - Only an option that plainly matches. No yes/no coercion, no nearest
 *   option: the question match is already one inference, and stacking a
 *   second one on it is how a form comes to say "No" where its owner meant
 *   "Yes". Where nothing matches, the control is left for the person, which
 *   is exactly where it was.
 */
function answerFromMemory(remembered) {
  const filled = [];
  const skipped = [];
  if (!Array.isArray(remembered) || remembered.length === 0) return { filled, skipped };

  const bank = new Map();
  for (const { question, answer } of remembered) {
    const asked = clean(question);
    if (asked && String(answer ?? '').trim()) bank.set(asked, String(answer).trim());
  }
  if (bank.size === 0) return { filled, skipped };

  for (const choice of rememberableChoices()) {
    if (choice.answered()) continue;
    if (neverRemember(choice.question)) continue;
    const answer = bank.get(choice.question);
    if (!answer) continue;

    const took = choice.choose(answer);
    const row = { key: 'remembered', value: answer, description: choice.description.slice(0, 60) };
    if (took) filled.push({ ...row, question: choice.question, remembered: true });
    else skipped.push({ ...row, reason: 'the answer you gave before is not one of the options here' });
  }
  return { filled, skipped };
}

/** Whether an ARIA option is the one marked as chosen. */
const isMarkedChosen = (el) =>
  el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true';

/** Pick an option in a native `<select>` by its text or its value. */
function chooseInSelect(select, answer) {
  const choosable = [...select.options].filter((o) => !isDisabled(o));
  const option = choosable.find((o) => sameOption(o.textContent, answer) || sameOption(o.value, answer));
  if (!option) return false;
  nativeSet(select, 'value', option.value);
  // Two options can share a value, so the write can land on the placeholder.
  // The same read-back `fillForm` does, and for the same reason.
  if (select.selectedOptions[0] !== option) return false;
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

/** Tick a radio in a group by its label or its value. */
function chooseInRadios(radios, answer) {
  const wanted = radios.find(
    (radio) => sameOption(optionLabelFor(radio), answer) || sameOption(radio.value, answer),
  );
  if (!wanted) return false;
  // Clicked, not set — React listens for click on radios. See
  // `answerRadioGroups`, which explains what setting it instead cost.
  wanted.click();
  if (!wanted.checked) {
    nativeSet(wanted, 'checked', true);
    wanted.dispatchEvent(new Event('input', { bubbles: true }));
    wanted.dispatchEvent(new Event('change', { bubbles: true }));
  }
  return wanted.checked;
}

/** Click an ARIA option by its label, and believe the page about the result. */
function chooseInAria(options, answer) {
  const labelOf = (el) => clean(el.getAttribute('aria-label') || el.textContent);
  const wanted = options.find((el) => sameOption(labelOf(el), answer));
  if (!wanted) return false;
  wanted.click();
  // Never written here: `aria-checked` belongs to the page's own component,
  // and forging it puts a tick over a form that will submit blank. See
  // `answerChoiceButtons`.
  return isMarkedChosen(wanted);
}

/**
 * Choices that are not form controls at all.
 *
 * Workday's dropdowns — and the react-select widgets half the other systems
 * have moved to — are a button that opens a listbox. There is nothing to set a
 * value on, and driving them means synthesising clicks against markup that
 * changes between releases, which is exactly the kind of guessing that fills a
 * form wrongly.
 *
 * So they are not filled. But they were also not mentioned, which is worse:
 * the report said everything it could do was done, the form looked handled,
 * and the required country dropdown was still empty at the bottom of page
 * three. Naming them costs nothing and is the difference between "done" and
 * "done silently wrong".
 */
const PICK_BY_HAND = 'this one has to be picked by hand';

/**
 * The widgets on the page that ask something the profile answers, with the
 * element — shared by the report below and by `fillComboboxes`, so the two
 * cannot disagree about which widget is which question.
 */
function widgetChoices(fields, filled) {
  const already = new Set(filled.map((f) => f.key));
  const found = [];

  for (const widget of deepQueryAll(
    '[role="combobox"], [aria-haspopup="listbox"], [role="listbox"], [aria-autocomplete="list"], [aria-autocomplete="both"]',
  )) {
    if (!isWidgetChoice(widget)) continue;
    if (widget.getClientRects().length === 0) continue;

    const description = describeField(widget);
    if (!description) continue;
    if (isNotAboutYou(description, clean(labelFor(widget)), surroundingWords(widget))) continue;

    const dated = educationDateKey(widget, description);
    const match =
      dated && fields[dated] && !already.has(dated)
        ? [dated]
        : FIELD_PATTERNS.find(([key, re]) => re.test(description) && fields[key] && !already.has(key));
    if (!match) continue;
    found.push({ key: match[0], description: description.slice(0, 60), el: widget });
    already.add(match[0]);
  }
  return found;
}

function unfillableChoices(fields, filled) {
  return widgetChoices(fields, filled).map(({ key, description }) => ({ key, reason: PICK_BY_HAND, description }));
}

/* ---------------------------------------------------------------------- *
 * Driving the widgets, where that can be done without guessing             *
 * ---------------------------------------------------------------------- */

const pause = (ms) => new Promise((done) => setTimeout(done, ms));

/** Poll until `find` answers something, or give up. */
async function waitFor(find, patience) {
  const until = Date.now() + patience;
  for (;;) {
    const got = find();
    if (got) return got;
    if (Date.now() >= until) return null;
    await pause(50);
  }
}

/** The text box a widget types into, if it has one. */
function typingBoxOf(widget) {
  if (widget instanceof HTMLInputElement) return widget;
  return widget.querySelector?.('input:not([type=hidden])') ?? null;
}

/**
 * The options this widget opened — and only this widget's.
 *
 * The listbox it names through `aria-controls` or `aria-owns`, which is how an
 * accessible widget says which popup is its own. Failing that, the listbox
 * that is visible, but only if exactly one is: two open listboxes and no
 * pointer to either is a page where choosing is a guess about which one
 * answers this question, and guessing is what this does not do.
 */
function optionsOf(widget) {
  const box = typingBoxOf(widget);
  const ids = [widget, box]
    .filter(Boolean)
    .flatMap((el) => `${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('aria-owns') ?? ''}`.split(/\s+/))
    .filter(Boolean);
  const named = ids.map((id) => widget.getRootNode().getElementById?.(id) ?? document.getElementById(id)).filter(Boolean);
  const lists = named.length
    ? named
    : deepQueryAll('[role="listbox"]').filter(
        /*
         * `visibility: hidden` keeps a box, so a closed menu that an exit
         * transition leaves mounted counted as open — and as a second listbox
         * it refused every unlinked widget on the page.
         */
        (l) => l !== widget && l.getClientRects().length > 0 && getComputedStyle(l).visibility !== 'hidden',
      );
  if (!named.length && lists.length !== 1) return [];
  return lists.flatMap((l) => [...l.querySelectorAll('[role="option"]')]).filter((o) => !isDisabled(o) && o.getAttribute('aria-disabled') !== 'true');
}

/** The option that is plainly this answer, or nothing. Never the nearest. */
function exactOption(options, key, value) {
  return (
    options.find((o) => sameOption(o.textContent, value)) ??
    options.find((o) => sameAnswerSpelledOtherwise(key, o.textContent, value)) ??
    null
  );
}

/** A click as a person makes one — some widgets choose on mousedown, some on click. */
function press(el) {
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
    const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window }));
  }
}

/**
 * Whether the widget really took the answer, read back the way a person would.
 *
 * A widget can render options and then ignore the click — a newer release
 * that chooses on a keypress, a listener the synthetic event did not reach —
 * and a form that looks answered and submits nothing is the failure this
 * whole file is written against. So it has to be seen: the option marked
 * chosen, or the control now showing it with the typing gone, or the value it
 * submits carrying something where it carried nothing.
 */
function tookIt(widget, box, option, value, hiddenBefore) {
  const hidden = hiddenPartner(widget);
  if (hidden && hidden.value && hidden.value !== hiddenBefore) return true;
  if (option.isConnected && option.getAttribute('aria-selected') === 'true') return true;
  /*
   * An autocomplete that writes the choice into its own box — MUI, Downshift,
   * Ant Design — with no hidden input and the option gone once the menu
   * closes. The box holding the option's text is not evidence on its own,
   * because it was typed there; the widget saying its menu is now closed, with
   * exactly that text left in the box, is. An ignored click leaves the menu
   * open, and a widget that drops the choice clears the box as it closes.
   */
  const expanded = box?.getAttribute('aria-expanded') ?? widget.getAttribute('aria-expanded');
  if (box && expanded === 'false' && sameOption(box.value, option.textContent)) return true;
  /*
   * Not "the box holds the option's text": the box holds it because it was
   * typed there, whether or not the click did anything. And the control's text
   * is read with any open listbox cut out of it, or an ignored click would
   * pass because the option is still showing in the menu underneath — which
   * is what a React widget that re-renders its options on click, choosing
   * nothing, looks like: the clicked node is gone and the menu is still open.
   */
  const control = controlOf(widget).cloneNode(true);
  for (const list of control.querySelectorAll('[role="listbox"]')) list.remove();
  const shows = clean(control.textContent).toLowerCase().includes(clean(value).toLowerCase());
  return shows && (!box || !box.value);
}

/**
 * The element a widget draws its current answer in.
 *
 * The widget itself where no wrapper says it is the control — not its parent.
 * A button sitting straight in a form has the form as its parent, and the
 * answer "shown" anywhere in the form's text passed for a choice that took:
 * an ignored click beside a paragraph naming the city was reported as filled.
 */
function controlOf(widget) {
  return widget.closest?.('[class*="control"], [class*="select"], [class*="combobox"]') ?? widget;
}

/**
 * The hidden input carrying what the widget submits, where it sits beside it
 * — beside it, not anywhere below the parent, which for a widget straight in a
 * form was the first hidden input of some other field.
 */
function hiddenPartner(widget) {
  const around = controlOf(widget).parentElement ?? controlOf(widget);
  return around.querySelector?.(':scope > input[type="hidden"]') ?? null;
}

/** Whether pressing this would send its form. */
function wouldSubmit(el) {
  if (el instanceof HTMLButtonElement) return el.type === 'submit' && Boolean(el.form);
  if (el instanceof HTMLInputElement) return ['submit', 'image'].includes(el.type) && Boolean(el.form);
  return false;
}

/** Put the widget back as it was: nothing typed, nothing open. */
function undoWidget(widget, box) {
  if (box) setValue(box, '');
  (box ?? widget).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  (box ?? widget).blur?.();
}

/**
 * Choose in the widgets `fillForm` could only report.
 *
 * Workday's dropdowns and the react-select boxes half the other systems use
 * are a control that opens a listbox, with nothing to assign a value to — so
 * the country, the state and the school on those forms were all left for the
 * person to pick, every time. They can be driven, the way a person drives
 * them: type or click to open, choose the option, see that it took.
 *
 * Only on these terms, because a form that looks answered and is not is worse
 * than one that says it is not:
 *
 *   - Exactly the answer, never the nearest. "United States" does not choose
 *     "United States Minor Outlying Islands", and no option means no choice.
 *   - Only this widget's own options. See `optionsOf`.
 *   - Seen to have taken. See `tookIt`. Otherwise everything typed is taken
 *     back out and the widget is reported exactly as it was before.
 *
 * Async, and after `fillForm`, because a widget opens and fills in on its own
 * time — a school list fetched as you type can take a second to arrive.
 */
export async function fillComboboxes(fields, report, { patience = 1500 } = {}) {
  const pending = new Set(report.skipped.filter((s) => s.reason === PICK_BY_HAND).map((s) => s.key));
  if (pending.size === 0) return report;

  const done = [];
  for (const { key, el: widget } of widgetChoices(fields, report.filled)) {
    if (!pending.has(key)) continue;
    const value = String(fields[key]);
    const box = typingBoxOf(widget);
    const hiddenBefore = hiddenPartner(widget)?.value ?? '';

    /*
     * Never a control that would send the form.
     *
     * A `<button>` with no `type` inside a form *is* a submit button — that is
     * the default, and a Workday-style dropdown written without `type="button"`
     * is one. Pressing it to open its list submitted the application instead:
     * the page navigated away mid-fill, half the form empty, and nothing came
     * back to say so. A widget that has to be pressed to open, and would send
     * the form if pressed, is left for the person, exactly as before.
     */
    if (!box && wouldSubmit(widget)) continue;

    widget.focus?.();
    if (box) {
      setValue(box, value);
    } else {
      press(widget);
    }
    const option = await waitFor(() => exactOption(optionsOf(widget), key, value), patience);
    if (!option) {
      undoWidget(widget, box);
      continue;
    }
    press(option);
    await pause(60);
    if (!tookIt(widget, box, option, value, hiddenBefore)) {
      undoWidget(widget, box);
      continue;
    }
    done.push({ key, value, widget: true });
  }

  const chose = new Set(done.map((d) => d.key));
  return {
    ...report,
    filled: [...report.filled, ...done],
    skipped: report.skipped.filter((s) => !(s.reason === PICK_BY_HAND && chose.has(s.key))),
  };
}

/**
 * Is this document an application form at all?
 *
 * Asked only of frames, and only because the script now runs in all of them so
 * that it can reach the form on the systems that serve it in an iframe. The
 * other frames on a job posting are adverts, newsletter boxes and embedded
 * widgets, and they have fields with exactly the same names — an advert asking
 * for an email address looks, field by field, like the top of an application.
 *
 * Typing someone's address and name into a third party's iframe is a different
 * and worse kind of wrong than leaving a field empty, so the test is for
 * evidence rather than absence of doubt: something only an application asks
 * for, or enough of the form that nothing else would have it.
 */
const APPLICATION_WORDS =
  /\b(submit (your )?application|start your application|cover letter|work authoriz\w*|legally authorized to work|require sponsorship|equal opportunity employer|voluntary self-identification)\b/i;

/**
 * A question only the employer would ask.
 *
 * Recruitee asks for a name, an email, a phone number and "What draws you to
 * this team?" — and labels none of them, using `aria-label` throughout. By
 * every other rule here that is a newsletter box with a comment field: the
 * three fields are the three a mailing list asks for, there is no file
 * upload, and the prose says nothing about applying. So the form was filled
 * correctly and then not recognised as a form at all, which matters because
 * recognition is what gates autofill inside a frame and the finding of
 * questions anywhere.
 *
 * The open question is the evidence that was being ignored. Narrowly: one
 * that asks about *this* role, team or company. "How can we help?" on a
 * contact form and "Comment" under a blog post ask about neither, and both
 * are fixtures here precisely so this cannot quietly start filling them.
 */
const ASKS_ABOUT_THE_JOB =
  /\b(this (role|team|position|job|opportunity|company)|work(ing)? (here|with us|for us)|join(ing)? (us|the team)|our (team|company|mission))\b/i;

/*
 * Fields an advert has no reason to ask for.
 *
 * Name, email, phone and town are the four an application opens with, and also
 * the four a newsletter box asks for — so counting parts of a person cannot
 * tell the two apart. Degree, work authorization, sponsorship, GPA: these are
 * asked by something that intends to employ you.
 */
/*
 * Fields an advert has no reason to ask for.
 *
 * Name, email, phone and town are the four an application opens with, and also
 * the four a newsletter box asks for — so counting parts of a person cannot
 * tell the two apart, which is what the old threshold of four tried to do.
 * LinkedIn, a degree, a GPA, the right to work: these are asked by something
 * that intends to employ you.
 *
 * Deliberately not `website` (name, email and website is a blog comment box)
 * and not the address fields (a job search box asks for city and country).
 */
const TELLTALE = new Set([
  'linkedin', 'github', 'school', 'degree', 'major', 'gpa',
  'work_authorization', 'requires_sponsorship',
]);

/**
 * Watch what the person chooses, so the next form can offer it back.
 *
 * Applying is the same twenty questions over and over, and the answers to most
 * of them do not change. What changes is the wording and the widget, which is
 * why this records the *question* and the *answer as a human reads it* rather
 * than a field name and a value: `q_88213 = 1` is worth nothing on the next
 * site, and "Are you legally authorized to work in the United States? — Yes"
 * is worth something on all of them.
 *
 * Chosen answers only, and that scope is most of the safety here rather than a
 * limitation worked around: a chosen answer is one of a handful the form
 * itself offered, and no form offers a social security number in a dropdown.
 * See `worthRemembering`, which refuses the rest.
 *
 * Returns a function that stops watching, the way `watchForSending` does.
 */
export function watchChoices(tell) {
  const seen = (control) => {
    /*
     * The question is the group's, never the button's own label — each button
     * carries one of the answers. `groupLabelFor` already knows that and says
     * why at length.
     *
     * And it is the *question*, never the description. The first version of
     * this stored `describeField(control)`, which is a bag of words built for
     * regular expressions: the label, plus `name`, `id` and `placeholder`,
     * each also split into words. Greenhouse's work-authorisation dropdown
     * therefore went into the bank as
     *
     *   Are you legally authorized to work in the United States? *
     *   job_application[answers_attributes][1][boolean_value]
     *   job application[answers attributes][1][boolean value] …
     *
     * — which reads as nonsense in the Workspace, writes a form's internal
     * field names into somebody's store, and above all can never be found
     * again: the matcher scores on shared words, and those are shared with
     * nothing. Every select somebody answered was recorded and none of it
     * was ever offered back. The same three functions the reuse side uses
     * (`rememberableChoices`), so that what is written down and what is
     * looked up are the same string.
     */
    if (control instanceof HTMLSelectElement) {
      const option = control.selectedOptions?.[0];
      if (!option || looksLikePlaceholder(option, control)) return null;
      return { question: clean(questionFor(control)), answer: clean(option.textContent) };
    }
    if (control instanceof HTMLInputElement && control.type === 'radio') {
      if (!control.checked) return null;
      const group = [...deepQueryAll('input[type=radio]')].filter(
        (r) => r.name === control.name && r.form === control.form,
      );
      return {
        question: clean(groupLabelFor(group.length ? group : [control])),
        answer: optionLabelFor(control),
      };
    }
    const option = control?.closest?.('[role="radio"], [role="option"]');
    if (option) {
      const group = option.closest('[role="radiogroup"], [role="listbox"], [role="group"]');
      if (!group) return null;
      return {
        question: choiceQuestionFor(group),
        answer: clean(option.getAttribute('aria-label') || option.textContent),
      };
    }
    return null;
  };

  const look = (event) => {
    const target = event.composedPath?.()?.[0] ?? event.target;
    if (!target || rootOf(target)?.host?.id === OURS) return;
    let said;
    try {
      said = seen(target);
    } catch {
      // A page that throws from a getter is not a reason to break the form.
      return;
    }
    if (!said?.question || !said?.answer) return;
    /*
     * The refusal is here rather than at the far end, so nothing personal
     * leaves the page at all — not to the worker, not to the store, not into
     * a log on the way. See `worthRemembering`.
     */
    const verdict = worthRemembering(said);
    tell(verdict.keep ? { ...said, keep: true } : { ...said, keep: false, why: verdict.why });
  };

  /*
   * `change` for the native controls, which is what a browser fires when a
   * choice is made, and `click` for the ARIA ones, which fire nothing at all
   * — the page's own handler is what marks them chosen, so this runs after it
   * and reads what it decided.
   */
  document.addEventListener('change', look, true);
  document.addEventListener('click', look, true);
  return () => {
    document.removeEventListener('change', look, true);
    document.removeEventListener('click', look, true);
  };
}

export function looksLikeApplicationForm() {
  const text = deepText();

  const keys = new Set();
  for (const input of deepQueryAll('input, textarea, select')) {
    const description = describeField(input);
    if (!description) continue;
    const match = FIELD_PATTERNS.find(([, re]) => re.test(description));
    if (match) keys.add(match[0]);
    // The same bare "Name" that `fillForm` fills — a real part of a person,
    // and on several systems the only place the name is asked for.
    else if (BARE_NAME.test(withoutMarkers(labelFor(input)))) keys.add('full_name');
  }

  let telltales = 0;
  for (const key of keys) if (TELLTALE.has(key)) telltales++;

  /*
   * Something only an application would have. Each of the old routes here let
   * a third party's iframe through, and each was a route on its own:
   *
   * "apply for this" is a call to action, not a form — a sponsored "Senior SRE
   * at Hyperion. Apply for this role" creative with an email-alerts box prints
   * it, and the user's name and city were typed into the advertiser's input,
   * where the page's own script read them straight off the input event.
   *
   * Counting four parts of a person was worse, because it needed no words at
   * all: name, email, phone and town is a newsletter box. But it cannot simply
   * be raised, because iCIMS asks for exactly four and Taleo for five. What
   * separates them is not how many but which — an employer asks for a legal
   * first and last name as two fields, where a mailing list asks for "Name".
   */
  const evidence =
    APPLICATION_WORDS.test(text) ||
    // A long-form question about this role — see `ASKS_ABOUT_THE_JOB`.
    (deepQueryAll('textarea').length > 0 && ASKS_ABOUT_THE_JOB.test(text)) ||
    // A file upload beside the word résumé is the clearest sign there is.
    (deepQueryAll('input[type=file]').length > 0 && /\b(resum|cv)\b/i.test(text)) ||
    // One field only an employer asks for. The hosted systems serve the form
    // on its own with no prose to match against — Ashby's frame is six
    // labelled inputs and nothing else — so there has to be a route that reads
    // the fields rather than the copy.
    telltales >= 1 ||
    (keys.has('first_name') && keys.has('last_name'));

  // And in every case, enough of a form to be one. Evidence alone let a frame
  // through that merely talked about applying.
  return evidence && keys.size >= 2;
}

/** Marks a field so the card can point back at it later. */
const FIELD_KEY = 'data-jobhelper-field';
let fieldCounter = 0;

/**
 * Find the free-text questions on the page — the boxes that want a paragraph,
 * not a phone number. Returned rather than filled: a long-form answer is
 * something to read before it goes out under your name.
 */
export function findQuestions() {
  const found = [];
  const candidates = [
    ...deepQueryAll('textarea'),
    // Some boards use a contenteditable div for long answers.
    ...deepQueryAll('[contenteditable="true"]'),
  ];

  for (const field of candidates) {
    if (field instanceof HTMLTextAreaElement && !isFillable(field)) continue;
    if (field.getClientRects().length === 0) continue;

    /*
     * The cover letter box is not an essay question. It is long-form, it is
     * labelled, and it passes every test below — so it was being offered as a
     * question to draft an answer to, on the same card that already has a
     * cover letter step for it. One box, asked for twice.
     */
    if (/cover\s*letter/i.test(describeField(field))) continue;

    /*
     * The placeholder, where there is no label at all.
     *
     * Lever labels nothing: "Why do you want to work at Lever?" is a
     * placeholder on the textarea and nothing else, so the one question on the
     * form was not offered — the card showed a form with no questions on it,
     * and the box stayed empty. Only as a fallback, and only from the
     * placeholder rather than `describeField`, because a field's name and id
     * are not a question anyone wrote.
     */
    const question = cleanQuestion(questionFor(field) || field.getAttribute?.('placeholder') || '');
    // Anything this short is a label like "Notes" rather than a question worth
    // drafting an answer to — unless it ends in a question mark, which settles
    // it. "Why us?" is seven characters and is exactly the sort of thing this
    // is for.
    if (!question) continue;
    if (question.length < 12 && !question.endsWith('?')) continue;

    let id = field.getAttribute(FIELD_KEY);
    if (!id) {
      id = `jh-${++fieldCounter}`;
      field.setAttribute(FIELD_KEY, id);
    }
    found.push({
      fieldId: id,
      question,
      currentValue: field.value ?? field.textContent ?? '',
      /*
       * The box's own limit. A script assigning a value is not held to
       * `maxlength`, so an answer over it went in whole and the form refused
       * it on submit. -1 is what a box without one reports.
       */
      ...(field.maxLength > 0 ? { limit: field.maxLength } : {}),
      ...(yoursToAnswer(question) ? { yours: yoursToAnswer(question) } : {}),
    });
  }
  return found;
}

/*
 * Questions a model must not answer for you, and why.
 *
 * These are still offered — hiding a question the form requires is the worse
 * failure, and the box is still there to type in. What is withheld is the
 * "draft an answer" button, because an answer invented for any of these is
 * either a false statement or a disclosure that is not the tool's to make.
 *
 * A salary figure is the plain case: whatever a model writes is a number the
 * applicant did not choose and may be held to. The self-identification
 * questions are the other kind — voluntary by law and about the person, so an
 * answer written on their behalf is a lie told in their name about something
 * they were entitled to decline.
 */
const YOURS_TO_ANSWER = [
  /*
   * Plurals matter here, and this is where that was measured rather than
   * assumed: "What are your salary expectations for this role?" is the single
   * commonest phrasing on any form, and `expectation` without the `s?` misses
   * every one of them.
   */
  [/\b(salary|compensation|wage|pay|rate|comp)\b.*\b(expectations?|expected|desired|requirements?|ranges?|seeking)\b/i,
    'A figure here is yours to choose.'],
  [/\b(expected|desired|minimum|required)\b.*\b(salary|compensation|pay|rate)\b/i,
    'A figure here is yours to choose.'],
  [/\b(disabilit|accommodat|impairment)\w*/i,
    'This one is yours to answer — nothing is written for you.'],
  [/\b(race|ethnicit|gender|veteran|disabled|sexual orientation|pronoun)\w*/i,
    'This one is yours to answer — nothing is written for you.'],
  /*
   * And the two the rest of this file treats as the most damaging to get
   * wrong, which were not on this list at all.
   *
   * `yesNoFrom` goes to great lengths so that a *tick box* about the right to
   * work is never filled in against what the applicant wrote — the note above
   * it calls a wrong answer there a false legal declaration made in their
   * name. The same question asked as a paragraph ("Please describe your
   * current work authorisation status", "If you will require sponsorship,
   * please explain") is an ordinary custom question on Greenhouse and Lever,
   * and it was offered to the model to invent an answer for.
   */
  [/\b(work[\s_-]authori[sz]ation|authori[sz]ed[\s_-]to[\s_-]work|right[\s_-]to[\s_-]work|sponsorship|sponsor|visa|h-?1b|opt|cpt|immigration|citizenship|work[\s_-]permit)\b/i,
    'This one is yours to answer — nothing is written for you.'],
  [/\b(criminal|conviction|felony|misdemeanou?r|background check)\b/i,
    'This one is yours to answer — nothing is written for you.'],
];

/** The reason a question is yours alone, or undefined where it is not. */
export function yoursToAnswer(question) {
  for (const [re, why] of YOURS_TO_ANSWER) if (re.test(question)) return why;
  return undefined;
}

/**
 * Does this form want a cover letter? Boards signal it with a file upload
 * named for one, or a long-answer box that says so.
 */
export function wantsCoverLetter() {
  for (const field of deepQueryAll('input[type=file], textarea, label, legend')) {
    const text = `${field.getAttribute?.('name') ?? ''} ${field.getAttribute?.('id') ?? ''} ${
      field.textContent ?? ''
    }`.toLowerCase();
    if (/cover\s*letter/.test(text)) return true;
  }
  return false;
}

/**
 * Whether a question is marked required, by any of the usual conventions.
 *
 * The field's own label first. Climbing to `closest('div,fieldset,li,p')` and
 * taking the first label in it usually landed on the wrapper around the whole
 * form, whose first label is "First Name *" — so every question on the form
 * came back required, and the workspace told the user that optional ones had to
 * be answered. Climbing is still useful for the forms that mark the asterisk on
 * a wrapper rather than the label, but only while the container holds this
 * field and nothing else fillable, which is the rule `labelFor` already uses.
 */
export function isRequired(fieldId) {
  const field = deepQueryAll(`[${FIELD_KEY}="${CSS.escape(fieldId)}"]`)[0];
  if (!field) return false;
  if (field.required || field.getAttribute('aria-required') === 'true') return true;

  const marked = (text) => /\*|\brequired\b/i.test(text ?? '');

  // The label actually associated with this field.
  const own =
    (field.id && rootOf(field).querySelector(`label[for="${CSS.escape(field.id)}"]`)) ||
    field.closest('label');
  if (own) return marked(own.textContent);

  let group = field.parentElement;
  for (let i = 0; i < 3 && group; i++, group = group.parentElement) {
    if (group.querySelectorAll(ANOTHER_FIELD).length > 1) break;
    const label = group.querySelector('label,legend');
    if (label) return marked(label.textContent);
  }
  return false;
}

/** Put text into a field the card previously identified. */
export function insertAnswer(fieldId, text) {
  const field = deepQueryAll(`[${FIELD_KEY}="${CSS.escape(fieldId)}"]`)[0];
  if (!field) return false;
  if (field instanceof HTMLTextAreaElement || field instanceof HTMLInputElement) {
    setValue(field, text);
  } else {
    field.textContent = text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  field.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return true;
}

/**
 * Labels arrive with the surrounding furniture attached — character counters,
 * "(optional)", the word "Required". Strip it so the question matches what was
 * stored last time.
 */
function cleanQuestion(raw) {
  return String(raw)
    .replace(/\b\d+\s*(?:of|\/)\s*\d+\s*characters?\b/gi, '')
    .replace(/\(\s*optional\s*\)/gi, '')
    .replace(/\*\s*(required|mandatory)\b/gi, '')
    .replace(/\b(required|optional)\b\s*$/gi, '')
    // A bare asterisk is the universal "required" marker, and it was surviving
    // into the question — so the same question stored from two forms, one
    // marked required and one not, became two questions in the answer bank.
    .replace(/^\s*\*+\s*/, '')
    .replace(/\s*\*+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export { describeField, questionFor, labelFor };
