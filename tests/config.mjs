/**
 * The one setting somebody types by hand, and what is made of it.
 *
 * Everything else in this extension is a checkbox or a picker. The server
 * address is a text box, and it took whatever was typed and stored it
 * verbatim — so three ordinary slips each became a problem that pointed
 * somewhere else: at the server for being closed when it was open, at a
 * placeholder that looked like a default in force when it was not, and at a
 * Chrome error page where "Open editor" should have been.
 *
 *   node --test tests/config.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULTS, normaliseServerUrl } from '../src/shared/config.js';

describe('the server address, as typed', () => {
  it('leaves an address that is already one alone', () => {
    assert.equal(normaliseServerUrl('http://127.0.0.1:4600'), 'http://127.0.0.1:4600');
    assert.equal(normaliseServerUrl('https://rmm.example:8443'), 'https://rmm.example:8443');
  });

  /*
   * The commonest slip there is. Stored as typed, every fetch failed, and the
   * popup said "ResumeM-M is not open. Start it, then try again." about a
   * server that was open — an instruction that cannot work, pointing away
   * from the cause.
   */
  it('adds the scheme somebody did not type', () => {
    assert.equal(normaliseServerUrl('localhost:4600'), 'http://localhost:4600');
    assert.equal(normaliseServerUrl('127.0.0.1:4600'), 'http://127.0.0.1:4600');
  });

  /*
   * `chrome.storage.sync.get(DEFAULTS)` returns a stored value whenever the
   * key is present, so an emptied box beat the default for ever — while the
   * greyed-out placeholder read exactly as though the default were in force.
   * And the empty string reached `chrome.tabs.create`, so "Open editor"
   * opened chrome-error://chromewebdata/ rather than saying anything.
   */
  it('reads an emptied box as "the default", which is what it looks like', () => {
    assert.equal(normaliseServerUrl(''), DEFAULTS.serverUrl);
    assert.equal(normaliseServerUrl('   '), DEFAULTS.serverUrl);
    assert.equal(normaliseServerUrl(undefined), DEFAULTS.serverUrl);
    assert.equal(normaliseServerUrl(null), DEFAULTS.serverUrl);
  });

  it('trims what a paste brought with it, and a trailing slash', () => {
    assert.equal(normaliseServerUrl('  http://127.0.0.1:4600  '), 'http://127.0.0.1:4600');
    assert.equal(normaliseServerUrl('http://127.0.0.1:4600/'), 'http://127.0.0.1:4600');
    assert.equal(normaliseServerUrl('http://127.0.0.1:4600///'), 'http://127.0.0.1:4600');
  });

  /*
   * Somewhere real beats honouring a typo, because every caller of this
   * either fetches it or opens it in a tab. A value that cannot be parsed
   * even with a scheme in front of it is not an address at all.
   */
  it('falls back to somewhere real when it is not an address at all', () => {
    assert.equal(normaliseServerUrl('://'), DEFAULTS.serverUrl);
    assert.equal(normaliseServerUrl('http://'), DEFAULTS.serverUrl);
  });

  /*
   * A path is a mistake this cannot fix — `/api` appended to every request
   * would 404 — but it is a parseable address, so it is kept and the
   * connection line reports what the server said. Guessing which part of
   * somebody's URL was surplus is worse than telling them it did not work.
   */
  it('keeps a path rather than guessing which part was surplus', () => {
    assert.equal(normaliseServerUrl('http://127.0.0.1:4600/api'), 'http://127.0.0.1:4600/api');
  });
});
