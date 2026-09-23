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
  rootOf,
  lighten,
  judgeApplication,
  plainlyAnotherRole,
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

  /*
   * And the view most people actually read Indeed in: a list on the left, the
   * selected posting on the right, and the whole thing at `/jobs`. Which one
   * is selected lives in `vjk`, which was on no list — so every job clicked
   * in that pane was the same page as the last one, and the trail folded them
   * all into one application. `/viewjob?jk=` branched correctly, which is why
   * this only ever bit in the list.
   */
  it('does not join two jobs picked out of one search-results pane', () => {
    const jobs = 'https://www.indeed.com/jobs?q=software+engineer&l=Boston';
    assert.equal(relatedPath(`${jobs}&vjk=aaaa1111`, `${jobs}&vjk=bbbb2222`), false);
    // The same posting reached with the search worded differently is still it.
    assert.equal(relatedPath(`${jobs}&vjk=aaaa1111`, `https://www.indeed.com/jobs?q=golang&vjk=aaaa1111`), true);
  });

  /*
   * And the two systems this repo already ships fixtures for.
   *
   * `JOB_PARAM` is the whole defence for an ATS that keeps every posting at
   * one path: `relatedPath` returns true the moment the paths match, so a job
   * id the list does not know is a job id that does not exist. `tests/ats-web`
   * models ADP WorkForce Now at `/ta/6100.jobs?ApplyToJob=` with three
   * different postings, so the product claims to handle a system whose jobs
   * it could not tell apart.
   *
   * `jobpostingid` is the same omission one word longer: `postingid` is on the
   * list and the regex is anchored, so the longer spelling matched nothing.
   *
   * Two roles whose titles are plainly different are caught anyway, by the
   * role gate, and come back `unsure` — a chip rather than a merge. What this
   * fixes is the pair the gate cannot separate: "Platform Engineer" and
   * "Senior Platform Engineer" share a word, so the addresses were the only
   * evidence left and they said "same page".
   */
  /*
   * The steps a real application form is actually made of.
   *
   * `STEP_WORDS` had the words a *developer* would pick — apply, form, step,
   * submit, review — and none of the ones an ATS actually puts in the path.
   * A Workday or Greenhouse application walks `/jobs/12345/apply` then
   * `/jobs/12345/eeo`, `/documents`, `/demographics`, and the sibling rule
   * needs both ends to look like steps: `apply` did, `eeo` did not, and the
   * pair named no job in the query for `namesTheSameJob` to agree about.
   *
   * So the answer was `different` — the confident branch, not `unsure`. The
   * trail resets at the equal-opportunity page, and while the letter is
   * parked and comes back, page 0 does not: everything written from there on
   * is written from the form rather than the description, and nothing says so
   * because the chip only exists for `unsure`.
   *
   * These join only where the *other* end is a step too, which is the rule
   * that already keeps `/careers/apply` from swallowing `/careers/vega-
   * engineer`. Two jobs are never both named like form steps.
   */
  it('keeps the steps of one application form together', () => {
    const job = 'https://careers.acme.example/jobs/12345';
    assert.equal(relatedPath(`${job}/apply`, `${job}/eeo`), true);
    assert.equal(relatedPath(`${job}/apply`, `${job}/documents`), true);
    assert.equal(relatedPath(`${job}/review`, `${job}/demographics`), true);
    assert.equal(relatedPath(`${job}/application`, `${job}/voluntary-disclosures`), true);
  });

  /*
   * And the rule that protects them is still the one doing the work: a step
   * beside something that is not a step is two different things.
   */
  it('still refuses a step beside a posting', () => {
    assert.equal(relatedPath('https://acme.example/careers/apply', 'https://acme.example/careers/vega-engineer'), false);
    assert.equal(relatedPath('https://acme.example/careers/documents', 'https://acme.example/careers/data-scientist'), false);
    assert.equal(relatedPath('https://acme.example/jobs/1111', 'https://acme.example/jobs/2222'), false);
  });

  it('does not join two postings an unlisted job parameter tells apart', () => {
    const adp = 'https://acme.example/ta/6100.jobs';
    assert.equal(relatedPath(`${adp}?ApplyToJob=482991`, `${adp}?ApplyToJob=482992`), false);
    // The same posting reached twice is still the same posting.
    assert.equal(relatedPath(`${adp}?ApplyToJob=482991`, `${adp}?ApplyToJob=482991&src=email`), true);

    const ukg = 'https://acme.example/careers';
    assert.equal(relatedPath(`${ukg}?jobPostingId=111`, `${ukg}?jobPostingId=222`), false);
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

  /*
   * What the applicant typed never leaves with the page.
   *
   * React keeps an input's `value` attribute in step with what is typed, so a
   * form page captured after it was filled carried the social security
   * number, the date of birth and the address in its markup, to the server
   * and on to the AI. The questions are what the AI needs; the answers are
   * the applicant's. Radio and checkbox values are the options' own names —
   * part of the question — and stay.
   */
  it('drops typed values and textarea contents, keeping the questions and the options', () => {
    const page =
      '<label for="ssn">Social Security Number</label><input id="ssn" type="text" value="123-45-6789">' +
      "<label>Date of birth</label><input type=date value='1999-02-03'>" +
      '<label>Address</label><input value=12MainSt name="addr">' +
      '<label>Why us?</label><textarea name="why">My private draft answer</textarea>' +
      '<label><input type="radio" name="auth" value="Yes" checked> Yes</label>' +
      '<label><input type="checkbox" name="remote" value="Open to remote"> Open to remote</label>';
    const kept = trimForStorage(page);
    for (const secret of ['123-45-6789', '1999-02-03', '12MainSt', 'My private draft answer']) {
      assert.ok(!kept.includes(secret), `"${secret}" was sent`);
    }
    for (const question of ['Social Security Number', 'Date of birth', 'Address', 'Why us?', 'value="Yes"', 'value="Open to remote"']) {
      assert.ok(kept.includes(question), `"${question}" was lost`);
    }
  });

  /*
   * Nor which option they chose. A server-rendered step marks the answer with
   * `checked` or `selected`, and an ARIA group with `aria-checked`; on the
   * self-identification step those are the applicant's gender, disability
   * and veteran status. Every option is still there, so the question is.
   */
  it('drops the mark on a chosen option, keeping every option', () => {
    const page =
      '<fieldset><legend>Gender</legend>' +
      '<label><input type="radio" name="g" value="Female" checked> Female</label>' +
      '<label><input type=radio name=g value=Male> Male</label></fieldset>' +
      '<label>Disability</label><select name="d"><option value="">Select</option>' +
      '<option value="1" selected="selected">Yes, I have a disability</option><option value="0">No</option></select>' +
      '<label><input type="checkbox" name="remote" checked="" value="Open to remote"> Open to remote</label>' +
      '<div role="radiogroup" aria-label="Veteran status">' +
      '<div role="radio" aria-checked="true">I am a protected veteran</div>' +
      '<div role="radio" aria-checked="false">I am not a protected veteran</div></div>' +
      '<button aria-pressed="true">Hispanic or Latino</button>';
    const kept = trimForStorage(page);
    for (const mark of [/\schecked\b/, /\sselected\b/, /aria-checked/, /aria-pressed/]) {
      assert.ok(!mark.test(kept), `${mark} survived: ${kept}`);
    }
    for (const option of ['value="Female"', 'value=Male', 'Yes, I have a disability', 'value="Open to remote"', 'I am a protected veteran', 'I am not a protected veteran', 'Hispanic or Latino', 'Veteran status']) {
      assert.ok(kept.includes(option), `"${option}" was lost`);
    }
  });

  /*
   * However the tag is written. The scrub read a tag as `<input[^>]*>` and
   * its type as `\btype=`: a `>` inside a quoted attribute ended the tag
   * before the value, and `\b` matches after the hyphen in `data-type`, so a
   * text box labelled for some script as a checkbox kept what was typed.
   */
  it('drops the typed value however the tag around it is written', () => {
    const page =
      '<input type="text" data-x="a>b" value="SECRET-A">' +
      '<input data-type="checkbox" value="SECRET-B">' +
      '<input type=text value="1 > 2 SECRET-C">' +
      "<input title='say \"type=radio\"' value='SECRET-D'>" +
      '<input type="checkbox" data-x="a>b" name="remote" value="Open to remote" checked>' +
      '<select><option data-x="a>b" value="1" selected>Yes, I have a disability</option></select>' +
      '<textarea placeholder="a>b">SECRET-E</textarea>';
    const kept = trimForStorage(page);
    for (const secret of ['SECRET-A', 'SECRET-B', 'SECRET-C', 'SECRET-D', 'SECRET-E']) {
      assert.ok(!kept.includes(secret), `"${secret}" was sent: ${kept}`);
    }
    assert.ok(!/\schecked\b|\sselected\b/.test(kept), `the chosen option was marked: ${kept}`);
    for (const option of ['value="Open to remote"', 'Yes, I have a disability', 'placeholder="a>b"']) {
      assert.ok(kept.includes(option), `"${option}" was lost`);
    }
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

  /*
   * This used to assert the opposite — "gives up the oldest pages first,
   * since the newest are the ones in use" — which is the argument `keepPages`
   * exists to refute. Page zero is the description, the only page holding
   * what the job actually is and the one the letter and the essay answers are
   * written from; everything after it is form steps. Shedding it first meant
   * a trail too large to store came out holding `/apply/eeo` and
   * `/apply/documents` and no description, so the letter was written from the
   * fields it was about to be pasted into.
   */
  it('keeps the description and the page you are on, and sheds the middle', () => {
    const lighter = lighten(trail);
    assert.deepEqual(lighter.pages.map((p) => p.html), ['aaa', '', 'ccc']);
  });

  it('keeps the description even when there is room for only one', () => {
    assert.deepEqual(lighten(trail, 1).pages.map((p) => p.html), ['aaa', '', '']);
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

  /*
   * An apply link says where you went, not which job you went to.
   *
   * The other three routes into a join were each taught this, and each says
   * so: the click "is evidence about *where you went*, though, and none at
   * all about whether you went to the same job", and the referrer branch
   * concludes "the role is consulted here as it is there, on the same terms".
   * The link route was left returning a flat `same`.
   *
   * It is the route that runs when the referrer has been stripped — which
   * boards do routinely with `rel="noreferrer"` — so it is not a rare corner.
   * A careers listing whose rows each carry an Apply button: read Platform
   * Engineer, apply, come back, press Data Scientist's Apply, and its form
   * opens inside the first job's application with "Carried over: the resume,
   * the letter" and no chip.
   *
   * Measured against the module before the fix: this returned `same`, while
   * the identical situation arriving with a referrer returned `unsure`.
   */
  it('leaves an apply link unsure when the page plainly names another job', () => {
    const board = {
      url: 'https://careers.acme.example/openings',
      at: Date.now() - 60_000,
      html:
        '<a href="/jobs/1111">Platform Engineer</a><a href="/jobs/1111">Apply</a>' +
        '<a href="/jobs/2222">Data Scientist</a><a href="/jobs/2222">Apply</a>',
    };
    const first = {
      url: 'https://careers.acme.example/jobs/1111',
      at: Date.now() - 30_000,
      company: 'Acme',
      role: 'Platform Engineer',
    };
    const trail = { pages: [board, first], at: Date.now() };

    assert.equal(
      judgeApplication(trail, {
        url: 'https://careers.acme.example/jobs/2222',
        company: 'Acme',
        role: 'Data Scientist',
      }),
      'unsure',
    );

    // And the hand-off the route exists for is untouched: a form that names
    // no role of its own is the ordinary next page, not a new job.
    assert.equal(judgeApplication(trail, { url: 'https://careers.acme.example/jobs/2222' }), 'same');
    assert.equal(
      judgeApplication(trail, {
        url: 'https://careers.acme.example/jobs/2222',
        company: 'Acme',
        role: 'Platform Engineer',
      }),
      'same',
    );
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

/**
 * Two employers are not one site, and two jobs are not one application.
 *
 * Both of these merged an application into a different one, which is the
 * failure this module's own header opens with: the letter is then written
 * from the other job's page, and the resume built for one posting is offered
 * on the other.
 */
describe('two employers, and two jobs at one employer', () => {
  it('does not read a country-code domain as a company', () => {
  // `slice(-2)` made this `co.uk`, which is every company in Britain.
  assert.equal(rootOf('careers.monzo.co.uk'), 'monzo.co.uk');
  assert.equal(rootOf('jobs.deliveroo.co.uk'), 'deliveroo.co.uk');
  assert.equal(rootOf('careers.example.com.au'), 'example.com.au');
  assert.equal(rootOf('recruit.example.co.jp'), 'example.co.jp');

  // And the ordinary shapes are untouched.
  assert.equal(rootOf('careers.acme.com'), 'acme.com');
  assert.equal(rootOf('boards.greenhouse.io'), 'greenhouse.io');
  assert.equal(rootOf('acme.com'), 'acme.com');
  });

  it('keeps two British employers as two applications', () => {
  const trail = {
    at: Date.now(),
    pages: [{ url: 'https://careers.monzo.co.uk/jobs', title: '', company: 'Monzo', at: Date.now() }],
  };
    assert.equal(sameApplication(trail, { url: 'https://jobs.deliveroo.co.uk/jobs', title: '' }), false);
  });

  it('does not let an apply link claim the next job along', () => {
  const clicked = (to) => ({ expecting: { to, at: Date.now() } });

  // The slug pairs that actually occur. Each of these is two postings.
  for (const [a, b] of [
    ['https://acme.com/careers/data-analyst', 'https://acme.com/careers/data-analyst-intern'],
    ['https://acme.com/careers/platform-engineer', 'https://acme.com/careers/platform-engineer-ii'],
    ['https://acme.com/o/designer', 'https://acme.com/o/designer-2'],
  ]) {
    assert.equal(wasExpected(clicked(a), b), false, `${a} → ${b}`);
  }

  // And the case the expectation exists for: the link landing a step below
  // where it pointed, or exactly on it.
  assert.equal(wasExpected(clicked('https://acme.com/careers/data-analyst'), 'https://acme.com/careers/data-analyst/apply'), true);
  assert.equal(wasExpected(clicked('https://acme.com/careers/data-analyst/apply'), 'https://acme.com/careers/data-analyst'), true);
    assert.equal(wasExpected(clicked('https://acme.com/careers/data-analyst'), 'https://acme.com/careers/data-analyst'), true);
  });
});

/**
 * "Start fresh" has to mean it for longer than two seconds.
 *
 * An absent trail and a forgotten one both read as `pages: []`, and the card
 * does not stop writing when that button is pressed — its keeper re-sends the
 * resume and the letter every two seconds. So the trail came back within two
 * seconds holding the old job's work, and `sameApplication` handed it to the
 * next posting opened in that tab, as "Carried over: the resume, the letter".
 * The user had pressed a button that said Forgotten and been told it was.
 */
describe('a tab that was told to start fresh', () => {
  const emptied = { pages: [], cleared: Date.now(), at: Date.now() };

  it('claims no page, where an untouched tab claims any', () => {
    const page = { url: 'https://acme.com/jobs/platform-engineer', title: '', company: 'Acme' };
    assert.equal(sameApplication({ pages: [], at: Date.now() }, page), true);
    assert.equal(sameApplication(emptied, page), false);
  });

  it('and says so however long the page list stays empty', () => {
    assert.equal(sameApplication(emptied, { url: 'https://other.com/careers/x', title: '' }), false);
  });

  it('but is an ordinary trail again once it holds a page', () => {
    const read = {
      ...emptied,
      pages: [{ url: 'https://acme.com/jobs/platform-engineer', title: '', company: 'Acme', at: Date.now() }],
    };
    // The mark only ever speaks for an empty trail; a page of its own settles
    // it, and `remember` drops the mark because the fresh branch spreads
    // nothing.
    assert.equal(sameApplication(read, { url: 'https://acme.com/jobs/platform-engineer/apply', title: '' }), true);
  });
});

/**
 * Branching on a board that keeps every posting at one address.
 *
 * The address is the identity everywhere it can be, and on a results pane it
 * cannot be: Indeed's list, a single-page board, anything that swaps the
 * right-hand half and leaves the url alone. There the only thing that has
 * changed is what the page says it is, and that is thin evidence — forms
 * retitle themselves and boards append the company — so the answer is neither
 * yes nor no. The caller branches and asks.
 */
describe('a board that shows several jobs at one address', () => {
  const now = Date.now();
  const board = 'https://jobs.example.test/search?q=engineer';
  const page = (role, company) => ({ url: board, title: `${role} - ${company}`, role, company });
  const held = (role, company) => ({
    pages: [{ url: board, title: `${role} - ${company}`, role, company, at: now }],
    at: now,
  });

  it('is unsure when the pane changes to a plainly different job', () => {
    assert.equal(
      judgeApplication(held('Platform Engineer', 'Helios'), page('Data Scientist', 'Helios'), now),
      'unsure',
    );
  });

  it('is sure it is the same job when the role has only been reworded', () => {
    for (const [was, now_] of [
      ['Software Engineer', 'Senior Software Engineer'],
      ['Platform Engineer', 'Platform Engineer (Remote)'],
      ['Data Engineer', 'Data Engineer II'],
      // Related, and not the same job — but the wrong answer here splits an
      // application in two, and the url distinguishes the real cases.
      ['Platform Engineer', 'Data Engineer'],
    ]) {
      assert.equal(judgeApplication(held(was, 'Helios'), page(now_, 'Helios'), now), 'same', `${was} → ${now_}`);
    }
  });

  it('says nothing about a page it could not put a role to', () => {
    assert.equal(judgeApplication(held('Platform Engineer', 'Helios'), page(undefined, 'Helios'), now), 'same');
    assert.equal(judgeApplication(held(undefined, 'Helios'), page('Data Scientist', 'Helios'), now), 'same');
  });

  /*
   * And a different employer is still settled without asking: that veto is
   * older and stronger than anything a role title can say.
   */
  it('does not ask about a different company, it answers', () => {
    assert.equal(
      judgeApplication(held('Platform Engineer', 'Helios'), page('Data Scientist', 'Altair'), now),
      'different',
    );
  });

  it('reads the boolean form as a join, so a card can still save its own page', () => {
    assert.equal(sameApplication(held('Platform Engineer', 'Helios'), page('Data Scientist', 'Helios'), now), true);
  });
});

/**
 * An address that names a different job settles it, however it was reached.
 *
 * `relatedPath` says this and said it too late to matter: the click was
 * checked first, and on a board the click is exactly how you reach the next
 * job. Open a posting from a list, go back, open another — the expectation
 * set by the second click vouched for a page whose own url said, in the
 * board's own parameter, that it was a different requisition.
 */
describe('clicking through to another job on the same board', () => {
  const now = Date.now();
  const jobA = 'https://www.indeed.com/viewjob?jk=aaaa1111';
  const jobB = 'https://www.indeed.com/viewjob?jk=bbbb2222';

  it('does not let the click vouch for a different requisition', () => {
    const trail = {
      pages: [{ url: jobA, title: 'Platform Engineer - Helios', role: 'Platform Engineer', at: now }],
      expecting: { to: jobB, at: now },
      at: now,
    };
    assert.equal(judgeApplication(trail, { url: jobB, title: 'Data Scientist - Altair', role: 'Data Scientist' }, now), 'different');
  });

  it('still lets a click carry an application to its own form', () => {
    const posting = 'https://boards.example.test/helios/platform-engineer';
    const form = 'https://boards.example.test/helios/platform-engineer/apply';
    const trail = {
      pages: [{ url: posting, title: 'Platform Engineer', role: 'Platform Engineer', at: now }],
      expecting: { to: form, at: now },
      at: now,
    };
    assert.equal(judgeApplication(trail, { url: form, title: 'Apply' }, now), 'same');
  });
});

describe('two role titles', () => {
  it('are another job only when they share nothing that names the work', () => {
    assert.equal(plainlyAnotherRole('Platform Engineer', 'Data Scientist'), true);
    assert.equal(plainlyAnotherRole('Software Engineer', 'Senior Software Engineer'), false);
    assert.equal(plainlyAnotherRole('Data Engineer', 'Platform Engineer'), false);
    // Seniority and shape are not identity.
    assert.equal(plainlyAnotherRole('Engineer II', 'Senior Engineer'), false);
    // No opinion where there is nothing to compare.
    assert.equal(plainlyAnotherRole('', 'Data Scientist'), false);
    assert.equal(plainlyAnotherRole('Senior', 'Remote'), false);
  });
});

/*
 * The two ways a click or a referrer vouched for a job it knew nothing about.
 *
 * Both were measured against this module before they were fixed, and both
 * produced the failure the file's header opens with: one application holding
 * two jobs, no chip, the first job's letter and resume still on the card, and
 * the first job's description handed to whatever is written next.
 */
describe('evidence about where you went, and not about which job', () => {
  const now = Date.now();

  /*
   * `watchForApplyClicks` matches buttons as well as links, and a button has
   * no href — so the expectation it sets is the page's own address. On a
   * board showing every job at one address, pressing "Easy Apply", abandoning
   * the modal and clicking the next job in the list arrived with an
   * expectation that vouched for it.
   */
  describe('an Apply button that does not navigate', () => {
    const board = 'http://board.example/jobs';
    const trail = {
      pages: [{ url: board, company: 'Acme', role: 'Platform Engineer', at: now }],
      expecting: { to: board, at: now },
      at: now,
    };

    it('does not vouch for a plainly different job at that address', () => {
      assert.equal(
        judgeApplication(trail, { url: board, company: 'Acme', role: 'Data Scientist' }, now),
        'unsure',
      );
    });

    it('and never for another employer', () => {
      assert.equal(
        judgeApplication(trail, { url: board, company: 'Helios', role: 'Data Scientist' }, now),
        'different',
      );
    });

    it('but still carries an application to its own form', () => {
      const posting = 'http://x.example/jobs/7';
      const form = 'http://x.example/jobs/7/apply';
      const onIt = {
        pages: [{ url: posting, company: 'Acme', role: 'Platform Engineer', at: now }],
        expecting: { to: form, at: now },
        at: now,
      };
      // The form calls itself "Application", which is not a different job.
      assert.equal(judgeApplication(onIt, { url: form, company: 'Acme', role: 'Application' }, now), 'same');
    });
  });

  /*
   * A careers site is where every role at an employer is listed, and the first
   * page of a trail is kept for its whole life — so one hand-off from that
   * host vouched for every later job reached from it. The company veto cannot
   * help: it is the same employer.
   */
  describe('a hand-off from a careers site to an applicant tracking system', () => {
    const careers = 'https://careers.acme.com/jobs/platform-engineer';
    const first = 'https://job-boards.greenhouse.io/acme/jobs/1111';
    const second = 'https://job-boards.greenhouse.io/acme/jobs/2222';
    const trail = {
      pages: [
        { url: careers, company: 'Acme', role: 'Platform Engineer', at: now },
        { url: first, company: 'Acme', role: 'Platform Engineer', at: now },
      ],
      at: now,
    };

    it('does not keep vouching for the next role on that site', () => {
      assert.equal(
        judgeApplication(
          trail,
          { url: second, company: 'Acme', role: 'Data Scientist', referrerHost: 'careers.acme.com' },
          now,
        ),
        'unsure',
      );
    });

    it('and still joins the hand-off it was written for', () => {
      const one = { pages: [{ url: careers, company: 'Acme', role: 'Platform Engineer', at: now }], at: now };
      assert.equal(
        judgeApplication(
          one,
          { url: first, company: 'Acme', role: 'Platform Engineer', referrerHost: 'careers.acme.com' },
          now,
        ),
        'same',
      );
    });

    it('including when the form does not say what job it is', () => {
      const one = { pages: [{ url: careers, company: 'Acme', role: 'Platform Engineer', at: now }], at: now };
      assert.equal(
        judgeApplication(one, { url: first, company: 'Acme', referrerHost: 'careers.acme.com' }, now),
        'same',
      );
    });
  });
});

/*
 * The page as sent, with what is inside its shadow roots.
 *
 * `document.documentElement.outerHTML` does not serialise a shadow root, so a
 * posting or an application form rendered inside a web component — which
 * autofill reaches and fills — never reached the server as text, and the AI
 * wrote the letter and the answers without it.
 */
describe('the page as sent includes its shadow roots', () => {
  it('carries the text of an open shadow root, and of one nested inside it', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Apply</title></head><body><h1>Acme careers</h1>
        <apply-form id="host"></apply-form>
        <script>
          const outer = document.getElementById('host').attachShadow({ mode: 'open' });
          outer.innerHTML = '<h2>Platform Engineer</h2><label>Why do you want to work at Acme?</label><textarea></textarea><inner-part id="in"></inner-part>';
          outer.getElementById('in').attachShadow({ mode: 'open' }).innerHTML = '<p>Salary: $150,000 to $180,000</p>';
        </script></body></html>`);
      const out = await page.evaluate(async (js) => {
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        const empty = document.implementation.createHTMLDocument('x');
        return { html: mod.pageHtml(document), bare: mod.pageHtml(empty), plainOuter: empty.documentElement.outerHTML };
      }, source);
      assert.ok(out.html.includes('Why do you want to work at Acme?'), 'the shadow root\'s question is sent');
      assert.ok(out.html.includes('Salary: $150,000 to $180,000'), 'and the nested one\'s salary');
      assert.ok(out.html.includes('<h1>Acme careers</h1>'), 'and the page itself');
      assert.ok(out.html.indexOf('Why do you want') < out.html.lastIndexOf('</body>'), 'inside the body');
      assert.equal(out.bare, out.plainOuter, 'a page with no shadow roots is sent exactly as it was');
    } finally {
      await browser.close();
    }
  });

  /*
   * Except our own. The card and the "is this a job?" chip are shadow roots
   * on the page like any other, and the card is up before the page is read
   * and still up at every rebuild — so the page went to the server with the
   * card inside it: the letter being written, the resume's own lines, and a
   * feedback box labelled like a question, as though the posting had said
   * them. `allRoots` in autofill.js has skipped the card for the same reason
   * since it learned to walk shadow roots.
   */
  it('does not carry the card or the chip, only the page', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Apply</title></head><body><h1>Platform Engineer</h1>
        <apply-form id="form"></apply-form>
        <div id="jobhelper-card-host"></div>
        <div id="jobhelper-ask-host"></div></body></html>`);
      // Attached from out here rather than by a script in the page, whose own
      // source would otherwise carry the very words being looked for.
      const html = await page.evaluate(async (js) => {
        document.getElementById('form').attachShadow({ mode: 'open' }).innerHTML =
          '<label>Why do you want to work at Acme?</label><textarea></textarea>';
        document.getElementById('jobhelper-card-host').attachShadow({ mode: 'open' }).innerHTML =
          '<p>Dear Hiring Manager, I led the migration of our billing system.</p><label>Anything to change?</label><textarea></textarea>';
        document.getElementById('jobhelper-ask-host').attachShadow({ mode: 'open' }).innerHTML =
          '<p>Is this a job you are applying for?</p>';
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        return mod.pageHtml(document);
      }, source);
      assert.ok(html.includes('Why do you want to work at Acme?'), 'the page\'s own shadow root is still sent');
      for (const ours of ['Dear Hiring Manager', 'Anything to change?', 'Is this a job you are applying for?']) {
        assert.ok(!html.includes(ours), `"${ours}" was sent as part of the page`);
      }
    } finally {
      await browser.close();
    }
  });

  /*
   * Nor the applicant's answers, from anywhere in the tree. A rich-text
   * editor holds a draft essay as plain paragraphs under a `contenteditable`
   * ancestor, which no expression over markup can find the end of, so the
   * draft went to the server word for word. `pageHtml` now scrubs a copy of
   * the page while it is still a tree — and the copy must be inert: the page's
   * own custom elements are not constructed again, and its images are not
   * fetched again, because of it.
   */
  it('does not carry what the applicant wrote or chose, and copies the page without side effects', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      const fetched = [];
      await page.route('https://img.example/**', (route) => {
        fetched.push(route.request().url());
        return route.fulfill({ status: 200, contentType: 'image/gif', body: '' });
      });
      await page.setContent(`<!doctype html><html><head><title>Apply</title></head><body><h1>Platform Engineer</h1>
        <img src="https://img.example/logo.gif" alt="Acme">
        <label>Why Acme?</label><div class="ql-editor" contenteditable="true"><p>Draft one</p></div>
        <label>Anything else?</label><div contenteditable><p>Draft two</p></div>
        <label>Notes</label><div contenteditable="false"><p>Kept: the posting's own text</p></div>
        <label>Name</label><input id="name" type="text" data-type="radio">
        <label><input id="yes" type="radio" name="auth" value="Yes"> Yes</label>
        <select id="d"><option value="0">No</option><option value="1">Yes, I have a disability</option></select>
        <apply-form id="form"></apply-form>
        <x-widget></x-widget></body></html>`);
      const out = await page.evaluate(async (js) => {
        window.constructed = 0;
        customElements.define('x-widget', class extends HTMLElement {
          constructor() {
            super();
            window.constructed += 1;
          }
        });
        const name = document.getElementById('name');
        name.setAttribute('value', 'SECRET-NAME');
        document.getElementById('yes').setAttribute('checked', '');
        document.getElementById('d').options[1].setAttribute('selected', '');
        document.getElementById('form').attachShadow({ mode: 'open' }).innerHTML =
          '<label>Tell us about a project</label><div contenteditable="plaintext-only">Draft three</div>' +
          '<textarea>Draft four</textarea>';
        const before = window.constructed;
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        const html = mod.pageHtml(document);
        await new Promise((r) => setTimeout(r, 200));
        return { html, constructedAgain: window.constructed - before };
      }, source);
      for (const answer of ['Draft one', 'Draft two', 'Draft three', 'Draft four', 'SECRET-NAME']) {
        assert.ok(!out.html.includes(answer), `"${answer}" was sent as part of the page`);
      }
      assert.ok(!/\schecked\b|\sselected\b/.test(out.html), 'the chosen option was marked');
      for (const question of ['Why Acme?', 'Anything else?', 'Tell us about a project', "Kept: the posting's own text", 'value="Yes"', 'Yes, I have a disability', 'contenteditable="true"']) {
        assert.ok(out.html.includes(question), `"${question}" was lost`);
      }
      assert.equal(out.constructedAgain, 0, 'copying the page ran its custom elements');
      assert.equal(fetched.length, 1, `copying the page fetched its images again: ${fetched.join(', ')}`);
    } finally {
      await browser.close();
    }
  });
});
