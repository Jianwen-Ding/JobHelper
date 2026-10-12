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
  /*
   * Where somebody was born, which the two above did not reach: "Place of
   * birth", "Country of birth", "Birthplace", "Where were you born?". The
   * same words ResumeM-M's `isSensitiveQuestion` refuses.
   */
  /\b(place|country|city|town|state|province|county|region)\s*of\s*birth\b/i,
  /\bbirth\s*(place|country|city|town)\b/i,
  /\bwhere\s+(were|was)\s+you\s+born\b/i,
  /*
   * A Medicare or Medicaid number, named either way or both. `medical` and
   * `health` below did not reach it. The number, as the server has it, not
   * the words: "Have you worked with Medicare claims data?" is about work.
   */
  /\bmedica(re|id)\b(\s*(\/|or|and|&)\s*medica(re|id)\b)?\s*(number|no\b\.?|#|id\b|card|beneficiary)/i,
  /\bdob\b/i,
  /\bage\b/i,
  // A curly apostrophe as well as a straight one: "Driver’s License" is how a
  // form that went through a word processor writes it.
  /\bdriv(er['’]?s?|ing)\s*licen[cs]e\b/i,
  /\bpassport\b/i,
  /\bvisa\s*number\b/i,
  /\bbank\b/i,
  /\brouting\b/i,
  /\b(account|card)\s*number\b/i,
  /\biban\b/i,
  /\bsort\s*code\b/i,
  /\bpassword\b/i,
  /\bsecurity\s*question\b/i,
  /\bmother['’]?s\s*maiden\b/i,
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
  /*
   * And the plural, which is how the field is usually labelled: "Veterans
   * Status" passed `\bveteran\b`, and "I AM NOT A VETERAN" was banked twice in
   * October and offered to the next employer.
   */
  /\bveterans?\b/i,
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
   * And every name ResumeM-M refuses or redacts that this list did not know,
   * so the card never says "will be kept" about an answer the server then
   * declines, or keeps one it would have taken out of anything else. A
   * Canadian SIN spelled out, an NI "No." or "#", a US ITIN, a card asked
   * about without the word "number", a government ID shortened or "issued",
   * and the national numbers by their own names: India's Aadhaar,
   * Singapore's NRIC and FIN, Brazil's CPF, Spain's DNI and NIE, Poland's
   * PESEL, the Dutch BSN and the Swedish personnummer. The short ones in
   * capitals, as the forms write them, because "nie" and "dni" are words.
   */
  /\bsocial\s*insurance\b/i,
  /\bni\s*(no\b\.?|#)/i,
  /\bitin\b/i,
  /\b(credit|debit)\s*card\b/i,
  /\bgov(ernmen|['’])?t\.?[\s-]*(issued[\s-]*)?(id|identity|identification)\b/i,
  /\baadhaa?r\b/i,
  /\bpesel\b/i,
  /\bpersonnummer\b/i,
  /\b(NRIC|FIN|CPF|DNI|NIE|BSN)\b/,
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
  // With the month cut short ("Apr. 2, 1999") and the day said as "2nd".
  /^\d{1,2}(st|nd|rd|th)?(\s+of)?\s+\w{3,9}\.?,?\s+\d{4}$/i,
  /^\w{3,9}\.?\s+\d{1,2}(st|nd|rd|th)?,?\s+\d{4}$/i,
  /*
   * And the shapes ResumeM-M refuses anywhere in an answer, not only as the
   * whole of it — the server declines to save these, and redacts them from
   * anything else, so keeping one here would be a promise the card cannot
   * keep. An SSN's 3-2-4 with its separators, an IBAN, a UK National
   * Insurance number, and a card-length run of digits.
   */
  /\b\d{3}(?:\s?[-–.]\s?| )\d{2}(?:\s?[-–.]\s?| )\d{4}\b/,
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}/,
  /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/i,
  /\b(?:\d[ -]?){12,18}\d\b/,
];

/*
 * An identifier after its own label, which is how ResumeM-M's
 * `redactIdentifiers` finds one inside a longer text: "SSN 123456789",
 * "DOB: 04/02/1999", "Passport # X1234567", "Aadhaar 1234 5678 9012". The
 * label names below are the ones it knows; a value needs five digits, as
 * there, so "a driver's license and a car" is still words.
 */
const LABELLED_ID = new RegExp(
  String.raw`\b(?:ssn|social\s+(?:security|insurance)|sin|national\s+(?:insurance|id(?:entity|entification)?)|ni\s+(?:no\.?|number)|driv(?:er['’]?s?|ing)\s+licen[cs]e|tax\s+(?:id|identification)|itin|gov(?:ernmen|['’])?t\.?[\s-]+(?:issued\s+)?id|aadhaa?r|nric|cpf|dni|nie|pesel|bsn|personnummer|personal\s+(?:identity|identification|id)|passport)` +
    String.raw`(?:\s+(?:card|no\.?|number|code|#))*(?:\s*\([^)\n]{0,40}\))?(?:\s*\*)?\s*(?:is\s+)?[:\-#]?\s*([A-Z]{0,5}\d[A-Z0-9]*(?:[ .\-][A-Z]?\d[A-Z0-9]*)*)`,
  'i',
);
const LABELLED_BIRTH =
  /\b(?:date of birth|birth ?date|birthday|born(?: on)?|d\.?o\.?b\.?)(?:\s*\([^)\n]{0,40}\))?(?:\s*\*)?\s*[:,-]?\s*(?:\d{1,4}[/.\- ]\d{1,2}[/.\- ]\d{1,4}|[a-z]+\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}(?:st|nd|rd|th)?(?: of)? [a-z]+\.?,? \d{4})/i;

function labelledIdentifier(text) {
  if (LABELLED_BIRTH.test(text)) return true;
  const m = text.match(LABELLED_ID);
  // A passport number is shorter than the rest, and is taken at any length.
  return Boolean(m && ((m[1].match(/\d/g) ?? []).length >= 5 || /passport/i.test(m[0])));
}

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
  return SENSITIVE_SHAPE.some((re) => re.test(text)) || labelledIdentifier(text);
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
 * Parameter names that carry a credential or an identifier rather than a
 * place: `access_token`, `resourceKey`, `X-Amz-Signature`, `sessionid`.
 *
 * A list, matched against whole words of the name (and against neighbouring
 * words run together, so `resourceKey` is `resourcekey` and `api_key` is
 * `api_key`), and nothing looser. Read by the end of a word, `key` refused
 * Dropbox's `rlkey` and `monkey`, `code` the Go playground's `code` and every
 * `zipcode` and `country_code`, `pass` `bypass`, and `session` a page number
 * called `session=42`. Those are links people paste every day.
 *
 * But the list was cut too far. Every name it refused before being made
 * exact had to be on it by name, and several were not: `access_key`,
 * `private_key`, `license_key`, `verification_code`, `pass` itself and
 * `accessToken` went into the bank as freely as a page number, where the
 * looser rule had refused them all. So the whole words are back on the list,
 * a name that *ends* in one of the unmistakable words is refused whatever
 * comes before it (see `SECRET_ENDING`), and the short words that mean a
 * secret only sometimes are refused when the value is one (see
 * `SECRET_WHEN_OPAQUE`). `pass` and `pw` are among those now, refused alone
 * unless they carry a switch (`ONLY_A_FLAG`).
 */
const SECRET_PARAM = new Set([
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'apikey',
  'api_key',
  'access_key',
  'private_key',
  'license_key',
  'licence_key',
  'secret_key',
  'resourcekey',
  'verification_code',
  'auth_code',
  'passcode',
  'passphrase',
  'password',
  'passwd',
  'pwd',
  'secret',
  'client_secret',
  'sessionid',
  'session_id',
  'sid',
  'sig',
  'signature',
  'x-amz-signature',
  'ssn',
  'dob',
  'birthdate',
  'birthday',
  'otp',
  'jwt',
  'auth',
  'authorization',
  'credential',
  'credentials',
]);

/*
 * A name that ends in one of these is a credential whatever it starts with:
 * `accessToken`, `password_reset_token`, `client-secret`, `x-api-key` run
 * together as `xapikey`. Read off the whole name with its separators taken
 * out, and only at the end, because these words do not end any innocent word
 * the way `key` ends `monkey` — and at the start they do not mean the same
 * thing: `tokens=3` is a count.
 */
const SECRET_ENDING = /(token|secret|password|passwd|apikey|accesskey|privatekey)$/;

/*
 * Three words that are a secret only when what they carry is. `key=AIza…`
 * is a Google API key and `code=4/0AY…` is an OAuth code to be swapped for
 * a token, and both were kept once `key` and `code` came off the list for
 * the sake of `rlkey` and `zipcode`; but `key=python` is a tag, `code=US` a
 * country and `session=42` a page. So the value decides: a run of the
 * characters a generated credential is made of, with no spaces, that is
 * sixteen characters or more, has a slash in it, or mixes letters with
 * digits through eight characters or round a dot. A word or a small number
 * is none of those, and neither is the Go playground's `code=fmt.Println` —
 * a dot between two words is code, not a key.
 */
/*
 * And not through eight characters mixed, which is what words with a
 * number in them are: a conference's `?session=fall2024` and `?session=
 * a12b34c5`, pretalx's `?session=ses_4f8a9b2c`, a tag `?key=react2024`, an
 * anchor `?key=section-1` and a shop's `?promo_code=SUMMER2024` were all
 * refused as credentials. What a server generates to stand for somebody is
 * longer than that — a PHP session id is twenty-six characters, a Java one
 * thirty-two — and an OAuth code has its slash. Nor round a dot, which the
 * Go playground's `code=fmt.Println` needed setting aside from and nothing
 * real needed refusing for. So sixteen characters or more, or a slash.
 *
 * The rest of the names here say a secret as often as not, and are read the
 * same way: a `bearer` or a `ticket` (a CAS sign-in's `ST-…`), a
 * `magic_link`, and the session cookies a server puts in a link when the
 * browser will not keep them — `PHPSESSID`, `jsessionid` — and `ssid`. Each
 * kept a session or a sign-in in the bank, while `?ticket=general` and
 * `?ssid=HomeWifi` are words.
 *
 * And `pass` inside a longer name, which is a pass of some other kind:
 * `?season_pass=1` was refused as a password. Alone it is still one (see
 * `ONLY_A_FLAG`).
 */
const SECRET_WHEN_OPAQUE = new Set([
  'key',
  'code',
  'session',
  'pass',
  'bearer',
  'ticket',
  'magic_link',
  'magiclink',
  'phpsessid',
  'jsessionid',
  'ssid',
]);
const looksOpaque = (value) => {
  if (!/^[\w\-./+=~%]+$/.test(value)) return false;
  return value.length >= 16 || /\/|%2f/i.test(value);
};

/*
 * But sixteen was too long for the names that stand for a sign-in. A reset
 * link's `?code=8f3k2m9x1q`, a verification `?code=AB12CD34EF56`, a
 * `?session=a8f9c2e1d4b7f3` and a Maps `?key=a1b2c3d4e5f6g7h` were all kept,
 * because each is under sixteen characters and has no slash; and a code a
 * server mails out is ten or twelve characters, not twenty-six. What tells
 * them from `fall2024` and `SUMMER2024` is length and mixing together: twelve
 * letters and digits run together with no break is generated, and a word
 * with a year on it is not. Read on the longest run without a separator, so
 * a prefix with a word in it — pretalx's `ses_4f8a9b2c` is `ses` and eight
 * characters, a public talk's id — is judged on what was generated, and a
 * run of digits alone, a time, is not mixed at all.
 *
 * And on a page that says it is for signing in, resetting or confirming,
 * eight is enough: there a short code is the one that was sent, and nothing
 * on such a page is a conference session or a promotion.
 *
 * `key` keeps its sixteen, for the tags and anchors it carries, but a mixed
 * run of twelve is refused under it too.
 */
const SIGN_IN_CODE_NAME = new Set(['code', 'session', 'magic_link', 'magiclink', 'ticket', 'bearer', 'phpsessid', 'jsessionid']);
const SIGN_IN_PAGE = /(?:^|[^a-z])(reset|verif|log-?in|oauth|auth(?!or)|sign-?in|confirm|invit)/i;
const longestMixedRun = (value) =>
  Math.max(0, ...(value.match(/[A-Za-z0-9]+/g) || []).filter((run) => /[A-Za-z]/.test(run) && /\d/.test(run)).map((run) => run.length));
const looksGenerated = (value, signInPage) => {
  if (!/^[\w\-./+=~%]+$/.test(value)) return false;
  return longestMixedRun(value) >= (signInPage ? 8 : 12);
};

/*
 * `pass` and `pw` alone are a password, unless all they carry is a switch:
 * `?pw=1` turns something on, it does not sign anybody in, and was refused.
 */
const PASSWORD_WORD = /^(pass|pw)$/;
const ONLY_A_FLAG = /^(0|1|true|false|yes|no|on|off|y|n)$/i;
/*
 * And inside a longer name too. Read only as the whole name, `pass` and `pw`
 * let `?user_pass=hunter2`, `?admin_pass=…`, `?wifi_pass=…`, `?user_pw=…`
 * and `?userPw=…` into the bank, each a password under a word that says
 * whose. So `pw` as any word of the name is one, and `pass` as the last word
 * is — but not the passes that get somebody on a bus or into a park, which
 * are named for what they are a pass to. `bypass` and `passport` are one
 * word and never reach here.
 */
const NOT_A_PASSWORD = /^(season|boarding|bus|day|week|weekly|month|monthly|annual|year|train|rail|transit|metro|ski|park|parking|festival|event|museum|gym|guest|visitor|press|backstage|hall)$/;
const namesAPassword = (words) =>
  words.includes('pw') ||
  (words.length > 1 && words[words.length - 1] === 'pass' && !NOT_A_PASSWORD.test(words[words.length - 2]));

/*
 * A Google Sheet shared before 2014 is named by its `key`: `docs.google.com/
 * spreadsheet/ccc?key=0Au…&usp=sharing`, and `/pub?key=` when published. That
 * is the document's id, the one a newer link carries in its path, and sixteen
 * characters and more of it was refused as a credential. On Google Docs' own
 * host a `key` is that; a Google API key under any name is still caught by
 * its shape, `AIza…`.
 */
const KEY_IS_THE_DOCUMENT = /^docs\.google\.com$/;

/** Names under which a number is a telephone number, and a date a birthday. */
const PHONE_PARAM = /^(phone|tel|telephone|mobile|cell)$/;
/*
 * And names under which a bare run of digits is somebody's number all the
 * same. Nine digits is a Social Security number with its dashes taken out,
 * and ten or eleven a telephone number, and neither has punctuation to give
 * it away — so `?contact=4155551234` and `?n=123456789` were kept. Refused
 * only under a name that says contact, or one too short to say anything at
 * all (and none: a bare fragment). Not under `id`, `item`, `scriptVersionId`
 * or any other longer name, which is what nine and ten digit ids are
 * published under every day.
 */
const CONTACT_PARAM = /^(contact|phone|tel|telephone|mobile|cell|cellphone|whatsapp|sms|number|num|no|callback|call)$/;
const BARE_PERSONAL_NUMBER = /^\+?\d{9,11}$/;
/*
 * But the short names that say something are not saying "a person". A
 * time in seconds is ten digits beginning with 1 until 2033, and it is what
 * `?t=`, `?ts=`, a cache-buster's `?cb=` and jQuery's `?_=` carry, and
 * WordPress's `?p=123456789` is a post: each was refused as a telephone
 * number. Ten digits beginning with 1 is not a whole telephone number
 * anywhere this is used — no North American area code begins with 1 — so
 * it is a time under any name but one that says contact; and under these,
 * any run of digits is what they say.
 */
const NOT_SOMEBODY = /^(t|ts|cb|_|p|v|s|pg|id)$/;
const A_TIME = /^1\d{9}$/;
const BIRTH_PARAM = /^(dob|birth|birthdate|birthday|born)$/;

/*
 * A telephone number by its punctuation: a leading `+`, an area code in
 * brackets, or the 3-3-4 groups people write. A run of bare digits is an id
 * far more often in a link — a GitHub comment, a playlist, a record — and is
 * read as a telephone number only under a name that says it is one.
 */
const PHONE_PUNCTUATED = /(^|[^\w])(\+\d[\d\s().-]{7,}\d|\(\d{2,4}\)\s?\d{3,4}[\s.-]?\d{3,4}|\d{3}[\s.-]\d{3}[\s.-]\d{4})(?!\w)/;

/*
 * Values shaped like a credential whatever they are called: a JWT, and the
 * prefixes GitHub, OpenAI-style, AWS and Slack keys carry.
 */
const TOKEN_SHAPE = [
  /eyJ[\w-]+\.[\w-]+\./,
  // A Stripe secret or restricted key, live or test.
  /\b[sr]k_(live|test)_[A-Za-z0-9]{16,}/,
  /\b(gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/,
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{8,}/,
  // A Google API key, and a GitLab personal access token.
  /\bAIza[0-9A-Za-z_-]{35}/,
  /\bglpat-[\w-]{20,}/,
  /*
   * And the keys that were still kept by their shape: SendGrid's, an npm
   * token, a PyPI upload token and a Mailchimp key with its data centre.
   */
  /\bSG\.[\w-]{16,}\.[\w-]{16,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bpypi-[A-Za-z0-9_-]{50,}/,
  /\b[0-9a-f]{32}-us\d{1,2}\b/,
];

/*
 * Shapes refused in a value as they are in any answer — an SSN with its
 * dashes, an IBAN, a National Insurance number, a card number in its groups
 * of four, an identifier after its label — but not the bare digit runs and
 * dates `looksPrivate` also refuses, which in a link are an id, a time or a
 * page: those are below, under the names that make them personal.
 */
const LINK_VALUE_SHAPE = [
  /\b\d{3}(?:\s?[-–.]\s?| )\d{2}(?:\s?[-–.]\s?| )\d{4}\b/,
  /\b[A-Z]{2}\d{2}(?:\s?[A-Z0-9]{4}){3,7}/,
  /\b[A-CEGHJ-PR-TW-Z]{2} ?\d{2} ?\d{2} ?\d{2} ?[A-D]\b/i,
  /\b\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}\b/,
];

/*
 * Paths that are a credential whatever the query says. See `linkCarriesPrivate`.
 */
/*
 * Slack's workflow and trigger webhooks post as their owner as the older
 * `services` ones do, and Discord's API takes a version in front of
 * `webhooks` (`/api/v10/webhooks/…`); both forms were kept.
 */
const SECRET_PATH = [
  /^hooks\.slack\.com\/(?:services|workflows|triggers)\/T[A-Z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/i,
  /^(?:[\w-]+\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+/i,
  /\/bot\d+:[A-Za-z0-9_-]{30,}/,
];

const DATE_SHAPE = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/;
/*
 * A date is a birthday under a birth name, and otherwise only when it is
 * one somebody applying for work could have been born on: the 15th of
 * January this year is a date filter, 1990-01-02 is somebody's age.
 */
function birthLikeDate(value, birthName) {
  if (!DATE_SHAPE.test(value)) return false;
  if (birthName) return true;
  const year = value.match(/\b\d{4}\b/)?.[0];
  return Boolean(year) && Number(year) <= new Date().getFullYear() - 14;
}

/**
 * Whether a link carries something private in the parts of it that are not
 * the place it points to.
 *
 * A link was exempt from the contact check, because the digits in a path are
 * an id and not a telephone number — and that exemption reached the whole of
 * it, so `https://x.com/?ssn=123456789`, `?access_token=ghp_…`, `?email=…`,
 * `https://user:pass@x.com/` and a Drive link's `resourcekey=` all went into
 * the bank and were offered to the next form. The scheme, the host and the
 * path are still read as a place. What is refused is a link that logs in as
 * somebody, a query or fragment parameter named like a secret, and a value
 * that is shaped like one, or like an address, a telephone number or a
 * birthday. Every digit run and date was refused at first, and with it a
 * YouTube time, a GitHub comment, a playlist and a date filter.
 */
function linkCarriesPrivate(said, depth = 0) {
  let url;
  try {
    url = new URL(said);
  } catch {
    // Not a link after all, so read as anything else typed would be.
    return looksPrivate(said) || CONTACT_SHAPE.some((re) => re.test(said));
  }
  if (url.username || url.password) return true;
  /*
   * And a path that is a secret by itself, which no parameter name gives
   * away: a Slack webhook (`hooks.slack.com/services/T…/B…/…`), a Discord
   * one, and a Telegram bot's token in front of the method it calls. Anyone
   * holding these can post as their owner, and each was kept.
   */
  if (SECRET_PATH.some((re) => re.test(`${url.hostname.toLowerCase()}${url.pathname}`))) return true;
  const params = [...url.searchParams];
  /*
   * And the parameters some servers write into the path after a `;`, as
   * Java's do with `;jsessionid=…` when the browser will not keep a cookie.
   */
  for (const [, name, value] of url.pathname.matchAll(/;([^=/;]+)=([^/;]*)/g)) params.push([name, value]);
  const docsKey = KEY_IS_THE_DOCUMENT.test(url.hostname.toLowerCase().replace(/\.$/, ''));
  const signInPage = SIGN_IN_PAGE.test(`${url.hostname}${url.pathname}`);
  const fragment = url.hash.slice(1);
  if (fragment.includes('=')) params.push(...new URLSearchParams(fragment));
  else if (fragment) params.push(['', fragment]);
  return params.some(([name, value]) => {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Already decoded by URLSearchParams, or a stray `%`: read it as it is.
    }
    // The name a word at a time, with camelCase and the separators taken apart.
    const words = name
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const named = [...words, words.join(''), words.join('_'), words.join('-')];
    for (let i = 1; i < words.length; i++) named.push(words[i - 1] + words[i], `${words[i - 1]}_${words[i]}`);
    const whole = words.join('');
    if (named.some((w) => SECRET_PARAM.has(w))) return true;
    if (SECRET_ENDING.test(whole)) return true;
    if ((PASSWORD_WORD.test(whole) || namesAPassword(words)) && !ONLY_A_FLAG.test(decoded.trim())) return true;
    const opaqueName = named.some((w) => SECRET_WHEN_OPAQUE.has(w) && !(PASSWORD_WORD.test(whole) || (w === 'key' && docsKey)));
    if (opaqueName && [value, decoded].some(looksOpaque)) return true;
    const signInName = named.some((w) => SIGN_IN_CODE_NAME.has(w));
    if (signInName && [value, decoded].some((v) => looksGenerated(v, signInPage))) return true;
    if (!docsKey && named.includes('key') && [value, decoded].some((v) => looksGenerated(v, false))) return true;
    const contactName = words.some((w) => CONTACT_PARAM.test(w));
    if (
      BARE_PERSONAL_NUMBER.test(decoded.trim()) &&
      (contactName || (whole.length <= 2 && !NOT_SOMEBODY.test(name.toLowerCase()) && !A_TIME.test(decoded.trim())))
    ) {
      return true;
    }
    // A link inside a link — a redirect — is read the same way, once more.
    if (depth < 2 && /^https?:\/\//i.test(decoded)) return linkCarriesPrivate(decoded, depth + 1);
    const phoneName = words.some((w) => PHONE_PARAM.test(w));
    const birthName = words.some((w) => BIRTH_PARAM.test(w));
    return [name, decoded].some(
      (t) =>
        CONTACT_SHAPE[0].test(t) ||
        (phoneName ? CONTACT_SHAPE[1].test(t) : PHONE_PUNCTUATED.test(t)) ||
        birthLikeDate(t, birthName) ||
        TOKEN_SHAPE.some((re) => re.test(t)) ||
        LINK_VALUE_SHAPE.some((re) => re.test(t)) ||
        labelledIdentifier(t),
    );
  });
}

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


/*
 * An ORCID iD in a link's path, set aside before the path is read for
 * private shapes. "0000-0002-1825-0097" is four groups of four digits, which
 * is a card number to `looksPrivate`, so the one link a researcher's resume
 * most often carries was never remembered. Only a real iD is set aside — the
 * last character is the ISO 7064 11,2 check digit ORCID uses — so sixteen
 * digits that merely look like one are still read as they are.
 *
 * And only on ORCID's own host. Set aside wherever it appeared, a card number
 * in a payment link's path — `pay.example.com/card/4111-1111-1111-0238`,
 * whose last digit happens to satisfy the same check one time in eleven —
 * was taken for an iD and kept. An iD anywhere else is a researcher's to
 * paste as the orcid.org link it is.
 */
function withoutOrcid(link) {
  let host = '';
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return link;
  }
  /*
   * Its subdomains too — `pub.orcid.org` is the public API's, `sandbox.
   * orcid.org` the test one's — and with the dot a fully written host ends
   * in, which the browser keeps.
   */
  host = host.replace(/\.$/, '');
  if (host !== 'orcid.org' && !host.endsWith('.orcid.org')) return link;
  return link.replace(/(?<=\/)(\d{4}-\d{4}-\d{4}-\d{3}[\dX])(?=\/|$)/gi, (id) => {
    const digits = id.replace(/-/g, '');
    let total = 0;
    for (const d of digits.slice(0, 15)) total = (total + Number(d)) * 2;
    const check = (12 - (total % 11)) % 11;
    return digits[15].toUpperCase() === (check === 10 ? 'X' : String(check)) ? 'orcid' : id;
  });
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
   * Its query, its fragment and anybody it logs in as are not a place, and
   * are read in full by `linkCarriesPrivate`.
   */
  const oneLink = /^https?:\/\/\S+$/i.test(said) && said.length <= 200;
  /*
   * The query and the fragment of a link are read by `linkCarriesPrivate`
   * alone. Read here as well, a Scholar `cluster=` id was a card number to
   * `looksPrivate`, whatever was decided there.
   */
  const place = oneLink ? withoutOrcid(said.replace(/[?#].*$/, '')) : said;
  if (looksPrivate(place) || (oneLink ? linkCarriesPrivate(said) : CONTACT_SHAPE.some((re) => re.test(said)))) {
    return { keep: false, why: 'the answer looks personal, so it is not kept' };
  }
  if (namesThem(said, company)) return { keep: false, why: 'the answer depends on the employer, so it is not kept' };
  if (/[\r\n]/.test(said) || (said.length >= A_LINE && !oneLink)) {
    return { keep: false, why: 'this is longer than a line, so it is not kept' };
  }
  return { keep: true };
}
