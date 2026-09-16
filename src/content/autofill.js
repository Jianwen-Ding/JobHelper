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
  ['work_authorization', /\b(work[\s_-]?authoriz\w*|legally[\s_-]?authorized|right[\s_-]?to[\s_-]?work)\b/i],
  ['requires_sponsorship', /\b(sponsor\w*|visa[\s_-]?status)\b/i],
];

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

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
 * Find the label that belongs to a field.
 *
 * Getting this wrong is worse than not filling at all: an earlier version
 * appended "the first label found in the enclosing container", which on a form
 * inside one big <div> meant every field inherited the first field's label and
 * the email box got filled with a first name. So an explicit association wins
 * outright, and the positional fallback only looks at what immediately precedes
 * the field.
 */
function labelFor(input) {
  if (input.id) {
    const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (label) return clean(label.textContent);
  }

  const wrapping = input.closest('label');
  if (wrapping) return clean(wrapping.textContent);

  const describedBy = input.getAttribute('aria-labelledby');
  if (describedBy) {
    const text = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (clean(text)) return clean(text);
  }

  const aria = clean(input.getAttribute('aria-label'));
  if (aria) return aria;

  // Positional fallback: the nearest preceding element that reads like a label.
  let node = input.previousElementSibling;
  for (let i = 0; i < 3 && node; i++, node = node.previousElementSibling) {
    if (node.querySelector?.('input, textarea, select')) break;
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
    if (group.querySelectorAll('input:not([type=hidden]), textarea, select').length !== 1) break;
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

function isFillable(input) {
  if (input.disabled || input.readOnly) return false;
  if (input.type === 'hidden' || input.type === 'file' || input.type === 'password') return false;
  // Radios are answered as a group, below; checkboxes are consent and are
  // nobody's to tick but the applicant's.
  if (input.type === 'radio' || input.type === 'checkbox') return false;
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
const PLACEHOLDER = /^(|-+|—+|select.*|choose.*|pick.*|please\b.*|none|n\/?a|--.*--)$/i;

function looksLikePlaceholder(option) {
  return (
    option.disabled ||
    PLACEHOLDER.test(String(option.value ?? '').trim()) ||
    PLACEHOLDER.test((option.textContent ?? '').trim())
  );
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
  return !looksLikePlaceholder(option);
}

/** Set a value in a way React and friends actually notice. */
function setValue(input, value) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * Fill what we can. Returns a report of what was filled and what was skipped,
 * so the user can see the difference between "done" and "done silently wrong".
 */
export function fillForm(fields, { overwrite = false } = {}) {
  const filled = [];
  const skipped = [];

  const inputs = [...document.querySelectorAll('input, textarea, select')];
  for (const input of inputs) {
    if (!isFillable(input)) continue;

    const description = describeField(input);
    if (!description) continue;

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
      // Only pick an option that plainly matches; never guess on a dropdown.
      const option = [...input.options].find(
        (o) =>
          o.textContent.trim().toLowerCase() === String(value).toLowerCase() ||
          o.value.toLowerCase() === String(value).toLowerCase(),
      );
      if (option) {
        input.value = option.value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
        filled.push({ key, value });
      } else {
        skipped.push({ key, reason: 'no matching option', description: description.slice(0, 60) });
      }
      continue;
    }

    setValue(input, value);
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
  const legend = first.closest('fieldset')?.querySelector('legend');
  if (legend) return clean(legend.textContent);

  let group = first.parentElement;
  for (let i = 0; i < 5 && group; i++, group = group.parentElement) {
    if (!radios.every((radio) => group.contains(radio))) continue;
    // Another field in here means this is the form, not this question.
    if (group.querySelectorAll('input:not([type=radio]):not([type=hidden]), textarea, select').length > 0) break;
    const heading = [...group.querySelectorAll('label,legend,.label,[class*="label"]')].find(
      (el) => !el.querySelector('input, textarea, select'),
    );
    if (heading) return clean(heading.textContent);
  }
  return '';
}

/** What one button of a group means, which is what a human reads beside it. */
function optionLabelFor(radio) {
  const wrapping = radio.closest('label');
  if (wrapping) return clean(wrapping.textContent);
  if (radio.id) {
    const label = document.querySelector(`label[for="${CSS.escape(radio.id)}"]`);
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
function answerRadioGroups(fields, overwrite) {
  const filled = [];
  const skipped = [];

  const groups = new Map();
  for (const radio of document.querySelectorAll('input[type=radio]')) {
    if (radio.disabled || radio.getClientRects().length === 0) continue;
    const key = radio.name || radio.closest('fieldset');
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(radio);
  }

  for (const radios of groups.values()) {
    const description = clean([groupLabelFor(radios), radios[0].name].filter(Boolean).join(' '));
    if (!description) continue;

    const match = FIELD_PATTERNS.find(([key, re]) => re.test(description) && fields[key]);
    if (!match) continue;

    const [key] = match;
    const value = String(fields[key]).toLowerCase();

    if (radios.some((radio) => radio.checked) && !overwrite) {
      skipped.push({ key, reason: 'already filled', description: description.slice(0, 60) });
      continue;
    }

    const wanted = radios.find(
      (radio) => optionLabelFor(radio).toLowerCase() === value || String(radio.value).toLowerCase() === value,
    );
    if (!wanted) {
      skipped.push({ key, reason: 'no matching option', description: description.slice(0, 60) });
      continue;
    }

    wanted.checked = true;
    wanted.dispatchEvent(new Event('input', { bubbles: true }));
    wanted.dispatchEvent(new Event('change', { bubbles: true }));
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

  for (const widget of document.querySelectorAll(
    '[role="combobox"], [aria-haspopup="listbox"], [role="listbox"]',
  )) {
    if (widget instanceof HTMLSelectElement) continue;
    if (widget.getClientRects().length === 0) continue;

    const description = describeField(widget);
    if (!description) continue;

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
  /\b(submit (your )?application|apply for this|cover letter|work authorizat|require sponsorship|equal opportunity employer|voluntary self-identification)\b/i;

export function looksLikeApplicationForm() {
  const text = (document.body?.textContent ?? '').slice(0, 40_000);
  if (APPLICATION_WORDS.test(text)) return true;

  // A file upload beside the word résumé is the clearest sign there is.
  if (document.querySelector('input[type=file]') && /\b(resum|cv)\b/i.test(text)) return true;

  // Failing that, enough distinct parts of a person that nothing but an
  // application would be collecting them all at once.
  const keys = new Set();
  for (const input of document.querySelectorAll('input, textarea, select')) {
    const description = describeField(input);
    if (!description) continue;
    const match = FIELD_PATTERNS.find(([, re]) => re.test(description));
    if (match) keys.add(match[0]);
    // The same bare "Name" that `fillForm` fills — a real part of a person,
    // and on several systems the only place the name is asked for.
    else if (BARE_NAME.test(clean(labelFor(input)))) keys.add('full_name');
  }
  return keys.size >= 4;
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
    ...document.querySelectorAll('textarea'),
    // Some boards use a contenteditable div for long answers.
    ...document.querySelectorAll('[contenteditable="true"]'),
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

    const question = cleanQuestion(questionFor(field));
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
    found.push({ fieldId: id, question, currentValue: field.value ?? field.textContent ?? '' });
  }
  return found;
}

/**
 * Does this form want a cover letter? Boards signal it with a file upload
 * named for one, or a long-answer box that says so.
 */
export function wantsCoverLetter() {
  for (const field of document.querySelectorAll('input[type=file], textarea, label, legend')) {
    const text = `${field.getAttribute?.('name') ?? ''} ${field.getAttribute?.('id') ?? ''} ${
      field.textContent ?? ''
    }`.toLowerCase();
    if (/cover\s*letter/.test(text)) return true;
  }
  return false;
}

/** Whether a question is marked required, by any of the usual conventions. */
export function isRequired(fieldId) {
  const field = document.querySelector(`[${FIELD_KEY}="${CSS.escape(fieldId)}"]`);
  if (!field) return false;
  if (field.required || field.getAttribute('aria-required') === 'true') return true;

  const group = field.closest('div,fieldset,li,p');
  const label = group?.querySelector('label,legend');
  return /\*|\brequired\b/i.test(label?.textContent ?? '');
}

/** Put text into a field the card previously identified. */
export function insertAnswer(fieldId, text) {
  const field = document.querySelector(`[${FIELD_KEY}="${CSS.escape(fieldId)}"]`);
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
