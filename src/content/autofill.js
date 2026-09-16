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
  ['phone', /\b(phone|mobile|telephone|cell)\b/i],
  ['linkedin', /\b(linked-?in)\b/i],
  ['github', /\b(git-?hub)\b/i],
  ['website', /\b(website|portfolio|personal[\s_-]?site|homepage)\b/i],
  ['school', /\b(school|university|college|institution)\b/i],
  ['degree', /\b(degree)\b/i],
  ['major', /\b(major|discipline|field[\s_-]?of[\s_-]?study)\b/i],
  ['gpa', /\bgpa\b/i],
  ['address_city', /\b(city|town)\b/i],
  ['address_state', /\b(state|province|region)\b/i],
  ['address_country', /\b(country)\b/i],
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

  // Last resort: a container holding this field and nothing else fillable.
  const group = input.closest('div,fieldset,li,p');
  if (group && group.querySelectorAll('input, textarea, select').length === 1) {
    const heading = group.querySelector('label,legend,.label,[class*="label"]');
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

    // A field labelled just "Name" wants the whole name. It cannot be written
    // as a pattern over the description, because the description also carries
    // the name and id attributes — so it is asked of the label alone.
    if (!match && fields.full_name && /^(full\s+)?name$/i.test(clean(labelFor(input)))) {
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

  return { filled, skipped };
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
