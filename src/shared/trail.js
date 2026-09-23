/**
 * Whether two pages are the same application.
 *
 * This is the most dangerous judgement in the extension, and the only one
 * whose mistakes are invisible. Every other error announces itself: a card
 * that does not appear, a resume that will not compile, a server that is
 * down. This one produces a cover letter addressed to one company and written
 * from another company's posting, and nothing about it looks wrong until a
 * human reads it — by which point it has been sent.
 *
 * So the rules live here, apart from the browser, where they can be read in
 * one sitting and tested without one. Erring towards "no" is cheap: the pages
 * are simply not joined, and the tool works exactly as it did before any of
 * this existed.
 */

/** How long a click on "Apply" stands as a promise about the next page. */
export const EXPECTATION_MS = 5 * 60 * 1000;

export const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/*
 * Labels that are a registry's, not a company's.
 *
 * `slice(-2)` alone makes `careers.monzo.co.uk` into `co.uk`, and `co.uk` is
 * every company in Britain. Two employers' careers sites then had the same
 * root, which `sameApplication` reads as the same site — after which one
 * matching path is enough, and `/jobs` on both is one. The cover letter is
 * then written from the other employer's page, which is the failure this
 * file's own header opens with.
 *
 * The company veto cannot save it where it matters most: `trailPages` is
 * asked before the page has been analysed, so there is no company name yet.
 *
 * A short list rather than the public suffix list, because a list nobody
 * updates is worse than a rule: these are the second-level labels that exist
 * under a two-letter country, and the rule below only fires under one. Being
 * wrong here takes *more* of the host, which makes two sites look different —
 * the direction that starts a second application rather than merging two.
 */
const REGISTRY_LABEL = /^(co|com|net|org|gov|edu|ac|mil|govt|or|ne|in|sch)$/;

export const rootOf = (h) => {
  const labels = String(h ?? '').split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const last = labels[labels.length - 1];
  const under = labels[labels.length - 2];
  return labels.slice(last.length === 2 && REGISTRY_LABEL.test(under) ? -3 : -2).join('.');
};

export const pathOf = (u) => {
  try {
    return new URL(u).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return '';
  }
};

const segments = (p) => p.split('/').filter(Boolean);

/**
 * Segments that mean "this is a step of an application" rather than "this is
 * one of many jobs". Two sibling paths under `/apply/` are two steps of one
 * form; two siblings under `/jobs/` are two different jobs.
 *
 * The second line is the vocabulary a real ATS uses, which the first line —
 * the words a developer reaches for — did not have. A Workday or Greenhouse
 * application walks `/jobs/12345/apply` and then `/jobs/12345/eeo`,
 * `/documents`, `/demographics`; the sibling rule needs *both* ends to look
 * like steps, `apply` did and `eeo` did not, and a path-shaped job id is not
 * something `namesTheSameJob` can agree about. So the equal-opportunity page
 * came back `different` — the confident branch, with no chip — and the trail
 * reset there. The letter is parked and comes back; page 0 is not, so
 * everything written afterwards is written from the form rather than from the
 * description, and nothing says so.
 *
 * Safe to add because they only ever join where the other end is a step too.
 * Two jobs are never both named like form steps, which is the same rule that
 * already keeps `/careers/apply` from swallowing `/careers/vega-engineer`.
 */
const STEP_WORDS =
  /^(apply|applynow|applymanually|application|applications|form|step|steps|questions|submit|details|profile|review|eeo|demographics|disclosures|voluntary[-_]?disclosures|self[-_]?id(entification)?|documents|attachments|experience|education)$/i;

/**
 * Segments that mean a step only at the end of a path that is already a
 * posting's. `/o/platform-engineer/c/new` is Recruitee's form; `/jobs/new` on
 * its own is a listing of new jobs, so these never decide a sibling.
 */
const STEP_TAIL = /^(new|start|begin|continue|resume|upload|confirm)$/i;

/**
 * Segments that carry no meaning of their own. Every system seems to have one:
 * Workable's `/j/`, Breezy's `/p/`, Recruitee's `/o/` and `/c/`.
 */
const CONTAINER = /^[a-z]{1,2}$/i;

/**
 * The segment without its file extension.
 *
 * Taleo's steps are files rather than paths — `jobdetail.ftl` becomes
 * `application.ftl` — so without this the step that submits the application
 * looked like a different page altogether.
 */
const bare = (seg) => String(seg ?? '').replace(/\.(ftl|html?|aspx?|jsp|php|do|cfm)$/i, '');

/**
 * Query parameters that say which posting this is.
 *
 * On plenty of systems the path is the same for every job and the identity is
 * entirely in the query: every Indeed posting is `/viewjob`, every embedded
 * Greenhouse board is `/embed/job_app`, every SuccessFactors job is
 * `/careers`. Comparing paths alone made all of them one application — so
 * reading one Indeed posting and then another wrote the second up as the
 * first, which is the exact failure the host rules exist to prevent.
 *
 * `vjk` is the same story in the view most people actually read Indeed in.
 * The search results are a list on the left and the selected posting on the
 * right, all of it at `/jobs`, and which one is selected lives in `vjk` —
 * clicking down the list changes only that. It was on no list, so every job
 * in the pane was the same page as the last and the trail folded all of them
 * into one application. `/viewjob?jk=` branched correctly, which is why this
 * only ever bit in the list.
 */
