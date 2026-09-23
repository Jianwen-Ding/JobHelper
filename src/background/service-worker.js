/**
 * The service worker owns every call to the ResumeM-M server. Content scripts
 * run in the page's origin, so routing requests through here keeps loopback
 * traffic out of the page's reach and gives one place to report a server that
 * is not running.
 */

import { getSettings } from '../shared/config.js';
import {
  EXPECTATION_MS,
  employerKey,
  judgeApplication,
  keepPages,
  plainlyAnotherRole,
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
 *
 * And on the trail as well as here, because here does not survive. This
 * worker is stopped after about half a minute of no extension events, which
 * reading a posting and writing a letter produces none of — so the map was
 * routinely empty by the time Submit was pressed. `serverFetch` sends the
 * header only when it has a save, and the store's guard only refuses a save
 * it disagrees with, so a forgotten one was not a refusal: it was the whole
 * protection quietly switching itself off, in the ordinary case rather than a
 * rare one, and the application filed into whichever save happened to be open.
 */
const saveOf = new Map();

/**
 * Which save this tab's application was built from, memory or not.
 *
 * The map is the fast path and the trail is the true one; the trail is in
 * session storage and outlives the worker. Undefined only for an application
 * that was in flight when the extension was updated, which is the one case
 * where there is genuinely nothing to know.
 */
async function saveFor(tabId) {
  /*
   * The trail first, because the trail is the true one — which is what the
   * note above says and what this used to get backwards.
   *
   * Reading the map first meant nothing ever invalidated it. `remember`
   * writes the *new* save into the trail when an application starts, and the
   * map went on answering with the old one: read a posting with "work" open,
   * switch save in the editor, read a different posting in the same tab, and
   * the second application — proposed, tailored and written entirely in
   * "personal" — was filed into "work" with a 200. The store's own guard
   * could not help, because the header it was sent said "work" too.
   *
   * Worse, it disappears when the worker is stopped, so the same sequence
   * behaves correctly after half a minute of idling and wrongly when it does
   * not — and the refusal it does produce ("this was written against work,
   * reload the editor or open that save again") offers the user the action
   * that then files a personal-built proposal into the work save.
   *
   * The map stays as the fallback for the case it was written for: a worker
   * that remembers an application whose trail has been cleared out from under
   * it.
   */
  const trail = await readTrail(tabId);
  if (trail.save) {
    saveOf.set(tabId, trail.save);
    return trail.save;
  }
  return saveOf.get(tabId);
}

/**
 * The save this application belongs to, or a refusal to write without one.
 *
 * The store refuses a write whose `X-RMM-Project` disagrees with the save it
 * has open. It does not refuse one that carries no header at all — it cannot,
 * because the editor's own pages and every other caller are headerless and
 * legitimate. So "which save is this?" being unanswerable did not mean the
 * write stopped; it meant the write went to whichever save happened to be
 * open, agreed with nothing, and was accepted.
 *
 * That is the same failure `saveOf` and the header exist to prevent, reached
 * by not knowing rather than by knowing wrongly. Seen end to end: stop the
 * worker mid-application, change save in the editor, press Submit. The final
 * filing still remembered the save and was refused — the card said so, in the
 * store's own words — while the staging write that puts the files in the
 * upload folder had already landed a row in the other save's tracker, marked
 * `applying`, because it went out with no header.
 *
 * Refusing is right rather than harsh. There is no save to guess at here: the
 * work on screen was built from one, and picking a different one silently is
 * the outcome this whole mechanism is about. A reload rebuilds the
 * application against the save that is actually open, which is a few seconds
 * and no surprises.
 */
async function saveOrRefuse(tabId) {
  const save = await saveFor(tabId);
  if (save) return save;
  throw new Error(
    'JobHelper has lost track of which save this application was built from, so it will not file it — ' +
      'it could go into the wrong one. Reload this page to start it again.',
  );
}

/**
 * Work the user is allowed to walk away from, by tab.
 *
 * A tailoring pass is a model reading a posting — minutes of it — and until
 * there was a way out the only ways out were waiting and closing the card. The
 * controller for the request in flight is kept here so a later "stop" can
 * reach it.
 *
 * What stopping does and does not do is worth being exact about: it abandons
 * the request, so the extension lets go of the connection and the reply is
 * never applied. The model on the other end is a process ResumeM-M started and
 * it keeps going until it is finished. Nothing here can reach into that, and
 * pretending otherwise would be the more comfortable lie.
 */
const stoppable = new Map();

/**
 * The reason a controller in `stoppable` was aborted.
 *
 * A fresh object each time, because `AbortSignal.any` forwards the reason of
 * whichever signal fired first and the check downstream is identity-free: it
 * asks whether the reason is marked, not which controller it came from.
 */
function stopReason() {
  const err = new Error('Stopped.');
  err.jobhelper = { stopped: true };
  return err;
}

/**
 * Run `fn` with a signal the tab can abort, and forget the controller after.
 *
 * Held as a set per tab, and each controller remembers `what` it is for,
 * because a tab can have a tailoring pass and a writing pass in the air at
 * once — the card runs them in separate lanes on purpose, so that typing a
 * cover letter is possible while the resume is being read. The Stop beside
 * the tailoring bar has to mean *that* run and not the letter being written
 * underneath it; a stop that took both down would be a worse trap than the
 * one it was added to fix, because at least waiting does not throw work away.
 */
async function stoppably(tab, what, fn) {
  const id = tab?.id;
  if (id === undefined) return fn(undefined);
  const ctl = new AbortController();
  ctl.what = what;
  const held = stoppable.get(id) ?? new Set();
  held.add(ctl);
  stoppable.set(id, held);
  try {
    return await fn(ctl.signal);
  } finally {
    held.delete(ctl);
    if (held.size === 0) stoppable.delete(id);
  }
}

async function serverFetch(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, save, ...init } = options;
  const { serverUrl } = await getSettings();
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;

  let res;
  try {
    res = await fetch(url, {
      ...init,
      /*
       * Both deadlines, not whichever was passed.
       *
       * A caller's signal used to replace the timeout, which meant every
       * request that could be stopped by hand also lost its ceiling: a wedged
       * server would have hung until the tab was closed. `any` aborts on the
       * first of the two, and the reason tells them apart below.
       */
      signal: init.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)])
        : AbortSignal.timeout(timeoutMs),
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
    /*
     * Asked to stop, rather than gone wrong. `AbortSignal.timeout` and a
     * controller we aborted ourselves both arrive here as an AbortError, and
     * telling somebody who has just pressed Stop that the server did not
     * answer would be blaming the server for doing as it was told. The mark
     * on the reason is what separates them; the name on the exception does
     * not.
     */
    if (init.signal?.aborted && init.signal.reason?.jobhelper?.stopped) {
      throw stopReason();
    }
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
    /*
     * The two deadlines again, because neither of them stops at the headers.
     *
     * A reply is "received" the moment its status line arrives, and the body
     * can take as long as it likes after that — so both the Stop button and
     * the ceiling can fire in here, and both arrived as a parse failure.
     * Measured: press Stop while the body is stalled and the card put up a
     * red strip reading "ResumeM-M sent something that is not JSON (200)."
     * about a run the user had just cancelled; a server that wedges
     * mid-body got the same sentence with no way out on it, twenty seconds
     * later, instead of the "did not answer" message that carries the button.
     *
     * Checked before the status, because a stop is a stop whatever the server
     * had already managed to say.
     */
    if (init.signal?.aborted && init.signal.reason?.jobhelper?.stopped) {
      throw stopReason();
    }
    if (cause?.name === 'TimeoutError' || cause?.name === 'AbortError') {
      const wedged = new Error('ResumeM-M did not answer. Check it is still running, then try again.', { cause });
      wedged.jobhelper = { fix: 'start-server', serverUrl };
      throw wedged;
    }
    if (res.ok) {
      throw new Error(`ResumeM-M sent something that is not JSON (${res.status}).`, { cause });
    }
    body = {};
  }

  if (!res.ok) {
    const failed = new Error(body.error ?? `${res.status} ${res.statusText}`);
    // What the store called it, for the callers that treat one refusal
    // differently from another. See `holdASpace` and `not-a-job`.
    if (typeof body.kind === 'string') failed.kind = body.kind;
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

/**
 * How many applications one address can be holding at once.
 *
 * One, until a board that never changes its url made that wrong. Read a job
 * in Indeed's results pane, write half a letter, click the next job in the
 * list: the trail branches — correctly — and parks what it is leaving under
 * the address it was on, which is the address the next job is on too. The
 * second park overwrote the first, so going back to the first job found the
 * second job's letter waiting for it.
 *
 * Three, because that is a person switching between jobs on one board, and
 * every one of them is somebody's writing.
 */
const PARK_MAX = 3;

/** What is parked at one address, oldest last, whatever shape it is in. */
const parkedAt = (record) => {
  if (Array.isArray(record?.parked)) return record.parked.filter((p) => p?.work);
  return record?.work ? [{ work: record.work, save: record.save, at: record.at }] : [];
};

/*
 * By the same key the trail joins pages on — see `employerKey`. Compared
 * exactly, a park named after the form's "Helios" was another employer's to
 * the posting's "Helios, Inc.", and coming back to the job refused its own
 * letter: measured, `takeWork` answered `{work: null}` with the park still
 * sitting at the address.
 */
const companyOf = (job) => employerKey(job?.company);

/**
 * Two applications that are plainly not each other.
 *
 * The same conservatism as `plainlyAnotherRole`, and for the same reason: an
 * opinion is only worth having here when it is obvious. Different employers
 * is obvious. Roles with no word in common is obvious. Anything else — a form
 * page that calls itself nothing, a role written two ways — is not, and gets
 * no answer.
 */
function plainlyOtherJob(job, other) {
  if (!job || !other) return false;
  if (companyOf(job) && companyOf(other) && companyOf(job) !== companyOf(other)) return true;
  return plainlyAnotherRole(job.role, other.role);
}

/** The same job, said well enough to put writing back into. */
const sameJob = (job, other) =>
  Boolean(job && other) && companyOf(job) === companyOf(other) && !plainlyAnotherRole(job.role, other.role);

/**
 * Put an application's writing aside under an address, without displacing
 * another job's writing parked at the same one.
 */
/**
 * Take what `isGone` names out of an address's parked work, leaving the rest.
 *
 * Through the same chain as `parkWork`, and over the list as it is when the
 * turn comes rather than as it was when somebody last looked. `dropPark` was
 * handed the list `takeWork` had read several turns earlier, across a real
 * `await writeTrail`, and wrote it back minus the entry claimed. Measured in
 * tests/worker.mjs, with another tab parking at the same address a couple of
 * milliseconds either side of a claim: its letter was written and then
 * erased, and at the neighbouring delays the claim was written over instead,
 * leaving the letter just claimed parked for another tab to claim again.
 */
function unpark(key, isGone) {
  return changeStored(key, async (stored) => {
    const held = parkedAt(stored);
    const left = held.filter((p) => !isGone(p));
    if (left.length === held.length) return null;
    if (left.length > 0) return { parked: left, at: Date.now() };
    await session().remove(key).catch(() => undefined);
    return null;
  });
}

/** One entry, as it was read; see `unpark`. */
function dropPark(key, gone) {
  const same = JSON.stringify(gone);
  return unpark(key, (p) => JSON.stringify(p) === same);
}

/**
 * The same entry, at every address it was parked under.
 *
 * `remember` and `clearTrail` park one entry under every page of the
 * application, so that coming back to any of them finds it — which makes each
 * of those a copy, and claiming one of them took only that one. Measured in
 * tests/worker.mjs: a letter claimed on the posting was handed again to
 * another tab opening the form, as "recovered from a tab that closed", while
 * the tab that claimed it was open and holding it. The copies are one object
 * written several times, so they are the entries that read back identical.
 */
async function dropParkEverywhere(gone) {
  const same = JSON.stringify(gone);
  const all = await session().get(null).catch(() => ({}));
  for (const [key, record] of Object.entries(all)) {
    if (!key.startsWith('jh-orphan:')) continue;
    if (parkedAt(record).some((p) => JSON.stringify(p) === same)) await dropPark(key, gone);
  }
}

async function parkWork(url, entry) {
  const key = orphanKey(url);
  /*
   * Through the same chain the frame lists use, because this is the same
   * three-turn read-modify-write and this one holds somebody's prose.
   *
   * Two tabs closing together — a window shut, or one closed while another
   * branches — run `onRemoved` twice, independently and asynchronously, and
   * both begin with a full `sweepOrphans` read that guarantees the overlap.
   * Their trails share the board or careers page they both started from, so
   * both handlers read the same list, both add one entry, and the second
   * write lands on top. One of the two letters is then unreachable at the
   * address people actually come back to — `changeFrames` says exactly this
   * about frame ids, which are cheaper to lose.
   */
  return changeStored(key, async (stored) => {
    const held = parkedAt(stored);
    const kept = [...held.filter((p) => !sameJob(p.job, entry.job)), entry].slice(-PARK_MAX);
    return { parked: kept, at: Date.now() };
  });
}

/**
 * Which of the things parked at this address belongs to the job being looked
 * at now, if any of them does.
 *
 * A park that names a plainly different job is refused and left where it is:
 * it is not this job's to take, and the tab that comes back to *its* job
 * still needs to find it. Ones that name nothing — a tab closed before the
 * page was ever analysed — are still offered, newest first, because that is
 * the case this rescue was built for and it has no better evidence to go on.
 */
function pickParked(held, job, tabId) {
  if (held.length === 0) return null;
  /*
   * This tab's own park first, whatever the page is called.
   *
   * Parks are keyed by address and trails are keyed by tab, so two tabs open
   * on the same board share a park list. Without this, a page the analyser
   * could not name took the newest thing parked there — which may be the
   * other tab's half-written letter, handed over as "Recovered what you had
   * written before this tab closed" on a tab that never closed.
   */
  const thisTabs = held.filter((p) => p.tab !== undefined && p.tab === tabId);
  if (!job) return thisTabs[thisTabs.length - 1] ?? held[held.length - 1];
  const mine = held.filter((p) => sameJob(p.job, job));
  if (mine.length > 0) return mine[mine.length - 1];
  const possible = held.filter((p) => !plainlyOtherJob(p.job, job));
  return possible[possible.length - 1] ?? null;
}

/**
 * Where the application a tab has just branched away from waits, in case it
 * turns out to have been the same one. See `remember` and `keepTogether`.
 */
const branchKey = (tabId) => `jh-branched:${tabId}`;

/**
 * Which applications have already had a space opened for them, and in which
 * save. See `holdASpace`, which is the only thing that reads or writes these.
 *
 * Percent-encoded rather than joined on a NUL, which is the obvious separator
 * and does not survive the trip. `chrome.storage.session` takes a key with a
 * NUL in it, stores it — `get(null)` lists it — and then answers `undefined`
 * when asked for it by name, so every read missed and the guard below held
 * nothing. Measured, not assumed: `set` ok, `get(null)` one key, `get(key)`
 * null.
 */
const heldKey = (save, company, role, applied) =>
  /*
   * And whether the form had been acted on when it was held.
   *
   * Without that last part this key is what stops the second push. The first
   * one opens the row while the resume is being built, which is before
   * anything has been put in the employer's boxes — so the row is `interested`
   * and the key is set, and the push that would carry `actedOnForm: true` and
   * move it to `applying` never goes. The row stays "Not applied" through an
   * application that was filled in and sent.
   *
   * Two keys, so each of the two states is pushed once. It cannot oscillate:
   * `actedOnForm` is only ever set on the card, never cleared.
   */
  `jh-held:${[save, company, role, applied ? 'applied' : 'held'].map(encodeURIComponent).join('|')}`;

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
  /*
   * And not into a tab that was told to start fresh.
   *
   * "Inherited once, on the new tab's first look" was written as "has no
   * pages yet", and `openerTabId` stays on a tab for its whole life — so a
   * tab emptied on purpose looked exactly like one that had never inherited,
   * and the next page load copied the opener's whole application back over
   * it: pages, work, save and expectation, as a blind write rather than a
   * merge.
   */
  if (mine.pages.length > 0 || mine.cleared) return;

  const theirs = await readTrail(openerTabId);
  if (theirs.pages.length === 0) return;

  /*
   * And only when the tab it came from was in the middle of applying.
   *
   * `openerTabId` is set by Chrome for *any* tab a page opens — a middle
   * click, a ctrl-click, a `target="_blank"` link, a `window.open` — and this
   * runs on nearly every page, because `openHere` is what a low-scoring page
   * asks before giving up and most pages are low-scoring. So middle-clicking
   * "Benefits" from a posting you had half a letter written for handed that
   * whole application to the new tab: its pages, its resume, its letter, and
   * its live `expecting`, which is the one thing that overrides the host and
   * path rules. One ordinary navigation from there to another company's
   * posting could be taken as the same application.
   *
   * The expectation is the discriminator this always wanted, and
   * `expectContinuation` says as much in its own comment — a new tab
   * inherits "so an Apply button that opens one lands already knowing where
   * it came from". Pressing Apply sets it; middle-clicking "Benefits" does
   * not. Held to the same five minutes `wasExpected` allows, so a tab opened
   * out of a posting left open since yesterday inherits nothing either.
   *
   * Where it is missing the new tab starts fresh, which is what every tab
   * with no opener already does — and `wasLinkedFrom` still reads the link
   * out of the page it came from, with no race in it at all.
   */
  const applying = theirs.expecting?.to && Date.now() - (theirs.expecting.at ?? 0) <= EXPECTATION_MS;
  if (!applying) return;

  await writeTrail(tabId, { ...theirs, at: Date.now() });
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

/**
 * One frame at a time may change the list.
 *
 * Reading the list, adding to it and writing it back is three turns, and every
 * frame on the page announces itself at once — a page with eight iframes is
 * eight of these interleaved. Two that read the same list both write their own
 * frame onto it, and the one that lands second has silently dropped the first.
 *
 * Measured, on the same page loaded six times:
 *
 *   round 1: iframes on the page 8, recorded 8
 *   round 2: iframes on the page 8, recorded 7   <-- LOST 1
 *   round 3: iframes on the page 8, recorded 8
 *   round 4: iframes on the page 8, recorded 8
 *   round 5: iframes on the page 8, recorded 8
 *   round 6: iframes on the page 8, recorded 6   <-- LOST 2
 *
 * A frame that is not on the list is never asked anything: `askFrames` reads
 * the list and messages what is in it, so the lost frame's questions never
 * appear on the card and Autofill walks past its fields. Two in three loads
 * were right here, which is the worst shape for this — the same page works
 * when you try it and quietly misses a field when you do not look.
 *
 * `chrome.storage.session` has no compare-and-set, so the exclusion is a
 * promise chain: each change waits for the one before it and reads a list that
 * already has it in. Per key, so two tabs loading at once do not queue behind
 * each other. Worth saying that this is enough only because there is one
 * service worker at a time — the chain lives in its memory, and a worker that
 * has been stopped has no changes in flight to lose.
 */
const frameWrites = new Map();

/**
 * The same exclusion, for the settings — which are one object shared by the
 * popup, the card and every tab, and are changed by reading them, altering
 * one list and writing the whole thing back. See `muteHost`.
 */
let settingWrites = Promise.resolve();

function changeSettings(change) {
  const next = settingWrites
    .then(async () => {
      const patch = change(await getSettings());
      if (patch) await chrome.storage.sync.set(patch);
    })
    .catch(() => undefined);
  settingWrites = next;
  return next;
}

/**
 * One writer at a time for one key, whatever is in it.
 *
 * Lifted out of `changeFrames` when `parkWork` needed the same thing: read,
 * modify, write is three turns, and the write that lands second has silently
 * dropped the first. `change` is given the stored value and returns the next
 * one, or `null` to leave it alone.
 *
 * A refused write is tried once more with the cupboard swept first. Session
 * storage is 10MB across every tab and the thing being stored here can be a
 * cover letter somebody typed, so "the quota said no" cannot be the end of
 * it — see `writeTrail`, which carries less rather than failing for the same
 * reason. Resolves to whether the value is stored.
 */
/**
 * One application's work, out of the two halves a branch split it into.
 *
 * Everything but the writing comes from before the branch: the resume that
 * was built, the files staged, the spec it came from. Those the card rebuilt
 * on arrival and the older copy is the one somebody chose.
 *
 * The writing is added up instead. Answers merge by question, and the
 * earlier answer wins where both answered the same one. A letter that
 * contains the other is the other — the usual case, where the keeper saved a
 * prefix a moment before the branch — and two that genuinely differ are
 * both kept, one after the other, because a button that says "everything you
 * had written" cannot quietly pick.
 */
function bothHalves(before, since) {
  if (!before) return since ?? undefined;
  if (!since) return before;
  return {
    ...since,
    ...before,
    letter: bothLetters(before.letter, since.letter),
    answersByQuestion: { ...(since.answersByQuestion ?? {}), ...(before.answersByQuestion ?? {}) },
  };
}

function bothLetters(before, since) {
  const a = String(before ?? '');
  const b = String(since ?? '');
  if (!b.trim() || a.includes(b.trim())) return a;
  if (!a.trim() || b.includes(a.trim())) return b;
  return `${a.trimEnd()}\n\n${b.trimStart()}`;
}

function changeStored(key, change) {
  const next = (frameWrites.get(key) ?? Promise.resolve())
    .then(async () => {
      const stored = (await session().get(key).catch(() => ({})))[key];
      const wanted = await change(stored);
      if (wanted === null || wanted === undefined) return true;
      try {
        await session().set({ [key]: wanted });
        return true;
      } catch {
        await sweepOrphans().catch(() => undefined);
        try {
          await session().set({ [key]: wanted });
          return true;
        } catch {
          return false;
        }
      }
    })
    .catch(() => false)
    .finally(() => {
      // Only the last change queued clears the slot, or a change queued while
      // this one was running would be dropped from the chain.
      if (frameWrites.get(key) === next) frameWrites.delete(key);
    });
  frameWrites.set(key, next);
  return next;
}

function changeFrames(key, change) {
  const next = (frameWrites.get(key) ?? Promise.resolve())
    .then(async () => {
      const ids = (await session().get(key))[key] ?? [];
      const wanted = change(ids);
      if (wanted === null) return;
      await session().set({ [key]: wanted });
    })
    .catch(() => undefined)
    .finally(() => {
      // Only the last change queued clears the slot, or a change queued while
      // this one was running would be dropped from the chain.
      if (frameWrites.get(key) === next) frameWrites.delete(key);
    });
  frameWrites.set(key, next);
  return next;
}

async function noteFrame(tabId, frameId) {
  if (tabId === undefined || !frameId) return;
  await changeFrames(framesKey(tabId), (ids) => (ids.includes(frameId) ? null : [...ids, frameId]));
}

async function forgetFrame(tabId, frameId) {
  await changeFrames(framesKey(tabId), (ids) =>
    ids.includes(frameId) ? ids.filter((id) => id !== frameId) : null,
  );
}

/** What the top document of this tab says its application is, if anything. */
async function askThePage(tabId) {
  const reply = await chrome.tabs
    .sendMessage(tabId, { type: 'jh-what-is-this' }, { frameId: 0 })
    .catch(() => null);
  return reply?.ok ? (reply.data ?? null) : null;
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
/*
 * Once per application, and the worker must not be what remembers it.
 *
 * This was a module-level Set. A service worker is stopped whenever the
 * browser feels like it — thirty seconds without a message is the documented
 * case, and an extension reload or memory pressure will do it at any time —
 * and module state goes with it. The card's keeper sends every two seconds,
 * so the first tick after a restart found an empty set and pushed again: the
 * whole spec the card is holding, merged over the version in the editor.
 * Which is, word for word, the loss the comment above says this guard exists
 * to prevent — you switch to the editor, rearrange the entries, and a card
 * still open behind it puts its older copy back.
 *
 * Keyed by the save as well, because the same role applied for out of two
 * saves is two applications and wants a row in each. Keyed off `company` and
 * `role` alone, the second save silently never got one.
 *
 * `holding` is the narrower guard the Set was also doing by accident: a
 * synchronous add before an await, so two keeper ticks overlapping across a
 * slow POST cannot both send. Session storage cannot do that — the read and
 * the write are two awaits — so it stays, in memory, for the in-flight case
 * only.
 */
const holding = new Set();
/**
 * Something the person made, as against something the card worked out.
 *
 * `worthKeeping` is true of a spec alone, and the opening read of every
 * posting produces one — so the keeper, which saves every couple of seconds,
 * opened a row in the tracker for every posting anybody *looked at*. Click
 * down a board and you come back to a dozen drafts for jobs you read a line
 * of and moved on from, each one a thing to notice and dismiss.
 *
 * A row is a claim that an application is under way, so what makes one is a
 * deliberate act: a resume compiled, files staged for a form, a letter
 * started, an answer written. Reading a posting is not one of those, and
 * Submit files a row by its own route regardless.
 */
function madeSomething(work) {
  return Boolean(
    work?.render ||
      work?.staged ||
      work?.letter?.trim() ||
      Object.keys(work?.answersByQuestion ?? {}).length > 0,
  );
}

async function holdASpace(trail, tabId) {
  const work = trail?.work;
  if (!madeSomething(work)) return;

  /*
   * Into the save this application was built from, and no other.
   *
   * This was the one write to `/api/workspace` that went out headerless.
   * `openWorkspace` carries `save` and is refused when the editor has moved
   * on; this one is the automatic version — it runs off the trail as work
   * accumulates, with nobody pressing anything — so when the save changed
   * underneath it, a row was opened in whichever save happened to be open.
   * Every other write in the same moment was correctly refused, which is what
   * made it hard to see: the card said "ResumeM-M has another save open now"
   * and a tracker row for this application appeared in that other save
   * regardless.
   *
   *   FAIL  the other save is untouched
   *         2026-09-19-helios-platform-engineer [applying] role="Platform Engineer"
   *
   * Intermittent, because it only lands if this write is in flight across the
   * change; one in six runs of the case that watches for it.
   *
   * Not written at all when the save cannot be named, rather than written
   * without the header: headerless is exactly the thing the store cannot
   * refuse, and `saveOrRefuse`'s own note says an unanswerable save must not
   * mean the write goes somewhere. Holding a place is a convenience and this
   * one is retried as the application grows; a row in a stranger's tracker is
   * not undone by the next attempt.
   */
  const save = await saveFor(tabId);
  if (!save) return;
  /*
   * Named by the spec, which is the only thing here that knows. A trail page
   * carries a url, a title and markup; the company and the role are what the
   * analysis made of them, and they come back on the proposal.
   */
  const company = work.spec?.generatedFor?.company;
  const role = work.spec?.generatedFor?.role;
  if (!company || !role) return;

  const key = heldKey(save, company, role, work.actedOnForm);
  if (holding.has(key)) return;
  holding.add(key);
  try {
    if ((await session().get(key).catch(() => ({})))[key]) return;
    await session().set({ [key]: { at: Date.now() } }).catch(() => undefined);
    try {
      await serverFetch('/api/workspace', {
        method: 'POST',
        timeoutMs: SLOW_TIMEOUT_MS,
        save,
        body: JSON.stringify({
          /*
           * Nobody pressed anything to get here, so the store is allowed to
           * disbelieve it. `openWorkspace` — the card's button — carries no
           * such flag: somebody typing a company and a role means it, however
           * odd it reads. This one is a guess made from a page's markup, and a
           * guess is how "Indeed — Now Hiring: 300 Software Intern Jobs" and
           * "Reddit — https://preview.redd.it/…jpeg?width=1280" became rows in
           * somebody's tracker.
           */
          auto: true,
          /*
           * And whether it has been applied to yet, which is a different
           * question from whether there is anything to hold.
           *
           * A place to write is wanted as soon as there is a resume: the
           * letter is drafted before the form is opened, and gating the
           * workspace on the form having been filled puts the writing surface
           * behind the thing it is for. But a row that says `applying` is a
           * claim about what somebody is doing, and a built resume is not that
           * claim — a resume is built on anything job-shaped you open, and
           * `prepareSoon` stages the folder off a timer with nobody pressing
           * anything. So the tracker filled up with "Indeed — Now Hiring: 300
           * Software Intern Jobs", a `preview.redd.it` image url, and one row
           * each for "NVIDIA Corporation" and "2100 NVIDIA USA", every one of
           * them sitting at `applying` for ever.
           *
           * Putting text in the employer's boxes or a file in its upload
           * control is the thing no amount of browsing does by accident. The
           * store opens the row at `interested` until it hears this, and
           * advances it when it does.
           */
          actedOnForm: Boolean(work.actedOnForm),
          company,
          role,
          url: trail.pages?.[0]?.url,
          source: trail.pages?.[0]?.url ? new URL(trail.pages[0].url).hostname : undefined,
          resumeId: work.spec?.id,
          spec: work.spec,
          coverLetterRequired: Boolean(work.letter?.trim()) || undefined,
        }),
      });
    } catch (err) {
      /*
       * A refusal stands. The store has looked at this company and role and
       * said it is not a job — "Indeed — Now Hiring: 300 Software Intern
       * Jobs" — and the answer will be the same next time, so the key stays
       * and this pair is not asked about again. Dropping it would put the
       * write on every keeper tick for as long as the tab is open.
       */
      if (err?.kind === 'not-a-job') return;
      // Anything else, and the store may simply not be running, which is not
      // this save's problem: the work is already held in the browser either
      // way. Letting the key go means the next application tries again
      // rather than this one failing twice.
      await session().remove(key).catch(() => undefined);
    }
  } finally {
    holding.delete(key);
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
/** What an application is called, for a sentence a person reads. */
function nameOfTrail(trail) {
  const last = [...(trail?.pages ?? [])].reverse().find((p) => p?.role || p?.company);
  if (!last) return null;
  return { role: last.role ?? null, company: last.company ?? null };
}

/**
 * The same name in a sentence, the way the card's heading and the toolbar
 * already say it: "Platform Engineer at Helios".
 */
function sayJob(job) {
  const role = job?.role?.trim();
  const company = job?.company?.trim();
  if (role && company) return `${role} at ${company}`;
  return role || company || null;
}

async function remember(tab, page) {
  await inheritIfNew(tab?.id, tab?.openerTabId);
  const trail = await readTrail(tab?.id);
  /*
   * Three answers, not two.
   *
   * A board that keeps every posting at one address — Indeed's results pane,
   * any single-page board — leaves the url saying "same page" when the pane
   * has been changed to a different job entirely. `judgeApplication` says it
   * is unsure there rather than guessing, and unsure branches: writing the
   * second job up as the first is the failure this whole file exists to
   * prevent, and a split is the one of the two that can be undone.
   *
   * So it is undoable. What the tab is leaving is stashed whole, and the card
   * puts up a chip naming the job it has started — one press puts the old one
   * back. See `keepTogether`.
   */
  const verdict = judgeApplication(trail, page);
  const joins = verdict === 'same';
  const pages = joins ? trail.pages.filter((p) => p.url !== page.url) : [];

  if (verdict === 'unsure' && tab?.id !== undefined) {
    /*
     * Without the markup of every page but the first.
     *
     * The stash holds the pages, the writing, the tailored resume and the
     * save — everything a merge has to give back. Page text is the one part
     * that is large and nearly recoverable: the first page is the posting,
     * whose description is what a later form page reads back, and the rest is
     * forms. Keeping all of it would put half a megabyte into a 10MB budget
     * shared with every other tab.
     */
    const keeping = {
      ...trail,
      pages: (trail.pages ?? []).map((p, i) => (i === 0 ? p : { ...p, html: undefined })),
    };
    await session()
      .set({ [branchKey(tab.id)]: { trail: keeping, left: nameOfTrail(trail), at: Date.now() } })
      .catch(() => undefined);
  }

  /*
   * A page that starts a fresh application in a tab that was holding written
   * work does not get to throw it away.
   *
   * `joins` is a judgement — a click, a company name, where the pages live —
   * and judgements are wrong sometimes. When it says fresh, everything under
   * `work` is replaced: the letter, the answers, the tailored resume. That is
   * right for the resume, which can be built again in seconds, and wrong for
   * the letter, which somebody wrote.
   *
   * So it is parked where a closed tab's work is parked, under the address of
   * the page it was written on, and going back to that page brings it
   * straight back — see the rescue in `takeWork`. Nothing is carried forward
   * into the new application, because that is the failure this heuristic
   * exists to prevent; nothing is destroyed either, which is the failure it
   * was causing.
   */
  if (!joins && trail.work) {
    /*
     * Under every page of it, not only the last one. An application is a
     * posting and a form and whatever came between; somebody coming back to
     * it comes back to whichever of those they were last looking at, and
     * keying only the last one meant returning to the form found nothing
     * because the trail happened to end on the description. Five at most —
     * see `TRAIL_MAX` — and `sweepOrphans` keeps the total bounded.
     */
    const where = [...new Set(trail.pages.map((p) => p?.url).filter(Boolean))];
    if (where.length > 0) {
      await sweepOrphans();
      /*
       * Named, and from which tab. Both are for the board that keeps every
       * posting at one address: without the name the next job's page rescues
       * this job's letter one message later, which is the branch undone on
       * the spot; without the tab the card calls it "recovered from a closed
       * tab" when the tab is the one you are sitting in. See `pickParked`.
       */
      const entry = { work: trail.work, save: trail.save, job: nameOfTrail(trail), tab: tab?.id, at: Date.now() };
      for (const url of where) await parkWork(url, entry);
    }
  }

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
    /*
     * Which save this application is being built from, kept where it will
     * still be after the worker is stopped — see `saveOf`. Named in the
     * spread above rather than left to it, because a fresh application
     * inherits nothing and this is the page that decides which save it is.
     */
    save: joins ? (trail.save ?? page.save) : page.save,
    pages: keepPages(pages, TRAIL_MAX),
    /*
     * And, when this was a guess, what the guess was — so the card can say
     * "started a new application for X, same one as before?" rather than
     * silently reorganising the tab underneath somebody.
     */
    branchedFrom: verdict === 'unsure' ? nameOfTrail(trail) : undefined,
    at: Date.now(),
  };
  /*
   * The badge says what was stored, not what this function built.
   *
   * `writeTrail` answers null when session storage will not take the trail
   * even stripped of every page's text, and that is the case this file
   * budgets for rather than an impossible one — its own note puts the fill
   * point at five tabs of five pages. `saveWork` already reads the answer,
   * and says in as many words why: the note on `markTab` is that this line
   * has to be believed when it claims nothing was lost. This one drew the
   * badge from `next` regardless, so the toolbar read "3 pages read, a
   * tailored resume is ready" while the third page was in no storage
   * anywhere and the card, which re-reads, listed two.
   */
  const written = await writeTrail(tab?.id, next);
  const stored = written === null ? trail : next;
  await markTab(tab?.id, stored);
  return { ...summarise(stored), startedFresh: !joins };
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

  /** Put the files into whatever upload boxes the sub-frames hold. */
  async attachInFrames({ files }, tab) {
    if (tab?.id === undefined) return { frames: [] };
    const replies = await askFrames(tab.id, { type: 'jh-frame-attach', payload: { files } });
    return { frames: replies.map(({ frameId, data }) => ({ frameId, ...data })) };
  },

  /**
   * Tell every sub-frame that a chip is in the air, or that it has landed.
   *
   * The drop has to be taken by whichever document the pointer is over, and
   * on half the portals that matter that document is an embed — a Greenhouse
   * or Lever form in an iframe, with the top frame holding nothing but the
   * job advert. The card lives in the top frame, so without this the frame
   * under the pointer never knew a drag was happening and the drop did
   * nothing at all.
   *
   * Every frame is told, and each one decides: the same
   * `looksLikeApplicationForm` guard `jh-frame-attach` uses, for the same
   * reason — every advert and chat widget on the page runs this script too,
   * and a resume is a name, an address and an employment history in one file.
   */
  async draggingInFrames({ files }, tab) {
    if (tab?.id === undefined) return { frames: 0 };
    const replies = await askFrames(tab.id, { type: 'jh-frame-dragging', payload: { files } });
    return { frames: replies.length };
  },

  /**
   * A frame took a drop. Hand the report to the top frame, where the card is.
   *
   * `sender` names the frame that is telling us, which is not the one that
   * needs to hear: the card is in the top frame and this is the only account
   * anybody gets of where the file went.
   */
  async droppedInFrame({ report }, tab, sender) {
    const tabId = tab?.id ?? sender?.tab?.id;
    if (tabId === undefined) return false;
    await chrome.tabs
      .sendMessage(tabId, { type: 'jh-frame-dropped', payload: { report } }, { frameId: 0 })
      .catch(() => undefined);
    return true;
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
    // And nothing at all into a tab that was told to start fresh, until it
    // has read a page of its own. See `clearTrail`: the card's keeper is
    // still running when that button is pressed.
    if (trail.cleared && trail.pages.length === 0) return { ok: false };
    // And never nothing over something: a card that failed to analyse its page
    // has an empty state, and saving it threw away the resume built on the
    // page before.
    if (!worthKeeping(work) && worthKeeping(trail.work)) return { ok: false };

    // Stamped, because `at` is what says the trail is still current — work
    // written without it reads back as a trail from another sitting.
    const next = { ...trail, work, at: Date.now() };
    const written = await writeTrail(tab?.id, next);
    /*
     * The toolbar says "your writing is being held" the moment it is — and
     * only then.
     *
     * `writeTrail` returns null when session storage refuses the write, which
     * this file budgets for, and the badge was drawn from the in-memory
     * `next` regardless. Measured with the quota filled: `saveWork` answered
     * `{ok: false}`, the letter was in no storage anywhere, and the tooltip
     * read "1 page read, your writing is being held". The only caller
     * discards the reply, so that tooltip was the whole of what the user had
     * to go on — and the note on `markTab` says the purpose of this line is
     * to be believed when it says nothing was lost.
     */
    await markTab(tab?.id, written === null ? trail : next);
    void holdASpace(next, tab?.id);
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
     * writing behind, and so may this tab itself, having gone off to read
     * another job: `remember` parks what it is about to replace under every
     * page of the application it belonged to. Ctrl+Shift+T gives a reopened
     * page a new tab id and a new posting replaces the trail, so in both
     * cases the address is the only thing the two have in common.
     */
    const key = orphanKey(page?.url ?? '');
    const held = page?.url ? parkedAt((await session().get(key))[key]) : [];
    /*
     * Which job is being looked at, as the trail itself has just recorded it
     * — `analyze` reads the page and records it in one round trip, and this
     * message is sent after that, so the last page of the trail is this page.
     * Nothing else here knows: what the content script sends is an address
     * and a title.
     */
    const looking = nameOfTrail(trail);
    const rescued = pickParked(held, looking, tab?.id);
    if (rescued) {
      const fresh = Date.now() - (rescued.at ?? 0) < TRAIL_STALE_MS;
      // Claimed or expired, this one goes either way. Leaving the stale ones
      // behind is how the space fills up; see `sweepOrphans`. The others stay
      // for the job they belong to.
      if (rescued.work && fresh) {
        /*
         * Onto this tab's trail before the park is let go, and with the work
         * in it.
         *
         * The park used to be deleted first and the writing returned only in
         * the reply — so between the two there was exactly one copy of
         * somebody's letter, in a message. The caller drops that message
         * whenever the pass has been superseded, which on a single-page board
         * is any url tick: `if (!current()) return;` sits on the line after
         * the send, and the `.catch` beside it does the same thing when a
         * real navigation kills the response. The letter was then in neither
         * place, and the next pass asked again and found nothing.
         *
         * Written first, the worst case is a park that outlives its claim —
         * the same work offered twice — which `sameJob` collapses and the
         * sweep expires. Losing it is not recoverable at all.
         *
         * `at` with it: a trail without one reads as stale on the next look,
         * which would lose the save again a moment after finding it.
         */
        if (tab?.id !== undefined) {
          if (rescued.save) saveOf.set(tab.id, rescued.save);
          await writeTrail(tab.id, {
            ...trail,
            work: rescued.work,
            save: rescued.save ?? trail.save,
            at: Date.now(),
          });
        }
        await dropPark(key, rescued);
        // And its copies under the application's other pages.
        await dropParkEverywhere(rescued);
        /*
         * And which of the two rescues this was, because they want different
         * sentences. A tab that closed and came back is a surprise worth
         * explaining; going back to a job you were reading ten seconds ago,
         * in the tab you never left, is not a closed tab and saying so reads
         * as the extension having lost track.
         */
        const mine = rescued.tab !== undefined && rescued.tab === tab?.id;
        /*
         * And, where nothing checked it against this page, which job it was.
         *
         * `pickParked` refuses a park that names a plainly different job —
         * but only when it has a job to compare it to. A page the analysis
         * could not name gives it none, and rather than refuse every rescue
         * there it hands back the newest thing parked at the address, which
         * is the branch the whole Ctrl+Shift+T case runs down: a reopened tab
         * has a new id, so its own park is not recognisable as its own.
         *
         * That is the right call — the alternative loses the letter the
         * rescue exists for — but on a board that keeps every posting at one
         * address the newest park may be another job's, and "Recovered what
         * you had written before this tab closed" gave nothing to notice it
         * by. Saying whose it was costs a clause and turns a silent wrong
         * hand-off into one the reader can see.
         *
         * Only in that branch. Everywhere else the park was matched against
         * the job on screen, and the card's own heading already names it.
         */
        return {
          work: rescued.work,
          recovered: mine ? 'job' : true,
          recoveredFor: mine || looking ? undefined : sayJob(rescued.job) ?? undefined,
        };
      }
      // Claimed or expired, this one goes either way. Leaving the stale ones
      // behind is how the space fills up; see `sweepOrphans`. The others stay
      // for the job they belong to.
      await dropPark(key, rescued);
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

  /**
   * Is there an application under way in this tab, and has anything been
   * written into it?
   *
   * Asked by the score gate, and by nothing else. The gate is a guess about
   * whether a page is a posting, and it is deliberately generous in one
   * direction and silent in the other: below the threshold the card does not
   * appear, no chip appears, and nothing is said.
   *
   * That is right on an ordinary page and wrong on the page after Apply.
   * Reported from a real attempt — Indeed to a posting to a ByteDance
   * application — where the last hop is on a host no pattern here knows, in a
   * single-page form whose first paint carries almost no words. It scored
   * under the threshold, so the card withdrew rather than asking whether this
   * was the same application, and the letter and answers already written went
   * with it as far as anybody could see. The work was still held; there was
   * simply nothing on screen to reach it from, and the only way forward was
   * to start again.
   *
   * So the gate asks this first. A guess does not get to bury work somebody
   * has done: where there is an application open in this tab with something
   * in it, the card comes up and `remember` decides whether this page joins,
   * branches, or starts afresh — which is the question that was owed.
   *
   * Deliberately not about whether this page belongs. That is
   * `sameApplication`'s judgement and it is made later, with the page read;
   * this only says there is something here to be judged against.
   */
  async openHere(_payload, tab) {
    await inheritIfNew(tab?.id, tab?.openerTabId);
    const trail = await readTrail(tab?.id);
    return {
      open: (trail?.pages ?? []).length > 0,
      made: madeSomething(trail?.work),
      job: nameOfTrail(trail),
    };
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
  /**
   * "That was the same job after all" — put the application back.
   *
   * The other half of branching on an unsure verdict. Branching is the safe
   * guess of the two, because a split can be undone and a merge cannot: once
   * the second job's pages and the first job's letter are one application,
   * nothing can tell them apart again. So the tab branches, says so, and
   * keeps what it left whole until somebody presses this.
   *
   * What comes back is the pages, the writing, the tailored resume and the
   * save. The page that caused the branch joins them, which is the point: it
   * was a page of this application and was read as a new one.
   */
  async keepTogether({ tabId } = {}, tab, sender) {
    const id = whichTab(tabId, tab, sender);
    if (id === undefined) return { ok: false };
    const key = branchKey(id);
    const held = (await session().get(key).catch(() => ({})))[key];
    if (!held?.trail) return { ok: false, gone: true };

    const now = await readTrail(id);
    /*
     * And only while both halves are still real.
     *
     * `held.at` was written and never read, and the chip lives in the content
     * script's memory for as long as the page is open — so a branch left
     * unanswered overnight still offered "Same job — put it back" in the
     * morning. By then `readTrail` calls the live trail stale and answers
     * `{pages: []}`, so the merge kept the *old* pages and dropped the page
     * actually on screen: the card on job B, the toolbar naming job A, and
     * A's hours-old description fed to whatever is written next.
     */
    if (Date.now() - (held.at ?? 0) > TRAIL_STALE_MS || (now.pages ?? []).length === 0) {
      await session().remove(key).catch(() => undefined);
      return { ok: false, gone: true };
    }
    /*
     * The page that is on screen, kept, and the old pages under it. Not the
     * other way round: `keepPages` drops the oldest first, and the page being
     * looked at is the one that must survive.
     */
    const pages = keepPages(
      [...(held.trail.pages ?? []), ...(now.pages ?? []).filter((p) => !(held.trail.pages ?? []).some((q) => q.url === p.url))],
      TRAIL_MAX,
    );
    const merged = {
      ...held.trail,
      pages,
      /*
       * Both halves, not whichever is older.
       *
       * This took `held.trail.work` whenever there was any, on the grounds
       * that "the branch is seconds old, so anything under `work` now is what
       * the card rebuilt on arrival". The staleness check fifteen lines above
       * accepts a stash for two hours, and the chip offering the merge stays
       * up for as long as the page is open — so the ordinary shape is: the
       * card branches, you keep writing, and then you press the button. Every
       * sentence written after the branch went, from a button whose tooltip
       * promises "with everything you had written". Nothing had parked it,
       * because parking happens in `remember` and no `remember` ran in
       * between.
       */
      work: bothHalves(held.trail.work, now.work),
      save: held.trail.save ?? now.save,
      branchedFrom: undefined,
      at: Date.now(),
    };
    await writeTrail(id, merged);
    await markTab(id, merged);
    await session().remove(key).catch(() => undefined);
    /*
     * And the copies the branch parked, now that the writing is back here.
     *
     * Branching parks what it leaves under every page of the old application
     * — see `remember` — so that a tab closed on the new job can still reach
     * the old one's letter. The merge put the writing back into this tab and
     * left those parks where they were. Measured in tests/worker.mjs: a second
     * tab opening the posting was handed the same letter as "recovered from a
     * tab that closed", while the tab it came from was open and holding it —
     * one application being written in two places, and sent from either.
     *
     * Only this tab's parks for this job. Another tab's, or another job's at
     * the same address, are still somebody's only copy.
     */
    const leftJob = nameOfTrail(held.trail);
    const ours = (p) => p.tab === id && (leftJob ? sameJob(p.job, leftJob) : !p.job);
    for (const url of new Set((held.trail.pages ?? []).map((p) => p?.url).filter(Boolean))) {
      await unpark(orphanKey(url), ours);
    }
    /*
     * With the writing, which `summarise` deliberately strips.
     *
     * The merge put the letter back into the trail and answered with a
     * summary — and a summary is booleans. Both callers did only `setTrail`,
     * so nothing reached the screen: the panel grew to two pages, the letter
     * did not come back, and two seconds later the card's keeper saved its
     * own empty work over the restored trail. Pressing a button whose tooltip
     * promises "with everything you had written" lost the writing for good.
     */
    return { ok: true, work: merged.work ?? null, ...summarise(merged) };
  },

  /**
   * And the opposite: "no, this really is a different job".
   *
   * Dismisses the offer without merging, so the strip stops asking. The
   * branch has already happened — this only agrees with it.
   */
  async keepApart({ tabId } = {}, tab, sender) {
    const id = whichTab(tabId, tab, sender);
    if (id === undefined) return { ok: false };
    const trail = await readTrail(id);
    await writeTrail(id, { ...trail, branchedFrom: undefined, at: Date.now() });
    await session().remove(branchKey(id)).catch(() => undefined);
    return { ok: true };
  },

  async clearTrail({ tabId, keep } = {}, tab, sender) {
    const id = whichTab(tabId, tab, sender);
    const trail = await readTrail(id);
    const held = keep?.url ? trail.pages.filter((p) => p.url === keep.url) : [];

    /*
     * What is being forgotten is parked first, exactly as `remember` parks it.
     *
     * Forgetting an application and destroying what was written for it are two
     * different things, and every other path already knows it: closing the tab
     * parks, and `remember`'s own fresh start parks with the reason written
     * out — "nothing is destroyed either, which is the failure it was
     * causing". This one dropped `trail.work` on the floor, and it is reached
     * from the popup, whose panel says "your writing is being held, and comes
     * back when you return" two lines above the button. So the same intent had
     * two outcomes, and the destructive one was the one that had just promised
     * otherwise.
     *
     * Under the pages being forgotten, never the one kept. The card's "start a
     * new application here" keeps the page you are on, and parking under that
     * url would have the new application rescue the old one's letter on its
     * first read — the failure `pickParked` exists to prevent, arranged by
     * hand. The pages that go are the pages the writing goes with.
     */
    if (trail.work) {
      const gone = [...new Set(trail.pages.filter((p) => !held.includes(p)).map((p) => p?.url).filter(Boolean))];
      if (gone.length > 0) {
        await sweepOrphans();
        const entry = { work: trail.work, save: trail.save, job: nameOfTrail(trail), tab: id, at: Date.now() };
        for (const url of gone) await parkWork(url, entry);
      }
    }

    if (held.length === 0) {
      /*
       * Marked as emptied, not simply removed.
       *
       * An absent trail and a forgotten one read the same to everything
       * downstream — `pages: []` — and the card does not stop writing when
       * this is pressed: its keeper re-sends the resume and the letter every
       * two seconds. `saveWork`'s two guards are both gated on the trail
       * having something in it, so within two seconds of "Start fresh" the
       * trail was back, holding the old job's work under no pages, with no
       * `save` and no badge. The next posting read in that tab was then
       * handed it. The mark is what tells the two apart; it expires with the
       * trail's own staleness window, so a tab left alone is a new tab again.
       */
      await writeTrail(id, { pages: [], cleared: Date.now(), at: Date.now() });
      /*
       * And the remembered binding with it, or the next application in this
       * tab inherits the last one's save.
       *
       * `saveFor` falls back to the map when the trail has no save, which is
       * exactly what this branch leaves behind: the trail is gone and the map
       * still answers. "Start fresh", open another save in the editor, read a
       * posting — and the new application was filed into the save the
       * forgotten one came from.
       */
      saveOf.delete(id);
      await markTab(id, { pages: [] });
      return { pages: [] };
    }

    /*
     * The save binding survives, because it is not part of the application.
     *
     * Every other writer spreads `...trail`; this one built a fresh object,
     * so `save` — the one field kept here specifically to outlive the worker,
     * see `saveOf` — was dropped. It went on working while the worker lived,
     * because `saveFor` finds it in the map first, and the map is memory.
     *
     * Measured, with one variable changed at a time: read a posting, follow
     * Apply, press "Start a new application here", let the worker be stopped,
     * then Build. The resume compiles and the preview appears, and then the
     * automatic filing is refused under a perfectly good document — "JobHelper
     * has lost track of which save this application was built from". Leave the
     * button unpressed, or leave the worker alive, and neither happens.
     *
     * Which save you are working in is not something "use only this page"
     * says anything about. The pages are what is being forgotten.
     */
    const next = { pages: held, save: trail.save, at: Date.now() };
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
      /*
       * With a deadline, and only a reply that says it worked.
       *
       * This is the one server call in here that does not go through
       * `serverFetch`, and it had neither of those. A server that accepts the
       * socket and then never answers — wedged, paused, behind a proxy that
       * has lost its upstream — left this promise unsettled for ever, and the
       * popup's AI panel awaits it: it sat on whatever `popup.html` had
       * painted before anything was known, while the status line underneath
       * correctly reported that the server had not answered. The window
       * contradicted itself and never stopped.
       *
       * And `res.ok` was never looked at, so a 503 carrying `{"error": "The
       * store is still starting up."}` was read as a health payload. That has
       * no `ai` in it, so "no AI is configured" is what the panel concluded —
       * about a server that has one and was merely restarting — and it
       * offered a button to go and set up what was already set up.
       */
      const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
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

  /**
   * And this extension's own switch, from the same chip.
   *
   * The other half of the pair above, and the half that had no way out at
   * all. Turn the AI on in ResumeM-M — which is where somebody who has just
   * set one up is sitting — and the card still reads "AI off", because this
   * extension has its own opt-in and it starts off. The chip said so in a
   * tooltip and did nothing when pressed, and there is nothing on the card to
   * say the remaining switch is behind the toolbar icon.
   *
   * Answers the fresh status rather than `{ ok: true }`, so the chip redraws
   * from what is now true of both switches instead of assuming its own press
   * was the whole story.
   */
  async setUseAi({ enabled }) {
    await chrome.storage.sync.set({ useAi: Boolean(enabled) });
    return handlers.aiStatus();
  },

  async getSettings() {
    return getSettings();
  },

  async setSettings({ patch }) {
    await chrome.storage.sync.set(patch);
    return getSettings();
  },

  /**
   * Mute a site, or stop muting it.
   *
   * Its own message because it is a read-modify-write of one shared list, and
   * it had two callers doing it separately — the popup's button and the
   * card's "never offer here" — each reading `mutedHosts`, adding its own
   * host and writing the whole array back through `setSettings`. Mute one
   * site from the card and another from the popup close together and the
   * second read happens before the first write lands, so one of them is
   * dropped: a button that said Muted and did nothing, and no way to tell
   * except by meeting the site again.
   *
   * `chrome.storage.sync` has no compare-and-set, so the exclusion is the
   * same promise chain `changeFrames` uses, and the note there applies here
   * too: it is enough only because there is one service worker at a time.
   */
  async muteHost({ host, muted }) {
    if (!host) return getSettings();
    await changeSettings((settings) => {
      const hosts = new Set(settings.mutedHosts ?? []);
      if (muted) hosts.add(host);
      else hosts.delete(host);
      return { mutedHosts: [...hosts] };
    });
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
    /*
     * Nothing, unless this call says otherwise.
     *
     * Landing on a posting used to run the keyword match, and run the model if
     * the AI switch was on — so simply reading a job advert started a tailoring
     * pass, and clicking through an application started one per page. Both
     * cost something the person had not asked for: the model costs money and
     * minutes, and the match arrives having already changed the resume, which
     * makes "send what I have" the thing you undo rather than the default.
     *
     * The pages are still read and still remembered; what stops is acting on
     * them. `tailor` is passed explicitly by each of the three buttons, so
     * this fallback is only ever the opening analysis.
     */
    const mode = tailor ?? (typeof useAi === 'boolean' ? (useAi ? 'ai' : 'match') : 'none');
    const result = await stoppably(tab, 'rebuild', (signal) =>
      serverFetch('/api/extension/analyze', {
        method: 'POST',
        signal,
        /*
         * The long deadline belongs to the AI and nothing else.
         *
         * Every mode came through here on `SLOW_TIMEOUT_MS`, which is ten
         * minutes, because one of them runs a model. The keyword match reads
         * the pages and picks among phrasings already written — no model, no
         * LaTeX, no network beyond this one call. Measured against the worst
         * case worth having, eight pages totalling 17.6MB against a real save,
         * that is two seconds. It runs on arrival now, so that deadline is the
         * one every ordinary page lands on.
         *
         * So a keyword match or a straight copy that went wrong sat there
         * looking like work for ten minutes before saying anything, which is
         * indistinguishable from a wedged server and is what it was. Twenty
         * seconds is ten times the measured worst case, and the difference is
         * between a message you can act on and a morning.
         */
        timeoutMs: mode === 'ai' ? SLOW_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
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
      }),
    );

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
    /*
     * Only if this tab has not already bound itself to one.
     *
     * A page is analysed again whenever the worker comes back, which is often
     * — and this line used to take whichever save was open at that moment. So
     * an application in progress could be moved to a different save without
     * anything happening on screen: the work still showing came from the old
     * one, `saveOf` now said the new one, and the write went there and was
     * not refused, because it agreed with itself. Quietly rebinding is the
     * exact failure the header exists to prevent, arriving through the code
     * that sets it.
     *
     * A genuinely new application in this tab does rebind — see `remember`,
     * which keeps the save only while the application continues.
     */
    if (result?.save && tab?.id !== undefined && !(await saveFor(tab.id))) {
      saveOf.set(tab.id, result.save);
    }
    if (result?.isJobPosting) {
      await remember(tab, {
        save: result?.save,
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
  /**
   * Build the files and put them in the flat folder, without filing the
   * application as sent.
   *
   * Same endpoint as `bundle`; the status is forced here rather than taken
   * from the caller, so that this route cannot file something by accident.
   * That is the only difference and it is the point of having two names.
   */
  async stage(payload, tab) {
    return serverFetch('/api/applications/bundle', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      save: await saveOrRefuse(tab?.id),
      body: JSON.stringify({ ...payload, status: 'applying' }),
    });
  },

  async bundle(payload, tab) {
    return serverFetch('/api/applications/bundle', {
      method: 'POST',
      timeoutMs: SLOW_TIMEOUT_MS,
      save: await saveOrRefuse(tab?.id),
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
    /*
     * With a ceiling, like every other call to the store.
     *
     * This one went round `serverFetch` because it wants bytes rather than
     * JSON, and took its deadline with it: a bare `fetch` against a server
     * that accepts the socket and never answers never settles. Measured at
     * 75 seconds and still waiting, with the worker held alive by the
     * in-flight request — and the card had already latched
     * `state.shownPdf[kind]`, so the preview pane stayed a grey strip with no
     * message and never asked for that url again.
     */
    let res;
    try {
      res = await fetch(absolute, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      const failed = new Error('ResumeM-M did not answer with the PDF. Check it is still running, then try again.', {
        cause,
      });
      failed.jobhelper = { fix: 'start-server', serverUrl };
      throw failed;
    }
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

  /**
   * What the form can be filled from — as the resume being sent says it.
   *
   * The resume's `choices` go along because some answers differ per resume,
   * and the graduation date is the one that matters: somebody applying to
   * internships and new-grad roles keeps two, and the form asked with no
   * resume named was answered from the default — May, on every internship
   * form, under a resume that says December. The store reads the choices and
   * answers the way the attached document does.
   */
  async autofillData(_payload, tab) {
    const trail = await readTrail(tab?.id);
    const choices = trail?.work?.spec?.choices;
    const query =
      choices && typeof choices === 'object' && Object.keys(choices).length > 0
        ? `?choices=${encodeURIComponent(JSON.stringify(choices))}`
        : '';
    return serverFetch(`/api/autofill${query}`);
  },

  /**
   * The answers this person has already given to questions like these.
   *
   * The matching lives in the store, not here. ResumeM-M's `matchAnswer` is
   * the only question-similarity function either product has, it is what the
   * Workspace already answers questions with, and a second one written in the
   * extension would be a copy that drifts — silently, and into an application
   * answered wrongly rather than into a failing test.
   *
   * Only the confident matches come back. `matchAnswer` grades every one, and
   * a loose match is a starting point for somebody to read, not something to
   * tick a radio button with; the Workspace shows those and this does not use
   * them. The question is echoed back beside its answer so the caller can
   * pair them up by string equality.
   */
  async rememberedAnswers({ questions }) {
    if (!Array.isArray(questions) || questions.length === 0) return { answers: [] };
    const reply = await serverFetch('/api/answers/match', {
      method: 'POST',
      body: JSON.stringify({ questions }),
    }).catch(() => null);

    const answers = (reply?.matches ?? [])
      .filter((m) => m?.confident && m.answer)
      .map((m) => ({ question: m.question, answer: m.answer }));
    return { answers };
  },

  /**
   * What this application could attach, with the bytes of each.
   *
   * One round trip rather than a list and then a fetch per file, because the
   * card asks for this the moment somebody presses Attach and a second wait
   * between the press and the files appearing is the whole of what the
   * feature saves. A resume is about 30kB and there are rarely more than
   * three; the messaging channel is JSON, so they travel as base64, the same
   * way `pdfBytes` sends one.
   */
  async attachments({ application }, tab) {
    const { serverUrl } = await getSettings();
    const list = await serverFetch(
      `/api/attachments${application ? `?application=${encodeURIComponent(application)}` : ''}`,
      { save: await saveFor(tab?.id) },
    );
    const base = serverUrl.replace(/\/$/, '');

    const files = [];
    /*
     * And the ones that would not come.
     *
     * A file that 404s or times out was dropped here and appeared in neither
     * list afterwards — so the card said "Attached the resume and the letter"
     * with the transcript unmentioned, as though it had never been asked for.
     * The note above this loop has always said the card names what it got and
     * what it did not; this is what lets it.
     */
    const missing = [];
    for (const item of list.attachments ?? []) {
      try {
        const res = await fetch(`${base}${item.url}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
        if (!res.ok) {
          missing.push({ name: item.name, why: `the store answered ${res.status} for it` });
          continue;
        }
        const buffer = new Uint8Array(await res.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buffer.length; i += 8192) {
          binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
        }
        files.push({
          name: item.name,
          standing: Boolean(item.standing),
          type: res.headers.get('content-type') ?? 'application/pdf',
          base64: btoa(binary),
        });
      } catch {
        // One file that would not come is not a reason to attach none of the
        // others. The card names what it got and what it did not.
        missing.push({ name: item.name, why: 'the store did not hand it over' });
      }
    }
    return { files, missing, dir: list.dir, asked: (list.attachments ?? []).length };
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
  async answerQuestion({ question, force, job, limit }, tab) {
    return stoppably(tab, 'answerQuestion', (signal) =>
      serverFetch('/api/ai/answer', {
        method: 'POST',
        signal,
        timeoutMs: SLOW_TIMEOUT_MS,
        body: JSON.stringify({
          question,
          force,
          // The box's own `maxlength`, so the draft is written to fit it.
          limit,
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
      }),
    );
  },

  /**
   * An answer somebody chose on a form, kept for the next one.
   *
   * Goes into the same answer bank a written answer goes into, because it is
   * the same thing: a question this person has answered before. The label
   * says where it came from, so a bank row can be told from one they wrote in
   * the editor.
   *
   * The refusal happened on the page — see `worthRemembering` — so nothing
   * personal reaches this function, let alone the store.
   */
  async rememberChoice({ question, answer }) {
    if (!question?.trim() || !answer?.trim()) return { ok: false };
    return serverFetch('/api/answers/save', {
      method: 'POST',
      body: JSON.stringify({ question, answer, label: 'Chosen on a form' }),
    });
  },

  async saveAnswer({ question, answer, itemId, label }) {
    return serverFetch('/api/answers/save', {
      method: 'POST',
      // `label` is the employer this was written for. Dropping it here is how
      // every answer the card saved ended up labelled "Saved" — see the note
      // at the call site in card.js.
      body: JSON.stringify({ question, answer, itemId, label }),
    });
  },

  /**
   * The letter and every answer, in one run of the model.
   *
   * The two handlers below still exist and are still used: they are what
   * redrafting a single thing does, and what happens when the reply says one
   * run was not possible — the writing tools need an MCP entry point and a CLI
   * willing to take it, and without those the pieces cannot be collected
   * apart from each other.
   */
  async writeApplication({ spec, job, letter, questions }, tab) {
    return stoppably(tab, 'writeApplication', (signal) =>
      serverFetch('/api/extension/write', {
        method: 'POST',
        signal,
        timeoutMs: SLOW_TIMEOUT_MS,
        body: JSON.stringify({
          // The base, as `coverLetter` does: a tailored spec exists only in
          // the card until the folder is built, so the store has never seen
          // it.
          resumeId: spec.extends ?? spec.id,
          job: {
            jobTitle: job.title,
            company: job.company,
            jobDescription: job.description ?? '',
            url: job.url ?? job.source,
          },
          letter,
          questions,
        }),
      }),
    );
  },

  /**
   * Draft a cover letter. The server returns the relevant previous letters
   * whether or not the AI runs, so there is always something to start from.
   */
  async coverLetter({ spec, job }, tab) {
    return stoppably(tab, 'coverLetter', (signal) =>
      serverFetch('/api/ai/cover-letter', {
        method: 'POST',
        signal,
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
      }),
    );
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
      save: await saveOrRefuse(tab?.id),
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
    /*
     * The trail first, and the page itself when the trail has nothing yet.
     *
     * A frame has no card and no analysis, so it cannot say what it has just
     * submitted — it asks here, and here used to read only the trail. The
     * trail's `work` is written by a keeper running every two seconds, and
     * pressing Submit inside an embedded form is faster than that when the
     * resume is already built and the fields are already filled. So the one
     * send a frame has went nowhere and the tracker kept saying `applying`
     * for an application that had gone out. Measured on the ATS walk: the
     * embedded board failed this on every run, while the same form served as
     * its own page passed every time — the difference being which document
     * held the answer.
     */
    const named =
      trail?.work?.spec?.generatedFor ?? (tab?.id === undefined ? null : await askThePage(tab.id));
    if (!named?.company || !named?.role) return { ok: false };
    return handlers.applicationSent({ company: named.company, role: named.role, url, note }, tab);
  },

  /**
   * "The form for this application was just sent."
   *
   * Passed straight through: what it is worth to the tracker — whether it
   * moves anything, and never backwards — is the store's decision, and it is
   * the only side that knows how an application is named.
   */
  async applicationSent({ company, role, url, note }, tab) {
    try {
      return await serverFetch('/api/extension/sent', {
        method: 'POST',
        /*
         * Which save this application belongs to, like every other write that
         * touches the tracker.
         *
         * This was the one that did not say. The store refuses a header that
         * names a different save and lets a request with *no* header through
         * to whichever one happens to be open — which is the failure that
         * check was built for, described in its own words where it is
         * installed: "Filing it then wrote the application into whichever
         * save happened to be open… a row in somebody else's tracker." So
         * staging in "work" and then switching the editor to "personal"
         * before pressing Submit left the Helios row in "work" reading
         * `applying` for an application that had gone out, and put a stray
         * one in "personal".
         *
         * `saveFor`, not `saveOrRefuse`: this handler must not throw. The
         * form has already been submitted by the time it runs, and the note
         * below is right that a store which cannot be reached is no reason to
         * interrupt somebody who has just applied. Not knowing the save is
         * rare — the trail carries it, and the per-tab map answers when the
         * trail does not — and when it happens this is no worse than it was.
         */
        save: await saveFor(tab?.id),
        body: JSON.stringify({ company, role, url, note }),
      });
    } catch (err) {
      // The store not running is not a reason to interrupt somebody who has
      // just sent an application. It stays in the tracker as "applying".
      return { ok: false, error: String(err?.message ?? err) };
    }
  },

  /**
   * Let go of whatever this tab has in the air.
   *
   * Answers how many were let go of rather than `{ ok: true }`, because zero
   * is a real and useful answer: it means the reply had already landed and
   * the card is about to show it, and a card that has just hidden its
   * progress bar on the strength of a stop it did not actually make would be
   * lying about which of the two happened.
   */
  async cancelWork({ what }, tab) {
    const held = stoppable.get(tab?.id);
    if (!held) return { stopped: 0 };
    // A copy, because aborting runs the `finally` in `stoppably`, which
    // mutates the set we would otherwise be iterating.
    const going = [...held].filter((ctl) => !what?.length || what.includes(ctl.what));
    for (const ctl of going) ctl.abort(stopReason());
    return { stopped: going.length };
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

/**
 * Throw away rescued work nobody came back for.
 *
 * An orphan is written whenever a tab holding a letter closes, and until now
 * it was only ever removed by a reopened tab on that same address claiming it.
 * Close ten tabs you never return to and ten copies of your writing sit there
 * for the rest of the browser session.
 *
 * That matters because the space is already budgeted to the limit: session
 * storage is 10MB shared, and `writeTrail`'s own comment notes that five tabs
 * holding five pages fills it exactly. When it does fill, the failure is
 * silent and it is the wrong thing that degrades — `writeTrail` starts
 * dropping page text, so the description stops crossing pages, which is the
 * feature the trail exists for. Dead orphans must not be what costs you that.
 *
 * Swept when a new one is written, which is the only moment the number can
 * grow, and bounded by count as well as by age so a single long sitting cannot
 * accumulate without limit.
 */
const ORPHAN_LIMIT = 20;

async function sweepOrphans() {
  const all = await session().get(null).catch(() => ({}));
  /*
   * Branch stashes too. Each holds a whole trail including the first page's
   * markup — up to `TRAIL_HTML_MAX` — and until now nothing expired them: a
   * branch nobody answered sat in a budget this file's own note calls full at
   * five tabs of five pages. What degrades when it fills is page text, which
   * is the feature the trail exists for.
   */
  const mine = Object.entries(all ?? {})
    .filter(([key]) => key.startsWith('jh-orphan:') || key.startsWith('jh-branched:'))
    .map(([key, value]) => ({ key, at: value?.at ?? 0 }));

  const now = Date.now();
  const expired = new Set(mine.filter((o) => now - o.at > TRAIL_STALE_MS).map((o) => o.key));

  /*
   * By the moment each was written, because that is what an application is
   * here.
   *
   * A closed tab parks its writing under *every* page of the trail it was on
   * — the posting, the form, whatever came between — so that coming back to
   * whichever of them you were last looking at finds it. One application is
   * therefore several keys, written in one go and all carrying the same `at`.
   *
   * The count used to be of keys, newest first, cut wherever the number ran
   * out. That cut falls inside an application as easily as between two: four
   * of five pages kept and the fifth let go, so the letter is still there and
   * which page you come back through decides whether you find it. Nothing
   * says so either way, and the one page people actually return to — the
   * posting they searched for again — is as likely to be the dropped one as
   * not.
   */
  const groups = new Map();
  for (const o of mine) {
    if (expired.has(o.key)) continue;
    groups.set(o.at, [...(groups.get(o.at) ?? []), o.key]);
  }

  const surplus = [];
  let kept = 0;
  for (const [, keys] of [...groups.entries()].sort((a, b) => b[0] - a[0])) {
    // Whole or not at all — except that the newest is always kept, so a trail
    // longer than the whole budget cannot throw away the thing that has just
    // been rescued.
    if (kept === 0 || kept + keys.length <= ORPHAN_LIMIT) kept += keys.length;
    else surplus.push(...keys);
  }

  const doomed = [...expired, ...surplus];
  if (doomed.length > 0) await session().remove(doomed).catch(() => undefined);
}

chrome.tabs?.onRemoved?.addListener(async (tabId) => {
  try {
    const trail = await readTrail(tabId);
    /*
     * Under every page of it, as `remember` does and for the reason given
     * there.
     *
     * The last page is the form, and the form is not how anybody comes back.
     * Write half a letter on it, lose the tab, and what you do next is search
     * for the job again and land on the description — a different address,
     * under which nothing was filed, so the letter was unreachable while
     * sitting in storage one key away. Measured: the letter parked under the
     * form's url only, and the posting's card came up empty.
     */
    const where = [...new Set((trail.pages ?? []).map((p) => p?.url).filter(Boolean))];
    if (trail.work && where.length > 0) {
      await sweepOrphans();
      /*
       * And which save it was built from. Without it the rescued application
       * comes back knowing what it says and not where it belongs, and the
       * writes that follow go out with no `X-RMM-Project` at all — which the
       * store does not refuse. See `saveOf`.
       */
      const entry = { work: trail.work, save: trail.save, job: nameOfTrail(trail), at: Date.now() };
      for (const url of where) await parkWork(url, entry);
    }
  } catch {
    // Storage full, or the trail already gone. Losing the rescue copy is not
    // worth failing the cleanup that follows.
  }
  // The branch stash goes with the tab it belonged to. It holds a whole
  // trail, first page's markup and all, and nothing else ever removed it.
  session().remove([trailKey(tabId), framesKey(tabId), branchKey(tabId)]).catch(() => undefined);
});

/*
 * Frames left behind by a navigation are pruned the first time they fail to
 * answer, in `askFrames`. Noticing the navigation itself would be tidier but
 * costs the `webNavigation` permission, and an extension that reads every page
 * you visit should ask for as little as it can get away with. The cost of
 * doing it lazily is one message that goes nowhere, once.
 */

/**
 * Settings that exist but cannot be chosen, and so must not be frozen.
 *
 * A default written into storage stops being a default. `getSettings` reads
 * `chrome.storage.sync.get(DEFAULTS)`, which returns a stored value whenever
 * the key is present — so seeding every default on install pinned all of them
 * to whatever version somebody first installed, and a later improvement to
 * one reached new installs only.
 *
 * That already happened. `minScore` went from 4 to 3 in "Follow one
 * application across the pages it is spread over", precisely so the card
 * would stop being absent on application forms — which describe nothing and
 * score almost nothing. Anyone installed before that keeps 4 for ever, and
 * the symptom is silence on exactly the pages the change was made for.
 *
 * Nothing needed the seed: `getSettings` supplies a default for every key
 * that is missing, which is the whole point of passing DEFAULTS to `get`. So
 * it is gone, and from here a default stays a default until somebody changes
 * it.
 *
 * The stored copies left behind by earlier installs still need clearing, and
 * that can only be done where it is certain the value was never a choice.
 * `minScore` has no control anywhere — it is read in content.js and written
 * nowhere — so a stored copy of it is a seed and nothing else. The settings
 * that do have controls are left exactly alone: a value that could have been
 * chosen is treated as chosen.
 */
const NEVER_CHOSEN = ['minScore'];

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(NEVER_CHOSEN);
  const seeded = NEVER_CHOSEN.filter((key) => key in stored);
  if (seeded.length > 0) await chrome.storage.sync.remove(seeded);
});
