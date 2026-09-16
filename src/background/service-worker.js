/**
 * The service worker owns every call to the ResumeM-M server. Content scripts
 * run in the page's origin, so routing requests through here keeps loopback
 * traffic out of the page's reach and gives one place to report a server that
 * is not running.
 */

import { DEFAULTS, getSettings } from '../shared/config.js';

async function serverFetch(path, options = {}) {
  const { serverUrl } = await getSettings();
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;

  let res;
  try {
    res = await fetch(url, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
    });
  } catch (cause) {
    throw new Error(
      `Can't reach ResumeM-M at ${serverUrl}. Start it with \`npm run serve\` in the ResumeM-M folder.`,
      { cause },
    );
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body;
}

/* ------------------------------------------------------------------ *
 * The trail: one application, across the pages it is spread over       *
 * ------------------------------------------------------------------ */

/**
 * An application is rarely one page. You read the description on a careers
 * site, follow "Apply" to a form on a different host, and the form is where
 * the cover letter and the essay questions are — by which point the
 * description that would answer them is on the page you just left.
 *
 * So pages are kept as you walk them. The trail lives in session storage: it
 * is about this sitting, not a preference, and it should not follow you into
 * next week. A page joins when the card appears on it and it plausibly belongs
 * to the same application as the trail so far; anything else starts a new one.
 */
const TRAIL_KEY = 'trail';
const TRAIL_MAX = 5;
/**
 * How much of each earlier page to keep.
 *
 * The page you are on is sent whole; the ones behind it are kept only so their
 * description can be read again, and session storage is not a place to put
 * five copies of a two-megabyte bundle. A posting that does not fit in this is
 * a posting whose first 400kB is the posting.
 */
const TRAIL_HTML_MAX = 400_000;
/** Older than this and it is a different sitting, whatever the host says. */
const TRAIL_STALE_MS = 2 * 60 * 60 * 1000;
/** How long a click on "Apply" stands as a promise about the next page. */
const EXPECTATION_MS = 5 * 60 * 1000;

const session = () => chrome.storage.session ?? chrome.storage.local;

async function readTrail() {
  const stored = (await session().get(TRAIL_KEY))[TRAIL_KEY];
  if (!stored?.pages?.length) return { pages: [] };
  if (Date.now() - (stored.at ?? 0) > TRAIL_STALE_MS) return { pages: [] };
  return stored;
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};
const rootOf = (h) => h.split('.').slice(-2).join('.');
const pathOf = (u) => {
  try {
    return new URL(u).pathname;
  } catch {
    return '';
  }
};

/** Same host, and plainly the same posting on it rather than another one. */
function relatedPath(a, b) {
  const pa = pathOf(a);
  const pb = pathOf(b);
  if (!pa || !pb) return false;
  if (pa === pb || pa.startsWith(pb) || pb.startsWith(pa)) return true;

  // An applicant tracking system hosts thousands of companies under one
  // domain, so the host says nothing; the first path segment is the company.
  const first = (p) => p.split('/').filter(Boolean)[0] ?? '';
  return first(pa) !== '' && first(pa) === first(pb);
}

/**
 * Is this page part of the application already being followed?
 *
 * Getting this wrong in the generous direction is worse than not following at
 * all: a cover letter written from two different companies' postings is
 * nonsense, and nothing about it would look wrong until a human read it. So
 * the company decides wherever it is known, and where it is not, a page has to
 * have been arrived at from the trail — following "Apply" from a careers page
 * to its ATS is the case this exists for, and it is also the only case where
 * two unrelated hosts should ever be joined up.
 */
/** Did the user just click a link to this page, meaning "apply"? */
function wasExpected(trail, url) {
  const expecting = trail.expecting;
  if (!expecting?.to || Date.now() - (expecting.at ?? 0) > EXPECTATION_MS) return false;
  if (expecting.to === url) return true;

  // An apply link routinely lands somewhere near where it pointed: a redirect
  // to a login, a tracking parameter added, a trailing slash dropped.
  try {
    const a = new URL(expecting.to);
    const b = new URL(url);
    return a.hostname === b.hostname && (a.pathname.startsWith(b.pathname) || b.pathname.startsWith(a.pathname));
  } catch {
    return false;
  }
}

