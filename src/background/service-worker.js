/**
 * The service worker owns every call to the ResumeM-M server. Content scripts
 * run in the page's origin, so routing requests through here keeps loopback
 * traffic out of the page's reach and gives one place to report a server that
 * is not running.
 */

import { DEFAULTS, getSettings } from '../shared/config.js';
import {
  lighten,
  sameApplication,
  summarise,
  trimForStorage,
  wasExpected,
  worthKeeping,
} from '../shared/trail.js';

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
    // Marked, so the card can offer the way out rather than only naming the
    // problem. The text still has to stand on its own: it is what a user sees
    // if anything swallows the marker.
    const offline = new Error(`ResumeM-M is not open. Start it, then try again.`, { cause });
    offline.jobhelper = { fix: 'start-server', serverUrl };
    throw offline;
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const failed = new Error(body.error ?? `${res.status} ${res.statusText}`);
    // The server says which sort of refusal this is. "No save open" is the one
    // worth acting on: there is a button that fixes it, one tab away.
    if (body.kind === 'no-project') failed.jobhelper = { fix: 'open-save', serverUrl };
    throw failed;
  }
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

const session = () => chrome.storage.session ?? chrome.storage.local;

/**
 * One trail per tab.
 *
 * It was one trail for the whole browser, and everybody opens several postings
 * in several tabs. Each tab's card saves its work every couple of seconds, so
 * two open postings overwrote each other: a tab reading about one company
 * would, on navigating, come back holding the other company's description and
 * the other company's resume. A cover letter written from the wrong posting is
 * precisely the failure this whole feature was built to avoid, and it arrived
 * through the back door.
 *
 * The tab is the application. Nothing else in the browser is.
 */
const trailKey = (tabId) => (tabId === undefined ? TRAIL_KEY : `${TRAIL_KEY}:${tabId}`);

async function readTrail(tabId) {
  const key = trailKey(tabId);
  const stored = (await session().get(key))[key];
  if (!stored?.pages?.length) return { pages: [] };
  if (Date.now() - (stored.at ?? 0) > TRAIL_STALE_MS) return { pages: [] };
  return stored;
}

/**
 * Store the trail, carrying less rather than failing.
 *
 * Session storage is 10MB shared across every tab, and five tabs each holding
 * five pages fills it exactly — at which point the write throws and the trail
 * silently stops working, which is the worst of the available outcomes.
 */
async function writeTrail(tabId, trail) {
  const key = trailKey(tabId);
  for (const attempt of [trail, lighten(trail), lighten(trail, 0)]) {
    try {
      await session().set({ [key]: attempt });
      return attempt;
    } catch {
      // Out of room. Drop the oldest pages' text and try again.
    }
  }
  return trail;
}

/**
 * A tab opened by "Apply" starts empty, and what it needs is in the tab that
 * opened it. Inherited once, on the new tab's first look: the two tabs are
 * separate applications from then on, and the one you came from carries on
 * being whatever it is.
 */
async function inheritIfNew(tabId, openerTabId) {
  if (tabId === undefined || openerTabId === undefined) return;
  const mine = await readTrail(tabId);
  if (mine.pages.length > 0) return;

  const theirs = await readTrail(openerTabId);
  if (theirs.pages.length > 0) await writeTrail(tabId, { ...theirs, at: Date.now() });
}

/* ------------------------------------------------------------------ *
 * Frames: the form is often not in the page you are looking at         *
 * ------------------------------------------------------------------ */

/**
 * Which sub-frames of which tab have a content script in them.
 *
 * Plenty of systems serve the application form in an iframe — iCIMS serves its
 * whole application that way, and so do embedded Greenhouse boards. The script
 * now runs in every frame, but only the top one puts up a card; the rest sit
 * quiet until they are asked to read or fill the form in front of them.
 *
 * Asking them needs their frame ids, and there is no way to collect a reply
 * from each of several frames in one broadcast — so each announces itself as it
 * loads. Kept in memory on purpose: a worker that has been asleep and lost this
 * is a worker whose frames have also gone, since a reload re-announces.
 */
const framesByTab = new Map();

function noteFrame(tabId, frameId) {
  if (tabId === undefined || !frameId) return;
  if (!framesByTab.has(tabId)) framesByTab.set(tabId, new Set());
  framesByTab.get(tabId).add(frameId);
}

