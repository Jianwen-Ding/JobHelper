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

/*
 * How long to wait before deciding the server is not coming back.
 *
 * A wedged server is worse than an absent one. An absent one refuses the
 * connection and the card says so with a button; one that accepts the socket
 * and then never answers left the Autofill button spinning with no message and
 * no way out, because none of these requests carried a deadline.
 *
 * Anything that compiles LaTeX or calls a model gets its own, longer, deadline:
 * those really do take minutes, and cutting them off at twenty seconds would
 * turn a slow success into a failure.
 */
const REQUEST_TIMEOUT_MS = 20_000;
const SLOW_TIMEOUT_MS = 10 * 60_000;

/**
 * Which save the application in hand was built from.
 *
 * An application takes pages and minutes to write, and the editor can be
 * pointed at a different save in the meantime — a work one and a personal
 * one is the ordinary reason to have two. Nothing said so, and filing the
 * application then wrote it into whichever save happened to be open, with
 * the PDFs typeset from that save's profile and wordings: files that were
 * not the ones on screen, in somebody else's folder, with a 200 back.
 *
 * So the save each proposal came from travels with the writes that follow
 * it, and the store refuses one meant for a save it no longer has open.
 * Held per tab, because two tabs are two applications.
 */
const saveOf = new Map();

async function serverFetch(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, save, ...init } = options;
  const { serverUrl } = await getSettings();
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;

  let res;
  try {
    res = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        ...(save ? { 'X-RMM-Project': save } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    // Marked, so the card can offer the way out rather than only naming the
    // problem. The text still has to stand on its own: it is what a user sees
    // if anything swallows the marker.
    const wedged = cause?.name === 'TimeoutError' || cause?.name === 'AbortError';
    const offline = new Error(
      wedged
        ? 'ResumeM-M did not answer. Check it is still running, then try again.'
        : 'ResumeM-M is not open. Start it, then try again.',
      { cause },
    );
    offline.jobhelper = { fix: 'start-server', serverUrl };
    throw offline;
  }

  /*
   * A reply that is not JSON is a failure, not an empty success. Swallowing
   * the parse error on a 200 turned a captive portal page, a proxy error page
   * or a truncated response into `{}`, and the caller then failed somewhere
   * far away with "resumes.filter is not a function".
   */
  let body;
  try {
    body = await res.json();
  } catch (cause) {
    if (res.ok) {
      throw new Error(`ResumeM-M sent something that is not JSON (${res.status}).`, { cause });
    }
    body = {};
  }

  if (!res.ok) {
    const failed = new Error(body.error ?? `${res.status} ${res.statusText}`);
    // The server says which sort of refusal this is. "No save open" is the one
    // worth acting on: there is a button that fixes it, one tab away.
    if (body.kind === 'no-project') failed.jobhelper = { fix: 'open-save', serverUrl };
    // And the same button for a different save being open: what fixes it is
    // choosing one, which is the page that button goes to.
    if (body.kind === 'other-save') failed.jobhelper = { fix: 'open-save', serverUrl };
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

/**
 * Where the writing from a closed tab waits, keyed by the page it was on
 * rather than by the tab it was in — a reopened tab has a new id and would
 * never find it otherwise.
 */
const orphanKey = (url) => `jh-orphan:${String(url).split('#')[0]}`;

/*
 * Whether a trail is still current is a question about when, not about how
 * many pages it holds. Keyed off `pages.length`, a record with work in it and
 * no pages yet read as nothing — so `saveWork` could write the resume it had
 * just built and the next read would hand back an empty trail, every time.
 */
async function readTrail(tabId) {
  const key = trailKey(tabId);
  const stored = (await session().get(key))[key];
  if (!stored) return { pages: [] };
  if (Date.now() - (stored.at ?? 0) > TRAIL_STALE_MS) return { pages: [] };
  return { pages: [], ...stored };
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
  // Even with every page's text dropped it would not go in. Saying so beats
  // returning the trail as though it had been stored.
  return null;
}

/* ------------------------------------------------------------------ *
 * Saying, anywhere you go, that an application is open                 *
 * ------------------------------------------------------------------ */

/**
 * Mark the tab that is holding an application.
 *
 * An application takes several pages and a while, and in the middle of it
 * people wander: to the company's About page, to a salary site, to the
 * documentation for something the posting mentioned. Every one of those is
 * correctly a page this tool stays quiet on — and quiet was indistinguishable
 * from forgotten. The description, the resume and the half-written letter were
 * all still being held, and nothing said so, so the honest thing to assume was
 * that leaving the form had thrown them away.
 *
 * The toolbar is where that belongs. It is per-tab, which is exactly what an
 * application is; it is visible on every site including the ones with no card;
 * and it puts nothing on a page that has nothing to do with it — the
 * alternative, a badge injected into the corner of every page you visit while
 * applying, is the flicker complaint again wearing a different hat.
 */
async function markTab(tabId, trail) {
  if (tabId === undefined || !chrome.action?.setBadgeText) return;
  try {
    const held = trail ?? (await readTrail(tabId));
    const pages = held.pages ?? [];
    if (pages.length === 0) {
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'JobHelper' });
      return;
    }

    // The company if it is known, and the last page's title if it is not: on a
    // form that never names the employer, "the application you are on" is
    // still better said with the words from the page it started on.
    const named = pages.map((p) => p.company).filter(Boolean).pop();
    const role = pages.map((p) => p.role).filter(Boolean).pop();
    const who = named ?? pages.map((p) => p.title).filter(Boolean).pop() ?? 'An application';
    /*
     * "Platform Engineer at Helios", the way the card's own heading says it.
     * Not with a dash: this line already joins its parts with dashes, and
     * three of them in "JobHelper — Platform Engineer — Helios — 2 pages
     * read" is a sentence nobody can find the seams of.
     */
    const what = role && named ? `${role} at ${named}` : who;
    const n = pages.length;
    const parts = [`${what} — ${n} ${n === 1 ? 'page' : 'pages'} read`];
    /*
     * Which of the two, said apart.
     *
     * `worthKeeping` is true of a built resume with nothing written yet, and
     * reporting that as "your writing is being held" promises something that
     * is not there — which is worse than silence, because the whole purpose of
     * this line is to be believed when it says nothing was lost.
     */
    const wrote = Boolean(held.work?.letter?.trim()) || Object.keys(held.work?.answersByQuestion ?? {}).length > 0;
    if (wrote) parts.push('your writing is being held');
    else if (held.work?.spec) parts.push('a tailored resume is ready');

    await chrome.action.setBadgeText({ tabId, text: String(n) });
    await chrome.action.setBadgeBackgroundColor?.({ tabId, color: '#1a73e8' });
    await chrome.action.setTitle({ tabId, title: `JobHelper — ${parts.join(', ')}` });
  } catch {
    // A tab that closed between the read and the write. The badge is a
    // courtesy; it must never be the thing that fails a save.
  }
}

