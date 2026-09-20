/**
 * Fills an application form from the profile already stored in ResumeM-M.
 *
 * Deliberately conservative: it only fills fields it is confident about, never
 * overwrites something already typed, and always reports what it touched. A
 * form filled wrongly costs more than a form filled by hand.
 */

/** Map a stored profile key to the label/name patterns that mean it. */
const FIELD_PATTERNS = [
  ['first_name', /\b(first[\s_-]?name|given[\s_-]?name|fname)\b/i],
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
  ['school', /\b(school|university|college|institution)\b/i],
  ['degree', /\b(degree)\b/i],
  ['major', /\b(major|discipline|field[\s_-]?of[\s_-]?study)\b/i],
  ['gpa', /\bgpa\b/i],
  ['address_city', /\b(city|town)\b/i],
  /*
   * Country before state, because the first pattern to match wins and
   * "Country/Region" — which is what SuccessFactors, Workday and most of the
   * enterprise systems call the field — matches `region`. It was being filled
   * with a state, finding no such option, and reporting that the country had
   * no matching option while leaving a required field empty.
   */
  ['address_country', /\b(country)\b/i],
  ['address_state', /\b(state|province|region)\b/i],
  ['location', /\b(location|where.*based)\b/i],
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
    /\b(work[\s_-]?authoriz\w*|legally[\s_-]?authorized|authoriz\w+[\s_-]+to[\s_-]+work|right[\s_-]?to[\s_-]?work)\b/i,
  ],
  ['requires_sponsorship', /\b(sponsor\w*|visa[\s_-]?status)\b/i],
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
   */
  /\b(employer|company|organi[sz]ation)['’]?s?[\s_-]+(name|address|city|town|state|province|country|phone|telephone|zip|postal)\b/i,
  // Where you heard about the job, which is not a profile of yours.
  /\b(did[\s_-]you[\s_-]hear|hear[\s_-]about[\s_-](us|this)|referral)\b/i,
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
  /\b(location|city|town|country|office|site)\b[\s\S]{0,24}\b(prefer\w*|desired|requested)\b/i,
  // Relocation is about somewhere you are not. "Which city would you relocate
  // to?" was answered with the city the applicant already lives in.
  /\brelocat\w*/i,
  /\b(salary|compensation|wage|pay[\s_-]?rate|hourly[\s_-]?rate|bonus)\b/i,
  /\b(gender|race|ethnicit\w*|hispanic|latin[ox]|veteran|disabilit\w*|sexual[\s_-]orientation|pronouns)\b/i,
  /\b(eeoc?|self[\s_-]?identification|equal[\s_-]employment)\b/i,
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
const DIALLING_CODE = /\b(country|area|dial(?:l?ing)?)[\s_-]?code\b/i;
const asksForADiallingCode = (description) =>
  DIALLING_CODE.test(description.replace(/\([^)]*\)/g, ' '));

const isNotAboutYou = (description) =>
  asksForADiallingCode(description) || NOT_ABOUT_YOU.some((re) => re.test(description));

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
  const attrs = [input.name, input.id, input.placeholder].map(clean).filter(Boolean);
  return clean([label, ...attrs].filter(Boolean).join(' ')).slice(0, 300);
}

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

/** Two option labels are the same answer if they read the same. */
const sameOption = (a, b) => clean(a).toLowerCase() === clean(b).toLowerCase();

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

/** A denial close enough in front of a word to be about that word. */
const NEAR_NO = /\b(no|not|never|non|cannot|can't|don'?t|doesn'?t|without|nor|neither)\b/i;

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
    // Only the few words in front of it: a denial further away than that is
    // about some other clause. "…does not require sponsorship" denies the
    // sponsorship; "I do not need it now but will require sponsorship in
    // 2027" does not.
    const before = said.slice(0, hit.index).split(/\s+/).slice(-LOOK_BACK_WORDS).join(' ');
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
export function fillForm(fields, { overwrite = false } = {}) {
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
    if (isNotAboutYou(description)) continue;

    let match = FIELD_PATTERNS.find(([key, re]) => re.test(description) && fields[key]);

    if (!match && fields.full_name && BARE_NAME.test(clean(labelFor(input)))) {
      match = ['full_name'];
    }
    if (!match) continue;

    const [key] = match;
    const value = fields[key];

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
        // And, failing that, a yes/no pair against a phrase. See `yesNoOption`.
        yesNoOption(
          key,
          value,
          choosable.map((o) => ({ label: o.textContent, el: o })),
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
  return {
    filled: [...filled, ...radios.filled],
    skipped: [...skipped, ...radios.skipped, ...unfillableChoices(fields, [...filled, ...radios.filled])],
  };
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
  const aria = clean(first.getAttribute('aria-label'));
  if (aria) return aria;

  /*
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

function answerRadioGroups(fields, overwrite) {
  const filled = [];
  const skipped = [];

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

  for (const radios of groups.values()) {
    const description = clean([groupLabelFor(radios), radios[0].name].filter(Boolean).join(' '));
    if (!description) continue;
    // Before the exclusions and before the match, as in `fillForm`. Radios
    // are the commoner shape for this question: Workable and Teamtailor ask
    // "legally authorized to work without sponsorship" as a pair of buttons.
    if (handBack(description, skipped)) continue;
    if (isNotAboutYou(description)) continue;

    /*
     * Only the keys that are a choice between options. A name, an email address
     * or a phone number is typed, never picked from two radio buttons, so a
     * pattern matching one of those against a radio group has matched a word in
     * a sentence rather than a field: "Marketing: may we email you about
     * sponsorship webinars?" matched `email` and was reported as a field
     * waiting for the user.
     */
    const match = FIELD_PATTERNS.find(
      ([key, re]) => CHOOSABLE.has(key) && re.test(description) && fields[key],
    );
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
function unfillableChoices(fields, filled) {
  const already = new Set(filled.map((f) => f.key));
  const found = [];

  for (const widget of deepQueryAll(
    '[role="combobox"], [aria-haspopup="listbox"], [role="listbox"], [aria-autocomplete="list"], [aria-autocomplete="both"]',
  )) {
    if (!isWidgetChoice(widget)) continue;
    if (widget.getClientRects().length === 0) continue;

    const description = describeField(widget);
    if (!description) continue;
    if (isNotAboutYou(description)) continue;

    const match = FIELD_PATTERNS.find(([key, re]) => re.test(description) && fields[key] && !already.has(key));
    if (!match) continue;
    found.push({
      key: match[0],
      reason: 'this one has to be picked by hand',
      description: description.slice(0, 60),
    });
    already.add(match[0]);
  }
  return found;
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
  /\b(submit (your )?application|start your application|cover letter|work authorizat|legally authorized to work|require sponsorship|equal opportunity employer|voluntary self-identification)\b/i;

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
    else if (BARE_NAME.test(clean(labelFor(input)))) keys.add('full_name');
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
