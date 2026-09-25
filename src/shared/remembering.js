/**
 * What may be remembered from one application and offered on the next.
 *
 * Applying is the same twenty questions over and over — work authorisation,
 * sponsorship, how you heard about us, which state you live in — and
 * answering them again every time is most of what makes a form tedious. So
 * the answers are kept. Not "whether you have worked here before", which
 * this list once named: see `DEPENDS_ON_EMPLOYER`.
 *
 * The ones that were *chosen*, first. That scope does most of the safety work
 * on its own: a chosen answer is by construction one of a handful the form
 * itself offered, and no form offers your social security number in a
 * dropdown. Free text is where the dangerous things live — an SSN typed into
 * a box, a date of birth, an account number — so what was typed is kept only
 * from a one-line box, only a line long, and on the narrower terms of
 * `worthRememberingTyped` at the end of this file.
 *
 * The two checks below are belt and braces over that. The first reads the
 * question, which catches the ordinary case of a sensitive field that happens
 * to be a choice ("Date of birth" as three dropdowns). The second reads the
 * answer, which catches the same field when nobody labelled it — a box named
 * `q_88213` holding nine digits is not something to keep, whatever it is
 * called.
 *
 * Both are deliberately one-way: anything that looks like it might be
 * sensitive is refused, and the cost of refusing wrongly is that one question
 * gets answered by hand again.
 */

/**
 * Questions whose answer is never kept, however it was given.
 *
 * Written as whole words with boundaries, because the substring versions are
 * worse than useless here: `ssn` is inside "lessons", `dob` inside "doberman",
 * and a check that fires on those teaches nobody anything while quietly
 * refusing ordinary questions.
 *
 * "Salary" and "notice period" are deliberately *not* on this list. What you
 * are asking for and how much notice you have to give are the same answer
 * next week, and are exactly what somebody tires of typing. What you are paid
 * *now*, or were paid before, is on it: see the salary history below.
 */