/**
 * Which tab a request is about.
 *
 * Nearly every request is about the tab it came from, and that is the only
 * answer a content script may have: a page on one site asking to read the
 * application you are filling in on another is a request with no legitimate
 * form, whatever tab id it puts in the payload.
 *
 * The extension's own pages are the exception, and have to be: the popup is
 * asking about the tab underneath it, which is by definition not the one it
 * is running in. Told apart by who is asking, not by whether a tab came with
 * the message — a popup usually has no tab of its own, but one opened in a
 * tab (which is how it can be driven by a test at all) does, and "no tab
 * means trusted" would have quietly excluded exactly that case.
 */
function whichTab(tabId, tab, sender) {
  const ours = sender?.url?.startsWith(chrome.runtime.getURL(''));
  if (ours && typeof tabId === 'number') return tabId;
  return tab?.id;
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
 * loads.
 *
 * In session storage rather than in memory. This was a Map, on the reasoning
 * that a worker which has been asleep and lost it is a worker whose frames have
 * also gone, since a reload re-announces. That is not how MV3 works: Chrome
 * stops an idle worker after about thirty seconds while the page carries on
 * living, and nothing re-announces without a reload. Read a posting, leave the
 * tab while you think about it, come back and press Autofill — on iCIMS, where
 * every field is inside the frame, the answer was "Filled 0 fields" and an
 * untouched form. Scanning and reading the frame's markup failed the same way,
 * so the questions vanished and the posting was analysed as the empty shell it
 * looks like from outside.
 */
const framesKey = (tabId) => `frames:${tabId}`;

async function noteFrame(tabId, frameId) {
  if (tabId === undefined || !frameId) return;
  const key = framesKey(tabId);
  const ids = new Set((await session().get(key))[key] ?? []);
  if (ids.has(frameId)) return;
  ids.add(frameId);
  await session()
    .set({ [key]: [...ids] })
    .catch(() => undefined);
}

async function forgetFrame(tabId, frameId) {
  const key = framesKey(tabId);
  const ids = ((await session().get(key))[key] ?? []).filter((id) => id !== frameId);
  await session()
    .set({ [key]: ids })
    .catch(() => undefined);
}

/**
 * Put the same question to every sub-frame, and keep the answers that come
 * back. A frame that has navigated away, or is cross-origin and gone, simply
 * does not answer — which is ordinary rather than an error.
 */
async function askFrames(tabId, message) {
  const key = framesKey(tabId);
  const ids = (await session().get(key))[key] ?? [];
  const replies = await Promise.all(
    ids.map(async (frameId) => {
      try {
        const reply = await chrome.tabs.sendMessage(tabId, message, { frameId });
        return reply?.ok ? { frameId, data: reply.data } : null;
      } catch {
        // The frame is gone. Drop it rather than asking again forever.
        await forgetFrame(tabId, frameId);
        return null;
      }
    }),
  );
  return replies.filter(Boolean);
}

/**
 * Open a space for this application in ResumeM-M, once it is worth one.
 *
 * A half-finished application used to exist only here: a resume built, half
 * a letter typed, and nothing in the editor's Workspace or its tracker to
 * come back to. You found it again by remembering which tab it was in.
 *
 * `worthKeeping` is already the line between an idle card and work — a
 * built resume, a letter, an answer — so it is the line for this too. Once
 * per application, because the workspace endpoint merges rather than
 * overwrites and the person may be writing in the editor at the same time;
 * pushing the card's version over theirs every two seconds would be a way
 * of losing their sentence, not of holding their place.
 */
const held = new Set();
async function holdASpace(trail) {
  const work = trail?.work;
  if (!worthKeeping(work)) return;
  /*
   * Named by the spec, which is the only thing here that knows. A trail page
   * carries a url, a title and markup; the company and the role are what the
   * analysis made of them, and they come back on the proposal.
   */
  const company = work.spec?.generatedFor?.company;
  const role = work.spec?.generatedFor?.role;
  if (!company || !role) return;

  const key = `${company}\u0000${role}`;
  if (held.has(key)) return;
  held.add(key);
  try {
    await serverFetch('/api/workspace', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      body: JSON.stringify({
        company,
        role,
        url: trail.pages?.[0]?.url,
        source: trail.pages?.[0]?.url ? new URL(trail.pages[0].url).hostname : undefined,
        resumeId: work.spec?.id,
        spec: work.spec,
        coverLetterRequired: Boolean(work.letter?.trim()) || undefined,
      }),
    });
  } catch {
    // The store may not be running, which is not this save's problem: the
    // work is already held in the browser either way. Letting it go means
    // the next application tries again rather than this one failing twice.
    held.delete(key);
  }
}

