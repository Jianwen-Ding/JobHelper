/**
 * What is kept from one application and offered on the next, and what is not.
 *
 * The keeping is the feature; the refusing is the part that has to be right.
 * An answer bank that quietly holds somebody's social security number is a
 * worse tool than one that remembers nothing, and the failure is silent —
 * nothing on screen is different, the number simply sits in a file for ever.
 *
 * Pure, so it is a node test.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  looksPrivate,
  mayRememberTyped,
  namesThem,
  neverRemember,
  worthRemembering,
  worthRememberingTyped,
} from '../src/shared/remembering.js';

/* The questions applying actually repeats, which are the reason for any of this. */
const KEEP = [
  ['Are you legally authorized to work in the United States?', 'Yes'],
  ['Will you now or in the future require sponsorship for employment visa status?', 'No'],
  ['How did you hear about this position?', 'LinkedIn'],
  ['What is your state of residence?', 'Massachusetts'],
  ['Are you willing to relocate?', 'Yes'],
  ['Highest level of education completed', "Bachelor's degree"],
  ['Preferred pronouns', 'they/them'],
];

test('the questions applying repeats are kept', () => {
  for (const [question, answer] of KEEP) {
    assert.equal(worthRemembering({ question, answer }).keep, true, question);
  }
});

/*
 * And the ones that are not anybody's business twice. Each of these is a real
 * field on a real application — the background-check step and the
 * equal-opportunity page ask most of them — and each is sometimes a dropdown,
 * which is what brings it within reach of a thing that remembers choices.
 */
const REFUSE = [
  ['Social Security Number', '123-45-6789'],
  ['SSN (last four)', '6789'],
  ['National Insurance number', 'QQ123456C'],
  ['Date of birth', '1999-04-02'],
  ['Month of birth', 'April'],
  ['DOB', '02/04/1999'],
  ['Your age', '26'],
  ["Driver's license number", 'S12345678'],
  ['Passport number', '5551234'],
  ['Bank account number', '00012345'],
  ['Routing number', '011000015'],
  ['IBAN', 'GB29NWBK60161331926819'],
  ['Have you ever been convicted of a crime?', 'No'],
  ['Do you have a disability?', 'No'],
  ['Are you a protected veteran?', 'No'],
  ['Race / Ethnicity', 'Decline to self-identify'],
  ['Gender', 'Decline to self-identify'],
  ['What is your religion?', 'None'],
  ['Marital status', 'Single'],
  ["Mother's maiden name", 'Smith'],
  // A home address, and the same address a box at a time.
  ['Street address', '12 Elm St'],
  ['Address Line 1', '12 Elm St'],
  ['Zip code', '02115'],
  ['Postal Code', 'M5V 2T6'],
  ['Apartment / Suite', 'Apt 4'],
  /*
   * The equal-opportunity questions that do not use the words above. Every one
   * of these was banked and offered back on the next form. The first is
   * Greenhouse's own wording, verbatim, on the commonest form there is.
   */
  ['Are you Hispanic/Latino?', 'No'],
  ['Hispanic or Latino?', 'Decline to self-identify'],
  ['Are you Hispanic/Latinx?', 'No'],
  ['Do you identify as Latine?', 'No'],
  ['Do you identify as a person of color?', 'No'],
  ['Do you identify as Indigenous?', 'No'],
  ['Are you Aboriginal or Torres Strait Islander?', 'No'],
  ['National origin', 'Decline to self-identify'],
  ['Are you disabled?', 'No'],
  ['What is your sex?', 'Decline to self-identify'],
  // Refused before only for being short, which is the wrong reason; the
  // assertion below that the reason is "personal" is what pins that.
  ['Sex', 'Decline to self-identify'],
  ['Caste', 'Decline to self-identify'],
  ['Are you transgender?', 'No'],
  ['Do you identify as trans?', 'No'],
  ['Do you identify as non-binary?', 'No'],
  ['Do you identify as LGBTQ+?', 'No'],
  ['Do you consider yourself a member of the LGBTQIA+ community?', 'No'],
  ['Do you identify as neurodivergent?', 'No'],
  /*
   * One each that only its own pattern can catch. The pairs above — "Hispanic
   * or Latino", "Aboriginal or Torres Strait Islander" — are how the forms
   * put it, but each half matches on its own, so removing either pattern left
   * them refused by the other and nothing here noticed. These are the halves
   * asked alone, which the forms also do.
   */
  ['Do you identify as Hispanic?', 'No'],
  ['Are you of Aboriginal descent?', 'No'],
  ['Are you a Torres Strait Islander?', 'No'],
  ['Do you identify as First Nations, Métis or Inuit?', 'No'],
  // The UK wording of the licence question; only "driver's licence" was known.
  ['Do you hold a full UK driving licence?', 'Yes'],
  /*
   * A government number by the name most countries give it, and what
   * somebody is paid now — both asked as dropdowns often enough, and neither
   * matched anything here.
   */
  ['National ID number', 'AB1234567'],
  ['Government ID type', 'Passport'],
  ['Current salary range', '$120k–$140k'],
  ['What was your salary in your last position?', '$120k–$140k'],
  ['What are you currently earning?', '$120k–$140k'],
];

