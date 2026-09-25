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
  carriesOn,
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

/**
 * Whether a page is plainly the next page of the application in hand, which
 * is what lets a thin form step be read before anything has been written.
 *
 * Oracle Recruiting Cloud's first form page is an email box under the
 * posting's title, reached by pushState from the posting's own address. It
 * scored under the threshold, and with nothing written the card went.
 */
describe('a page carrying on the application in hand', () => {
  const posting = at('https://ebfr.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobs/job/11514', 'Oceaneering');

  it('is the posting\'s own apply steps, on its own address', () => {
    for (const step of ['apply/email', 'apply/section/1', 'apply/section/3']) {
      assert.equal(carriesOn(trailOf(posting), { url: `${posting.url}/${step}` }), true, step);
    }
  });

  it('is where Apply was pressed to, on another site', () => {
    const trail = { ...trailOf(at('https://careers.acme.com/jobs/platform-engineer', 'Acme')), expecting: { to: 'https://acme.bytedance.example/n/c/8f2a1b', at: Date.now() } };
    assert.equal(carriesOn(trail, { url: 'https://acme.bytedance.example/n/c/8f2a1b' }), true);
  });

  /*
   * The joins `sameApplication` also accepts, and that must not be enough to
   * read a page on: every link out of a posting would bring the card along.
   */
  it('is not a page on another site that merely came from it', () => {
    const trail = trailOf(at('https://careers.acme.com/jobs/platform-engineer', 'Acme'));
    const about = { url: 'https://acme.example/about', referrerHost: 'careers.acme.com' };
    assert.equal(sameApplication(trail, about), true, 'the looser judge joins it');
    assert.equal(carriesOn(trail, about), false);
  });

  it('is not another page of the same site, nor another job on it', () => {
    assert.equal(carriesOn(trailOf(posting), { url: 'https://ebfr.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobs/my-profile' }), false);
    assert.equal(carriesOn(trailOf(posting), { url: 'https://ebfr.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/jobs/job/11999/apply/email' }), false);
  });

  it('is nothing at all in a tab with no application', () => {
    assert.equal(carriesOn(trailOf(), { url: `${posting.url}/apply/email` }), false);
  });
});

/**
 * One employer, written two ways.
 *
 * A posting's JSON-LD carries the legal name and the form it hands you to
 * says the short one. The veto compared them exactly, so "Acme, Inc." and
 * "Acme" were two employers and the form was split off confidently, with no
 * chip — by every route that would otherwise have joined it.
 */
describe('the same employer with and without its legal form', () => {
  const posting = at('https://careers.acme.com/jobs/platform-engineer', 'Acme, Inc.');

  it('joins the form it hands you to, by the referrer', () => {
    const page = { url: 'https://boards.greenhouse.io/acme/jobs/1', referrerHost: 'careers.acme.com', company: 'Acme' };
    assert.equal(judgeApplication(trailOf(posting), page), 'same');
  });

  it('and by the Apply click', () => {
    const trail = {
      ...trailOf(posting),
      expecting: { to: 'https://boards.greenhouse.io/acme/jobs/1', at: Date.now() },
    };
    assert.equal(judgeApplication(trail, { url: 'https://boards.greenhouse.io/acme/jobs/1', company: 'Acme' }), 'same');
  });

  it('and one step down the same path, however the suffix is written', () => {
    for (const company of ['Acme', 'ACME Corp', 'Acme Inc', 'Acme, Inc']) {
      const page = { url: 'https://careers.acme.com/jobs/platform-engineer/apply', company };
      assert.equal(judgeApplication(trailOf(posting), page), 'same', company);
    }
  });

  it('but still refuses a name that differs by more than its legal form', () => {
    for (const company of ['Acme Labs', 'Acme Health', 'Northwind, Inc.']) {
      const page = { url: 'https://careers.acme.com/jobs/platform-engineer/apply', company };
      assert.equal(judgeApplication(trailOf(posting), page), 'different', company);
    }
  });
});

/**
 * And the same employer again, when an AI pass finishes late.
 *
 * `landLate` in content.js keeps a proposal that outlived the pass that asked
 * for it, and lands it only if the card is showing the same posting — which
 * `sameJob` decided by comparing the company exactly. So a three-minute AI
 * run for "Acme, Inc." finishing on a card that reads the same posting as
 * "Acme" was said to be for another posting and thrown away. It is compared
 * by the trail's `employerKey` now, the same key the trail joins pages on.
 *
 * `sameJob` lives inside the content script's closure, so it is lifted out of
 * the source the way tests/reporting.mjs lifts `describeAttach`.
 */