const JOB_PARAM =
  /^(jk|vjk|jl|jid|job|jobid|job_id|jobreqid|career_job_req_id|opportunityid|token|gh_jid|jvi|requisitionid|reqid|req|postingid|posting_id|jobpostingid|applytojob|vacancyid|currentjobid|id|oid|pid)$/i;

const jobIds = (u) => {
  const out = new Map();
  try {
    for (const [key, value] of new URL(u).searchParams) {
      if (JOB_PARAM.test(key)) out.set(key.toLowerCase(), value);
    }
  } catch {
    // Not an address; the caller's other rules will refuse it.
  }
  return out;
};

/** Two addresses that name a job, and name different ones. */
function namesAnotherJob(a, b) {
  const theirs = jobIds(b);
  for (const [key, value] of jobIds(a)) {
    if (theirs.has(key) && theirs.get(key) !== value) return true;
  }
  return false;
}

/** Two addresses that name a job, and name the same one. */
function namesTheSameJob(a, b) {
  const theirs = jobIds(b);
  for (const [key, value] of jobIds(a)) {
    if (theirs.has(key) && theirs.get(key) === value) return true;
  }
  return false;
}

/**
 * Same site, and plainly the same posting on it rather than another one.
 *
 * The rule that was here before joined any two paths sharing a first segment,
 * which on an applicant tracking system means any two jobs at the same
 * company, and on a job board means any two jobs at all: `/jobs/view/1` and
 * `/jobs/view/2` both start `/jobs`.
 */
export function relatedPath(a, b) {
  // Before anything about paths: an address that names a different job is a
  // different job, however identical the rest of it looks.
  if (namesAnotherJob(a, b)) return false;

  const pa = pathOf(a);
  const pb = pathOf(b);
  if (!pa || !pb) return false;
  if (pa === pb) return true;

  const sa = segments(pa);
  const sb = segments(pb);
  // A root path is a prefix of the whole site and says nothing about which
  // posting this is.
  if (sa.length === 0 || sb.length === 0) return false;

  // One extends the other: /vega/8f21 → /vega/8f21/apply.
  //
  // Only when what was added is a step of an application, though. A board's
  // listing page is a prefix of every posting on it — /acme of /acme/jobs/1,
  // /jobs of /jobs/view/1 — so accepting any extension joined the listing to
  // each job opened from it, and then, through the listing, each of those jobs
  // to the next. Open two roles from one board and the second was written
  // partly from the first.
  const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (shorter.every((seg, i) => seg === longer[i])) {
    /*
     * A path that already ends in a step is already this application's form,
     * so what comes after it is a later page of that form.
     *
     * This is the rule below said from the other end, and it was the half
     * that was missing. "Anything after the step segment is that step's own
     * business" held only while the trail's page was the posting: the moment
     * somebody landed on `/jobs/1234/apply` and started typing, that address
     * went into the trail, and the form's own next page —
     * `/jobs/1234/apply/experience`, `/apply/eeo`, `/apply/documents`,
     * `/apply/12345` — was measured against it and judged a different
     * application. The work was parked and the card came up empty, one click
     * into a form the person was halfway through. Even the example in the
     * comment below is only true from the posting; from the form page it was
     * false.
     *
     * The last segment, not any segment: the claim is that this page is a
     * step, not that a step happened somewhere upstream. A later step still
     * matches through the form page already in the trail.
     */
    if (STEP_WORDS.test(bare(shorter[shorter.length - 1]))) return true;

    // The first added segment decides, once any meaningless container is out
    // of the way; anything after it is that step's own business, which is how
    // /8f21/apply/12345 stays one application.
    const added = longer.slice(shorter.length).map(bare);
    const first = added.find((seg) => !CONTAINER.test(seg));
    return Boolean(first) && (STEP_WORDS.test(first) || STEP_TAIL.test(first));
  }

  /*
   * Siblings: everything matches but the last segment. Which they are depends
   * on what they are siblings under — steps of a form, or entries in a list.
   *
   * Both ends have to look like a step, not either.
   *
   * "Either" is the rule that a shared apply page walks straight through. A
   * great many sites have one — `/careers/apply`, `/jobs/apply` — and once
   * that address is in the trail, every posting beside it is its sibling with
   * one step-ish end, so `/careers/apply` joined `/careers/vega-engineer` and
   * then `/careers/data-scientist`. Apply to one job, open another on the same
   * site, and the second came up written from the first's description,
   * carrying the first's letter. From a one-segment `/apply` it was worse
   * still: `/pricing`, `/about` and `/blog` are all its siblings too.
   *
   * The parent clause is the one that was doing the real work — `/apply/eeo`
   * beside `/apply/documents` — and it is untouched. What goes is the claim
   * that a page named `apply` makes a *different* page beside it part of the
   * same application. `/jobs/apply` and `/jobs/submit` still join, because
   * both of those are steps.
   */
  if (sa.length === sb.length && sa.slice(0, -1).every((seg, i) => seg === sb[i])) {
    const parent = bare(sa[sa.length - 2]);
    if (STEP_WORDS.test(parent)) return true;

    const stepA = STEP_WORDS.test(bare(sa[sa.length - 1]));
    const stepB = STEP_WORDS.test(bare(sb[sb.length - 1]));
    // Both ends are steps of the same form: /jobs/apply beside /jobs/submit.
    if (stepA && stepB) return true;
    /*
     * Or one end is a step and the address says which job it is a step of.
     *
     * Taleo's form is a sibling *file* of its posting —
     * `jobdetail.ftl?job=12345` then `application.ftl?job=12345` — so the
     * posting side can never be a step word, and requiring both would
     * separate a form from the job it belongs to. What makes that pair safe
     * is the `job=12345` they agree on, which is the same thing
     * `namesAnotherJob` uses to keep two Indeed postings apart.
     *
     * A shared apply page has nothing of the kind: `/careers/apply` and
     * `/careers/vega-engineer` name no job at all, so there is nothing to
     * agree about and they stay separate.
     */
    return (stepA || stepB) && namesTheSameJob(a, b);
  }
  return false;
}