test('and the ones that are nobody else’s business are refused', () => {
  for (const [question, answer] of REFUSE) {
    const said = worthRemembering({ question, answer });
    assert.equal(said.keep, false, `${question} was kept`);
    assert.match(said.why, /personal/);
  }
});

/*
 * What somebody is paid, as against what they are asking for: a dropdown of
 * bands is how plenty of forms ask either, and only the second is kept.
 */
test('salary history is refused however it is asked, and expectations are not', () => {
  assert.equal(worthRemembering({ question: 'Current annual salary range', answer: '$120k–$140k' }).keep, false);
  assert.equal(worthRemembering({ question: 'Desired salary range', answer: '$140k–$160k' }).keep, true);
});

/*
 * And the words those patterns are built from, where they are not about
 * anybody. A refusal that fires on "Essex" teaches nobody anything while
 * quietly making an ordinary question get answered by hand every time.
 */
test('the equal-opportunity words do not refuse the ordinary questions they look like', () => {
  for (const question of [
    'Are you comfortable with trans-Atlantic travel?',
    'Which office would you prefer: Essex or Middlesex?',
    'Are you willing to relocate to Sussex?',
    'Do you speak Latin or Greek?',
    'Will you require a transfer of your visa?',
  ]) {
    assert.equal(worthRemembering({ question, answer: 'Yes' }).keep, true, `${question} was refused`);
  }
});

/*
 * And the ones whose answer is about the employer rather than the person.
 *
 * "Have you previously been employed by this company?" was on the keep list
 * above, and it is the same words on every form while the answer is not:
 * measured end to end, "Yes" chosen on Acme's form went into the bank and
 * Autofill put it into the same question on Helios's form, a false statement
 * that the applicant had worked there. Every one of these is asked in words
 * that do not change between employers, which is what makes the bank's match
 * confident, and whose answer changes with the employer, which is what makes
 * that match wrong.
 */
const ABOUT_THE_EMPLOYER = [
  ['Have you previously been employed by this company?', 'Yes'],
  ['Have you ever been employed with us?', 'Yes'],
  ['Have you ever worked for Acme before?', 'Yes'],
  // Workday's own wording.
  ['Have you previously worked for Helios or any of its subsidiaries?', 'No'],
  ['Have you ever worked here?', 'Yes'],
  ['Have you interned at this company before?', 'Yes'],
  ['Are you a current or former employee of Acme?', 'Yes'],
  ['Are you a current employee?', 'No'],
  ['Are you an ex-employee?', 'No'],
  ['Do you have any relatives currently employed by Acme?', 'Yes'],
  ['Do you have family members who work here?', 'Yes'],
  ['Are you related to anyone who works for this company?', 'Yes'],
  ['Do you know anyone who currently works at Acme?', 'Yes'],
  ['Have you applied to Acme before?', 'Yes'],
  ['Have you previously applied for a position with us?', 'Yes'],
  ['Have you ever interviewed with us?', 'Yes'],
  ['Were you referred by a current employee?', 'Yes'],
  ['Were you referred to this position?', 'Yes'],
];

test('an answer that depends on the employer is not carried to the next one', () => {
  for (const [question, answer] of ABOUT_THE_EMPLOYER) {
    const said = worthRemembering({ question, answer });
    assert.equal(said.keep, false, `${question} was kept`);
    assert.match(said.why, /employer/, question);
  }
});

