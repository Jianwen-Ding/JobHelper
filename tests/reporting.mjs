/**
 * What the card says after it has put files into a form.
 *
 * `describeAttach` is the only account of a press that happened somewhere off
 * screen — the boxes are down the page, the card is in the corner, and this
 * one sentence is what tells the person whether to go and look. It has to be
 * true about every file it names, because the whole point of it is to be
 * believed instead of the form being re-read.
 *
 * Pure, so it is a node test. It lives inside card.js's closure and card.js is
 * a content script that exports nothing, so it is lifted out of the source the
 * way tests/documents.mjs lifts `documentKind` — see there.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

function lifted() {
  const source = fs.readFileSync(new URL('../src/content/card.js', import.meta.url), 'utf8');
  const open = '  function describeAttach(r) {';
  const from = source.indexOf(open);
  assert.notEqual(from, -1, 'card.js no longer has a describeAttach');
  const to = source.indexOf('\n  }', from);
  assert.notEqual(to, -1, 'describeAttach does not end where expected');
  return new Function(`${source.slice(from, to + 4)}\nreturn describeAttach;`)();
}

const describeAttach = lifted();

test('the lift got describeAttach, not something that looks like it', () => {
  assert.equal(describeAttach({ nothing: true }), 'Nothing is built yet, so there is nothing to attach.');
  assert.equal(describeAttach({ placed: [], unplaced: [] }), 'Nothing to attach.');
});

test('a file that went in is said to have gone in', () => {
  const said = describeAttach({ placed: [{ name: 'Morgan-Testwell-Resume.pdf' }], unplaced: [] });
  assert.match(said, /^Attached Morgan-Testwell-Resume\.pdf\.$/);
});

/*
 * A drop is not an attachment. `input.files` can be read back; a drop event is
 * a thing that happened, and a page that ignored the file looks the same as
 * one that uploaded it.
 */
test('a drop is not claimed as an attachment', () => {
  const said = describeAttach({
    placed: [{ name: 'Morgan-Testwell-Resume.pdf', sure: false }],
    unplaced: [],
  });
  assert.doesNotMatch(said, /Attached/);
  assert.match(said, /drop area/);
  assert.match(said, /check the form before sending/);
});

/*
 * The one this file exists for.
 *
 * `attachFiles` gives each unplaced file its own reason, and one press
 * produces two of them often enough to matter: a resume refused by a box that
 * takes `.doc` only, and a transcript on a form that has no transcript box.
 * The sentence named both files and then printed the first file's reason.
 */
test('each file that had nowhere to go is given its own reason', () => {
  const said = describeAttach({
    placed: [],
    unplaced: [
      { name: 'Morgan-Testwell-Resume.pdf', why: 'this form only takes .doc,.docx there' },
      { name: 'Transcript.pdf', why: 'no box here asks for it' },
    ],
  });
  // Neither file is filed under the other's reason.
  assert.match(said, /Morgan-Testwell-Resume\.pdf had nowhere to go — this form only takes \.doc,\.docx there/);
  assert.match(said, /Transcript\.pdf had nowhere to go — no box here asks for it/);
  assert.doesNotMatch(said, /Transcript\.pdf and Morgan-Testwell-Resume\.pdf|Morgan-Testwell-Resume\.pdf and Transcript\.pdf/);
});

test('and files that failed for the same reason are said once, together', () => {
  const said = describeAttach({
    placed: [],
    unplaced: [
      { name: 'Transcript.pdf', why: 'no box here asks for it' },
      { name: 'Portfolio.pdf', why: 'no box here asks for it' },
    ],
  });
  assert.match(said, /Transcript\.pdf and Portfolio\.pdf had nowhere to go — no box here asks for it/);
  // Said once, not once per file.
  assert.equal(said.match(/had nowhere to go/g).length, 1);
});

test('the folder is offered once however many reasons there were', () => {
  const said = describeAttach({
    placed: [],
    unplaced: [
      { name: 'Morgan-Testwell-Resume.pdf', why: 'this form only takes .doc,.docx there' },
      { name: 'Transcript.pdf', why: 'no box here asks for it' },
    ],
  });
  assert.equal(said.match(/The folder above has everything/g).length, 1);
});

test('what went in and what did not are both said in one sentence', () => {
  const said = describeAttach({
    placed: [{ name: 'Morgan-Testwell-Resume.pdf' }],
    unplaced: [{ name: 'Transcript.pdf', why: 'no box here asks for it' }],
  });
  assert.match(said, /Attached Morgan-Testwell-Resume\.pdf/);
  assert.match(said, /Transcript\.pdf had nowhere to go/);
});
