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
  ['full_name', /\b(full[\s_-]?name|your[\s_-]?name|candidate[\s_-]?name|^name$)\b/i],
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
  ['work_authorization', /\b(work[\s_-]?authoriz|legally[\s_-]?authorized|right[\s_-]?to[\s_-]?work)\b/i],
  ['requires_sponsorship', /\b(sponsor|visa[\s_-]?status)\b/i],
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
  if (input.offsetParent === null && input.type !== 'hidden') return false; // not visible
  return true;
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

    const match = FIELD_PATTERNS.find(([key, re]) => re.test(description) && fields[key]);
    if (!match) continue;

    const [key] = match;
    const value = fields[key];

    if (input.value && !overwrite) {
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
    if (field.offsetParent === null) continue;

    const question = cleanQuestion(questionFor(field));
    // Anything this short is a label like "Notes", not a question worth
    // drafting an answer to.
    if (!question || question.length < 12) continue;

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
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export { describeField, questionFor, labelFor };