describe('a late AI result, against the posting on screen', async () => {
  const fsMod = await import('node:fs');
  const trailModule = await import('../src/shared/trail.js');
  const { employerKey } = trailModule;
  // Absent before the key existed; the lifted `sameJob` then falls back to
  // comparing exactly, which is what the title tests below are measuring.
  const titleKey = trailModule.titleKey ?? null;
  const source = fsMod.readFileSync(new URL('../src/content/content.js', import.meta.url), 'utf8');
  const from = source.indexOf('  const sameJob =');
  const to = source.indexOf(';\n', from);
  const sameJob = new Function('employerKey', 'titleKey', `${source.slice(from, to + 1)}\nreturn sameJob;`)(
    employerKey,
    titleKey,
  );
  const job = (company, title = 'Platform Engineer') => ({ job: { company, title } });

  it('is lifted from the content script', () => {
    assert.notEqual(from, -1, 'content.js no longer has a sameJob');
  });

  it('lands on the same employer written with its legal form', () => {
    assert.equal(sameJob(job('Acme, Inc.'), job('Acme')), true);
    assert.equal(sameJob(job('ACME Corp'), job('Acme')), true);
  });

  it('but not on another employer, nor another role', () => {
    assert.equal(sameJob(job('Acme Labs'), job('Acme')), false);
    assert.equal(sameJob(job('Northwind, Inc.'), job('Acme, Inc.')), false);
    assert.equal(sameJob(job('Acme, Inc.', 'Data Scientist'), job('Acme')), false);
  });

  /*
   * The title was compared exactly, and one posting writes its title more
   * than one way: the JSON-LD says "Platform Engineer", the heading the
   * server read says "Platform engineer", the page title "Platform Engineer –
   * Remote" with the dash of whoever typed it. Each of those threw a finished
   * AI run away as "not this posting".
   */
  it('lands on the same title written with other case, spacing or punctuation', () => {
    const pairs = [
      ['Platform engineer', 'Platform Engineer'],
      ['Platform  Engineer ', 'Platform Engineer'],
      ['Platform Engineer', 'Platform Engineer'],
      ['Sr. Platform Engineer', 'Sr Platform Engineer'],
      ['Platform Engineer, Payments', 'Platform Engineer - Payments'],
      ['Platform Engineer (Remote)', 'Platform Engineer – Remote'],
      ['Front-end Engineer', 'Front end Engineer'],
    ];
    for (const [a, b] of pairs) {
      assert.equal(sameJob(job('Acme', a), job('Acme', b)), true, `${a} / ${b}`);
      assert.equal(sameJob(job('Acme', b), job('Acme', a)), true, `${b} / ${a}`);
    }
  });

  it('but not on a title that differs by a word, or by what the punctuation said', () => {
    const pairs = [
      ['Platform Engineer', 'Senior Platform Engineer'],
      ['Platform Engineer', 'Platform Engineer II'],
      ['Platform Engineer II', 'Platform Engineer III'],
      ['Platform Engineer', 'Platform Engineer Intern'],
      ['C++ Engineer', 'C Engineer'],
      ['C# Developer', 'C Developer'],
      ['Frontend Engineer', 'Front end Engineer'],
      ['Platform Engineer', 'Plat form Engineer'],
    ];
    for (const [a, b] of pairs) {
      assert.equal(sameJob(job('Acme', a), job('Acme', b)), false, `${a} / ${b}`);
      assert.equal(sameJob(job('Acme', b), job('Acme', a)), false, `${b} / ${a}`);
    }
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

/*
 * What a select widget shows once something has been picked in it.
 *
 * Dropping `selected` and `aria-selected` covers a native <select>, and most
 * application forms no longer have one: the self-identification questions are
 * drawn by a widget, and the widget writes the answer out as ordinary text
 * beside the question. The markup below is what each library put in the page
 * after an option was clicked in Chromium — react-select 5.10 (with
 * Greenhouse's `select` class prefix, and without one), MUI 5.18 Select and
 * Autocomplete, Headless UI 2.2 Listbox, Radix Select 2.3, select2 4.1 and
 * Choices.js 11.2 — with inline styles and icons taken out. Workday's button
 * is the shape tests/autofill.mjs models, which draws its choice on itself.
 */
const CHOSEN_IN_WIDGETS = `
  <h1>Voluntary Self-Identification</h1>
  <p>Female founders network, veterans and people with a disability are encouraged to apply.</p>
  <div class="posting-tags"><div class="MuiChip-root MuiChip-filled"><span class="MuiChip-label">Location: Remote</span></div>
    <span class="chip">Hybrid</span></div>

  <label id="rs-g-l" for="rs-g">Gender</label>
  <div class="css-b62m3t-container">
    <span id="react-select-2-live-region" class="css-7pg0cj-a11yText"><span id="aria-selection">option ANSWER-RS-LIVE, selected.</span><span id="aria-focused"></span><span id="aria-results"></span><span id="aria-guidance">Select is focused ,type to refine list, press Down to open the menu, </span></span>
    <span aria-live="polite" aria-atomic="false" aria-relevant="additions text" role="log" class="css-7pg0cj-a11yText"></span>
    <div class="select__control css-t3ipsp-control"><div class="select__value-container select__value-container--has-value css-hlgwow">
      <div class="select__single-value css-1dimb5e-singleValue">ANSWER-RS-SINGLE</div>
      <div class="select__input-container css-19bb58m" data-value=""><input class="select__input" id="rs-g" type="text" aria-autocomplete="list" aria-expanded="false" aria-haspopup="true" aria-labelledby="rs-g-l" role="combobox" value=""></div>
    </div></div>
    <input name="gender" type="hidden" value="f">
  </div>

  <label id="rs-r-l">Race</label>
  <div class="css-b62m3t-container"><div class="css-13cymwt-control"><div class="css-1dyz3mf">
    <div class="css-1p3m7a8-multiValue"><div class="css-9jq23d">ANSWER-RS-CHIP</div><div role="button" class="css-v7duua" aria-label="Remove ANSWER-RS-REMOVE"></div></div>
    <div class="css-19bb58m" data-value=""><input id="rs-r" type="text" aria-labelledby="rs-r-l" role="combobox" value=""></div>
  </div></div></div>

  <div class="MuiFormControl-root"><label class="MuiFormLabel-root MuiInputLabel-root" id="mui-v-label">Veteran status</label>
    <div class="MuiInputBase-root MuiOutlinedInput-root">
      <div tabindex="0" role="combobox" aria-controls=":r0:" aria-expanded="false" aria-haspopup="listbox" aria-labelledby="mui-v-label mui-v" id="mui-v" class="MuiSelect-select MuiSelect-outlined MuiInputBase-input">ANSWER-MUI-SELECT</div>
      <input aria-invalid="false" aria-hidden="true" tabindex="-1" class="MuiSelect-nativeInput" value="pv">
    </div></div>

  <div class="MuiFormControl-root"><label class="MuiFormLabel-root MuiInputLabel-root" id="mui-e-label">Ethnicity</label>
    <div class="MuiInputBase-root MuiOutlinedInput-root">
      <div tabindex="0" role="combobox" aria-haspopup="listbox" aria-labelledby="mui-e-label mui-e" id="mui-e" class="MuiSelect-select MuiSelect-multiple MuiInputBase-input">
        <div><div class="MuiChip-root MuiChip-filled"><span class="MuiChip-label">ANSWER-MUI-MULTI</span></div></div></div>
    </div></div>

  <div class="MuiAutocomplete-root"><div class="MuiFormControl-root"><label class="MuiFormLabel-root" for="mui-ac" id="mui-ac-label">Languages spoken at home</label>
    <div class="MuiInputBase-root MuiAutocomplete-inputRoot">
      <div class="MuiButtonBase-root MuiChip-root MuiChip-deletable MuiAutocomplete-tag MuiAutocomplete-tagSizeMedium" tabindex="-1" role="button" data-tag-index="0"><span class="MuiChip-label">ANSWER-MUI-TAG</span></div>
      <input aria-invalid="false" autocomplete="off" id="mui-ac" type="text" class="MuiAutocomplete-input" role="combobox" value="">
    </div></div></div>

  <div data-headlessui-state=""><label id="headlessui-label-:r5:" data-headlessui-state="">Disability status</label>
    <button id="hl-btn" type="button" aria-haspopup="listbox" aria-expanded="false" data-headlessui-state="" aria-labelledby="headlessui-label-:r5: hl-btn">ANSWER-HEADLESS</button></div>

  <div><label id="rx-l">Are you Hispanic or Latino?</label>
    <button type="button" role="combobox" aria-expanded="false" aria-autocomplete="none" dir="ltr" data-state="closed" id="rx-t" aria-labelledby="rx-l"><span>ANSWER-RADIX</span><span aria-hidden="true">▼</span></button></div>

  <div><label id="wd-l">Please select your gender</label>
    <button type="button" id="wd-g" aria-haspopup="listbox" aria-labelledby="wd-l">ANSWER-WORKDAY</button></div>

  <label for="s2">Protected veteran status</label>
  <span class="select2 select2-container select2-container--default" dir="ltr"><span class="selection">
    <span class="select2-selection select2-selection--single" role="combobox" aria-haspopup="true" aria-expanded="false" tabindex="0" aria-labelledby="select2-s2-container">
      <span class="select2-selection__rendered" id="select2-s2-container" role="textbox" aria-readonly="true" title="ANSWER-S2-TITLE">ANSWER-S2-SINGLE</span>
      <span class="select2-selection__arrow" role="presentation"><b role="presentation"></b></span>
    </span></span></span>

  <label for="s2m">Race (select all that apply)</label>
  <span class="select2 select2-container select2-container--default" dir="ltr"><span class="selection">
    <span class="select2-selection select2-selection--multiple" role="combobox" aria-haspopup="true" aria-expanded="false" tabindex="-1">
      <ul class="select2-selection__rendered" id="select2-s2m-container">
        <li class="select2-selection__choice" title="ANSWER-S2M-TITLE"><button type="button" class="select2-selection__choice__remove" tabindex="-1" title="Remove item" aria-label="Remove item" aria-describedby="select2-s2m-container-choice-0jdg-ANSWERS2MID"><span aria-hidden="true">×</span></button><span class="select2-selection__choice__display" id="select2-s2m-container-choice-0jdg-ANSWERS2MID">ANSWER-S2M-CHIP</span></li>
      </ul>
      <span class="select2-search select2-search--inline"><textarea class="select2-search__field" aria-label="Search"></textarea></span>
    </span></span></span>

  <label for="ch">Pronouns</label>
  <div class="choices" data-type="select-one" tabindex="0" role="combobox" aria-haspopup="true" aria-expanded="false">
    <div class="choices__inner">
      <div class="choices__list choices__list--single" role="listbox">
        <div class="choices__item choices__item--selectable" data-item="" data-id="2" data-value="ANSWER-CH-VALUE" role="option">ANSWER-CH-SINGLE</div>
      </div>
    </div>
    <div class="choices__list choices__list--dropdown" aria-expanded="false"><div class="choices__list" role="listbox">
      <div id="choices--ch-item-choice-1" class="choices__item choices__item--choice choices__item--selectable" role="option" data-value="He/him">He/him</div>
      <div id="choices--ch-item-choice-3" class="choices__item choices__item--choice choices__item--selectable" role="option" data-value="They/them">They/them</div>
    </div></div>
  </div>

  <label for="chm">Sexual orientation</label>
  <div class="choices" data-type="select-multiple" role="combobox" aria-haspopup="true" aria-expanded="false">
    <div class="choices__inner">
      <div class="choices__list choices__list--multiple" role="listbox">
        <div class="choices__item choices__item--selectable" data-item="" data-id="1" data-value="ANSWER-CHM-VALUE" role="option" data-deletable="">ANSWER-CHM-CHIP<button type="button" class="choices__button" aria-label="Remove item: ANSWER-CHM-REMOVE" data-button="">Remove item</button></div>
      </div>
      <input type="search" class="choices__input choices__input--cloned" aria-label="Sexual orientation">
    </div>
  </div>
  <button type="button" aria-haspopup="menu">Share this job</button>`;

describe('the page as sent does not say which option a widget shows as chosen', () => {
  it('empties what react-select, MUI, Headless UI, Radix, Workday, select2 and Choices.js draw as the answer', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Apply</title></head><body>${CHOSEN_IN_WIDGETS}</body></html>`);
      const html = await page.evaluate(async (js) => {
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        return mod.trimForStorage(mod.pageHtml(document));
      }, source);
      const leaked = html.match(/ANSWER-?[A-Z0-9-]*/g) ?? [];
      assert.deepEqual(leaked, [], `the chosen answers were sent: ${leaked.join(', ')}`);
      for (const kept of [
        'Voluntary Self-Identification', 'Female founders network', 'Location: Remote', 'Hybrid',
        'Gender', 'Race', 'Veteran status', 'Ethnicity', 'Languages spoken at home', 'Disability status',
        'Are you Hispanic or Latino?', 'Please select your gender', 'Protected veteran status',
        'Race (select all that apply)', 'Pronouns', 'Sexual orientation', 'He/him', 'They/them',
        'Share this job', 'type to refine list',
      ]) {
        assert.ok(html.includes(kept), `"${kept}" was lost`);
      }
    } finally {
      await browser.close();
    }
  });

  /*
   * Nor which option in a list is the chosen one. The options are the
   * question and stay; what goes is the state each library puts on the pick.
   * Choices.js keeps its dropdown in the page closed or open, with
   * `is-selected` on the answer and the search box's `aria-activedescendant`
   * naming it; the others mark it while the menu is open, which is when the
   * page is read if the applicant is mid-choice. Each list below is what the
   * library rendered in Chromium on reopening a menu after a pick.
   */
  it('drops the marks each library puts on the chosen option in a list', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Apply</title></head><body>
        <label for="ch">Gender</label>
        <div class="choices" data-type="select-one" tabindex="0" role="combobox" aria-haspopup="true" aria-expanded="false">
          <div class="choices__list choices__list--dropdown" aria-expanded="false">
            <input type="search" class="choices__input choices__input--cloned" aria-label="Select" aria-activedescendant="choices--ch-item-choice-2">
            <div class="choices__list" role="listbox">
              <div id="choices--ch-item-choice-2" class="choices__item choices__item--choice is-selected choices__item--selectable is-highlighted" role="option" data-choice="" data-id="2" data-value="Female" data-select-text="Press to select" data-choice-selectable="" aria-selected="true">Female</div>
              <div id="choices--ch-item-choice-3" class="choices__item choices__item--choice choices__item--selectable" role="option" data-choice="" data-id="3" data-value="Male" data-select-text="Press to select" data-choice-selectable="" aria-selected="false">Male</div>
            </div>
          </div>
        </div>
        <div role="listbox">
          <div class="select__option select__option--is-focused select__option--is-selected css-tr4s17-option" aria-disabled="false" id="react-select-2-option-0" tabindex="-1" role="option" aria-selected="true">Asian</div>
          <div class="select__option css-10wo9uf-option" aria-disabled="false" id="react-select-2-option-1" tabindex="-1" role="option" aria-selected="false">White</div>
        </div>
        <ul role="listbox">
          <li class="MuiButtonBase-root MuiMenuItem-root MuiMenuItem-gutters Mui-selected Mui-focusVisible MuiMenuItem-root MuiMenuItem-gutters Mui-selected css-1km1ehz" tabindex="0" role="option" aria-selected="true" data-value="pv">I am a protected veteran</li>
          <li class="MuiButtonBase-root MuiMenuItem-root MuiMenuItem-gutters MuiMenuItem-root MuiMenuItem-gutters css-1km1ehz" tabindex="-1" role="option" aria-selected="false" data-value="nv">I am not a protected veteran</li>
        </ul>
        <div role="listbox">
          <div id="headlessui-listbox-option-:rh:" role="option" tabindex="-1" aria-selected="true" data-headlessui-state="active focus selected" data-selected="" data-active="" data-focus="">Yes, I have a disability</div>
          <div id="headlessui-listbox-option-:ri:" role="option" tabindex="-1" aria-selected="false" data-headlessui-state="">No, I do not</div>
        </div>
        <div role="listbox">
          <div role="option" aria-labelledby="radix-:rn:" aria-selected="false" data-state="unchecked" tabindex="-1" data-radix-collection-item=""><span id="radix-:rn:">Yes, Hispanic or Latino</span></div>
          <div role="option" aria-labelledby="radix-:ro:" aria-selected="true" data-state="checked" tabindex="-1" data-radix-collection-item="" data-highlighted=""><span id="radix-:ro:">No, not Hispanic or Latino</span></div>
        </div>
        <ul role="listbox">
          <li class="select2-results__option select2-results__option--selectable select2-results__option--selected select2-results__option--highlighted" id="select2-s2-result-jni4-pv" role="option" aria-selected="true">Male</li>
          <li class="select2-results__option select2-results__option--selectable" id="select2-s2-result-8wyp-nv" role="option" aria-selected="false">Female</li>
        </ul></body></html>`);
      const out = await page.evaluate(async (js) => {
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        const html = mod.trimForStorage(mod.pageHtml(document));
        const sent = new DOMParser().parseFromString(html, 'text/html');
        // Everything an option says about itself except which one it is.
        const shape = (o) =>
          [...o.attributes]
            .filter((a) => !['id', 'data-id', 'data-value', 'aria-labelledby', 'tabindex'].includes(a.name))
            .map((a) => `${a.name}=${a.value}`)
            .sort()
            .join(' ');
        return {
          html,
          lists: [...sent.querySelectorAll('[role="listbox"]')].map((list) =>
            [...list.querySelectorAll('[role="option"]')].map((o) => ({ text: o.textContent.trim(), shape: shape(o) })),
          ),
        };
      }, source);
      assert.ok(!/aria-activedescendant/.test(out.html), 'the search box still names the chosen option');
      assert.equal(out.lists.length, 6);
      for (const [first, second] of out.lists) {
        assert.ok(first.text && second.text, 'the options themselves are kept');
        assert.equal(first.shape, second.shape, `"${first.text}" is still marked apart from "${second.text}"`);
      }
    } finally {
      await browser.close();
    }
  });
});

/*
 * A review step, which writes every answer out as text beside its question.
 *
 * Workday's last step, Taleo's "Review and Submit", iCIMS's summary: no
 * inputs, no widgets, nothing any scrub above looks at — the answers are
 * ordinary text in a `<div>`, a `<dd>` or a table cell. Measured in Chromium
 * through the extension against a fake store, and then through ResumeM-M's
 * own `mergeJobPages`: the description the server built for this page, and
 * handed to the AI, read "Social Security Number 123-45-6789 … Date of Birth
 * 04/02/1999 … Gender Female … Ethnicity Asian … Disability Status Yes, I have
 * a disability".
 *
 * The labels are the shapes these systems draw a label and its answer in:
 * a label and a box beside it, a label wrapped a level deep, a definition
 * list, a table row with a header cell and one without, and a label with its
 * answer after a colon in the same text.
 */
const REVIEW_STEP = `
  <h2>Review</h2>
  <p>Helios is an equal opportunity employer. We consider applicants without regard to race, gender, disability or veteran status.</p>
  <h3>My Information</h3>
  <div><label>Legal Name</label><div>Jianwen Ding</div></div>
  <div><label>Social Security Number</label><div>ANSWER-SSN</div></div>
  <div><div class="lbl"><span>Date of Birth</span></div><div class="val">ANSWER-DOB</div></div>
  <h3>Application Questions</h3>
  <div><label>Are you legally authorized to work in the United States?</label><div>Kept: Yes</div></div>
  <div><label>Have you ever been convicted of a felony?</label><div>ANSWER-CONVICTED</div></div>
  <h3>Voluntary Disclosures</h3>
  <dl><dt>Gender</dt><dd>ANSWER-GENDER</dd><dt>Location preference</dt><dd>Kept: Boston</dd></dl>
  <table>
    <tr><th>Ethnicity</th><td>ANSWER-ETHNICITY</td></tr>
    <tr><td>Veteran Status</td><td>ANSWER-VETERAN</td></tr>
  </table>
  <p><strong>Are you Hispanic or Latino?</strong> ANSWER-HISPANIC</p>
  <p>Disability Status: ANSWER-DISABILITY</p>
  <h3>Equal Opportunity and Disability Accommodation</h3>
  <p>Kept: we provide accommodations on request.</p>
  <label for="g">Gender</label><select id="g"><option>Kept: Female</option><option>Kept: Male</option></select>`;

describe('the page as sent does not carry answers a review step writes out', () => {
  it('empties the answer beside a personal question, and leaves the rest of the page', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Review</title></head><body>${REVIEW_STEP}</body></html>`);
      const html = await page.evaluate(async (js) => {
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        return mod.trimForStorage(mod.pageHtml(document));
      }, source);
      const leaked = html.match(/ANSWER-[A-Z]+/g) ?? [];
      assert.deepEqual(leaked, [], `the review step's answers were sent: ${leaked.join(', ')}`);
      for (const kept of [
        'Social Security Number', 'Date of Birth', 'Gender', 'Ethnicity', 'Veteran Status',
        'Are you Hispanic or Latino?', 'Disability Status:', 'Have you ever been convicted of a felony?',
        'without regard to race, gender, disability or veteran status', 'Jianwen Ding',
        'Kept: Yes', 'Kept: Boston', 'Kept: we provide accommodations on request.', 'Kept: Female', 'Kept: Male',
      ]) {
        assert.ok(html.includes(kept), `"${kept}" was lost`);
      }
    } finally {
      await browser.close();
    }
  });
});