/*
 * And the questions that look like those and are about the person. The work
 * authorisation question says "work for any employer" and is the most
 * repeated question there is; refusing it would make the bank close to
 * useless.
 */
test('the questions about the person that look like them are still kept', () => {
  for (const question of [
    'Are you legally authorized to work for any employer in the United States?',
    'Have you worked with Kubernetes before?',
    'Have you worked in a regulated industry?',
    'Are you currently employed?',
    'May we contact your current employer?',
    'Are you willing to work in the office three days a week?',
    'How did you hear about this position?',
    'Do you have experience related to payments?',
  ]) {
    assert.equal(worthRemembering({ question, answer: 'Yes' }).keep, true, `${question} was refused`);
  }
});

/*
 * The equal-opportunity answers are refused even though they are the most
 * repeated questions on any application, and that is deliberate. "Decline to
 * self-identify" is a choice somebody makes about a particular employer, and a
 * tool that pre-answers it has made a declaration on their behalf.
 */
/*
 * Everything ResumeM-M's answer bank refuses, and everything its
 * `redactIdentifiers` takes out, is refused here too — by name, not by
 * accident. Measured against ResumeM-M's `isSensitiveQuestion`: "Social
 * Insurance Number", "NI No.", "ITIN", "Credit card", "Driver’s License" and
 * the national numbers by their own names were all kept here, so the card
 * said "will be kept" and the server then declined, or (for the ones the
 * server does not refuse either) the bank held them. The short ones were
 * refused only for being short, the wrong reason; the reason is pinned.
 */
const REFUSED_BY_THE_SERVER = [
  'Social Insurance Number',
  'NI No.',
  'NI #',
  'ITIN',
  'Credit card',
  'Debit card on file',
  'Driver’s License Number',
  "Mother’s maiden name",
  'Aadhaar number',
  'Aadhar card number',
  'NRIC',
  'NRIC / FIN',
  'CPF',
  'DNI',
  'NIE',
  'PESEL',
  'BSN',
  'Personnummer',
  'Govt. ID #',
  "Gov't ID",
  'Government-issued ID number',
  /*
   * Where somebody was born, and a Medicare or Medicaid number, which neither
   * side refused: "Place of birth" missed `date of birth`, "Birthplace"
   * missed `birth date`, and neither `medical` nor `health` is in "Medicare".
   */
  'Place of birth',
  'Country of birth',
  'City of birth',
  'Birthplace',
  'Birth place',
  'Birth country',
  'Where were you born?',
  'Medicare number',
  'Medicaid number',
  'Medicare/Medicaid number',
];

test('a question about work that says "birth" or "Medicare" is still kept', () => {
  for (const question of ['Are you willing to give birth to new ideas?', 'Have you worked with Medicare claims data?']) {
    assert.equal(neverRemember(question), false, question);
  }
});

test('every identifier the server refuses or redacts is refused as personal', () => {
  for (const question of REFUSED_BY_THE_SERVER) {
    const said = worthRemembering({ question, answer: 'Yes' });
    assert.equal(said.keep, false, `${question} was kept`);
    assert.match(said.why, /personal/, `${question}: ${said.why}`);
    assert.equal(mayRememberTyped(question, '').keep, false, `${question} was kept when typed`);
  }
});

/*
 * And the answers the server refuses or redacts anywhere in them, not only as
 * the whole answer. Each of these was kept here as a chosen answer.
 */
test('an identifier inside an answer, or after its label, is refused', () => {
  for (const answer of [
    'SSN 123-45-6789',
    'SSN 123456789',
    'GB82 WEST 1234 5698 7654 32',
    'GB82WEST12345698765432',
    'AB 12 34 56 C',
    'AB123456C',
    'Card 4111-1111-1111-1111 exp 04/29',
    'DOB: 04/02/1999',
    'Born on April 2nd, 1999',
    'Apr. 2, 1999',
    '2nd April 1999',
    'Passport # X1234567',
    'Aadhaar 1234 5678 9012',
  ]) {
    assert.equal(looksPrivate(answer), true, answer);
    assert.equal(worthRemembering({ question: 'Question 88213 of this form', answer }).keep, false, answer);
  }
  // And what only looks like one is still an answer.
  for (const answer of ['May 2026', 'Class of 2019', 'ISO 27001', 'Python 3.12', 'Passport holder', "A driver's license and a car"]) {
    assert.equal(looksPrivate(answer), false, answer);
  }
  // The short names are the forms' capitals, not the words they spell.
  for (const question of ['Do you have a fin-tech background?', 'Which finance tools have you used?', 'Where did you study (e.g. DNIPRO University)?']) {
    assert.equal(neverRemember(question), false, question);
  }
});

