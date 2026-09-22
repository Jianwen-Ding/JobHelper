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
import { looksPrivate, neverRemember, worthRemembering } from '../src/shared/remembering.js';

/* The questions applying actually repeats, which are the reason for any of this. */
const KEEP = [
  ['Are you legally authorized to work in the United States?', 'Yes'],
  ['Will you now or in the future require sponsorship for employment visa status?', 'No'],
  ['How did you hear about this position?', 'LinkedIn'],
  ['Have you previously been employed by this company?', 'No'],
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
];

test('and the ones that are nobody else’s business are refused', () => {
  for (const [question, answer] of REFUSE) {
    const said = worthRemembering({ question, answer });
    assert.equal(said.keep, false, `${question} was kept`);
    assert.match(said.why, /personal/);
  }
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
 * The equal-opportunity answers are refused even though they are the most
 * repeated questions on any application, and that is deliberate. "Decline to
 * self-identify" is a choice somebody makes about a particular employer, and a
 * tool that pre-answers it has made a declaration on their behalf.
 */
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
