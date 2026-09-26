/**
 * The card and the placing must read a filename the same way.
 *
 * There are two classifiers, by design: `kindOf` in `src/content/attach.js`,
 * which decides which upload box a file goes in, and `documentKind` in
 * `src/content/card.js`, which decides what a chip says it is and which files
 * a drag of that chip hands over. The card is a plain content script with no
 * imports — it is injected on every page the extension offers on, and attach.js
 * is loaded only when something is actually being placed — so the vocabulary is
 * a copy rather than an import, and a copy is a thing that drifts.
 *
 * It had drifted. The card stripped `._-` to spaces before matching and
 * attach.js did not, so `\bresume\b` could not see `resume_streamly`: the card
 * drew `Resume_Streamly.pdf` a resume chip, said "this form asks for it", and
 * the placing called the same file `other` and reported it homeless on a form
 * with an empty resume box. Underscores are not exotic — they are what a
 * person's own files are named, which is exactly the half of the folder the
 * store did not write.
 *
 * Pure, so it is a node test. `documentKind` is not exported by a script that
 * exports nothing, so it is lifted out of the source: the point is to compare
 * the two texts, and a copy that has been edited away from this one should
 * fail here rather than on a form.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { kindOf, wordsOf } from '../src/content/attach.js';

/** The card's classifier, lifted out of a script with no exports. */
function cardClassifier() {
  const source = fs.readFileSync(new URL('../src/content/card.js', import.meta.url), 'utf8');
  const cut = (open, close) => {
    const from = source.indexOf(open);
    assert.notEqual(from, -1, `card.js no longer contains ${JSON.stringify(open)}`);
    const to = source.indexOf(close, from);
    assert.notEqual(to, -1, `no ${JSON.stringify(close)} after ${JSON.stringify(open)}`);
    return source.slice(from, to + close.length);
  };
  const kinds = cut('const DOCUMENT_KINDS = {', '\n  };');
  const fn = cut('function documentKind(name) {', '\n  }');
  // If either slice stopped in the wrong place this throws, which is the
  // behaviour wanted: a lift that silently returns something else would make
  // every assertion below meaningless.
  return new Function(`${kinds}\n${fn}\nreturn documentKind;`)();
}

const documentKind = cardClassifier();

/*
 * Every name is one somebody's folder actually holds: what `bundleFileName`
 * writes, and what a person's own transcript or portfolio is called when it
 * came off a university portal or out of a word processor.
 */
const NAMES = [
  ['Morgan-Testwell-Resume.pdf', 'resume'],
  ['Morgan-Testwell-Resume-Streamly.pdf', 'resume'],
  ['Resume_Streamly.pdf', 'resume'],
  ['resume.pdf', 'resume'],
  ['Morgan Testwell CV.pdf', 'resume'],
  ['Curriculum Vitae.pdf', 'resume'],
  ['résumé.pdf', 'resume'],
  ['resumé.pdf', 'resume'],
  ['Morgan-Testwell-Cover-Letter.pdf', 'letter'],
  ['Morgan_Testwell_Cover_Letter.pdf', 'letter'],
  ['covering letter.docx', 'letter'],
  ['Transcript.pdf', 'transcript'],
  ['Academic_Transcript.pdf', 'transcript'],
  ['UVA Academic Record.pdf', 'transcript'],
  ['Morgan-Testwell-Answers.pdf', 'other'],
  ['something-else.pdf', 'other'],
  ['Portfolio.pdf', 'portfolio'],
  ['writing_sample.pdf', 'portfolio'],
];

test('the lift got the card, not something that looks like it', () => {
  // Cheapest possible proof that the two slices are the real ones: the name
  // the folder writes for every application reads as a resume.
  assert.equal(documentKind('Morgan-Testwell-Resume.pdf'), 'resume');
  assert.equal(documentKind('something-else.pdf'), 'other');
});

test('both classifiers read every name the same way', () => {
  for (const [name, kind] of NAMES) {
    assert.equal(kindOf(name), kind, `attach.js reads ${name} as ${kindOf(name)}`);
    assert.equal(documentKind(name), kind, `card.js reads ${name} as ${documentKind(name)}`);
  }
});

/*
 * The two things the shared normalisation is for, stated on their own so that
 * a failure names the cause rather than a filename.
 */
test('a separator is not part of a word', () => {
  assert.equal(wordsOf('Resume_Streamly.pdf'), 'resume streamly pdf');
  assert.equal(wordsOf('Cover-Letter_v2.pdf'), 'cover letter v2 pdf');
});

test('an accent is not part of a word either', () => {
  assert.equal(wordsOf('Résumé.pdf'), 'resume pdf');
  // The é is what `\b` cannot see past; both spellings people actually use.
  assert.equal(kindOf('Résumé.pdf'), 'resume');
  assert.equal(kindOf('Resumé.pdf'), 'resume');
});

/*
 * And the vocabularies themselves, not just the names above. A kind the card
 * knows and the placing does not means a chip the card marks "this form asks
 * for it" and the placing then has no box for.
 */
test('neither knows a kind the other does not, in the same order', () => {
  const read = (file, pattern) => {
    const source = fs.readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
    const found = [...source.matchAll(pattern)].map((m) => m[1]);
    assert.ok(found.length > 0, `no kinds found in ${file}`);
    return found;
  };
  /*
   * In order, because the order is part of the meaning: `boxFor` hands a box
   * labelled "Resume or Cover Letter" to whichever kind comes first, and the
   * card's "this form also asks for" sentence lists them in the same order.
   */
  assert.deepEqual(
    read('content/card.js', /^\s{4}(\w+): \{ test:/gm),
    read('content/attach.js', /^\s{2}(\w+): \/\\b\(/gm),
  );
});
