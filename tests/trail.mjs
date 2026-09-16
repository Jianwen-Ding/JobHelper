/**
 * The rules for "is this the same application", tested against the addresses
 * real systems actually use.
 *
 * This is the judgement whose mistakes are invisible: joining two postings
 * produces a cover letter addressed to one company and written from another,
 * and nothing about it looks wrong until a human reads it. So the cases that
 * must NOT join get as much room here as the ones that must.
 *
 *   node --test tests/trail.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPECTATION_MS,
  lighten,
  relatedPath,
  sameApplication,
  summarise,
  trimForStorage,
  wasExpected,
} from '../src/shared/trail.js';

const trailOf = (...pages) => ({ pages, at: Date.now() });
const at = (url, company) => ({ url, company });

describe('two addresses on one site', () => {
  it('joins a posting to its own apply page', () => {
    assert.equal(relatedPath('https://jobs.lever.co/vega/8f21', 'https://jobs.lever.co/vega/8f21/apply'), true);
    assert.equal(
      relatedPath('https://jobs.ashbyhq.com/lyra/4c2', 'https://jobs.ashbyhq.com/lyra/4c2/application'),
      true,
    );
  });

  it('does not join two different jobs at the same company', () => {
    // Both start /streamly, which the first rule here accepted. They are two
    // jobs, and merging them writes one letter from both.
    assert.equal(
      relatedPath('https://boards.greenhouse.io/streamly/jobs/1', 'https://boards.greenhouse.io/streamly/jobs/2'),
      false,
    );
  });

  it('does not join two different jobs on a board', () => {
    assert.equal(relatedPath('https://linkedin.com/jobs/view/1', 'https://linkedin.com/jobs/view/2'), false);
    assert.equal(relatedPath('https://indeed.com/viewjob?jk=a', 'https://indeed.com/viewjob?jk=b'), true, 'same path, different query');
  });

  it('joins two steps of one form', () => {
    assert.equal(relatedPath('https://x.com/rigel/apply/details', 'https://x.com/rigel/apply/questions'), true);
  });

  it('does not treat the site root as a match for everything', () => {
    assert.equal(relatedPath('https://boards.greenhouse.io/', 'https://boards.greenhouse.io/acme/jobs/3'), false);
  });

  it('ignores a trailing slash, which means nothing', () => {
    assert.equal(relatedPath('https://x.com/vega/8f21/', 'https://x.com/vega/8f21'), true);
  });
});

describe('the click that means apply', () => {
  const trail = { ...trailOf(at('https://acme.com/careers/eng', 'Acme')), expecting: { to: 'https://gh.io/acme/1', at: Date.now() } };

  it('is honoured when the page arrives where the link pointed', () => {
    assert.equal(wasExpected(trail, 'https://gh.io/acme/1'), true);
  });

  it('survives a redirect that lands nearby', () => {
    assert.equal(wasExpected(trail, 'https://gh.io/acme/1/apply'), true);
  });

  it('does not stretch to another host', () => {
    assert.equal(wasExpected(trail, 'https://elsewhere.com/acme/1'), false);
  });

  it('expires, so a click an hour ago does not join an unrelated page', () => {
    assert.equal(wasExpected(trail, 'https://gh.io/acme/1', Date.now() + EXPECTATION_MS + 1), false);
  });
});

describe('is this the same application', () => {
  it('starts a trail with whatever page is first', () => {
    assert.equal(sameApplication({ pages: [] }, at('https://x.com/a')), true);
  });

  it('joins a careers page to the tracking system it sends you to', () => {
    const trail = trailOf(at('https://acme.com/careers/eng', 'Acme'));
    const page = { url: 'https://boards.greenhouse.io/acme/jobs/1', referrerHost: 'acme.com' };
    assert.equal(sameApplication(trail, page), true);
  });

  it('refuses a different company even when everything else lines up', () => {
    const trail = trailOf(at('https://boards.greenhouse.io/acme/jobs/1', 'Acme'));
    const page = { url: 'https://boards.greenhouse.io/acme/jobs/1/apply', company: 'Northwind' };
    assert.equal(sameApplication(trail, page), false);
  });

  it('refuses another posting on the same board', () => {
    // The reported shape: two postings open, and the second one inheriting the
    // first one's description.
    const trail = trailOf(at('https://jobs.lever.co/vega/8f21', 'Vega'));
    assert.equal(sameApplication(trail, { url: 'https://jobs.lever.co/lyra/4c2' }), false);
  });

  it('refuses a page it merely happens to share a host with', () => {
    const trail = trailOf(at('https://acme.com/careers/eng', 'Acme'));
    assert.equal(sameApplication(trail, { url: 'https://acme.com/blog/our-values' }), false);
  });

  it('refuses a cross-host page with nothing tying it to the trail', () => {
    const trail = trailOf(at('https://acme.com/careers/eng', 'Acme'));
    assert.equal(sameApplication(trail, { url: 'https://elsewhere.com/jobs/9' }), false);
  });

  it('lets the click override the host rules entirely', () => {
    const trail = {
      ...trailOf(at('https://acme.com/careers/eng', 'Acme')),
      expecting: { to: 'https://elsewhere.com/jobs/9', at: Date.now() },
    };
    assert.equal(sameApplication(trail, { url: 'https://elsewhere.com/jobs/9' }), true);
  });

  it('says no to a page with no address at all', () => {
    assert.equal(sameApplication(trailOf(at('https://x.com/a')), {}), false);
  });
});

describe('what the card is told', () => {
  it('keeps the page text and the work to itself', () => {
    const trail = {
      pages: [{ url: 'https://x.com/a', title: 'A', html: 'x'.repeat(50) }],
      work: { spec: { id: 'secret' } },
      expecting: { to: 'https://x.com/b', at: 1 },
    };
    const shown = summarise(trail);

    assert.equal(shown.work, undefined);
    assert.equal(shown.expecting, undefined);
    assert.equal(shown.pages[0].html, undefined);
    assert.equal(shown.pages[0].chars, 50);
    assert.equal(shown.pages[0].title, 'A');
  });

  it('is unbothered by a trail with no pages', () => {
    assert.deepEqual(summarise({ pages: [] }).pages, []);
  });
});

describe('what is worth keeping of a page', () => {
  const LD = '<script type="application/ld+json">{"@type":"JobPosting"}</script>';

  it('keeps the structured posting data, which lives in a script tag', () => {
    assert.ok(trimForStorage(`<html>${LD}</html>`).includes('JobPosting'));
  });

  it('drops the bundle, which is most of a page and none of the posting', () => {
    const page = `<html>${LD}<script>${'var x=1;'.repeat(10_000)}</script><p>The role</p></html>`;
    const kept = trimForStorage(page);

    assert.ok(kept.includes('The role'));
    assert.ok(kept.includes('JobPosting'));
    assert.ok(!kept.includes('var x=1'));
    assert.ok(kept.length < page.length / 10);
  });

  it('drops styles, inline svg and comments too', () => {
    const page = '<style>.a{}</style><svg><path/></svg><!-- note --><p>Kept</p>';
    assert.equal(trimForStorage(page).trim(), '<p>Kept</p>');
  });

  it('still obeys a hard limit, for a page that is all prose', () => {
    assert.equal(trimForStorage('<p>' + 'word '.repeat(200_000), 1000).length, 1000);
  });

  it('is unbothered by nothing at all', () => {
    assert.equal(trimForStorage(undefined), '');
  });
});

describe('carrying less when there is no room', () => {
  const trail = {
    pages: [
      { url: 'a', html: 'aaa' },
      { url: 'b', html: 'bbb' },
      { url: 'c', html: 'ccc' },
    ],
  };

  it('gives up the oldest pages first, since the newest are the ones in use', () => {
    const lighter = lighten(trail);
    assert.deepEqual(lighter.pages.map((p) => p.html), ['', 'bbb', 'ccc']);
  });

  it('can give up all of it and still name every page', () => {
    const bare = lighten(trail, 0);
    assert.deepEqual(bare.pages.map((p) => p.html), ['', '', '']);
    assert.deepEqual(bare.pages.map((p) => p.url), ['a', 'b', 'c']);
  });

  it('leaves a short trail alone', () => {
    assert.deepEqual(lighten({ pages: [{ url: 'a', html: 'aaa' }] }).pages[0].html, 'aaa');
  });
});