/*
 * A posting's requirements, which look exactly like a review step's answers.
 *
 * "Driver's license: Required", "Minimum age: 21", a passport over "Must
 * travel to Canada monthly": the label names one of the personal questions,
 * and the scrub above emptied whatever came after it. Measured through this
 * module on a delivery-driver posting, eight of its ten requirement lines
 * went to the AI as the label alone. Below them, a review step's answers
 * under the same labels — one of them marked "(Required)", as forms mark a
 * field — which must still go.
 */
const REQUIREMENTS = `
  <h1>Delivery Driver — Northwind Logistics</h1>
  <h2>Requirements</h2>
  <p>Driver's license: KEPT-A valid, clean record required</p>
  <p>Minimum age: KEPT-21</p>
  <dl><dt>Driver's License</dt><dd>KEPT-Class C required</dd><dt>Age</dt><dd>KEPT-18 or older</dd></dl>
  <table><tr><th>Passport</th><td>KEPT-Must travel to Canada monthly</td></tr></table>
  <ul><li><strong>Age requirement</strong> KEPT-Must be 21 or older to drive</li></ul>
  <div><span>Driver's license</span><span>KEPT-Required</span></div>
  <p>Veteran status: KEPT-Veterans encouraged to apply</p>
  <p>Age: KEPT-18+</p>
  <h2>Review your application</h2>
  <div><label>Gender (Required)</label><div>ANSWER-GENDER</div></div>
  <dl><dt>Date of Birth *</dt><dd>ANSWER-DOB</dd><dt>Age</dt><dd>ANSWER-34</dd></dl>
  <dl><dt>Age range</dt><dd>ANSWER-AGEBAND 40 and over</dd></dl>
  <p>Age: ANSWER-OVER 55 or older</p>
  <div><label>Driver's License Number</label><div>ANSWER-LICENSE</div></div>
  <p>Disability Status: ANSWER-DISABILITY No, I do not have a disability</p>`;