test('the refusal says which kind of refusal it is', () => {
  assert.match(worthRemembering({ question: 'Date of birth', answer: 'April' }).why, /this one is personal/);
  // Unlabelled, so the answer's own shape is the only thing to go on.
  assert.match(worthRemembering({ question: 'Question 88213 of this form', answer: '123-45-6789' }).why, /answer looks personal/);
});

/*
 * A word inside another word is not that word. These are the substring
 * matches the boundaries exist to refuse, and a check that fired on them
 * would silently drop ordinary questions while looking like it worked.
 */
test('a word inside another word is not that word', () => {
  // `ssn` is inside "lessons", `dob` inside "doberman", `race` inside
  // "racecar", `age` inside "language". Substring matching refuses all four
  // and teaches nobody anything.
  for (const question of [
    'How many lessons did you teach?',
    'Have you owned a doberman?',
    'Do you have a Racecar Engineering background?',
    'Which programming language do you prefer?',
    'Which management tools have you used?',
  ]) {
    assert.equal(neverRemember(question), false, question);
  }
  // And the words themselves still are those words.
  for (const question of ['Your SSN', 'DOB', 'Race / Ethnicity', 'Your age']) {
    assert.equal(neverRemember(question), true, question);
  }
});

test('an answer that looks like a secret is refused whatever it was asked by', () => {
  for (const answer of ['123-45-6789', '123456789', '4111 1111 1111 1111', '1999-04-02', '2 April 1999', 'April 2, 1999']) {
    assert.equal(looksPrivate(answer), true, answer);
  }
});

test('and an ordinary answer is not', () => {
  for (const answer of ['Yes', 'No', 'Massachusetts', 'LinkedIn', "Bachelor's degree", '5+ years', 'they/them']) {
    assert.equal(looksPrivate(answer), false, answer);
  }
});

/*
 * Nothing is kept that could not be found again. The whole value is that the
 * next form asks something recognisably the same question, and two words
 * cannot be recognised — a bank full of "State" rows helps nobody.
 */
test('a question too short to recognise again is not kept', () => {
  assert.equal(worthRemembering({ question: 'State', answer: 'Massachusetts' }).keep, false);
  assert.equal(worthRemembering({ question: 'Which state do you live in?', answer: 'Massachusetts' }).keep, true);
});

/*
 * And nothing that was written rather than chosen. The caller only ever
 * offers chosen options — that scope is most of the safety here, because no
 * form offers a social security number in a dropdown — and this is the second
 * lock on the same door.
 */
test('prose is not a chosen option', () => {
  const essay = 'I want to work here because '.repeat(8);
  assert.equal(worthRemembering({ question: 'Why do you want to work here?', answer: essay }).keep, false);
});

test('nothing is kept from an empty question or an empty answer', () => {
  assert.equal(worthRemembering({ question: '', answer: 'Yes' }).keep, false);
  assert.equal(worthRemembering({ question: 'Are you authorized to work?', answer: '' }).keep, false);
  assert.equal(worthRemembering({}).keep, false);
  assert.equal(worthRemembering().keep, false);
});

/* ---------------------------- What was typed ---------------------------- */

/*
 * The short boxes the walk in tests/reusing.mjs typed into on one form and
 * found empty again on the next, before these were kept. Each is typed on
 * every application and none is anybody's secret.
 */
const TYPED_KEEP = [
  ['How did you hear about us?', 'A friend on the payments team'],
  ['Earliest start date', 'Two weeks after an offer'],
  ['Expected salary', '$150,000 base'],
  ['What are your salary expectations?', '140-160k'],
  ['Current employer', 'Northwind Analytics'],
  ['Preferred first name', 'Jay'],
  ['Portfolio link', 'https://example.dev/work'],
  ['Are you 18 or older?', 'Yes'],
  ['Willing to relocate?', 'Yes, within the US'],
  ['What is your notice period?', 'Four weeks'],
];