function sameApplication(trail, page) {
  if (trail.pages.length === 0) return true;

  // The click that brought you here is better evidence than anything the page
  // can show, and it is the only evidence left when the referrer is stripped.
  if (wasExpected(trail, page.url)) return true;

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

    const cameFromHere =
      page.referrerHost && (page.referrerHost === there || rootOf(page.referrerHost) === rootOf(there));

    // Same site: only if it is the same posting, not merely the same board.
    if (here === there || rootOf(here) === rootOf(there)) {
      if (relatedPath(page.url, p.url)) return true;
      continue;
    }
    // Different site: only by having been sent there from the trail.
    if (cameFromHere) return true;
  }
  return false;
}

/** The trail without the page text, which nothing but the server wants. */
function summarise(trail) {
  const { work, expecting, ...rest } = trail;
  return {
    ...rest,
    pages: trail.pages.map(({ html, ...page }) => ({ ...page, chars: (html ?? '').length })),
  };
}

/** Message handlers, one per action the content script or popup can request. */
const handlers = {
  /**
   * Add the page to the current application, or start a new one with it.
   * Returns the trail as it now stands, so the card can show it.
   */
  async rememberPage({ page }) {
    const trail = await readTrail();
    const joins = sameApplication(trail, page);
    const pages = joins ? trail.pages.filter((p) => p.url !== page.url) : [];

    pages.push({
      url: page.url,
      title: page.title,
      company: page.company,
      kind: page.kind,
      html: (page.html ?? '').slice(0, TRAIL_HTML_MAX),
      at: Date.now(),
    });

    const next = { pages: pages.slice(-TRAIL_MAX), at: Date.now() };
    await session().set({ [TRAIL_KEY]: next });
    return { ...summarise(next), startedFresh: !joins };
  },

  async getTrail() {
    return summarise(await readTrail());
  },

  /**
   * Keep the work done on this page, so the next page of the same application
   * does not start from nothing.
   *
   * Clicking "Apply" is a navigation, and a navigation destroys the card. The
   * resume you built and the letter you drafted were gone at exactly the
   * moment the form appeared to put them in, which made the tool feel like it
   * had forgotten what you were doing — because it had.
   */
  async saveWork({ work }) {
    const trail = await readTrail();
    await session().set({ [TRAIL_KEY]: { ...trail, work, at: Date.now() } });
    return { ok: true };
  },

  /** The work from the pages before this one, if this page continues them. */
  async takeWork({ page }) {
    const trail = await readTrail();
    if (page && !sameApplication(trail, page)) return { work: null };
    return { work: trail.work ?? null };
  },

  /**
   * "The next page is part of this application."
   *
   * Said by the content script when a link that plainly means apply is
   * clicked. Referrers are stripped by plenty of sites and by every
   * rel="noreferrer" link, and an Apply button often opens a new tab — so the
   * evidence that two pages belong together can be gone by the time the second
   * one loads. The click is the evidence, and it is available before that.
   */
  async expectContinuation({ to }) {
    const trail = await readTrail();
    await session().set({
      [TRAIL_KEY]: { ...trail, expecting: { to, at: Date.now() }, at: Date.now() },
    });
    return { ok: true };
  },

  /**
   * The earlier pages that belong to the application this page is part of.
   *
   * Asked before the page is analysed, not after: whether a page belongs is a
   * fact about the page, and deciding it from the merged analysis meant the
   * merge decided its own inputs. Two unrelated postings on one host were
   * quietly written up as one job, and nothing about the result looked wrong.
   */
  async trailPages({ page }) {
    const trail = await readTrail();
    if (page && !sameApplication(trail, page)) return { pages: [] };
    return { pages: trail.pages.map((p) => ({ url: p.url, title: p.title, html: p.html })) };
  },

  /** Forget the trail — "this is a different application from the last one". */
  async clearTrail() {
    await session().remove(TRAIL_KEY);
    return { pages: [] };
  },

  /** Drop one page the user says does not belong. */
  async forgetPage({ url }) {
    const trail = await readTrail();
    const next = { pages: trail.pages.filter((p) => p.url !== url), at: Date.now() };
    await session().set({ [TRAIL_KEY]: next });
    return summarise(next);
  },

  async ping() {
    const { serverUrl } = await getSettings();
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
    return res.json();
  },

  /**
   * Whether AI is actually in play, which two switches decide: this extension's
   * `useAi`, and `ai.enabled` on the ResumeM-M server. Either one off means
   * nothing is sent to an AI — and the case where they disagree is the one
   * worth naming, since flipping the extension's switch alone does nothing.
   */
  async aiStatus() {
    const { useAi, serverUrl } = await getSettings();
    let server;
    try {
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
      server = await res.json();
    } catch {
      return { active: false, useAi, reachable: false, serverEnabled: false, state: 'offline' };
    }

    // Older servers do not report it; treat unknown as off rather than
    // claiming an AI is running when we cannot tell.
    const serverEnabled = Boolean(server?.ai?.enabled);
    // Whether there is anything to switch on. "Switched off" and "never set
    // up" are different problems with different fixes, and saying "off" for
    // both is why turning it on was a hunt.
    const configured = server?.ai?.configured ?? Boolean(server?.ai?.command);

    const state = !configured ? 'unconfigured' : !useAi ? 'off' : serverEnabled ? 'on' : 'server-off';
    return {
      active: state === 'on',
      state,
      useAi,
      reachable: true,
      serverEnabled,
      configured,
      command: server?.ai?.command,
    };
  },

  /**
   * Turn ResumeM-M's own AI switch on or off from here.
   *
   * Two switches have to agree before anything is sent to an AI, and until now
   * only one of them was reachable from the browser: ticking this extension's
   * box while the server's was off did nothing, and the only clue was a line
   * of small print naming a tab in another window. The switch that needs
   * flipping should be under the hand that is reaching for it.
   */
  async setAiEnabled({ enabled }) {
    await serverFetch('/api/config', {
      method: 'PUT',
      body: JSON.stringify({ ai: { enabled: Boolean(enabled) } }),
    });
    return handlers.aiStatus();
  },

  async getSettings() {
    return getSettings();
  },

  async setSettings({ patch }) {
    await chrome.storage.sync.set(patch);
    return getSettings();
  },

  async listResumes() {
    return serverFetch('/api/resumes');
  },

  /**
   * Analyse a page and get back a proposed tailored resume spec.
   *
   * `useAi` may be passed per call, which is how the card offers "build from
   * the base" and "let the AI decide what to change" as two deliberate
   * choices rather than one hidden setting. Omitted, it falls back to the
   * stored preference.
   */
  async analyze({ url, title, html, pages, useAi }) {
    const settings = await getSettings();
    return serverFetch('/api/extension/analyze', {
      method: 'POST',
      body: JSON.stringify({
        url,
        title,
        html,
        // Every page of this application, not just the one in front of you.
        // Forgetting to pass this on is invisible: the analysis still works,
        // it is just written from the wrong half of what was read.
        pages,
        baseResumeId: settings.baseResumeId,
        useAi: typeof useAi === 'boolean' ? useAi : settings.useAi,
      }),
    });
  },

  /** Compile a proposed spec so the user can look at it before committing. */
  async render({ spec }) {
    const result = await serverFetch('/api/render', {
      method: 'POST',
      body: JSON.stringify({ spec }),
    });
    const { serverUrl } = await getSettings();
    return { ...result, absolutePdfUrl: `${serverUrl.replace(/\/$/, '')}${result.pdfUrl}` };
  },

  /**
   * Re-tailor with the user's own words folded in. Feedback goes to the AI
   * path because a sentence of intent is exactly what tag matching cannot use.
   */
  async refine({ spec, feedback, job }) {
    return serverFetch('/api/ai/tailor', {
      method: 'POST',
      body: JSON.stringify({
        resumeId: spec.extends ?? spec.id,
        job: { ...job, jobDescription: `${job.jobDescription}\n\n## The applicant's instructions\n${feedback}` },
      }),
    });
  },

  /** Save a phrasing the user accepted from a suggestion. */
  async addVariant({ entryId, bulletId, variant }) {
    return serverFetch(`/api/entries/${encodeURIComponent(entryId)}/bullets/${encodeURIComponent(bulletId)}/variants`, {
      method: 'POST',
      body: JSON.stringify({ ...variant, suggested: true }),
    });
  },

  /** Write the application folder and record it in the tracker. */
  async bundle(payload) {
    return serverFetch('/api/applications/bundle', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  },

  /**
   * Fetch a compiled PDF as bytes, so the card can draw it on the page it is
   * sitting on. The fetch has to happen here: a job board served over https
   * cannot pull http://127.0.0.1 itself, and the whole point is not to send
   * the user to another tab to look at their own resume.
   */
  async pdfBytes({ url }) {
    const { serverUrl } = await getSettings();
    const absolute = url.startsWith('http') ? url : `${serverUrl.replace(/\/$/, '')}${url}`;
    const res = await fetch(absolute);
    if (!res.ok) throw new Error(`Could not load the PDF (${res.status})`);

    // Messaging is JSON, so the bytes travel as base64. A one-page resume is
    // ~30KB, which is nothing; chunked to keep the argument list sane.
    const buffer = new Uint8Array(await res.arrayBuffer());
    let binary = '';
    for (let i = 0; i < buffer.length; i += 8192) {
      binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
    }
    return { base64: btoa(binary) };
  },

  async autofillData() {
    return serverFetch('/api/autofill');
  },

  /** Pair page questions with whatever the answer bank already holds. */
  async matchAnswers({ questions }) {
    return serverFetch('/api/answers/match', {
      method: 'POST',
      body: JSON.stringify({ questions }),
    });
  },

  /** Answer one question, reusing a stored answer unless asked to redraft. */
  async answerQuestion({ question, force }) {
    return serverFetch('/api/ai/answer', {
      method: 'POST',
      body: JSON.stringify({ question, force }),
    });
  },

  async saveAnswer({ question, answer, itemId }) {
    return serverFetch('/api/answers/save', {
      method: 'POST',
      body: JSON.stringify({ question, answer, itemId }),
    });
  },

  /**
   * Draft a cover letter. The server returns the relevant previous letters
   * whether or not the AI runs, so there is always something to start from.
   */
  async coverLetter({ spec, job }) {
    return serverFetch('/api/ai/cover-letter', {
      method: 'POST',
      body: JSON.stringify({
        resumeId: spec.extends ?? spec.id,
        job: {
          jobTitle: job.title,
          company: job.company,
          jobDescription: job.description ?? '',
          url: job.url,
        },
      }),
    });
  },

  async saveLetter({ body, job }) {
    const id = `${new Date().toISOString().slice(0, 10)}-${(job.company ?? 'letter')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30)}`;
    return serverFetch(`/api/letters/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify({
        id,
        title: `${job.title ?? 'Role'} — ${job.company ?? 'Unknown'}`,
        company: job.company,
        role: job.title,
        createdAt: new Date().toISOString(),
        body,
      }),
    });
  },

  /**
   * Hand the application over to ResumeM-M and return a link straight to it.
   * A browser sidebar is fine for picking a resume and wrong for writing three
   * paragraphs; this is the door between the two.
   */
  async openWorkspace(payload) {
    const result = await serverFetch('/api/workspace', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const { serverUrl } = await getSettings();
    return { ...result, absoluteUrl: `${serverUrl.replace(/\/$/, '')}${result.url}` };
  },

  /** Open the editor in a new tab, focused on this draft. */
  async openTab({ url }) {
    const tab = await chrome.tabs.create({ url });
    return { id: tab.id };
  },

  async trackStatus({ id, status, note }) {
    return serverFetch(`/api/applications/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      body: JSON.stringify({ status, note }),
    });
  },
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message "${message?.type}"` });
    return false;
  }
  handler(message.payload ?? {})
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: err.message }));
  // Keeps the message channel open for the async response above.
  return true;
});

chrome.runtime.onInstalled.addListener(async () => {
  // Seed defaults so the popup has something to show on first open.
  const current = await chrome.storage.sync.get(null);
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([k]) => !(k in current)),
  );
  if (Object.keys(missing).length > 0) await chrome.storage.sync.set(missing);
});