describe('the page as sent keeps what a posting requires', () => {
  it('keeps a requirement under a personal label, and still empties an answer under one', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Delivery Driver</title></head><body>${REQUIREMENTS}</body></html>`);
      const html = await page.evaluate(async (js) => {
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        return mod.trimForStorage(mod.pageHtml(document));
      }, source);
      const lost = [...REQUIREMENTS.matchAll(/KEPT-[^<]+/g)].map((m) => m[0].trim()).filter((fact) => !html.includes(fact));
      assert.deepEqual(lost, [], `the posting's requirements were emptied: ${lost.join(' | ')}`);
      const leaked = html.match(/ANSWER-[A-Z0-9]+/g) ?? [];
      assert.deepEqual(leaked, [], `answers were sent: ${leaked.join(', ')}`);
    } finally {
      await browser.close();
    }
  });
});

/*
 * A posting's benefits, under labels that name a personal question.
 *
 * "Disability insurance: 100% employer-paid", a "Short-term disability" row,
 * "Pregnancy and parental leave", a criminal background check "conducted
 * after an offer": each label names one of the questions whose answers the
 * scrub empties, and what the posting said about it was emptied with them —
 * all seven of these lines went to the AI as the label alone. What they name
 * is a thing the employer offers or does: insurance, leave, a check, a
 * policy. Below them, a review step's answers under the bare questions, which
 * must still go.
 */
