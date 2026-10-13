/**
 * What a pressed control is called, as it is written into the tracker.
 *
 * The label of the button that sent an application becomes the history note
 * ("\"Submit\" was pressed on the page"), so it has to be a line a person
 * reads — not the markup's indentation.
 *
 *   node --test tests/naming.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nameOf } from '../src/shared/sending.js';

const control = ({ tagName = 'BUTTON', attrs = {}, value, textContent }) => ({
  tagName,
  value,
  textContent,
  getAttribute: (name) => attrs[name] ?? null,
});

describe('nameOf', () => {
  it('folds the whitespace of a label laid out over several lines', () => {
    const button = control({ textContent: '\n  Submit your application\n    \n      \n    ' });
    assert.equal(nameOf(button), 'Submit your application');
  });

  it('keeps one space between words split across elements', () => {
    const button = control({ textContent: 'Submit\n        \n   application' });
    assert.equal(nameOf(button), 'Submit application');
  });

  it('prefers the aria-label, folded the same way', () => {
    const button = control({ attrs: { 'aria-label': ' Send\n application ' }, textContent: 'ignored' });
    assert.equal(nameOf(button), 'Send application');
  });

  it('reads an input by its value', () => {
    assert.equal(nameOf(control({ tagName: 'INPUT', value: 'Apply  Now' })), 'Apply Now');
  });

  it('says nothing for nothing', () => {
    assert.equal(nameOf(undefined), '');
  });
});
