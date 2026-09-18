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

export const rootOf = (h) => h.split('.').slice(-2).join('.');

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
 */
const STEP_WORDS =
  /^(apply|applynow|applymanually|application|applications|form|step|steps|questions|submit|details|profile|review)$/i;

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
 */
const JOB_PARAM =
  /^(jk|jl|jid|job|jobid|job_id|jobreqid|career_job_req_id|opportunityid|token|gh_jid|jvi|requisitionid|reqid|req|postingid|posting_id|vacancyid|currentjobid|id|oid|pid)$/i;

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
    // The first added segment decides, once any meaningless container is out
    // of the way; anything after it is that step's own business, which is how
    // /8f21/apply/12345 stays one application.
    const added = longer.slice(shorter.length).map(bare);
    const first = added.find((seg) => !CONTAINER.test(seg));
    return Boolean(first) && (STEP_WORDS.test(first) || STEP_TAIL.test(first));
  }

  // Siblings: everything matches but the last segment. Which they are depends
  // on what they are siblings under — steps of a form, or entries in a list.
  if (sa.length === sb.length && sa.slice(0, -1).every((seg, i) => seg === sb[i])) {
    const parent = bare(sa[sa.length - 2]);
    return (
      STEP_WORDS.test(parent) ||
      STEP_WORDS.test(bare(sa[sa.length - 1])) ||
      STEP_WORDS.test(bare(sb[sb.length - 1]))
    );
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
  return a.startsWith(b) || b.startsWith(a);
}

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
      if (!there || !(there === target || target.startsWith(there) || there.startsWith(target))) continue;

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
export function sameApplication(trail, page, now = Date.now()) {
  if (!trail?.pages?.length) return true;
  if (!page?.url) return false;

  // The click is the strongest evidence there is, and the only evidence left
  // when the referrer has been stripped — which plenty of sites do.
  if (wasExpected(trail, page.url, now)) return true;

  const co = (c) => (c ?? '').trim().toLowerCase();
  const mine = co(page.company);
  const known = trail.pages.map((p) => co(p.company)).filter(Boolean);

  // A different company is a different application, whatever else matches.
  //
  // A veto, not a grant: this used to return the match either way, so two
  // postings at the same employer were one application on the strength of the
  // name alone — no matter that they were plainly two different jobs at two
  // different addresses. The same name is a necessary condition for joining,
  // never a sufficient one; where the pages are still has to agree.
  if (mine && known.length > 0 && !known.includes(mine)) return false;

  const here = hostOf(page.url);
  if (!here) return false;

  for (const p of trail.pages) {
    const there = hostOf(p.url);
    if (!there) continue;

    if (here === there || rootOf(here) === rootOf(there)) {
      // Same site: only the same posting, not merely the same board.
      if (relatedPath(page.url, p.url)) return true;
      continue;
    }
    // Different site: only by having been sent there from the trail.
    const cameFromHere =
      page.referrerHost && (page.referrerHost === there || rootOf(page.referrerHost) === rootOf(there));
    if (cameFromHere) return true;
  }

  /*
   * Last, and only for the hand-off with no other witness: an apply link on a
   * page already held, pointing here. Checked after everything else because it
   * is the most expensive and the least specific — and after the company veto
   * above, so a link cannot join two employers.
   */
  return wasLinkedFrom(trail, page.url);
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
export function trimForStorage(html, limit = 400_000) {
  const text = String(html ?? '')
    // Keep ld+json, drop every other script.
    .replace(/<script\b(?![^>]*application\/ld\+json)[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
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
  const cut = Math.max(pages.length - keepTextFor, 0);
  return {
    ...trail,
    pages: pages.map((p, i) => (i < cut ? { ...p, html: '' } : p)),
  };
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