const BENEFITS = `
  <h1>Warehouse Lead — Northwind Logistics</h1>
  <h2>Benefits</h2>
  <ul><li>Disability insurance: KEPT-100% employer-paid</li>
  <li><strong>Short-term disability</strong> KEPT-Company paid after 90 days</li>
  <li><strong>Pregnancy and parental leave</strong> KEPT-16 weeks fully paid</li></ul>
  <table><tr><th>Life &amp; disability coverage</th><td>KEPT-Basic life at 1x salary</td></tr></table>
  <p><strong>Criminal background check</strong> KEPT-conducted after an offer</p>
  <dl><dt>Gender pay equity</dt><dd>KEPT-We audit pay every year</dd><dt>Veteran hiring program</dt><dd>KEPT-Hire Heroes partner</dd></dl>
  <h2>Review your application</h2>
  <dl><dt>Disability Status</dt><dd>ANSWER-DISABILITY</dd><dt>Gender</dt><dd>ANSWER-GENDER</dd></dl>
  <p>Criminal convictions: ANSWER-CONVICTIONS</p>
  <div><label>Are you pregnant?</label><div>ANSWER-PREGNANT</div></div>`;

describe('the page as sent keeps what a posting offers', () => {
  it('keeps a benefit under a personal label, and still empties an answer under one', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Warehouse Lead</title></head><body>${BENEFITS}</body></html>`);
      const html = await page.evaluate(async (js) => {
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        return mod.trimForStorage(mod.pageHtml(document));
      }, source);
      const lost = [...BENEFITS.matchAll(/KEPT-[^<]+/g)].map((m) => m[0].trim()).filter((fact) => !html.includes(fact));
      assert.deepEqual(lost, [], `the posting's benefits were emptied: ${lost.join(' | ')}`);
      const leaked = html.match(/ANSWER-[A-Z]+/g) ?? [];
      assert.deepEqual(leaked, [], `answers were sent: ${leaked.join(', ')}`);
    } finally {
      await browser.close();
    }
  });
});