/**
 * Put the same question to every sub-frame, and keep the answers that come
 * back. A frame that has navigated away, or is cross-origin and gone, simply
 * does not answer — which is ordinary rather than an error.
 */
async function askFrames(tabId, message) {
  const ids = [...(framesByTab.get(tabId) ?? [])];
  const replies = await Promise.all(
    ids.map(async (frameId) => {
      try {
        const reply = await chrome.tabs.sendMessage(tabId, message, { frameId });
        return reply?.ok ? { frameId, data: reply.data } : null;
      } catch {
        // The frame is gone. Drop it rather than asking again forever.
        framesByTab.get(tabId)?.delete(frameId);
        return null;
      }
    }),
  );
  return replies.filter(Boolean);
}

/** Message handlers, one per action the content script or popup can request. */
const handlers = {
  /** "There is a content script in this frame." Sent once, on load. */
  async frameReady(_payload, tab, sender) {
    noteFrame(tab?.id, sender?.frameId);
    return { ok: true };
  },

  /**
   * "The application form is in here, not out there."
   *
   * Said by a frame that has found itself holding one. Plenty of careers pages
   * are a heading and an embedded board — Greenhouse and SuccessFactors both
   * ship an embed — and scored on the page itself there is nothing there at
   * all: no description, no qualifications, no form. The card never appeared,
   * on a page where somebody was about to apply.
   *
   * The frame is the only thing in a position to know, so it says so, and the
   * top document takes another look.
   */
  async applicationFrameHere(_payload, tab, sender) {
    noteFrame(tab?.id, sender?.frameId);
    if (tab?.id === undefined) return { ok: false };
    await chrome.tabs
      .sendMessage(tab.id, { type: 'jh-application-frame' }, { frameId: 0 })
      .catch(() => undefined);
    return { ok: true };
  },

  /** The markup of any frame holding an application, as part of this page. */
  async frameHtml(_payload, tab) {
    if (tab?.id === undefined) return { frames: [] };
    const replies = await askFrames(tab.id, { type: 'jh-frame-html' });
    return { frames: replies.map(({ frameId, data }) => ({ frameId, ...data })) };
  },

  /** Read the form in every sub-frame: its questions, and what it asks for. */
  async scanFrames(_payload, tab) {
    if (tab?.id === undefined) return { frames: [] };
    const replies = await askFrames(tab.id, { type: 'jh-frame-scan' });
    return { frames: replies.map(({ frameId, data }) => ({ frameId, ...data })) };
  },

  /** Fill the form in every sub-frame from the same profile. */
  async fillFrames({ fields }, tab) {
    if (tab?.id === undefined) return { frames: [] };
    const replies = await askFrames(tab.id, { type: 'jh-frame-fill', payload: { fields } });
    return { frames: replies.map(({ frameId, data }) => ({ frameId, ...data })) };
  },

  /** Put an answer into a field that lives in one particular frame. */
  async insertInFrame({ frameId, fieldId, text }, tab) {
    if (tab?.id === undefined) return false;
    const reply = await chrome.tabs
      .sendMessage(tab.id, { type: 'jh-frame-insert', payload: { fieldId, text } }, { frameId })
      .catch(() => null);
    return Boolean(reply?.ok && reply.data);
  },

  /**
   * Add the page to the current application, or start a new one with it.
   * Returns the trail as it now stands, so the card can show it.
   */
  async rememberPage({ page }, tab) {
    await inheritIfNew(tab?.id, tab?.openerTabId);
    const trail = await readTrail(tab?.id);
    const joins = sameApplication(trail, page);
    const pages = joins ? trail.pages.filter((p) => p.url !== page.url) : [];

    pages.push({
      url: page.url,
      title: page.title,
      company: page.company,
      kind: page.kind,
      html: trimForStorage(page.html, TRAIL_HTML_MAX),
      at: Date.now(),
    });

    /*
     * A fresh application inherits nothing.
     *
     * This kept the whole of the old trail and replaced only its pages, so the
     * previous posting's resume, letter and answers stayed behind under `work`
     * — invisible, because the page that started fresh is correctly refused
     * them. It is the page after that which asks and is given them: read one
     * job, build its resume, open another job in the same tab, follow Apply,
     * and the form comes up holding the first job's application.
     *
     * The expectation goes once it has been honoured, too: a click means "the
     * next page", and leaving it standing let it vouch for a third page five
     * minutes later.
     *
     * `expecting` has to be named in that inheriting, because the spread drops
     * every key except the ones written below it. Carrying it across a fresh
     * start was the whole of the rule undone by one line: press Apply on Vega
     * and have the board cancel the navigation and route the page itself —
     * which content.js already anticipates, and which `target=_blank` produces
     * too — then read a different job, and the expectation left over from Vega
     * vouches for it. Vega's form then comes up holding Lyra's resume and
     * Lyra's description as the source for the letter, with nothing on screen
     * looking wrong.
     */
    const honoured = joins && wasExpected(trail, page.url);
    const next = {
      ...(joins ? trail : {}),
      expecting: joins && !honoured ? trail.expecting : undefined,
      pages: pages.slice(-TRAIL_MAX),
      at: Date.now(),
    };
    await writeTrail(tab?.id, next);
    return { ...summarise(next), startedFresh: !joins };
  },

  async getTrail(_payload, tab) {
    return summarise(await readTrail(tab?.id));
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
  async saveWork({ work, page }, tab) {
    const trail = await readTrail(tab?.id);
    // Only the application this tab is actually on. Without this a card left
    // open on another posting would keep writing its work over this one's.
    if (page && trail.pages.length > 0 && !sameApplication(trail, page)) return { ok: false };
    // And never nothing over something: a card that failed to analyse its page
    // has an empty state, and saving it threw away the resume built on the
    // page before.
    if (!worthKeeping(work) && worthKeeping(trail.work)) return { ok: false };

    await writeTrail(tab?.id, { ...trail, work });
    return { ok: true };
  },

  /** The work from the pages before this one, if this page continues them. */
  async takeWork({ page }, tab) {
    await inheritIfNew(tab?.id, tab?.openerTabId);
    const trail = await readTrail(tab?.id);
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
  async expectContinuation({ to }, tab) {
    const trail = await readTrail(tab?.id);
    await writeTrail(tab?.id, { ...trail, expecting: { to, at: Date.now() }, at: Date.now() });
    // A new tab inherits this tab's trail, expectation and all, so an Apply
    // button that opens one lands already knowing where it came from.
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
  async trailPages({ page }, tab) {
    await inheritIfNew(tab?.id, tab?.openerTabId);
    const trail = await readTrail(tab?.id);
    if (page && !sameApplication(trail, page)) return { pages: [] };
    return { pages: trail.pages.map((p) => ({ url: p.url, title: p.title, html: p.html })) };
  },

  /** Forget the trail — "this is a different application from the last one". */
  async clearTrail(_payload, tab) {
    await session().remove(trailKey(tab?.id));
    return { pages: [] };
  },

  /** Drop one page the user says does not belong. */
  async forgetPage({ url }, tab) {
    const trail = await readTrail(tab?.id);
    const next = { ...trail, pages: trail.pages.filter((p) => p.url !== url), at: Date.now() };
    await writeTrail(tab?.id, next);
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message "${message?.type}"` });
    return false;
  }
  // Which tab asked. The trail is per tab, and this is the only place that
  // knows which one — it used to be thrown away. The frame matters too, now
  // that the form is often not in the page the card is sitting on.
  handler(message.payload ?? {}, sender?.tab, sender)
    .then((data) => sendResponse({ ok: true, data }))
    // The marker travels with the message: a card on a job page cannot see an
    // Error object, only what crosses as JSON.
    .catch((err) => sendResponse({ ok: false, error: err.message, fix: err.jobhelper }));
  // Keeps the message channel open for the async response above.
  return true;
});

// A closed tab cannot come back, and session storage has a quota.
chrome.tabs?.onRemoved?.addListener((tabId) => {
  session().remove(trailKey(tabId)).catch(() => undefined);
  framesByTab.delete(tabId);
});

/*
 * Frames left behind by a navigation are pruned the first time they fail to
 * answer, in `askFrames`. Noticing the navigation itself would be tidier but
 * costs the `webNavigation` permission, and an extension that reads every page
 * you visit should ask for as little as it can get away with. The cost of
 * doing it lazily is one message that goes nowhere, once.
 */

chrome.runtime.onInstalled.addListener(async () => {
  // Seed defaults so the popup has something to show on first open.
  const current = await chrome.storage.sync.get(null);
  const missing = Object.fromEntries(
    Object.entries(DEFAULTS).filter(([k]) => !(k in current)),
  );
  if (Object.keys(missing).length > 0) await chrome.storage.sync.set(missing);
});
