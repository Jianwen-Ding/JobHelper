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
import { DEFAULTS, getSettings, normaliseServerUrl } from '../src/shared/config.js';

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

  /*
   * A scheme is not the same as a scheme this can be fetched from.
   *
   * The test was for *a* scheme, so anything with `://` in it went straight
   * into storage: `ftp://127.0.0.1:4600`, `file:///etc/passwd`,
   * `chrome://settings`. The box then echoed it back as what is in force, the
   * status line blamed a server that was running, and both buttons offering to
   * fix it — "Open editor" and the one in the status line — call
   * `chrome.tabs.create`, which rejects such a URL. The second closes the
   * popup on its way to doing nothing, so the only way out of the window
   * simply vanished.
   */
  it('refuses a scheme nothing here could fetch or open', () => {
    for (const said of [
      'ftp://127.0.0.1:4600',
      'file:///etc/passwd',
      'chrome://settings',
      'ws://127.0.0.1:4600',
      'javascript://x%0aalert(1)',
      'data:text/html,hi',
    ]) {
      assert.equal(normaliseServerUrl(said), DEFAULTS.serverUrl, said);
    }
  });

  it('and still takes the two it can', () => {
    // The guard has to leave the ordinary cases exactly as they were.
    assert.equal(normaliseServerUrl('HTTP://127.0.0.1:4600'), 'HTTP://127.0.0.1:4600');
    assert.equal(normaliseServerUrl('https://rmm.example'), 'https://rmm.example');
    assert.equal(normaliseServerUrl('[::1]:4600'), 'http://[::1]:4600');
  });
});

/*
 * Why seeding the defaults into storage on install was not just unnecessary
 * but harmful.
 *
 * `getSettings` passes DEFAULTS to `chrome.storage.sync.get`, which is the
 * API's way of saying "these are the fallbacks" — so a key that is simply
 * absent already reads as its default. Writing them in on install therefore
 * bought nothing, and cost the ability to ever improve one: a stored value
 * wins, so every default was pinned to whatever version somebody first
 * installed. `minScore` went 4 → 3 precisely so the card would stop being
 * absent on application forms, and that fix reached new installs only.
 *
 * Tested with a stand-in for chrome.storage rather than a browser, because
 * the real `onInstalled` does not fire for an unpacked extension loaded by
 * the harness — a browser test of this passes whichever version is in place,
 * which is worth less than nothing.
 */
describe('a setting nobody has chosen', () => {
  const withStorage = async (stored, fn) => {
    const had = globalThis.chrome;
    globalThis.chrome = {
      storage: {
        sync: {
          async get(keys) {
            // The shape `getSettings` relies on: an object of key → fallback.
            const out = {};
            for (const [key, fallback] of Object.entries(keys)) {
              out[key] = key in stored ? stored[key] : fallback;
            }
            return out;
          },
        },
      },
    };
    try {
      return await fn();
    } finally {
      globalThis.chrome = had;
    }
  };

  it('reads as the shipped default when storage does not hold it', async () => {
    const settings = await withStorage({}, () => getSettings());
    assert.equal(settings.minScore, DEFAULTS.minScore);
    assert.equal(settings.serverUrl, DEFAULTS.serverUrl);
  });

  /*
   * And the half that made seeding harmful: a stored copy wins, for ever.
   * That is correct for a setting somebody chose and wrong for one that was
   * only ever written in on their behalf — which is why the install step no
   * longer writes any of them, and clears the one key that has no control.
   */
  it('is overridden by a stored copy, which is what pinned it', async () => {
    const settings = await withStorage({ minScore: 4 }, () => getSettings());
    assert.equal(settings.minScore, 4);
    assert.notEqual(DEFAULTS.minScore, 4, 'the shipped default has moved on, and the stored copy still wins');
  });
});