const NEVER_REMEMBER = [
  /\bssn\b/i,
  /\bsocial\s*security\b/i,
  /\bnational\s*insurance\b/i,
  /\bni\s*number\b/i,
  /\bsin\b/i,
  /\btax\s*(id|identification|payer)\b/i,
  /\btin\b/i,
  /\b(date|day|month|year)\s*of\s*birth\b/i,
  /\bbirth\s*(date|day)\b/i,
  /\bdob\b/i,
  /\bage\b/i,
  /\bdriv(er'?s?|ing)\s*licen[cs]e\b/i,
  /\bpassport\b/i,
  /\bvisa\s*number\b/i,
  /\bbank\b/i,
  /\brouting\b/i,
  /\b(account|card)\s*number\b/i,
  /\biban\b/i,
  /\bsort\s*code\b/i,
  /\bpassword\b/i,
  /\bsecurity\s*question\b/i,
  /\bmother'?s\s*maiden\b/i,
  /\bcriminal\b/i,
  // The stem, because a form asks "have you been convicted" and a list
  // written as "conviction" does not match it.
  /\bconvict/i,
  /*
   * The stem, like `convict` above: "Do you have a disability?" matched and
   * "Are you disabled?" — the same question, asked the other common way — did
   * not, so its answer was banked and offered to the next employer.
   */
  /\bdisab(led|ility|ilities)\b/i,
  /\bveteran\b/i,
  /\bethnicit(y|ies)\b/i,
  /\brace\b/i,
  /*
   * The equal-opportunity block asks about ethnicity without using the word.
   *
   * Greenhouse's own is "Are you Hispanic/Latino?", verbatim, as its own
   * question beside "Race" — and it matched nothing here, so the answer went
   * into the bank and was offered back on the next form. That is the exact
   * thing this list exists to stop, on the commonest form there is. The rest
   * are the same question as other systems and other countries put it: the
   * Australian forms ask about Aboriginal and Torres Strait Islander identity,
   * the Canadian ones about Indigenous identity and First Nations, and plenty
   * ask whether you are a person of colour or about national origin.
   */
  /\bhispanic\b/i,
  /\blatin[oaxe]s?\b/i,
  /\bpe(rson|ople)\s*of\s*colou?r\b/i,
  /\bindigenous\b/i,
  /\baboriginal\b/i,
  /\btorres\s*strait\b/i,
  /\bfirst\s*nations?\b/i,
  /\bnational\s*origin\b/i,
  /\bcaste\b/i,
  /\bgender\b/i,
  /*
   * And the same for sex and identity. "Sex" was refused before only because
   * it is shorter than the length check below — the wrong reason, and one
   * that did not survive being asked as "What is your sex?".
   *
   * `trans` not followed by a hyphen, so "trans-Atlantic travel" is left
   * alone. Word boundaries keep `sex` out of Essex and Middlesex.
   */
  /\bsex\b/i,
  /\btrans(gender)?\b(?![-\u2010-\u2015])/i,
  /\bnon-?binary\b/i,
  /\blgbt/i,
  /\bsexual\s*orientation\b/i,
  /\bneurodiver/i,
  /\breligion\b/i,
  /\bmarital\b/i,
  /\bpregnan/i,
  /\bmedical\b/i,
  /\bhealth\b/i,
  /*
   * Government numbers by the names the list above did not know. "National
   * ID number" and "Government ID" are how the forms outside the US and the
   * UK ask for the thing `ssn` and `national insurance` are there to refuse.
   */
  /\b(national|government|state|citizen|personal)[\s-]*(id|identity|identification)\b/i,
  /*
   * Where somebody lives, in any of its parts. The store refuses a "home
   * address", and short typed answers are now kept — so "Address Line 1",
   * "Zip code" and "Apartment" went into the bank piece by piece, the whole
   * address the rule exists to keep out of a file that is copied and shared.
   */
  /\b(home|mailing|residential|street|postal)\s*address\b/i,
  /\baddress\s*(line|[12])\b/i,
  /\b(zip|postal)\s*(code)?\b|\bpostcode\b/i,
  /\b(apartment|apt)\b/i,
  /*
   * What somebody is paid now, or was paid before.
   *
   * Asking for it is against the law in a growing list of places, and an
   * answer given to one employer is the number the next one negotiates down
   * from. What somebody *expects* is theirs to repeat, and is kept.
   */
  /\b(current|present|previous|prior|past|last|most\s+recent|existing)\s+(annual\s+|base\s+|total\s+|gross\s+)?(salary|compensation|pay|wages?|ctc|earnings|remuneration|package)\b/i,
  /\b(salary|compensation|pay|wage)\s+history\b/i,
  /\b(currently|previously)\s+(earn|make|paid)\b/i,
  /\b(were|are)\s+you\s+(currently\s+)?(earning|making|paid)\b/i,
  /\b(salary|compensation|pay)\b[^.?]{0,30}\b(last|previous|prior|former)\s+(position|role|job|employer|company)\b/i,
];

/**
 * And answers that look like something private whatever they were asked by.
 *
 * The label check cannot see a field nobody labelled, and those exist: an
 * enterprise questionnaire whose every control is `q_88213`. So the value is
 * looked at too — not to understand it, only to notice that its shape is one
 * secrets come in.
 *
 * Long digit runs, an SSN with or without its dashes, and anything that reads
 * as a date. A date is refused rather than parsed: a birthday and a graduation
 * date are the same nine characters, and the one that must not be kept is the
 * one worth being wrong about.
 */
const SENSITIVE_SHAPE = [
  // Nine digits, dashed or not: an SSN either way.
  /^\d{3}-?\d{2}-?\d{4}$/,
  // A card or account number, and any other long run of digits.
  /^[\d\s-]{11,}$/,
  // A date in any of the ways people write one.
  /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/,
  /^\d{1,2}\s+\w{3,9}\s+\d{4}$/,
  /^\w{3,9}\s+\d{1,2},?\s+\d{4}$/,
];

/**
 * Questions asked in the same words by every employer, whose answer is about
 * that employer.
 *
 * "Have you previously been employed by this company?" reads identically on
 * Acme's form and on Helios's, so the store matches it word for word and calls
 * the match confident — and the answer given to Acme is not the answer to
 * Helios. Measured end to end: "Yes" chosen on Acme's form went into the bank,
 * and Autofill on Helios's form put it into the same question there, telling
 * Helios the applicant had worked for them. The bank is keyed on the question
 * and nothing else, so there is nothing on the way out that could tell the two
 * apart; they are refused on the way in and on the way out instead.
 *
 * Past tense on purpose. "Are you legally authorized to work for any employer"
 * is the most repeated question there is and says "work for"; what is refused
 * is having *worked* for, been *employed* by, *applied* to, being a current or
 * former employee of, having family at, or being referred by someone at —
 * the employer, however it is named. "Have you worked with Kubernetes" is
 * about the person and is kept.
 */
const DEPENDS_ON_EMPLOYER = [
  /\b(worked|interned)\s+(for|at|here)\b/i,
  /\bemployed\s+(by|with|at|here)\b/i,
  /\b(current|former|previous|past|ex)[\s-]+(or\s+(current|former|previous|past)\s+)?(employee|intern|contractor)s?\b/i,
  /\b(relatives?|family\s+members?|related\s+to\s+(any|some)(one|body)|know\s+(any|some)(one|body))\b/i,
  /\b(ever|previously|already|before)\s+(applied|interviewed)\b/i,
  /\b(applied|interviewed)\b.*\b(before|previously|in\s+the\s+past)\b/i,
  /\b(were\s+you\s+referred|referred\s+by)\b/i,
];

/** Whether this question's answer depends on who is asking it. */
export function dependsOnEmployer(question) {
  const text = String(question ?? '');
  return DEPENDS_ON_EMPLOYER.some((re) => re.test(text));
}

/** Whether this question is one whose answer is never kept. */
export function neverRemember(question) {
  const text = String(question ?? '');
  return NEVER_REMEMBER.some((re) => re.test(text));
}

/** Whether this answer looks like something private, whatever it was asked by. */
export function looksPrivate(answer) {
  const text = String(answer ?? '').trim();
  return SENSITIVE_SHAPE.some((re) => re.test(text));
}

/**
 * Whether a chosen answer is worth keeping for next time — and if not, why.
 *
 * The reason is returned rather than swallowed because the card says it. A
 * tool that quietly declines to remember things looks broken; one that says
 * "not keeping the date-of-birth answer" is doing something the person can
 * agree with.
 */
export function worthRemembering({ question, answer } = {}) {
  const asked = String(question ?? '').trim();
  const said = String(answer ?? '').trim();

  if (!asked || !said) return { keep: false, why: 'there is no question and answer here' };

  /*
   * The two refusals first, before anything about shape or length.
   *
   * Order is not cosmetic here: it decides what the card says. "DOB" is three
   * characters, so a length check in front would refuse it for being short —
   * true, and the wrong reason to give somebody about their date of birth.
   * The sentence a person reads has to name the actual objection, or the next
   * person to read this code will relax the length rule and quietly turn the
   * other one off.
   */
  if (neverRemember(asked)) return { keep: false, why: 'this one is personal, so it is not kept' };
  if (looksPrivate(said)) return { keep: false, why: 'the answer looks personal, so it is not kept' };
  if (dependsOnEmployer(asked)) return { keep: false, why: 'the answer depends on the employer, so it is not kept' };

  /*
   * A question nobody could match again is not worth a row in the bank. The
   * point of keeping it is that the next form asks something recognisably the
   * same, and two words cannot be recognised.
   */
  if (asked.length < 8) return { keep: false, why: 'the question is too short to recognise again' };
  /*
   * And an answer long enough to be prose is not a chosen option — it is
   * something typed, which this does not keep. Belt and braces: the caller
   * only ever offers chosen options.
   */
  if (said.length > 120) return { keep: false, why: 'this is written rather than chosen' };

  return { keep: true };
}

/* ---------------------------- What was typed ---------------------------- */

/*
 * The same bargain for a short box somebody typed into, which is where the
 * rest of the repetition is.
 *
 * Measured on the fixtures in tests/reusing.mjs, shaped like Greenhouse's and
 * Lever's custom questions: a form answered once by hand — "How did you hear
 * about us?", "Earliest start date", "Expected salary", "Preferred first
 * name", "Portfolio link", "Current employer", and "Are you 18 or older?" and
 * "Willing to relocate?" asked as text rather than as buttons — and then a
 * second form asking the same things in its own words. Before this, the bank
 * held one row after the first form — the one dropdown on it — and Autofill
 * on the second filled "Filled 4 fields": the name, the email, and the two
 * preferred-name boxes given the legal names. None of the eight came back,
 * so the same eight boxes were typed again on every application.
 *
 * Typed text is where the dangerous things live — the header of this file
 * says so, and it is why only chosen answers were kept at first. So a typed
 * answer is kept on narrower terms than a chosen one: everything
 * `worthRemembering` refuses, and then the things only a box can hold.
 */

/*
 * Somebody else's details. A box can hold a referee's name and telephone
 * number, a chosen option cannot — and the answer is right for one employer's
 * reference check and nobody's next form.
 */
const SOMEBODY_ELSE = /\b(references?|referee|referr(?:er|ers|al|ed)|recommender|emergency|next[\s-]*of[\s-]*kin|guardian|spouse|manager'?s?|supervisor'?s?|recruiter'?s?)\b/i;

/*
 * Questions about this employer, however they avoid naming it. "Why?" is
 * always why *here*; the rest are the ways a form says "us" without the
 * company's name in it, which is caught separately by `namesThem`.
 */
const ABOUT_THIS_EMPLOYER = [
  /\bwhy\b/i,
  /\b(this|our)\s+(company|organi[sz]ation|firm|business|mission|culture|values|products?|services?)\b/i,
  /\b(join(ing)?|work(ing)?\s+(at|for|with))\s+us\b/i,
  /\bwork(ing)?\s+here\b/i,
];

/*
 * Contact details, whoever they belong to. The applicant's own are the
 * profile's and are filled from there; anybody else's are not to be kept.
 */
const CONTACT_SHAPE = [/[^\s@]+@[^\s@]+\.[^\s@]+/, /\+?\(?\d[\d\s().-]{7,}\d/];

/*
 * A line, not a paragraph. From here on it is writing, the card's to draft
 * and the bank's to keep only when somebody saves it there on purpose — and
 * it is where ResumeM-M's voice corpus starts reading an answer as prose (60
 * characters), which is the same judgement made from the other side: nothing
 * kept from a box here is ever read as how somebody writes.
 */
const A_LINE = 60;

/**
 * Whether the employer being applied to is named, as a whole word.
 *
 * The name as the page gave it and its first word, which is how people write
 * it: "Helios" for "Helios Systems, Inc.". A first word that is a common one
 * — "The", "New" — is not a name.
 */
export function namesThem(text, company) {
  const said = String(text ?? '');
  const name = String(company ?? '').trim();
  if (!said || name.length < 3) return false;
  const first = name.split(/[\s,]+/)[0];
  const names = [name.replace(/,?\s+(inc|llc|ltd|corp|co|plc|gmbh)\.?$/i, ''), first.length >= 4 && !/^(the|new|north|south|east|west|first|global)$/i.test(first) ? first : '']
    .filter(Boolean);
  return names.some((n) =>
    new RegExp(`(^|[^\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'iu').test(said),
  );
}

/**
 * Whether a typed box's question is one whose answer may be kept and offered
 * back, and if not, why. Asked of the question alone, so the bank is never
 * even asked about one that is not.
 */
export function mayRememberTyped(question, company) {
  const asked = String(question ?? '').trim();
  if (!asked) return { keep: false, why: 'there is no question here' };
  if (neverRemember(asked)) return { keep: false, why: 'this one is personal, so it is not kept' };
  if (SOMEBODY_ELSE.test(asked)) return { keep: false, why: 'this is about somebody else, so it is not kept' };
  if (dependsOnEmployer(asked) || ABOUT_THIS_EMPLOYER.some((re) => re.test(asked)) || namesThem(asked, company)) {
    return { keep: false, why: 'the answer depends on the employer, so it is not kept' };
  }
  if (asked.length < 8) return { keep: false, why: 'the question is too short to recognise again' };
  return { keep: true };
}

/**
 * Whether a typed answer is worth keeping for next time — and if not, why.
 *
 * The same shape as `worthRemembering`, and used both ways: on the way into
 * the bank, and on the way back out of it, because the bank also holds what
 * was typed into the Workspace by hand and what was kept before these rules.
 */
export function worthRememberingTyped({ question, answer, company } = {}) {
  const said = String(answer ?? '').trim();
  const asked = mayRememberTyped(question, company);
  if (!said) return { keep: false, why: 'there is no answer here' };
  // The question's refusal first, for the reason given in `worthRemembering`.
  if (!asked.keep) return asked;
  /*
   * A link is one word however long it is — and its digits are an id in a
   * path, not a telephone number, so it is read for the shapes that are
   * anchored to the whole answer and not for a number somewhere inside it.
   */
  const oneLink = /^https?:\/\/\S+$/i.test(said) && said.length <= 200;
  if (looksPrivate(said) || (!oneLink && CONTACT_SHAPE.some((re) => re.test(said)))) {
    return { keep: false, why: 'the answer looks personal, so it is not kept' };
  }
  if (namesThem(said, company)) return { keep: false, why: 'the answer depends on the employer, so it is not kept' };
  if (/[\r\n]/.test(said) || (said.length >= A_LINE && !oneLink)) {
    return { keep: false, why: 'this is longer than a line, so it is not kept' };
  }
  return { keep: true };
}