/** Message handlers, one per action the content script or popup can request. */

/**
 * Put a page into this tab's application, or start a new one with it.
 *
 * Called from `analyze`, and only from there. The page is recorded in the same
 * message that read it, so there is no window in which it has been read and
 * does not yet belong anywhere — which is the whole reason it moved here.
 *
 * There used to be a `rememberPage` message beside it "for anything that reads
 * a page without analysing it". Nothing ever sent it: every message type in
 * this extension is a literal string, and that one appeared in no content
 * script, no popup and no test. A handler nobody calls is not free — the
 * comment above this function described a second way in, and a second way in
 * is exactly what somebody reading this would have to reason about.
 */
async function remember(tab, page) {
  await inheritIfNew(tab?.id, tab?.openerTabId);
  const trail = await readTrail(tab?.id);
  const joins = sameApplication(trail, page);
  const pages = joins ? trail.pages.filter((p) => p.url !== page.url) : [];

  pages.push({
    url: page.url,
    title: page.title,
    company: page.company,
    /*
     * And which job it is, not only who it is with.
     *
     * The popup and the toolbar said "Helios" — right, and not enough to come
     * back to an hour later, or to tell two roles at one employer apart. The
     * analysis has worked the role out by the time a page is recorded; not
     * keeping it meant asking the page again later, from a tab that has since
     * moved on.
     */
    role: page.role,
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
  await markTab(tab?.id, next);
return { ...summarise(next), startedFresh: !joins };
}

const handlers = {
  /** "There is a content script in this frame." Sent once, on load. */
  async frameReady(_payload, tab, sender) {
    await noteFrame(tab?.id, sender?.frameId);
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
    await noteFrame(tab?.id, sender?.frameId);
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
   * The application this tab is on.
   *
   * The popup has to name a tab, because the tab it cares about is not its
   * own: usually it has none at all, and the trail key came out as the
   * browser-wide fallback, so the popup read an application nobody was on.
   */
  async getTrail({ tabId } = {}, tab, sender) {
    return summarise(await readTrail(whichTab(tabId, tab, sender)));
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

    // Stamped, because `at` is what says the trail is still current — work
    // written without it reads back as a trail from another sitting.
    const next = { ...trail, work, at: Date.now() };
    const written = await writeTrail(tab?.id, next);
    // So the toolbar starts saying "your writing is being held" the moment it
    // is, rather than at the next page of the application.
    await markTab(tab?.id, next);
    void holdASpace(next);
    return { ok: written !== null };
  },

  /** The work from the pages before this one, if this page continues them. */
  async takeWork({ page }, tab) {
    await inheritIfNew(tab?.id, tab?.openerTabId);
    const trail = await readTrail(tab?.id);
    if (page && sameApplication(trail, page) && trail.work) return { work: trail.work };
    if (page && !sameApplication(trail, page)) return { work: null };

    /*
     * Nothing in this tab. A tab closed on this same page may have left its
     * writing behind — Ctrl+Shift+T gives the reopened page a new tab id, so
     * the only thing the two have in common is the address.
     */
    const key = orphanKey(page?.url ?? '');
    const rescued = page?.url ? (await session().get(key))[key] : null;
    if (rescued?.work && Date.now() - (rescued.at ?? 0) < TRAIL_STALE_MS) {
      await session().remove(key).catch(() => undefined);
      return { work: rescued.work, recovered: true };
    }
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
  // Named tab honoured on the same terms as `getTrail`.
  /**
   * Forget this application — and, from the card, keep the page it was pressed
   * on.
   *
   * The two callers mean two different things by it, and the buttons say so.
   * The popup's is "Start fresh": the user is not on the page, they are saying
   * they are done with it, and everything goes. The card's says "Start a new
   * application here" and explains itself as "forget the earlier pages and use
   * only this one" — and it was using none of them.
   *
   * What that cost was not only a count. The badge went blank and the toolbar
   * reverted to plain "JobHelper" while the user stood on the application form
   * they had just said to start from, so the tool reported no application open
   * on the page that was one. The next page of the form then began its own
   * application, leaving the page the button was pressed on out of it — the
   * opposite of what the button offered.
   *
   * `keep` is the page to hold on to, sent by the card and absent from the
   * popup. The stored entry is kept rather than a fresh stub, because it
   * carries the markup this application is written from.
   */
  async clearTrail({ tabId, keep } = {}, tab, sender) {
    const id = whichTab(tabId, tab, sender);
    const held = keep?.url ? (await readTrail(id)).pages.filter((p) => p.url === keep.url) : [];

    if (held.length === 0) {
      await session().remove(trailKey(id));
      await markTab(id, { pages: [] });
      return { pages: [] };
    }

    const next = { pages: held, at: Date.now() };
    await writeTrail(id, next);
    await markTab(id, next);
    return summarise(next);
  },

  /** Drop one page the user says does not belong. */
  async forgetPage({ url }, tab) {
    const trail = await readTrail(tab?.id);
    const next = { ...trail, pages: trail.pages.filter((p) => p.url !== url), at: Date.now() };
    await writeTrail(tab?.id, next);
    await markTab(tab?.id, next);
    return summarise(next);
  },

  async ping() {
    // Through serverFetch, so a closed server reads as the same sentence the
    // card gives — with the button that fixes it. The popup is where someone
    // goes to check the connection, and it was the one place that answered
    // with a raw browser string: "Failed to fetch".
    return serverFetch('/health');
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
   * `tailor` may be passed per call, which is how the card offers "send it
   * unchanged", "match by keyword" and "let the AI decide what to change" as
   * three deliberate choices rather than one hidden setting. Omitted, it falls
   * back to the stored preference. `useAi` is the older two-way form of the
   * same question and still works.
   */
  async analyze({ url, title, html, pages, framed, useAi, tailor }, tab) {
    const settings = await getSettings();
    const mode =
      tailor ?? (typeof useAi === 'boolean' ? (useAi ? 'ai' : 'match') : settings.useAi ? 'ai' : 'match');
    const result = await serverFetch('/api/extension/analyze', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      body: JSON.stringify({
        url,
        title,
        html,
        // Every page of this application, not just the one in front of you.
        // Forgetting to pass this on is invisible: the analysis still works,
        // it is just written from the wrong half of what was read.
        pages,
        baseResumeId: settings.baseResumeId,
        tailor: mode,
        // Older servers read this and know nothing of `tailor`.
        useAi: mode === 'ai',
      }),
    });

    /*
     * And the page counts from here, in the same message that read it.
     *
     * It used to be a second message, sent by the content script once the
     * card was up. That is a round trip later, and a page is only part of an
     * application once it lands — so following Apply in the meantime, which
     * is exactly what you do on a description page, started a fresh
     * application on the form and lost the description you had just read: the
     * role reverted to whatever the form calls itself, and the tracker took
     * two rows for one job. A message in flight when the tab navigates is not
     * delivered, so no amount of sending it earlier closes that window; not
     * sending it at all does.
     *
     * Only when it is a posting. Recording every page the extension so much
     * as looked at would put a salary page, a careers index and a
     * confirmation page into the application you are writing.
     */
    if (result?.save && tab?.id !== undefined) saveOf.set(tab.id, result.save);
    if (result?.isJobPosting) {
      await remember(tab, {
        url,
        title,
        company: result.job?.company,
        role: result.job?.title,
        kind: result.kind,
        // The frames are part of the page: a posting inside an embed is an
        // empty shell at the top level, and the next page would be written
        // from the shell.
        html: [html, ...(framed ?? []).map((f) => f.html)].join('\n').slice(0, 400_000),
      });
    }
    return { ...result, trail: summarise(await readTrail(tab?.id)) };
  },

  /** Compile a proposed spec so the user can look at it before committing. */
  async render({ spec }) {
    const result = await serverFetch('/api/render', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      body: JSON.stringify({ spec }),
    });
    const { serverUrl } = await getSettings();
    return { ...result, absolutePdfUrl: `${serverUrl.replace(/\/$/, '')}${result.pdfUrl}` };
  },

  /**
   * Typeset the cover letter, so it can be looked at before it is sent.
   *
   * Set to match the resume it goes with — same margins, same name at the top
   * — which is why the resume's id travels with it. A preview compile: the
   * copy that gets attached is built again when the folder is.
   */
  async renderLetter({ body, company, role, resumeId }) {
    const result = await serverFetch('/api/render/letter', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      body: JSON.stringify({ body, company, role, resumeId }),
    });
    const { serverUrl } = await getSettings();
    return { ...result, absolutePdfUrl: `${serverUrl.replace(/\/$/, '')}${result.pdfUrl}` };
  },

  /**
   * Re-tailor with the user's own words folded in. Feedback goes to the AI
   * path because a sentence of intent is exactly what tag matching cannot use.
   */
  async refine({ spec, feedback, job }) {
    /*
     * Mapped into the server's shape, the way `coverLetter` below already does.
     *
     * `analyze` returns the job as `{company, description, keywords, title,
     * source}`; this read `job.jobDescription`, which is not one of those, and
     * spread the rest straight through. The template literal turned the missing
     * value into the four characters "undefined", which is non-empty, so the
     * server's own guard against a blank description passed and the prompt went
     * out reading:
     *
     *     ## Posting
     *     Company: Helios
     *     undefined
     *
     * The resume then came back re-picked bullet by bullet with no knowledge of
     * the job at all, and was presented as "your feedback applied".
     */
    const description = job?.description ?? '';
    return serverFetch('/api/ai/tailor', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      body: JSON.stringify({
        resumeId: spec.extends ?? spec.id,
        job: {
          jobTitle: job?.title,
          company: job?.company,
          url: job?.url ?? job?.source,
          keywords: job?.keywords,
          jobDescription: `${description}\n\n## The applicant's instructions\n${feedback}`,
        },
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
  async bundle(payload, tab) {
    return serverFetch('/api/applications/bundle', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      save: saveOf.get(tab?.id),
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
  async matchAnswers({ questions, company }) {
    return serverFetch('/api/answers/match', {
      method: 'POST',
      // Who is being applied to. An answer to "why do you want to work here?"
      // names the company, so the bank has to know which company is being
      // asked about before it hands one over.
      body: JSON.stringify({ questions, company }),
    });
  },

  /** Answer one question, reusing a stored answer unless asked to redraft. */
  async answerQuestion({ question, force, job }) {
    return serverFetch('/api/ai/answer', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      body: JSON.stringify({
        question,
        force,
        // Mapped into the server's shape, as `coverLetter` does below.
        job: job
          ? {
              jobTitle: job.title,
              company: job.company,
              jobDescription: job.description ?? '',
              url: job.url ?? job.source,
            }
          : undefined,
      }),
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
      timeoutMs: SLOW_TIMEOUT_MS,
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
  async openWorkspace(payload, tab) {
    const result = await serverFetch('/api/workspace', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      // The same rule as `bundle`: this writes a space, a tracker row and a
      // tailored resume into a save, and it has to be the save the proposal
      // was built from.
      save: saveOf.get(tab?.id),
      body: JSON.stringify(payload),
    });
    const { serverUrl } = await getSettings();
    return { ...result, absoluteUrl: `${serverUrl.replace(/\/$/, '')}${result.url}` };
  },

  /** Open the editor in a new tab, focused on this draft. */
  async openTab({ url }, tab) {
    // A path is resolved against the store, so the card can send someone to a
    // page of the editor without knowing where the editor lives.
    const absolute = /^[a-z]+:/i.test(url) ? url : `${(await getSettings()).serverUrl.replace(/\/$/, '')}${url}`;
    const opened = await chrome.tabs.create({ url: absolute });
    // Noted, so that coming back to the tab that sent you here means
    // something. See `awaitingReturn`.
    if (typeof tab?.id === 'number') awaitingReturn.add(tab.id);
    return { id: opened.id };
  },

  /**
   * "The application in this frame was just sent."
   *
   * Said by a frame, which has no analysis and no card and so cannot say
   * which application it is. This side can: the tab has been building a trail
   * as the person moved through the application, and the resume built for it
   * carries the company and the role.
   *
   * Requiring that resume is a stronger guard than the top document's, not a
   * weaker one — it means this tab was already being tracked as an
   * application in flight, so the worst this can do is finish something that
   * had already started.
   */
  async applicationSentHere({ note, url }, tab) {
    const trail = await readTrail(tab?.id);
    const named = trail?.work?.spec?.generatedFor;
    if (!named?.company || !named?.role) return { ok: false };
    return handlers.applicationSent({ company: named.company, role: named.role, url, note });
  },

  /**
   * "The form for this application was just sent."
   *
   * Passed straight through: what it is worth to the tracker — whether it
   * moves anything, and never backwards — is the store's decision, and it is
   * the only side that knows how an application is named.
   */
  async applicationSent({ company, role, url, note }) {
    try {
      return await serverFetch('/api/extension/sent', {
        method: 'POST',
        body: JSON.stringify({ company, role, url, note }),
      });
    } catch (err) {
      // The store not running is not a reason to interrupt somebody who has
      // just sent an application. It stays in the tracker as "applying".
      return { ok: false, error: String(err?.message ?? err) };
    }
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

/*
 * A closed tab, and what is worth keeping from it.
 *
 * This used to remove the trail outright, on the reasoning that a closed tab
 * cannot come back. The tab cannot; the work can, and it is the part that took
 * an hour — a cover letter and three answers, gone because a tab was closed by
 * accident. Ctrl+Shift+T reopens the page under a *new* tab id, so the trail
 * keyed by the old one was unreachable even though it was still there.
 *
 * The pages are dropped, because they are the bulk and they can be read again
 * by visiting the page. What was written is kept under the url instead, where
 * a reopened tab can find it, and it ages out on the same clock as everything
 * else in session storage — which is emptied when the browser closes anyway.
 */
/**
 * Tabs that sent someone to the builder and have not had them back yet.
 *
 * You press "Edit in ResumeM-M" because this posting wants a phrasing the
 * store does not have. Whatever you add there cannot be in the proposal on
 * the card, which was matched before it existed — so the card is told when
 * you return, and offers to match again.
 *
 * Held here rather than worked out in the page from `visibilitychange`: this
 * side knows the trip was made, and it catches the return made by closing the
 * builder tab, which is how people actually come back. Plain memory is right
 * for it — if the worker has been asleep long enough to forget, the trip is
 * old enough not to be worth mentioning.
 */
const awaitingReturn = new Set();

chrome.tabs?.onActivated?.addListener(({ tabId }) => {
  if (!awaitingReturn.delete(tabId)) return;
  chrome.tabs.sendMessage(tabId, { type: 'jh-came-back' }).catch(() => undefined);
});

/*
 * Put the mark back after a navigation.
 *
 * Chrome clears a tab-specific badge when the tab navigates, and navigating is
 * the entire point of this mark: the moment it is most needed — you have just
 * left the form to go and read something — is the moment the browser would
 * take it away. So it is re-applied on every load, from the trail, which is
 * the thing that actually knows whether an application is open.
 *
 * `onUpdated` and not `webNavigation`, because only the tab id is wanted and
 * the permission for that is already held.
 */
chrome.tabs?.onUpdated?.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading' && changeInfo.status !== 'complete') return;
  markTab(tabId).catch(() => undefined);
});

chrome.tabs?.onRemoved?.addListener(async (tabId) => {
  try {
    const trail = await readTrail(tabId);
    const url = trail.pages?.[trail.pages.length - 1]?.url;
    if (trail.work && url) {
      await session().set({ [orphanKey(url)]: { work: trail.work, at: Date.now() } });
    }
  } catch {
    // Storage full, or the trail already gone. Losing the rescue copy is not
    // worth failing the cleanup that follows.
  }
  session().remove([trailKey(tabId), framesKey(tabId)]).catch(() => undefined);
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