/*
 * The applicant's address and contact details, as a review step writes them.
 *
 * The scrub knew the identifiers and the equal-opportunity questions, and a
 * review step's "Address Line 1 / 12 Elm Street", "Postal Code 02115", "Email
 * Address …" and "Phone Number …" went to the server, into the posting it
 * keeps and on to the AI. An address has no shape the server could find it
 * by afterwards, so it is emptied here, by its label. The office a posting
 * names is not the applicant's, and stays.
 */
const CONTACT_REVIEW = `
  <h1>Payroll Specialist — Acme</h1>
  <p>Office address: KEPT-100 Main Street, Boston, MA 02110</p>
  <p>Location: KEPT-Boston (hybrid)</p>
  <h2>Review your application</h2>
  <div><label>Legal Name</label><div>KEPT-Jane Doe</div></div>
  <dl><dt>Address Line 1</dt><dd>ANSWER-ADDRESS</dd><dt>Address Line 2</dt><dd>ANSWER-APARTMENT</dd>
  <dt>City</dt><dd>KEPT-Somerville</dd><dt>Postal Code</dt><dd>ANSWER-POSTCODE</dd>
  <dt>Email Address</dt><dd>ANSWER-EMAIL</dd><dt>Phone Number</dt><dd>ANSWER-PHONE</dd></dl>
  <table><tr><th>Home address</th><td>ANSWER-HOME</td></tr><tr><th>ZIP code</th><td>ANSWER-ZIP</td></tr></table>
  <p>Mailing address: ANSWER-MAILING</p>
  <p>Mobile number: ANSWER-MOBILE</p>`;