/** Did the user just click a link to this page, meaning "apply"? */
export function wasExpected(trail, url, now = Date.now()) {
  const expecting = trail?.expecting;
  if (!expecting?.to || now - (expecting.at ?? 0) > EXPECTATION_MS) return false;
  if (expecting.to === url) return true;

  // An apply link routinely lands near where it pointed: a redirect through a
  // login, a tracking parameter added, a trailing slash dropped.
  const a = pathOf(expecting.to);
  const b = pathOf(url);
  if (!a || !b) return false;
  if (hostOf(expecting.to) !== hostOf(url)) return false;
  return sameOrUnder(a, b);
}

/*
 * One path is the other, or a step below it — counted in segments.
 *
 * This was `a.startsWith(b) || b.startsWith(a)`, which has no boundary in it,
 * so `/careers/data-analyst` was "near enough" to
 * `/careers/data-analyst-intern`. Ordinary slug pairs do that to each other:
 * `product-manager` and `product-manager-growth`, `platform-engineer` and
 * `platform-engineer-ii`, and the `-2` Recruitee adds to a duplicate slug. So
 * clicking Apply on one posting and then opening the next one in the same tab
 * folded the second into the first — and because an expectation is checked
 * *before* the company veto and before `relatedPath`, it overruled both of
 * the things that would have said no.
 *
 * `pathOf` strips trailing slashes, so a single `/` is the whole boundary
 * this needs. The case it is here for — an apply link landing a step below
 * where it pointed, at `/careers/data-analyst/apply` — still passes.
 */
const sameOrUnder = (a, b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/**
 * A link on a page that plainly means "apply".
 *
 * Deliberately the same words `content.js` watches clicks for. What the two
 * are asking is one question in two tenses: that one asks "are you about to
 * follow an apply link", this one asks "was there an apply link here pointing
 * at where you now are".
 */
const MEANS_APPLY = /\b(apply|application|start (your )?application|submit (your )?application|continue to apply)\b/i;

/** `<a href="…">text</a>`, near enough for markup nobody is generating to trick us. */
const ANCHOR = /<a\b([^>]*)>([\s\S]{0,200}?)<\/a>/gi;
const HREF = /href\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))/i;

/**
 * Did a page we are already holding have an apply link pointing here?
 *
 * The cross-host hand-off — a careers site handing you to an applicant
 * tracking system — is the one walk with no evidence of its own. The hosts
 * differ, so nothing about the address connects them, and the link that got
 * you there routinely carries rel="noreferrer", so there is no referrer
 * either. That left one witness: the click, reported by the content script as
 * the page is being torn down around it, which is a message racing a
 * navigation. Measured at 54-78ms to land — comfortable, until the machine is
 * busy, and then an application silently starts again at the form with the
 * description you just read left behind.
 *
 * This is the same evidence gathered before the navigation instead of during
 * it. The markup of every page in the trail is already stored; if one of them
 * held an Apply link pointing at this address, that is a fact recorded minutes
 * ago and there is nothing left to race.
 *
 * Only links that *say* apply count. A job board lists fifty postings and
 * links to all of them, and "this page linked to that page" would make any two
 * of them one application — which is the exact mistake `relatedPath` exists to
 * avoid on a single host.
 */
export function wasLinkedFrom(trail, url) {
  const target = pathOf(url);
  const host = hostOf(url);
  if (!target || !host) return false;

  for (const page of trail?.pages ?? []) {
    const html = page?.html;
    if (typeof html !== 'string' || !html) continue;
    /*
     * Cheap reject before walking every anchor on a page that can run to four
     * hundred kilobytes. Sound because every phrasing `MEANS_APPLY` accepts
     * contains "apply" or "application", and it has to appear in the href or
     * the link text either way — both of which are in this string.
     *
     * The first version of this rejected on the target's hostname not being
     * present, which is wrong for exactly the links most worth catching: a
     * relative `href="/apply/9910"` names no host at all.
     */
    if (!/appl(y|ication)/i.test(html)) continue;

    for (const [, attrs = '', text = ''] of html.matchAll(ANCHOR)) {
      const raw = HREF.exec(attrs);
      const href = raw?.[2] ?? raw?.[3] ?? raw?.[4];
      if (!href) continue;

      let absolute;
      try {
        absolute = new URL(href, page.url).href;
      } catch {
        continue;
      }
      if (hostOf(absolute) !== host) continue;
      const there = pathOf(absolute);
      // Anchored, for the reason given on `sameOrUnder`: an apply link on a
      // posting for one job must not be read as pointing at another job whose
      // slug happens to start with the same words.
      if (!there || !sameOrUnder(there, target)) continue;

      const label = text.replace(/<[^>]*>/g, ' ').trim();
      if (MEANS_APPLY.test(href) || MEANS_APPLY.test(label)) return true;
    }
  }
  return false;
}

