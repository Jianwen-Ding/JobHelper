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

/** Everything a field's label might be hiding in. */
function describeField(input) {
  const bits = [input.name, input.id, input.getAttribute('aria-label'), input.placeholder];

  if (input.id) {
    const label = document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (label) bits.push(label.textContent);
  }
  const wrapping = input.closest('label');
  if (wrapping) bits.push(wrapping.textContent);

  // Many boards put the label in a sibling div rather than a <label>.
  const group = input.closest('div,fieldset,li');
  const heading = group?.querySelector('label,legend,.label,[class*="label"]');
  if (heading && !heading.contains(input)) bits.push(heading.textContent);

  return bits.filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 300);
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

/**
 * Find free-text questions on the page that the stored answer bank can cover.
 * Returned rather than filled: a long-form answer is something to look at
 * before it goes out.
 */
export function matchQuestions(answers) {
  const matches = [];
  for (const textarea of document.querySelectorAll('textarea')) {
    if (!isFillable(textarea) || textarea.value) continue;
    const description = describeField(textarea).toLowerCase();
    if (!description) continue;

    const best = answers
      .map((a) => ({ a, score: overlap(description, a.question.toLowerCase()) }))
      .filter((x) => x.score >= 0.5)
      .sort((x, y) => y.score - x.score)[0];

    if (best) matches.push({ element: textarea, answer: best.a, score: best.score });
  }
  return matches;
}

/** Share of the stored question's significant words present in the page text. */
function overlap(haystack, question) {
  const stop = new Set(['the', 'a', 'an', 'for', 'to', 'of', 'in', 'you', 'your', 'this', 'are', 'is', 'do', 'what', 'why']);
  const words = [...new Set(question.split(/\W+/).filter((w) => w.length > 2 && !stop.has(w)))];
  if (words.length === 0) return 0;
  return words.filter((w) => haystack.includes(w)).length / words.length;
}

export { describeField };