describe('the page as sent does not carry the address and contact details a review step writes out', () => {
  it('empties them by their labels, and keeps the office the posting names', async () => {
    const { chromium } = await import('playwright-core');
    const { findChromium } = await import('./fixtures.mjs');
    const fsMod = await import('node:fs');
    const source = fsMod.readFileSync(new URL('../src/shared/trail.js', import.meta.url), 'utf8');
    const browser = await chromium.launch({ executablePath: findChromium(), args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setContent(`<!doctype html><html><head><title>Review</title></head><body>${CONTACT_REVIEW}</body></html>`);
      const html = await page.evaluate(async (js) => {
        const mod = await import(URL.createObjectURL(new Blob([js], { type: 'text/javascript' })));
        return mod.trimForStorage(mod.pageHtml(document));
      }, source);
      const leaked = html.match(/ANSWER-[A-Z]+/g) ?? [];
      assert.deepEqual(leaked, [], `the review step's contact details were sent: ${leaked.join(', ')}`);
      const lost = [...CONTACT_REVIEW.matchAll(/KEPT-[^<]+/g)].map((m) => m[0].trim()).filter((fact) => !html.includes(fact));
      assert.deepEqual(lost, [], `lost: ${lost.join(' | ')}`);
    } finally {
      await browser.close();
    }
  });
});