/**
 * Is this page part of the application already being followed?
 *
 * In order of how much the evidence is worth: the click that brought you here,
 * then the company named on the page, then where the page lives.
 */
/**
 * Words in a role title that say which job it is.
 *
 * Seniority and shape are not identity: "Senior Software Engineer" and
 * "Software Engineer II" are the same job described twice, and a form page
 * that titles itself "Software Engineer (Remote) - Apply" is the same job
 * again. Stripping those leaves the words that actually name the work.
 */
const ROLE_NOISE = new Set([
  'senior', 'junior', 'staff', 'lead', 'principal', 'associate', 'entry', 'level',
  'the', 'and', 'for', 'with', 'job', 'jobs', 'role', 'position', 'opening', 'vacancy',
  'apply', 'application', 'careers', 'career', 'hiring', 'remote', 'hybrid', 'onsite',
  'full', 'part', 'time', 'contract', 'permanent', 'new', 'grad', 'graduate',
]);

const roleWords = (text) =>
  new Set(
    (String(text ?? '').toLowerCase().match(/[a-z][a-z+#.]{2,}/g) ?? []).filter((w) => !ROLE_NOISE.has(w)),
  );

/**
 * Two role titles with nothing in common — a different job, said in words.
 *
 * Deliberately conservative, and the conservatism is the point: splitting one
 * application in two halfway through its form is worse than missing a split,
 * because the URL distinguishes the real cases anyway and this is the
 * fallback for the ones where it does not. So "Platform Engineer" and "Data
 * Scientist" are different; "Platform Engineer" and "Data Engineer" are not,
 * because they still share the word that says what the work is.
 *
 * No opinion at all unless both sides name something. A page the classifier
 * could not put a role to says nothing about whether this is a new job.
 */
export function plainlyAnotherRole(a, b) {
  const mine = roleWords(a);
  const theirs = roleWords(b);
  if (mine.size === 0 || theirs.size === 0) return false;
  for (const word of mine) if (theirs.has(word)) return false;
  return true;
}

/**
 * Same application, a different one, or not clear enough to say.
 *
 * The third answer is the one this grew for. A board that keeps every posting
 * at one address — Indeed's results pane, any single-page board — leaves the
 * url saying these are the same page when the pane has been changed to a
 * different job entirely. Answering "same" there writes the second job up as
 * the first; answering "different" on such thin evidence would split an
 * ordinary application the first time a form page called itself something
 * slightly different. So it says it is unsure, and the caller asks.
 *
 * `sameApplication` below is this, read as a yes or no, for the callers whose
 * question really is binary.
 */
export function judgeApplication(trail, page, now = Date.now()) {
  /*
   * A tab told to start fresh belongs to nothing until it reads a page.
   *
   * "No pages yet" reads as "this could be anything's first page", which is
   * right for a tab that has never held an application and wrong for one that
   * was just emptied on purpose. The two were indistinguishable, and the card
   * keeps writing: its keeper re-sends the resume and the letter every two
   * seconds, so pressing "Start fresh" in the popup was undone within two
   * seconds — the trail came back holding the old job's work under no pages —
   * and the next posting opened in that tab was handed it, as "Carried over:
   * the resume, the letter". The user had pressed a button that said Forgotten
   * and been told it was.
   */
  if (trail?.cleared && !trail?.pages?.length) return 'different';
  if (!trail?.pages?.length) return 'same';
  if (!page?.url) return 'different';

  /*
   * Before any of it: an address that names a different job is a different
   * job, however it was arrived at.
   *
   * `relatedPath` says this already and said it too late to matter, because
   * the click below is checked first — and on a board the click is exactly
   * how you reach the next job. Open a posting from a list, go back, open
   * another: the expectation set by the second click vouched for a page whose
   * own url said, in the board's own parameter, that it was a different
   * requisition. The click is strong evidence about *where you went*, and no
   * evidence at all about whether it is the same job.
   */
  for (const p of trail.pages) {
    if (p?.url && namesAnotherJob(page.url, p.url)) return 'different';
  }

  const co = (c) => (c ?? '').trim().toLowerCase();
  const mine = co(page.company);
  const known = trail.pages.map((p) => co(p.company)).filter(Boolean);
  const otherEmployer = Boolean(mine) && known.length > 0 && !known.includes(mine);

  /*
   * What the page says it is, against what the trail is already about.
   *
   * Hoisted above the click, because the click needed it. A role title is the
   * weakest identity there is — forms retitle themselves, boards append the
   * company — so it says "unsure" rather than "different", and a wrong split
   * costs somebody the letter they were halfway through. But no opinion at
   * all is what let two jobs become one below.
   */
  const knownRoles = trail.pages.map((p) => p?.role).filter(Boolean);
  const looksNew = () =>
    knownRoles.length > 0 && knownRoles.every((role) => plainlyAnotherRole(page.role, role));

  /*
   * The click is the strongest evidence there is, and the only evidence left
   * when the referrer has been stripped — which plenty of sites do. It is
   * evidence about *where you went*, though, and none at all about whether
   * you went to the same job.
   *
   * `watchForApplyClicks` matches buttons as well as links, and a button has
   * no href — so the expectation it sets is the page's own address. On a
   * board that shows every job at one address, pressing "Easy Apply",
   * abandoning the modal and clicking the next job in the list therefore
   * arrived with an expectation that vouched for it. Measured against this
   * module: trail "Acme / Platform Engineer" expecting board.example/jobs,
   * page "Acme / Data Scientist" at board.example/jobs -> "same"; and with
   * the page at "Helios / Data Scientist" -> "same" as well, because the
   * company veto below had not run yet. Two employers in one application, no
   * chip, the old letter and the old resume still on the card.
   *
   * So the click still vouches, and only for what it is evidence of: a
   * plainly different employer is refused outright, a plainly different role
   * is left unsure, and everything else — a form that calls itself
   * "Application", a step with no title, the ordinary second page — joins as
   * it always did.
   */
  if (wasExpected(trail, page.url, now)) {
    if (otherEmployer) return 'different';
    return looksNew() ? 'unsure' : 'same';
  }

  // A different company is a different application, whatever else matches.
  //
  // A veto, not a grant: this used to return the match either way, so two
  // postings at the same employer were one application on the strength of the
  // name alone — no matter that they were plainly two different jobs at two
  // different addresses. The same name is a necessary condition for joining,
  // never a sufficient one; where the pages are still has to agree.
  if (otherEmployer) return 'different';

  const here = hostOf(page.url);
  if (!here) return 'different';

  for (const p of trail.pages) {
    const there = hostOf(p.url);
    if (!there) continue;

    if (here === there || rootOf(here) === rootOf(there)) {
      // Same site: only the same posting, not merely the same board.
      if (relatedPath(page.url, p.url)) return looksNew() ? 'unsure' : 'same';
      continue;
    }
    /*
     * Different site: only by having been sent there from the trail — and
     * only for the job it sent you to.
     *
     * The same-site branch above was given `looksNew()` and this one was not,
     * and a careers site is precisely where every role at an employer is
     * listed. `keepPages` always keeps the first page, so the vouching host
     * stays in the trail for its whole two-hour life: read Platform Engineer
     * on careers.acme.com, press Apply into Greenhouse, go back, click Data
     * Scientist — which careers sites link straight at the ATS posting — and
     * the referrer vouched for it. Measured against this module: trail
     * [careers.acme.com/jobs/platform-engineer, greenhouse/acme/jobs/1111],
     * page greenhouse/acme/jobs/2222 as "Data Scientist" with referrerHost
     * careers.acme.com -> "same". No chip, the Platform Engineer resume and
     * half-written letter carried over, and that description handed to
     * whatever is written next.
     *
     * The company veto could not save it: it is the same employer. So the
     * role is consulted here as it is there, on the same terms.
     */
    const cameFromHere =
      page.referrerHost && (page.referrerHost === there || rootOf(page.referrerHost) === rootOf(there));
    if (cameFromHere) return looksNew() ? 'unsure' : 'same';
  }

  /*
   * Last, and only for the hand-off with no other witness: an apply link on a
   * page already held, pointing here. Checked after everything else because it
   * is the most expensive and the least specific — and after the company veto
   * above, so a link cannot join two employers.
   *
   * On the same terms as the other three, which is what this was missing. A
   * link is evidence about *where you went* and none at all about which job
   * you went to — the same sentence the click branch above is written around
   * — and this returned a flat `same`. It is also the route that runs when
   * the referrer has been stripped, which boards do routinely with
   * `rel="noreferrer"`, so it is the least supervised rather than the rarest.
   *
   * Measured against this module: trail [careers.acme.example/openings whose
   * rows each carry an Apply link, careers.acme.example/jobs/1111 "Platform
   * Engineer"], page /jobs/2222 as "Data Scientist" -> "same", where the
   * identical situation arriving with a referrer -> "unsure". Job 2222's form
   * inside job 1111's application, "Carried over: the resume, the letter",
   * and no chip.
   *
   * The hand-off it exists for is untouched: a form that names no role of its
   * own leaves `looksNew()` false and still joins.
   */
  return wasLinkedFrom(trail, page.url) ? (looksNew() ? 'unsure' : 'same') : 'different';
}

/**
 * The same question as a yes or no, for the callers whose question is binary.
 *
 * Unsure counts as yes, which is what it meant before there was a third
 * answer: `saveWork` asks "may this card write into this trail", and a card
 * that is unsure about its own page is still the card on it.
 */
export function sameApplication(trail, page, now = Date.now()) {
  return judgeApplication(trail, page, now) !== 'different';
}

/** The trail without the page text, or the work, which the card has no use for. */
export function summarise(trail) {
  const { work, expecting, ...rest } = trail;
  return {
    ...rest,
    /*
     * Not the writing itself — the popup has no business holding a copy of the
     * letter — only whether there is any. It is the difference between "two
     * pages have been read" and "two pages have been read and your letter is
     * in here", and the second is the one that answers "did leaving the form
     * throw my work away".
     *
     * The two are reported apart because `worthKeeping` is true of a resume
     * built with nothing written yet, and telling someone their writing is
     * safe when they have not written any is the one promise here that must
     * not be made loosely.
     */
    holdingWriting: Boolean(work?.letter?.trim()) || Object.keys(work?.answersByQuestion ?? {}).length > 0,
    holdingResume: Boolean(work?.spec),
    pages: (trail.pages ?? []).map(({ html, ...page }) => ({ ...page, chars: (html ?? '').length })),
  };
}

/**
 * Cut a page down to the part worth keeping.
 *
 * Most of a modern page is script: inlined bundles, analytics, state dumps.
 * None of it is the posting, and session storage is a shared 10MB across every
 * tab — five tabs holding five pages each fills it exactly, and the sixth tab's
 * write fails. Since the only thing read back out is the description, the
 * markup that cannot contain one goes before it is stored.
 *
 * JSON-LD survives: it is inside a <script> tag and it is the single most
 * reliable source of what a posting says.
 */
/**
 * The page's markup, with what is inside its shadow roots.
 *
 * `outerHTML` stops at a shadow root, so a posting or an application form
 * drawn inside a web component — which autofill reaches and fills — was sent
 * to the server as the empty host element around it, and the letter and the
 * answers were written without the questions. Each root's markup is added
 * inside the body, marked with the element it belongs to, nested roots
 * included. Closed roots too where the extension API can open them. A page
 * with none is returned exactly as `outerHTML` has it.
 */
/*
 * Except ours. The card and the "is this a job?" chip are open shadow roots on
 * the page like any other, and the card is up before the page is first read
 * and at every rebuild after — so each page went to the server with the whole
 * card written into it: the resume's changes line by line, every button, the
 * questions it had already found, and a feedback box labelled "Anything to
 * change?" as though the posting had asked it. `allRoots` in autofill.js
 * skips the card for the same reason. By id, as there, because the hosts are
 * found by id everywhere else.
 */
const OUR_HOSTS = new Set(['jobhelper-card-host', 'jobhelper-ask-host']);

/*
 * And never the applicant's answers, which are written into the page as
 * surely as the questions are.
 *
 * `trimForStorage` scrubbed those out of the markup with regular expressions,
 * and there was one place an answer lives that no expression over markup can
 * reach: a rich-text editor. Workday, Greenhouse's newer boards and any form
 * built on Quill, ProseMirror or Draft take the long answers in a
 * `contenteditable` element, and what is typed there is ordinary paragraphs —
 * nothing marks it as typed except the attribute on an ancestor, and a regex
 * cannot find where that ancestor ends. Measured in Chromium against this
 * module: a draft essay in `<div contenteditable="true">` went to the server,
 * and on to the AI, word for word.
 *
 * So the page is copied and the copy is scrubbed while it is still a tree,
 * where "everything inside the editor" is one assignment: editors emptied,
 * textareas emptied, typed values and the marks on chosen options dropped. The
 * copy goes into a document of its own with no window behind it, so nothing
 * in it loads an image, runs a custom element's constructor or is seen by the
 * page's own observers — the live page is only ever read. Measured on a page
 * of 26,000 elements and 2.7MB, this took the capture from 17ms to 41ms,
 * nearly all of it the copy itself; the capture runs when the browser is
 * idle.
 *
 * The regex scrub in `trimForStorage` stays, as the second layer and for
 * markup that did not come from here.
 */
const EDITABLE = new Set(['', 'true', 'plaintext-only']);
const ANSWERS = 'input, textarea, option, [contenteditable], [aria-checked], [aria-selected], [aria-pressed]';

/*
 * And the answer a select widget draws once something is picked in it.
 *
 * Dropping `selected` and `aria-selected` is the whole story for a native
 * <select>, and the self-identification step rarely has one any more. Its
 * gender, race, veteran and disability questions are drawn by a widget, and
 * the widget writes the pick out as plain text beside the question — which
 * nothing above touches. Measured in Chromium against this module, with each
 * library's own markup after an option was clicked: react-select's
 * `select__single-value` and its "option Female, selected." live region, MUI's
 * `MuiSelect-select`, Headless UI's and Workday's listbox button, Radix's
 * trigger, select2's `select2-selection__rendered` and Choices.js's chosen
 * item all went to the server, and on to the AI, with the answer in them.
 *
 * So each of those places is emptied, with the attributes that repeat the
 * pick: select2's `title`, Choices.js's `data-value`, the "Remove Asian" label
 * on a chip's close button, which goes with the chip. The classes are the
 * libraries' own, not a guess at what a chip looks like — react-select's
 * `__single-value` and `__multi-value` under any class prefix, and its
 * emotion `-singleValue` and `-multiValue` names when it has none; MUI's
 * chips only inside a Select or as an Autocomplete tag. A posting's own
 * "Location: Remote" chip is a `MuiChip-root` too, and is left alone. The
 * question stays, because it is a label outside the widget; so does any list
 * of options that is not the pick, like Choices.js's dropdown. On a page of
 * 20,800 elements and 2.7MB the extra pass cost about 3ms where nothing
 * matched, and about 12ms with 2,600 widgets to empty.
 */
const SHOWN_CHOICE = [
  '[class*="__single-value"]',
  '[class*="-singleValue"]',
  '[class*="__multi-value"]',
  '[class*="-multiValue"]',
  '[id="aria-selection"]',
  '[id="aria-focused"]',
  '.MuiSelect-select',
  '.MuiAutocomplete-tag',
  'button[aria-haspopup="listbox"]',
  'button[role="combobox"]',
  '.select2-selection__rendered',
  '.choices__list--single',
  '.choices__list--multiple',
].join(', ');
const REPEATS_CHOICE = ['title', 'aria-label', 'data-value', 'value'];

/*
 * And which option in a list is the pick.
 *
 * `aria-selected` was never the only mark. Each library puts state of its own
 * on the chosen option, and in the list the options are the question, so the
 * pick is plain to anyone comparing one option with the next. Choices.js keeps
 * its dropdown in the page whether it is open or not, with `is-selected` and
 * `is-highlighted` on the answer and the search box's `aria-activedescendant`
 * naming it by id; react-select (`__option--is-selected`), MUI
 * (`Mui-selected`), Headless UI (`data-headlessui-state="… selected"`,
 * `data-selected`), Radix (`data-state="checked"`) and select2
 * (`select2-results__option--selected`) mark it while the menu is open, which
 * is when the page is read if the applicant is in the middle of choosing.
 * Measured in Chromium by reopening each menu after a pick. The focus and
 * highlight marks go too, because a menu reopens with them on the pick, and
 * so does an emotion `css-…` class: react-select styles the pick differently,
 * so its generated class name is a different hash from its neighbours'. Only
 * on `role="option"`, so nothing but a list's options is touched.
 */
const OPTION_STATE_ATTRS = ['data-state', 'data-selected', 'data-headlessui-state', 'data-active', 'data-focus', 'data-highlighted'];
const OPTION_STATE_CLASS = /selected|highlighted|focused|focusvisible|^css-/i;

function scrubCopy(root) {
  for (const el of root.querySelectorAll(SHOWN_CHOICE)) {
    el.textContent = '';
    for (const name of REPEATS_CHOICE) el.removeAttribute(name);
  }
  for (const el of root.querySelectorAll('[role="option"], [aria-activedescendant]')) {
    el.removeAttribute('aria-activedescendant');
    if (el.getAttribute('role') !== 'option') continue;
    for (const name of OPTION_STATE_ATTRS) el.removeAttribute(name);
    for (const token of [...el.classList]) if (OPTION_STATE_CLASS.test(token)) el.classList.remove(token);
  }
  for (const el of root.querySelectorAll(ANSWERS)) {
    if (el.localName === 'input') {
      if (!NAMES_ITSELF.test(el.type)) el.removeAttribute('value');
      el.removeAttribute('checked');
    } else if (el.localName === 'textarea') {
      el.textContent = '';
    } else if (el.localName === 'option') {
      el.removeAttribute('selected');
    }
    if (EDITABLE.has(el.getAttribute('contenteditable')?.trim().toLowerCase())) el.textContent = '';
    el.removeAttribute('aria-checked');
    el.removeAttribute('aria-selected');
    el.removeAttribute('aria-pressed');
  }
  return root;
}

export function pageHtml(doc = document) {
  const inert = doc.implementation.createHTMLDocument('');
  const copyOf = (node) => scrubCopy(inert.importNode(node, true));
  const extra = [];
  const seen = new Set();
  const rootOf = (el) => {
    if (OUR_HOSTS.has(el.id)) return null;
    if (el.shadowRoot) return el.shadowRoot;
    try {
      return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(el) ?? null;
    } catch {
      return null;
    }
  };
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      const shadow = rootOf(el);
      if (!shadow || seen.has(shadow)) continue;
      seen.add(shadow);
      const box = inert.createElement('div');
      box.setAttribute('data-shadow-host', el.localName);
      for (const child of shadow.childNodes) box.append(inert.importNode(child, true));
      extra.push(scrubCopy(box).outerHTML);
      walk(shadow);
    }
  };
  walk(doc);
  const html = copyOf(doc.documentElement).outerHTML;
  if (extra.length === 0) return html;
  const at = html.lastIndexOf('</body>');
  return at < 0 ? html + extra.join('') : html.slice(0, at) + extra.join('') + html.slice(at);
}

/*
 * The inside of a tag, where a quoted attribute may hold a `>` of its own.
 * Each alternative starts with a different character, so there is nothing to
 * backtrack over.
 */
const TAG_BODY = String.raw`(?:[^>"']|"[^"]*"|'[^']*')*`;

/* One attribute: its name, and its value in any of the three spellings. */
const ATTRIBUTE = /\s+([^\s"'>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g;

/* Inputs whose value is the option's own name rather than what was typed. */
const NAMES_ITSELF = /^(?:radio|checkbox|submit|button|reset|image)$/i;

const unquote = (raw = '') => raw.replace(/^(["'])([\s\S]*)\1$/, '$2').trim();

/*
 * An `<input>` or `<option>` tag without the applicant's answer in it. The
 * first `type` wins, as it does for the browser.
 */
function scrubTag(tag) {
  const input = /^<input\b/i.test(tag);
  let type = '';
  if (input) {
    for (const [, name, raw] of tag.matchAll(ATTRIBUTE)) {
      if (name.toLowerCase() === 'type') {
        type = unquote(raw);
        break;
      }
    }
  }
  const keepValue = NAMES_ITSELF.test(type);
  return tag.replace(ATTRIBUTE, (whole, name) => {
    const n = name.toLowerCase();
    if (n === 'checked' || n === 'selected') return '';
    if (input && n === 'value' && !keepValue) return '';
    return whole;
  });
}

export function trimForStorage(html, limit = 400_000) {
  const text = String(html ?? '')
    // Keep ld+json, drop every other script.
    .replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    /*
     * What the applicant typed, and which of the options they chose.
     *
     * React keeps an input's `value` attribute in step with what is typed, so
     * a form captured after filling carried the SSN, the date of birth and
     * the address in its markup, to the server and on to the AI. Radio,
     * checkbox and button values are the options' own names and stay; a
     * textarea keeps its tag and loses its text.
     *
     * The chosen option is their answer as surely as a typed one. The options
     * stay — they are the question — but the mark on the chosen one goes: a
     * server-rendered step carries `checked` and `selected` on what was
     * answered. On the voluntary self-identification step that is the
     * applicant's gender, race, disability and veteran status, sent to the
     * server and on to the AI beside a question they were entitled to
     * decline.
     *
     * `pageHtml` now builds its markup from a scrubbed copy of the page, so
     * for the page itself this is the second layer; it stays for any caller
     * that hands over markup it did not get from there. And it reads the tag
     * attribute by attribute, because the version before read it with
     * `[^>]*` and `\btype=`, and both lied. A `>` inside a quoted attribute —
     * `data-x="a>b"`, or a typed `1 > 2` — ended the "tag" early, so the
     * `value` after it was never looked at and went out whole. And `\b`
     * matches after a hyphen, so `data-type="checkbox"` on a text box read as
     * a checkbox and kept what was typed in it. Measured against this module:
     * `<input type="text" data-x="a>b" value="SECRET">`,
     * `<input data-type="checkbox" value="SECRET">` and
     * `<input type=text value="1 > 2 SECRET">` all came out with the secret.
     */
    .replace(new RegExp(`<(?:input|option)\\b${TAG_BODY}>`, 'gi'), scrubTag)
    .replace(new RegExp(`(<textarea\\b${TAG_BODY}>)[\\s\\S]*?(<\\/textarea>)`, 'gi'), '$1$2')
    // Every ARIA group carries `aria-checked="true"` on its pick.
    .replace(/\saria-(?:checked|selected|pressed)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * The same trail, carrying less.
 *
 * Used when a write is refused for want of room: rather than failing — which
 * showed up as the trail quietly not working — the oldest pages give up their
 * text first, since the page you are on and the one before it are the ones
 * that matter. A trail with no text at all still names its pages, which is
 * enough for the card to say what it is doing.
 */
export function lighten(trail, keepTextFor = 2) {
  const pages = trail.pages ?? [];
  if (keepTextFor < 1) return { ...trail, pages: pages.map((p) => ({ ...p, html: '' })) };

  /*
   * The first page keeps its text, and the newest fill the rest.
   *
   * This used to shed the oldest first, on the reasoning that "the page you
   * are on and the one before it are the ones that matter" — which is the
   * argument `keepPages` a few lines down exists to refute, in as many words:
   * page zero is the *description*, "the only page that holds what the job
   * actually is, and the one the cover letter and the essay answers are
   * written from". Everything after it is form steps.
   *
   * So the two halves of the same module disagreed, and the disagreement only
   * showed under the condition this function is for. A trail too large to
   * store went through `lighten`, which blanked page zero and kept
   * `/apply/eeo` and `/apply/documents` — and the letter was then written
   * from the fields it was about to be pasted into, which is the failure
   * `keepPages` was written to prevent, arrived at by the other route.
   */
  const keep = new Set([0]);
  for (let i = pages.length - 1; i >= 0 && keep.size < keepTextFor; i -= 1) keep.add(i);
  return {
    ...trail,
    pages: pages.map((p, i) => (keep.has(i) ? p : { ...p, html: '' })),
  };
}

/**
 * Which pages survive when an application has more of them than the trail
 * holds.
 *
 * Not simply the newest, which is what `pages.slice(-max)` did. An
 * application is a description and then a form, and on the systems that
 * paginate — Workday, Taleo, a government portal — the form is four or five
 * steps on its own. So the page that gets pushed out first is the first one,
 * which is the *description*: the only page that holds what the job actually
 * is, and the one the cover letter and the essay answers are written from.
 * Everything left is a list of form steps, and the letter is then written
 * from the fields it is about to be pasted into.
 *
 * That is the failure this whole module exists to prevent — its own header
 * says so: "the description that would answer them is on the page you just
 * left". It simply took six pages instead of two.
 *
 * So the first page is kept and the newest fill the rest. The merge on the
 * server takes the role and the company from the first page that knows them,
 * which is the same page for the same reason.
 */
export function keepPages(pages, max) {
  const all = pages ?? [];
  if (max < 1) return [];
  if (all.length <= max) return all;
  return [all[0], ...all.slice(-(max - 1))];
}

/**
 * Is there anything in this worth keeping?
 *
 * The card saves on an interval, and a card that has not managed to analyse
 * its page — because the server went away, say — has nothing in it. Saving
 * that over the work from the page before is how a built resume disappeared
 * while its own tab sat there showing an error it had already recovered from.
 */
export function worthKeeping(work) {
  if (!work) return false;
  return Boolean(work.spec) || Boolean(work.letter?.trim()) || Object.keys(work.answersByQuestion ?? {}).length > 0;
}