test('the short answers typed on every application are kept', () => {
  for (const [question, answer] of TYPED_KEEP) {
    const said = worthRememberingTyped({ question, answer, company: 'Helios Systems' });
    assert.equal(said.keep, true, `${question} was refused: ${said.why}`);
  }
});

/*
 * And what a box can hold that a dropdown cannot. Every one of these is a
 * one-line box on a real form, and each is refused with the reason the card
 * would give — the reason matters, because "too short" said about a date of
 * birth invites somebody to relax the wrong rule.
 */
const TYPED_REFUSE = [
  ['Social Security Number', '123-45-6789', /personal/],
  ['National ID number', 'AB1234567', /personal/],
  ['Government ID', 'X99812', /personal/],
  ['Date of birth', 'April 2 1999', /personal/],
  ['Password', 'hunter22', /personal/],
  ['Gender (optional)', 'Decline to self-identify', /personal/],
  ['Race / ethnicity', 'Decline to self-identify', /personal/],
  ['Are you a protected veteran?', 'No', /personal/],
  ['Do you have a disability?', 'No', /personal/],
  // Salary history, not what somebody is asking for.
  ['Current salary', '$128,000', /personal/],
  ['What is your current base compensation?', '$128,000', /personal/],
  ['Salary history', '$120k, $128k', /personal/],
  ['What do you currently earn?', '$128,000', /personal/],
  // Somebody else's details.
  ['Reference name', 'Pat Example', /somebody else/],
  ['Reference phone number', 'Pat', /somebody else/],
  ["Your manager's name", 'Pat Example', /somebody else/],
  ['Emergency contact', 'Sam Example', /somebody else/],
  ['Who referred you?', 'Pat Example', /somebody else/],
  // About this employer, named or not.
  ['What makes Helios Systems the right next step for you?', 'Your payments work', /employer/],
  ['Do you use Helios products today?', 'Yes, daily', /employer/],
  ['Why do you want to join us?', 'The mission', /employer/],
  ['What do you know about our company?', 'Payments', /employer/],
  ['Have you worked for us before?', 'No', /employer/],
  ['Anything else we should know?', 'I met your Helios team at a meetup', /employer/],
  // Contact details and identifiers in the answer, whatever the question.
  ['Anything else we should know?', 'Reach me at pat@example.com', /personal/],
  ['Anything else we should know?', 'Call (555) 010-0100 after six', /personal/],
  ['Anything else we should know?', '123456789', /personal/],
  // And an essay, typed into a line.
  ['Anything else we should know?', 'I have been following the payments work for some time now and would love to help.', /line/],
];

test('and what is personal, somebody else’s, about this employer or writing is refused, and says which', () => {
  for (const [question, answer, why] of TYPED_REFUSE) {
    const said = worthRememberingTyped({ question, answer, company: 'Helios Systems' });
    assert.equal(said.keep, false, `${question} = ${answer} was kept`);
    assert.match(said.why, why, `${question} = ${answer}: ${said.why}`);
  }
});

test('a question is refused before the bank is asked about it', () => {
  assert.equal(mayRememberTyped('Reference email', 'Helios').keep, false);
  assert.equal(mayRememberTyped('How did you hear about Helios?', 'Helios').keep, false);
  assert.equal(mayRememberTyped('How did you hear about us?', 'Helios').keep, true);
});

/*
 * The employer's name as people write it, and not as a fragment of another
 * word. "Block" the company is not "blocker" the problem.
 */
test('the employer is recognised by its name, and by its first word, as whole words', () => {
  assert.equal(namesThem('Why Helios?', 'Helios Systems, Inc.'), true);
  assert.equal(namesThem('Do you use Helios Systems today?', 'Helios Systems, Inc.'), true);
  assert.equal(namesThem('What was your biggest blocker?', 'Block'), false);
  assert.equal(namesThem('What drew you to The Trade Desk?', 'The Trade Desk'), true);
  assert.equal(namesThem('What is the best thing you have built?', 'The Trade Desk'), false);
  assert.equal(namesThem('Anything', ''), false);
});

/*
 * A link is one word however long it is; a line of prose is not.
 */
test('a long link is still a line', () => {
  const link = `https://www.behance.net/gallery/123456789/${'a-project-name-'.repeat(4)}`;
  assert.equal(worthRememberingTyped({ question: 'Portfolio link', answer: link }).keep, true);
});
