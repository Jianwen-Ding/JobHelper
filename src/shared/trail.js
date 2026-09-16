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
const STEP_WORDS = /^(apply|application|applications|form|step|steps|questions|submit|details|profile|review)$/i;

/**
 * Same site, and plainly the same posting on it rather than another one.
 *
 * The rule that was here before joined any two paths sharing a first segment,
 * which on an applicant tracking system means any two jobs at the same
 * company, and on a job board means any two jobs at all: `/jobs/view/1` and
 * `/jobs/view/2` both start `/jobs`.
 */
export function relatedPath(a, b) {
  const pa = pathOf(a);
  const pb = pathOf(b);
  if (!pa || !pb) return false;
  if (pa === pb) return true;

  const sa = segments(pa);
  const sb = segments(pb);
  // A root path is a prefix of the whole site and says nothing about which
  // posting this is.
  if (sa.length === 0 || sb.length === 0) return false;

  // One extends the other: /vega/8f21 → /vega/8f21/apply. This is the ordinary
  // shape, and the one worth being confident about.
  const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  if (shorter.every((seg, i) => seg === longer[i])) return true;

  // Siblings: everything matches but the last segment. Which they are depends
  // on what they are siblings under — steps of a form, or entries in a list.
  if (sa.length === sb.length && sa.slice(0, -1).every((seg, i) => seg === sb[i])) {
    const parent = sa[sa.length - 2] ?? '';
    return STEP_WORDS.test(parent) || STEP_WORDS.test(sa[sa.length - 1]) || STEP_WORDS.test(sb[sb.length - 1]);
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
  if (mine && known.length > 0) return known.includes(mine);

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
  return false;
}

/** The trail without the page text, or the work, which the card has no use for. */
export function summarise(trail) {
  const { work, expecting, ...rest } = trail;
  return {
    ...rest,
    pages: (trail.pages ?? []).map(({ html, ...page }) => ({ ...page, chars: (html ?? '').length })),
  };
}
