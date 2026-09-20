/**
 * The sites nothing is ever offered on without being asked.
 *
 * Pure, so it is a node test rather than a browser one: the list and the
 * matching are the whole of it, and the part that can be wrong is whether
 * `reddit.com` covers `old.reddit.com` without also covering `notreddit.com`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { NEVER_OFFER, hostOf, neverOffer, under } from '../src/shared/sites.js';

test('a bare name covers the site and everything under it', () => {
  assert.equal(neverOffer('https://reddit.com/r/csMajors/comments/abc'), true);
  assert.equal(neverOffer('https://www.reddit.com/r/csMajors'), true);
  assert.equal(neverOffer('https://old.reddit.com/r/csMajors'), true);
  assert.equal(neverOffer('https://np.reddit.com/r/csMajors'), true);
});

test('and nothing that merely ends with the same letters', () => {
  // `endsWith` alone says yes to both of these, and a check that is wrong in
  // the direction of silence is the one kind this must not be.
  assert.equal(neverOffer('https://notreddit.com/jobs/123'), false);
  assert.equal(neverOffer('https://myx.com/careers'), false);
  assert.equal(under('notreddit.com', 'reddit.com'), false);
  assert.equal(under('reddit.com.jobs.example.org', 'reddit.com'), false);
});

test('the job boards that happen to be social networks are not on it', () => {
  // LinkedIn is a network by any definition and one of the largest job boards
  // in the world. Muting it would be muting the tool.
  assert.equal(neverOffer('https://www.linkedin.com/jobs/view/123456'), false);
  assert.equal(NEVER_OFFER.some((n) => n.includes('linkedin')), false);
  for (const board of ['indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'wellfound.com', 'greenhouse.io']) {
    assert.equal(NEVER_OFFER.includes(board), false, `${board} must not be on the list`);
  }
});

test('an ordinary posting host is not on it', () => {
  assert.equal(neverOffer('https://boards.greenhouse.io/helios/jobs/4012'), false);
  assert.equal(neverOffer('https://helios.com/careers/platform-engineer'), false);
  assert.equal(neverOffer('http://127.0.0.1:4600/anything'), false);
});

test('something that is not an address is not a site to refuse', () => {
  // A content script can be handed `about:blank`, a `data:` url or an empty
  // string. None of those is one of these sites, and treating an unparseable
  // address as "never offer" would be silence on pages nobody listed.
  assert.equal(neverOffer(''), false);
  assert.equal(neverOffer('not a url'), false);
  assert.equal(neverOffer(undefined), false);
  assert.equal(hostOf('about:blank'), '');
});

test('hostOf drops the www and the case, which is what the list is written in', () => {
  assert.equal(hostOf('https://WWW.Reddit.COM/r/x'), 'reddit.com');
  assert.equal(hostOf('https://m.facebook.com/jobs'), 'm.facebook.com');
});

test('every entry is a bare host, so `under` can do the matching', () => {
  for (const name of NEVER_OFFER) {
    assert.match(name, /^[a-z0-9.-]+\.[a-z]{2,}$/, `${name} should be a bare host`);
    assert.equal(name, name.toLowerCase());
    assert.equal(name.startsWith('www.'), false, `${name} should not carry a www`);
  }
  // And no duplicates, which would be a list nobody had read.
  assert.equal(new Set(NEVER_OFFER).size, NEVER_OFFER.length);
});
