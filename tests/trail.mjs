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
  keepPages,
  lighten,
  relatedPath,
  sameApplication,
  summarise,
  trimForStorage,
  wasExpected,
  worthKeeping,
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
    // Every Indeed posting is /viewjob; which one it is lives entirely in the
    // query. This asserted `true` — inside a test called "does not join two
    // different jobs" — so reading one posting and then the next wrote the
    // second up as the first.
    assert.equal(relatedPath('https://indeed.com/viewjob?jk=a', 'https://indeed.com/viewjob?jk=b'), false);
  });

  it('ignores the query when it says nothing about which job this is', () => {
    assert.equal(relatedPath('https://x.com/acme/8f21', 'https://x.com/acme/8f21?utm_source=board'), true);
    assert.equal(relatedPath('https://x.com/acme/8f21?gh_jid=9', 'https://x.com/acme/8f21?gh_jid=9&src=ad'), true);
  });

  it('joins two steps of one form', () => {
    assert.equal(relatedPath('https://x.com/rigel/apply/details', 'https://x.com/rigel/apply/questions'), true);
  });

  it('does not treat the site root as a match for everything', () => {
    assert.equal(relatedPath('https://boards.greenhouse.io/', 'https://boards.greenhouse.io/acme/jobs/3'), false);
  });

  it('does not join a board listing to the postings on it', () => {
    // A listing page is a prefix of every job it lists, so accepting any
    // extension joined it to all of them — and through it, each of them to the
    // next. Open two roles from one board and the second was written partly
    // from the first.
    assert.equal(relatedPath('https://boards.greenhouse.io/acme', 'https://boards.greenhouse.io/acme/jobs/1'), false);
    assert.equal(relatedPath('https://linkedin.com/jobs', 'https://linkedin.com/jobs/view/1'), false);
    assert.equal(relatedPath('https://x.com/altair/openings', 'https://x.com/altair/openings/data-scientist'), false);
  });

  it('still joins an apply page that has an id after it', () => {
    assert.equal(relatedPath('https://x.com/vega/8f21', 'https://x.com/vega/8f21/apply/12345'), true);
  });

  /*
   * And from the form itself, which is where somebody actually is when they
   * press Next.
   *
   * "Anything after the step segment is that step's own business" held only
   * while the page being compared against was the posting. The moment the
   * form's own address went into the trail — which it does as soon as you
   * land on it and start typing — the next page of the same form was judged a
   * different application, the letter was parked, and the card came up empty
   * one click into a form half filled in.
   */
  it('joins the next page of a form to the form you are standing on', () => {
    const form = 'https://x.com/jobs/1234/apply';
    for (const next of ['experience', 'eeo', 'voluntary-disclosures', 'documents', '12345']) {
      assert.equal(relatedPath(form, `${form}/${next}`), true, next);
    }
  });

  /*
   * Without letting that reach anything it should not. A listing is never a
   * step, so extending one still joins nothing.
   */
  it('does not let that join a listing to what is under it', () => {
    assert.equal(relatedPath('https://x.com/jobs', 'https://x.com/jobs/1234'), false);
    assert.equal(relatedPath('https://x.com/acme/careers', 'https://x.com/acme/careers/swe'), false);
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

  it('does not join two jobs merely because one employer posted both', () => {
    // The company check is a veto, not a grant. Read as a grant, "Cygnus" on
    // both pages was enough to make two unrelated postings one application.
    const trail = trailOf(at('https://boards.greenhouse.io/cygnus/jobs/1', 'Cygnus'));
    assert.equal(
      sameApplication(trail, { url: 'https://boards.greenhouse.io/cygnus/jobs/2', company: 'Cygnus' }),
      false,
    );
  });

  it('still joins the apply page of a posting that names its company', () => {
    const trail = trailOf(at('https://jobs.lever.co/vega/8f21', 'Vega'));
    assert.equal(
      sameApplication(trail, { url: 'https://jobs.lever.co/vega/8f21/apply', company: 'Vega' }),
      true,
    );
  });

  it('refuses another posting reached through the board that lists both', () => {
    // The listing sits in the trail between the two jobs, and used to join to
    // each of them — which joined them to each other.
    const trail = trailOf(
      at('https://boards.greenhouse.io/altair', 'Altair'),
      at('https://boards.greenhouse.io/altair/jobs/1', 'Altair'),
      at('https://boards.greenhouse.io/altair', 'Altair'),
    );
    assert.equal(sameApplication(trail, { url: 'https://boards.greenhouse.io/altair/jobs/2' }), false);
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

  /*
   * The promise, rather than the mechanism.
   *
   * This runs when session storage will not take the trail whole, and what
   * it gives up has to be the part that can be got back: a page's text can
   * be read again by visiting the page. A letter and three answers cannot be
   * got back from anywhere, so they are what the shedding is *for* — and
   * nothing here said so, which would have let a refactor start trimming
   * `work` to save room and pass every test above.
   */
  it('never gives up what was written, at any pressure', () => {
    const withWork = {
      ...trail,
      work: { letter: 'Dear Acme,', answersByQuestion: { 'Why us?': 'Because.' }, spec: { id: 'x' } },
    };
    for (const keep of [2, 1, 0]) {
      const lighter = lighten(withWork, keep);
      assert.deepEqual(lighter.work, withWork.work, `work survived lighten(…, ${keep})`);
    }
  });
});

describe('whether there is anything to keep', () => {
  it('counts a resume, a letter, or an answer', () => {
    assert.equal(worthKeeping({ spec: { id: 'x' } }), true);
    assert.equal(worthKeeping({ letter: 'Dear Acme,' }), true);
    assert.equal(worthKeeping({ answersByQuestion: { 'Why us?': 'Because.' } }), true);
  });

  it('counts an empty card as nothing, which is what stops it erasing the rest', () => {
    // A card that could not analyse its page — the server went away — has this
    // state, and saving it used to throw away the resume built on the page
    // before.
    assert.equal(worthKeeping({ spec: null, letter: '', answersByQuestion: {} }), false);
    assert.equal(worthKeeping({ letter: '   ' }), false);
    assert.equal(worthKeeping(null), false);
  });
});

/*
 * The hand-off with no witness of its own.
 *
 * A careers site sending you to an applicant tracking system is the one walk
 * where nothing about the two pages connects them: the hosts differ, so the
 * address rules say no, and the Apply link routinely carries rel="noreferrer",
 * so there is no referrer either. That left the click — a message the content
 * script sends as its page is being torn down around it, which was measured
 * taking 54 to 78 milliseconds to land and which one full-suite run in four
 * was losing.
 *
 * The link is the same evidence, recorded before the navigation rather than
 * during it: the markup of the page you came from is already in the trail, and
 * an Apply link in it pointing here is a fact from minutes ago with nothing
 * left to race.
 */
describe('an apply link on the page you came from', () => {
  const careers = (body) => ({
    url: 'https://acme.example/careers/platform-engineer',
    title: 'Platform Engineer at Acme',
    company: 'Acme',
    html: `<html><body>${body}</body></html>`,
  });
  const form = { url: 'https://boards.other.example/gh/acme/jobs/9910', title: 'Apply — Acme' };

  it('joins the form to the posting that linked to it', () => {
    const trail = { pages: [careers('<p><a rel="noreferrer" href="https://boards.other.example/gh/acme/jobs/9910">Apply now</a></p>')] };
    assert.equal(sameApplication(trail, form), true);
  });

  it('reads a relative link against the page it was on', () => {
    const trail = {
      pages: [
        {
          url: 'https://acme.example/careers/platform-engineer',
          company: 'Acme',
          html: '<a href="/apply/9910">Apply now</a>',
        },
      ],
    };
    assert.equal(sameApplication(trail, { url: 'https://acme.example/apply/9910' }), true);
  });

  /*
   * The reason only apply links count. A board lists fifty postings and links
   * to every one of them; "this page linked to that page" would make any two
   * of them one application, which is the exact mistake the same-host rules
   * already go to some length to avoid.
   */
  it('does not join two postings just because a board linked to both', () => {
    const board = {
      url: 'https://jobs.example/acme',
      company: 'Acme',
      html:
        '<a href="https://boards.other.example/gh/acme/jobs/9910">Platform Engineer</a>' +
        '<a href="https://boards.other.example/gh/acme/jobs/9911">Data Scientist</a>',
    };
    assert.equal(sameApplication({ pages: [board] }, { url: 'https://boards.other.example/gh/acme/jobs/9911' }), false);
  });

  it('does not join a link to somewhere else entirely', () => {
    const trail = { pages: [careers('<a href="https://acme.example/apply/1">Apply now</a>')] };
    assert.equal(sameApplication(trail, { url: 'https://elsewhere.example/jobs/7' }), false);
  });

  /*
   * The company veto runs first and still wins. A link cannot make two
   * employers into one application, which is the failure this whole file
   * exists to prevent.
   */
  it('never overrules a different company', () => {
    const trail = { pages: [careers('<a href="https://boards.other.example/gh/acme/jobs/9910">Apply now</a>')] };
    assert.equal(sameApplication(trail, { ...form, company: 'Lyra' }), false);
  });

  it('is unbothered by a page whose markup was dropped to save room', () => {
    // `lighten` throws the html away when session storage fills up. The rule
    // simply stops applying; it must not throw.
    const trail = { pages: [{ url: 'https://acme.example/careers/platform-engineer', company: 'Acme' }] };
    assert.equal(sameApplication(trail, form), false);
  });

  it('is unbothered by markup that is not valid html', () => {
    const trail = { pages: [careers('<a href=https://boards.other.example/gh/acme/jobs/9910 >Apply</a><a href=>x')] };
    // Unquoted href is legal and is what a hand-written page often has.
    assert.equal(sameApplication(trail, form), true);
  });
});

/*
 * A shared apply page is one address that every posting on the site links to,
 * and a great many sites have one: `/careers/apply`, `/jobs/apply`. Once it
 * was in the trail it was a sibling of every posting beside it, and the rule
 * accepted a sibling pair when *either* end looked like a step — so it joined
 * them all. Apply to one job, open another on the same site, and the second
 * came up written from the first's description, carrying the first's letter.
 *
 * This is the judgement whose mistakes are invisible, and that is the shape
 * they take.
 */
describe('a page named "apply" is not a claim about its neighbours', () => {
  const rp = (a, b) => relatedPath(`https://x.example${a}`, `https://x.example${b}`);

  it('does not join a shared apply page to the postings beside it', () => {
    assert.equal(rp('/careers/apply', '/careers/vega-engineer'), false);
    assert.equal(rp('/careers/apply', '/careers/data-scientist'), false);
  });

  it('does not make every page on the site a sibling of /apply', () => {
    assert.equal(rp('/apply', '/pricing'), false);
    assert.equal(rp('/apply', '/about'), false);
  });

  it('still joins two steps that are siblings of each other', () => {
    assert.equal(rp('/jobs/apply', '/jobs/submit'), true);
    assert.equal(rp('/jobs/1234/apply/eeo', '/jobs/1234/apply/documents'), true);
  });

  it('and still joins a posting to its own form, and the form to its next step', () => {
    assert.equal(rp('/jobs/1234', '/jobs/1234/apply'), true);
    assert.equal(rp('/jobs/1234/apply', '/jobs/1234/apply/eeo'), true);
  });

  /*
   * The boundary of the rule above, and the reason it is not simply "both
   * ends must be steps".
   *
   * Taleo's form is a sibling *file* of its posting, so the posting side can
   * never be a step word: `jobdetail.ftl` then `application.ftl`. What makes
   * that pair safe is the `job=12345` they agree on — the same thing that
   * keeps two Indeed postings apart, read the other way round. A shared apply
   * page has nothing of the kind to agree about.
   */
  it('joins a sibling form to its posting when both name the same job', () => {
    const taleo = (file, job) => `https://acme.taleo.net/careersection/ex/${file}.ftl?job=${job}`;
    assert.equal(relatedPath(taleo('jobdetail', 12345), taleo('application', 12345)), true);
    assert.equal(relatedPath(taleo('jobdetail', 12345), taleo('application', 67890)), false);
    // And the shared apply page joins too, once the address says which job.
    assert.equal(rp('/careers/apply?job=99', '/careers/vega-engineer?job=99'), true);
  });
});

/*
 * An application is a description and then a form, and on the systems that
 * paginate — Workday, Taleo, a government portal — the form is four or five
 * steps on its own. Keeping only the newest pages therefore pushed out the
 * first one, which is the description: the only page that holds what the job
 * actually is, and the one the cover letter and the essay answers are written
 * from. Everything left is a list of form steps, and the letter is then
 * written from the fields it is about to be pasted into.
 */
describe('which pages survive a long application', () => {
  const walk = (n) => Array.from({ length: n }, (_, i) => ({ url: `https://x.example/step-${i}` }));

  it('keeps everything while there is room', () => {
    assert.deepEqual(keepPages(walk(3), 5).map((p) => p.url), [
      'https://x.example/step-0',
      'https://x.example/step-1',
      'https://x.example/step-2',
    ]);
  });

  it('keeps the description when the form outgrows the trail', () => {
    const kept = keepPages(walk(8), 5).map((p) => p.url);
    assert.equal(kept.length, 5);
    // The page the letter is written from, whatever came after it.
    assert.equal(kept[0], 'https://x.example/step-0');
    // And the four most recent, which is where the questions are.
    assert.deepEqual(kept.slice(1), [
      'https://x.example/step-4',
      'https://x.example/step-5',
      'https://x.example/step-6',
      'https://x.example/step-7',
    ]);
  });

  it('never returns more than it was asked for, or a hole', () => {
    for (const n of [0, 1, 2, 5, 6, 20]) {
      const kept = keepPages(walk(n), 5);
      assert.ok(kept.length <= 5, `${n} pages`);
      assert.ok(kept.every(Boolean), `${n} pages`);
      assert.equal(new Set(kept.map((p) => p.url)).size, kept.length, `${n} pages`);
    }
    assert.deepEqual(keepPages(undefined, 5), []);
    assert.deepEqual(keepPages(walk(3), 0), []);
  });
});
