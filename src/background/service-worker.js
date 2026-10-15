/**
 * The service worker owns every call to the ResumeM-M server. Content scripts
 * run in the page's origin, so routing requests through here keeps loopback
 * traffic out of the page's reach and gives one place to report a server that
 * is not running.
 */

import { getSettings, NOT_PAIRED_MESSAGE, pairingHeaders, rememberPairing } from '../shared/config.js';
import { saveBugReport, listBugReports, syncBugReport, clearBugReport, extensionBuild } from '../shared/bug-reports.js';
import {
  OPEN_FORM_DRAFT_KEY,
  OPEN_FORM_KEY,
  cardDraft,
  createLogBuffer,
  dismissRefusedErrorLogs,
  queuedErrorLogs,
  refusedErrorLogs,
  routeOf,
  saveErrorLog,
  sendQueuedErrorLogs,
} from '../shared/error-log.js';
import {
  EXPECTATION_MS,
  employerKey,
  hostOf,
  rootOf,
  judgeApplication,
  keepPages,
  onlyLists,
  plainlyAnotherRole,
  pressedOnAnotherJob,
  lighten,
  sameApplication,
  carriesOn,
  titleKey,
  withoutGenderTag,
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

/*
 * What went wrong lately, for ResumeM-M's error log (see shared/error-log.js):
 * this worker's own errors, every call to ResumeM-M that failed, errors the
 * content scripts and the card forward, and which actions ran and how they
 * ended. Never a field's value or anything written. In session storage as
 * well as memory, because this worker is stopped after half a minute idle
 * and the error is usually noticed a minute after it happened.
 */
const workerLog = createLogBuffer({ storage: chrome.storage?.session ?? null });
const noteEvent = (kind, level, message, detail) => workerLog.push({ kind, level, message, detail });
globalThis.addEventListener?.('error', (event) => {
  noteEvent('worker-error', 'error', `${event.message || 'An error with no message'}${event.filename ? ` (${String(event.filename).split('/').pop()}:${event.lineno ?? 0})` : ''}`);
});
globalThis.addEventListener?.('unhandledrejection', (event) => {
  noteEvent('worker-error', 'error', `Nobody caught: ${event.reason?.message ?? String(event.reason)}`);
});

/*
 * Entries logged while ResumeM-M could not be reached go the next time it
 * answers anything. Assumed waiting when the worker starts, since this copy
 * does not know what the last one queued; looked at once, it knows.
 */
let errorLogsMaybeQueued = true;
function sendQueuedSoon(path) {
  if (!errorLogsMaybeQueued || path === '/api/error-log') return;
  errorLogsMaybeQueued = false;
  sendQueuedErrorLogs(serverFetch, chrome.storage.local)
    .then((r) => {
      if (r.queued > 0) errorLogsMaybeQueued = true;
    })
    .catch(() => {
      errorLogsMaybeQueued = true;
    });
}

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
 * The id a ResumeM-M too old to be asked gives the letter it files for this
 * employer and role.
 *
 * Only ever used for such a store: a current one names the id itself (see
 * `saveLetter`), which is the only way the two cannot drift. The employer
 * and the role each cut to 30 characters, with whichever is empty left out.
 * "Save to store" used to key the letter with a role cut at 40 and a
 * "letter" stand-in for a missing employer, so the letter saved here and the
 * one filed with the application were two rows for one letter.
 *
 * And the day in UTC, because that is the day such a store dates it by:
 * `letterId` there is `toISOString().slice(0, 10)`. The local day, which the
 * current store uses and this once copied, was a different day from that
 * store's every evening west of Greenwich — so the lookup that keeps a
 * filed letter from being written over (see `saveLetter`) looked under the
 * wrong date and found nothing.
 */
function letterId(company, role, at = new Date()) {
  const day = at.toISOString().slice(0, 10);
  /*
   * Letters and digits in any script, exactly as the server's rule does it.
   * ASCII only, an employer written in Japanese, Cyrillic, Arabic or Hebrew
   * slugged to nothing, so two such letters on one day were both the bare
   * date and the second was saved over the first.
   */
  const slug = (s) =>
    String(s)
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 30);
  return [day, company && slug(company), role && slug(role)].filter(Boolean).join('-');
}

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
 * A draft and what to change about it, only as much of it as was given — so a
 * plain first draft asks exactly what it always asked.
 */
function revision({ draft, feedback }) {
  const out = {};
  if (typeof draft === 'string' && draft.trim()) out.draft = draft;
  if (typeof feedback === 'string' && feedback.trim()) out.feedback = feedback.trim();
  return out;
}

/**
 * Which resume a letter, an answer or a re-tailor is written from.
 *
 * The card's resume is a proposal the store is not given until the folder is
 * built, so its own id names nothing there. This used to send the resume it
 * inherited from instead — `spec.extends ?? spec.id` — and resumes stopped
 * inheriting: `extends` is always missing now, the proposal's id went, and
 * every letter asked for from the card came back "No resume named …".
 *
 * The proposal itself goes, which the server writes from; `copiedFrom` goes as
 * the id, so a server that predates taking the proposal still finds a resume
 * that exists.
 */
function writingFrom(spec) {
  return { resumeId: spec?.copiedFrom ?? spec?.id, spec };
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

/**
 * The refusal ResumeM-M gives an extension it has not paired with, as
 * something to do rather than a failure.
 *
 * The button goes to the editor's pairing section, which is where the code
 * is. Marked `pair`, so the popup can put its code box up; anything that only
 * knows the older marks still gets a button that opens the right page.
 */
function notPaired(serverUrl, cause) {
  const err = new Error(NOT_PAIRED_MESSAGE, cause ? { cause } : undefined);
  err.kind = 'not-paired';
  err.status = 403;
  err.jobhelper = { fix: 'pair', serverUrl: `${serverUrl.replace(/\/$/, '')}/#pair`, codeUrl: pairCodeUrl(serverUrl) };
  return err;
}

/**
 * The editor's pairing section, with a fresh code already made.
 *
 * What "Get a code" opens, beside the code box on the card, the popup and
 * the side panel. The editor reads `make=1` and presses its own "Make a
 * code" (see `arriveToPair` in ResumeM-M's web/app.js), so the person only
 * reads the code off it. The code is still made by the editor's request,
 * not by this link: ResumeM-M answers that route for its own page alone.
 */
function pairCodeUrl(serverUrl) {
  return `${serverUrl.replace(/\/$/, '')}/#save/pair?make=1`;
}

/*
 * One pairing exchange at a time, for every tab.
 *
 * The code box is wherever the request failed — a card on each job page
 * that was open, the popup, the side panel — so the same code can be
 * pressed in two of them at once, or pasted into one while another is
 * still waiting. Each exchange the store sees is a try: two of the same
 * right code would spend it on the first and call the second wrong, and two
 * of the same wrong code would cost two of the extension's five tries. So
 * the exchange is held here: the same code again joins the one in the air,
 * and a different code waits for it — and is not sent at all if that one
 * paired.
 *
 * When one pairs, every tab hears it (`jh-paired`), so a card waiting for a
 * code on another job page carries on without being asked again.
 */
let pairingNow = null;
const PAIR_LATER_PREFIX = 'jh-pair-later:';

async function pairOnce(code) {
  const said = String(code ?? '').trim();
  if (!said) throw new Error('Enter the code ResumeM-M is showing under Save & Files → Pair JobHelper.');
  const key = said.toUpperCase().replace(/[\s-]/g, '');
  for (let now = pairingNow; now; now = pairingNow) {
    if (now.key === key) return now.run;
    if (await now.run.then(() => true, () => false)) return { paired: true, already: true };
    // Its own `finally` may not have run yet; it is over either way.
    if (pairingNow === now) pairingNow = null;
  }
  const run = (async () => {
    const { serverUrl } = await getSettings();
    const reply = await serverFetch('/api/extension/pair', { method: 'POST', body: JSON.stringify({ code: said }) });
    if (typeof reply?.token !== 'string' || !reply.token) throw new Error('ResumeM-M did not hand back a pairing.');
    await rememberPairing(serverUrl, reply.token);
    await pairedEverywhere();
    return { paired: true };
  })();
  const mine = { key, run };
  pairingNow = mine;
  try {
    return await run;
  } finally {
    if (pairingNow === mine) pairingNow = null;
  }
}

/** Every tab's card told it is paired now, and every "Not now" let go of. */
async function pairedEverywhere() {
  const all = await session().get(null).catch(() => ({}));
  const later = Object.keys(all ?? {}).filter((k) => k.startsWith(PAIR_LATER_PREFIX));
  if (later.length) await session().remove(later).catch(() => undefined);
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(
    tabs.map((t) => chrome.tabs.sendMessage(t.id, { type: 'jh-paired' }, { frameId: 0 }).catch(() => undefined)),
  );
}

async function serverFetch(path, options = {}) {
  const { timeoutMs = REQUEST_TIMEOUT_MS, save, ...init } = options;
  const { serverUrl } = await getSettings();
  const url = `${serverUrl.replace(/\/$/, '')}${path}`;
  // On every request: ResumeM-M answers only the extension it paired with.
  const paired = await pairingHeaders(serverUrl);

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
        ...paired,
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
    noteEvent('server', 'error', `${init.method ?? 'GET'} ${routeOf(path)} ${wedged ? 'got no answer' : 'did not reach ResumeM-M'}`, {
      method: init.method ?? 'GET',
      route: routeOf(path),
      status: null,
    });
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
    noteEvent('server', res.status >= 500 ? 'error' : 'warn', `${init.method ?? 'GET'} ${routeOf(path)} → ${res.status}: ${body.error ?? res.statusText}`, {
      method: init.method ?? 'GET',
      route: routeOf(path),
      status: res.status,
    });
    // Not paired, or no longer: said as what to do, with the way to do it.
    if (body.kind === 'not-paired') throw notPaired(serverUrl);
    const failed = new Error(body.error ?? `${res.status} ${res.statusText}`);
    // And the status, for a caller that has to tell "refused" from "not
    // yet": see `syncBugReport`, whose report is never sent again after a 4xx.
    failed.status = res.status;
    // What the store called it, for the callers that treat one refusal
    // differently from another. See `holdASpace` and `not-a-job`.
    if (typeof body.kind === 'string') failed.kind = body.kind;
    // A resume write refused because the store holds a write it was not based
    // on: what is there now, and which write that is. See `filingRefused`.
    if (body.kind === 'conflict') failed.conflict = { id: body.id ?? null, current: body.current ?? null, version: body.version ?? null };
    // A stage held because the application may already have gone out, and
    // which one: the card asks rather than says. See `filingRefused`.
    if (body.kind === 'already-sent' && body.maybe) {
      failed.maybe = true;
      const app = body.application ?? {};
      failed.application = { id: app.id ?? null, url: app.url ?? null, appliedAt: app.appliedAt ?? null, status: app.status ?? null };
    }
    // The server says which sort of refusal this is. "No save open" is the one
    // worth acting on: there is a button that fixes it, one tab away.
    if (body.kind === 'no-project') failed.jobhelper = { fix: 'open-save', serverUrl };
    // And the same button for a different save being open: what fixes it is
    // choosing one, which is the page that button goes to.
    if (body.kind === 'other-save') failed.jobhelper = { fix: 'open-save', serverUrl };
    throw failed;
  }
  sendQueuedSoon(routeOf(path));
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

/**
 * The same job, said well enough to put writing back into.
 *
 * The same title, by `titleKey`, as the card's own `sameJob` in content.js
 * compares a late reply with the posting on screen — not "no plainly different
 * word". That let any two roles at one employer that share a word be one job,
 * and on a board that keeps every posting at one address (Indeed's results
 * pane) the letter parked for "Data Engineer Intern" was put back into the
 * card for "Software Engineer Intern", the Summer 2026 letter into the Summer
 * 2027 posting, and the intern letter into the new grad one, each with no word
 * to say it was another job's. And not two requisitions under one title, when
 * both readings carry one.
 *
 * A park that names no role is still read loosely — a tab closed before its
 * page was ever analysed has nothing better to go on, and that is the rescue
 * this is for.
 */
/*
 * The same title as one job's two pages write it.
 *
 * `titleKey` alone read the employer's form and LinkedIn's posting for one
 * job as two titles, so the letter written on one tab was never this tab's
 * on the other: "Software Engineer – Sensor, … (Hybrid)" on Workday and the
 * same without "(Hybrid)" on LinkedIn; "2027 Summer" on iCIMS and "Summer
 * 2027" on LinkedIn; "Software Engineer Intern" on Greenhouse and "Software
 * Engineer Intern (Summer 2027)" on LinkedIn. So how the job is worked comes
 * off the end, a year before its season is put after it, and a title that is
 * the other plus a bracketed season or year on the end is the same. Two
 * titles that each name a season and not the same one are still two jobs:
 * the Summer 2026 letter is not the Summer 2027 posting's.
 */
/*
 * But not two live postings that differ in how the job is worked. The work
 * mode came off both sides before they were compared, so "Software Engineer
 * - Remote" and "Software Engineer - Hybrid" — two postings an employer runs
 * side by side — were one job, and the remote one's letter was handed to the
 * hybrid one's card. The suffix comes off when one side has it and the other
 * does not, which is the one page writing it and the other not; when both
 * name a mode and the modes differ, they are two jobs.
 *
 * And a season on one side only — "Software Engineer Intern" against
 * "Software Engineer Intern (Summer 2027)" — is the same job only for this
 * tab's own park, where the same tab went from the board to the form and
 * back and the two pages wrote the title differently (`ownPark`). For
 * another tab's park it is as likely the next intake's posting, and that
 * letter is not this one's.
 *
 * The suffixes come off as often as they are there, in whatever order the
 * title carries them, so "(Remote) (Summer 2027)" and "(Summer 2027)
 * (Remote)" read alike — and a gender tag ("(m/w/d)", "(H/F)"), which says
 * who may apply and nothing about the job, comes off wherever it is
 * (`withoutGenderTag`).
 */
const WORK_MODE_SUFFIX = /(?:\s*\(\s*(remote|hybrid|on-?site|in[- ]office)\s*\)|\s+[-–—|]\s+(remote|hybrid|on-?site|in[- ]office))\s*$/i;
const YEAR_THEN_SEASON = /\b((?:19|20)\d\d)\s+(summer|fall|autumn|winter|spring)\b/gi;
const SEASON_SUFFIX =
  /\s*\(\s*((?:summer|fall|autumn|winter|spring)\s+(?:19|20)\d\d|(?:19|20)\d\d(?:\s+(?:summer|fall|autumn|winter|spring))?)\s*\)\s*$/i;

/** The title with every trailing suffix off, and which work mode and bracketed season it carried. */
function peelTitle(title) {
  let rest = withoutGenderTag(title);
  let mode;
  let season;
  for (;;) {
    let m = WORK_MODE_SUFFIX.exec(rest);
    if (m) {
      // "On-site" and "in office" are one way of working, written two ways.
      mode ??= (m[1] ?? m[2]).toLowerCase().replace(/[-\s]/g, '').replace(/^inoffice$/, 'onsite');
      rest = rest.slice(0, m.index).trim();
      continue;
    }
    m = SEASON_SUFFIX.exec(rest);
    if (m) {
      season ??= titleKey(m[1].replace(YEAR_THEN_SEASON, '$2 $1'));
      rest = rest.slice(0, m.index).trim();
      continue;
    }
    break;
  }
  return { rest, mode, season };
}

function sameTitle(title, other, { ownPark = false } = {}) {
  const one = peelTitle(title);
  const two = peelTitle(other);
  if (one.mode && two.mode && one.mode !== two.mode) return false;
  const key = (t) => titleKey(t.replace(YEAR_THEN_SEASON, '$2 $1'));
  if (key(one.rest) !== key(two.rest)) return false;
  if (one.season && two.season) return one.season === two.season;
  if (one.season || two.season) return ownPark;
  return true;
}

const sameJob = (job, other, { ownPark = false } = {}) => {
  if (!job || !other || companyOf(job) !== companyOf(other)) return false;
  const role = String(job.role ?? '').trim();
  const otherRole = String(other.role ?? '').trim();
  if (!role || !otherRole) return !plainlyAnotherRole(job.role, other.role);
  if (!sameTitle(role, otherRole, { ownPark })) return false;
  const req = String(job.requisition ?? '').trim().toLowerCase();
  const otherReq = String(other.requisition ?? '').trim().toLowerCase();
  return !(req && otherReq && req !== otherReq);
};

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

/**
 * Where it is written down that a parked entry has been taken, keyed by the
 * tab that parked it and the moment it did — which is what every copy of it,
 * under every address, has in common.
 */
const claimKey = (entry) => `jh-claimed:${entry?.tab ?? '-'}:${entry?.at ?? 0}`;

/**
 * Take a parked entry for one tab, or learn that another tab already has.
 *
 * `takeWork` reads the parked list, picks from it and drops what it picked,
 * several awaits apart — and the reading was outside any turn. Two tabs
 * loading pages of the same application at once, which is what "Reopen closed
 * window" does with a posting and its form, or two tabs opened on one posting,
 * both read the list before either dropped anything, both picked the same
 * entry, and both were handed the closed tab's letter as "recovered". Measured
 * with the real worker in node: twenty times out of twenty. Two copies of one
 * letter in two tabs is two applications that each think they own it, and
 * whichever is sent second goes out under the wrong one's history.
 *
 * Dropping inside the address's own turn would not do it: the copies sit
 * under every page of the application, so the posting's tab and the form's
 * tab each have a different address and a different turn. The claim is one
 * key per entry, checked and written in that key's turn, so exactly one
 * caller gets `true`. And in session storage rather than in memory, so a
 * worker stopped between the claim and the drop does not wake up with the
 * copies still parked and nothing to say they were taken. `sweepOrphans`
 * expires the marks once the entry they name would be stale anyway.
 */
function claimPark(entry, tabId) {
  const key = claimKey(entry);
  return inTurn(key, async () => {
    const mark = (await session().get(key).catch(() => ({})))?.[key];
    /*
     * A mark names the tab that made it, and does not stand against that tab
     * or against a tab that is no longer there. A worker stopped between the
     * claim and the drop left a mark that blocked every tab, the one that
     * claimed included, and the park was swept a day later with the letter
     * in it: the tab that claimed asks again when it reloads, and must get
     * it. And a claimant closed before it could take the work has nothing
     * to hold it for. Another tab still open keeps its claim.
     */
    if (mark) {
      const theirs = mark.tab !== undefined && mark.tab !== tabId;
      const stillOpen = theirs ? Boolean(await chrome.tabs.get(mark.tab).catch(() => null)) : true;
      if (mark.tab === undefined || (theirs && stillOpen)) return false;
    }
    /*
     * A mark that cannot be written still hands the work over. The worst
     * that costs is the double this exists to stop; refusing would lose the
     * letter outright, which nothing gets back. See `takeWork`.
     */
    await session().set({ [key]: { at: Date.now(), tab: tabId } }).catch(() => undefined);
    return true;
  }).catch(() => true);
}

/**
 * Let a claim go when the work did not reach the tab that made it — it
 * closed in the middle, or its trail could not be written — so the park
 * stays takeable by the next tab on the application, not by nobody.
 */
function releaseClaim(entry) {
  const key = claimKey(entry);
  return inTurn(key, () => session().remove(key)).catch(() => undefined);
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
    /*
     * The same job from the same tab replaces its older copy. From another
     * tab it is another application — two tabs open on one posting, both
     * writing — and replacing it handed the first tab the second one's letter.
     */
    const kept = [...held.filter((p) => !(p.tab === entry.tab && sameJob(p.job, entry.job, { ownPark: true }))), entry].slice(-PARK_MAX);
    return { parked: kept, at: Date.now() };
  });
}

/**
 * Which of the things parked at this address belongs to the job being looked
 * at now, if any of them does.
 *
 * A park that names a plainly different job is refused and left where it is:
 * it is not this job's to take, and the tab that comes back to *its* job
 * still needs to find it. So is one whose role is not this page's, when both
 * name one (`sameJob`). Ones that name nothing — a tab closed before the
 * page was ever analysed — are still offered, newest first, because that is
 * the case this rescue was built for and it has no better evidence to go on.
 */
function pickParked(parked, job, tabId, openTabs = new Set()) {
  /*
   * Never another open tab's. A tab that parked its work and is still open
   * has only gone to read something else, and is coming back for it; the
   * address is a shared listing or login page as often as it is the job.
   * Taken here, it was the other tab's letter "recovered from a tab that
   * closed" on a tab that never closed, and the tab that wrote it came back
   * to nothing. Closed tabs' parks, and this tab's own, are still offered.
   */
  const held = parked.filter((p) => p.tab === undefined || p.tab === tabId || !openTabs.has(p.tab));
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
  const own = (p) => p.tab !== undefined && p.tab === tabId;
  const mine = held.filter((p) => sameJob(p.job, job, { ownPark: own(p) }));
  const ownMine = mine.filter(own);
  if (mine.length > 0) return ownMine[ownMine.length - 1] ?? mine[mine.length - 1];
  /*
   * And this tab's own whatever its page is called, short of plainly another
   * job (`plainlyOtherJob`: another employer, or no word of the role in
   * common). The tab went from LinkedIn to the employer's form and back, and
   * the two write the title differently in more ways than `sameTitle` knows;
   * refused as "not the same job", the letter this tab had written was left
   * parked for nobody. Another tab's park still has to be `sameJob`. The
   * card is told whose it was when the roles do not match (`takeWork`).
   */
  const ownAnyway = thisTabs.filter((p) => !plainlyOtherJob(p.job, job));
  if (ownAnyway.length > 0) return ownAnyway[ownAnyway.length - 1];
  /*
   * And never one that names a role when this page names one too: then
   * `sameJob` has already said whether it is this job, and it is not. Offered
   * as "not plainly another job", the letter parked for "Data Engineer
   * Intern" on a board that keeps every posting at one address was taken
   * into the card for "Software Engineer Intern", and the tab coming back to
   * the Data Engineer job found nothing. Left parked, it is there for that
   * tab. Only a park or a page with no role is still offered on the loose
   * reading, and `takeWork` says whose it was.
   */
  const named = (j) => Boolean(String(j?.role ?? '').trim());
  const possible = held.filter((p) => !plainlyOtherJob(p.job, job) && !(named(p.job) && named(job)));
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
 * Store the trail, carrying less rather than failing. Only ever from inside
 * `changeTrail`, which is what keeps two writers of one tab apart.
 *
 * Session storage is 10MB shared across every tab, and five tabs each holding
 * five pages fills it exactly — at which point the write throws and the trail
 * silently stops working, which is the worst of the available outcomes.
 *
 * Other tabs give up their page text before this one gives up any.
 *
 * It used to go straight to `lighten`, so the tab that ran out of room was
 * the one that paid: the tab you are applying in, at the moment you are in
 * it, while twenty postings opened this morning and never looked at again
 * each kept their full text. Measured with the real extension: thirty large
 * postings open, then a posting and its "Apply" — the form came up with the
 * posting's text gone from the trail, which is the text the letter and the
 * answers are written from. So when a write does not fit, other tabs' pages
 * lose their text first, least recently written first (`at`), one tab at a
 * time until it fits — see `makeRoom`. Only then is this trail lightened, and
 * if its first page still had to go without, the trail says so
 * (`textDropped`), for the card and the toolbar to say in words.
 */
async function writeTrail(tabId, trail) {
  const key = trailKey(tabId);
  const put = async (attempt) => {
    const stored = noteDropped(trail, attempt);
    await session().set({ [key]: stored });
    return stored;
  };
  let refused;
  try {
    return await put(trail);
  } catch (err) {
    refused = err;
  }
  if (/quota/i.test(refused?.message ?? '')) {
    const fitted = await makeRoom(tabId, () => put(trail));
    if (fitted) return fitted;
  }
  for (const attempt of [lighten(trail), lighten(trail, 0)]) {
    try {
      return await put(attempt);
    } catch {
      // Out of room. Drop the oldest pages' text and try again.
    }
  }
  // Even with every page's text dropped it would not go in. Saying so beats
  // returning the trail as though it had been stored.
  return null;
}

/**
 * Whether what is being stored has lost the first page's text — the posting,
 * which is what everything later is written from (see `lighten`).
 *
 * Set when this write is the one that dropped it; kept by the trails built on
 * top of it, which carry the empty page along; and cleared once the first
 * page has text again, because the page that lost it has been replaced.
 */
function noteDropped(wanted, stored) {
  const had = Boolean(wanted.pages?.[0]?.html);
  const has = Boolean(stored.pages?.[0]?.html);
  if (had && !has) return { ...stored, textDropped: true };
  if (has && stored.textDropped) {
    const { textDropped, ...rest } = stored;
    return rest;
  }
  return stored;
}

/**
 * The tabs whose turn is waiting on `makeRoom`, by trail key.
 *
 * Making room runs inside one tab's turn and waits on a turn of each tab it
 * strips. Two tabs doing that at once, each waiting on the other, would wait
 * for ever — so a tab that is itself making room is never waited on: it is
 * skipped, and its own write finishes, lightened if it must be. Nothing ever
 * waits on a tab that joined this set before it did, so no circle can close.
 * A tab's own key is never waited on either: that is the turn this is in.
 */
const makingRoom = new Set();

/** What the toolbar says when the first page's text was not kept. The card says the same. */
const POSTING_TEXT_DROPPED = 'the posting text could not be kept (browser storage is full)';

/**
 * Take the page text out of other tabs' trails, least recently written first,
 * until `retry` succeeds. Answers what `retry` answered, or null if every
 * other tab was stripped and it still did not fit.
 *
 * Only the pages' markup goes: never `work`, the letter, the answers, or the
 * pages themselves, which still say where the application has been. Each
 * strip is a `changeTrail` step for that tab, so it cannot land between that
 * tab's own read and write and undo one of them; and it keeps the trail's
 * `at`, because it is not a sign that anybody is using that tab.
 *
 * Before any live tab, what nobody is using. The sweep goes first — closed
 * tabs' keys, branch stashes and parks past their time — and then the branch
 * stashes' markup, oldest first (see `stripStash`). A stash is an
 * application a tab left on an unsure verdict, kept in case "Same job — put
 * it back" is pressed; each holds a whole posting's markup. Live tabs' trails
 * were stripped while those kept theirs, so a tab mid-application in another
 * window lost the posting its letter is written from, to keep a copy of one
 * nobody may ever ask for.
 */
async function makeRoom(tabId, retry) {
  const own = trailKey(tabId);
  if (makingRoom.has(own)) return null;
  makingRoom.add(own);
  try {
    await sweepOrphans().catch(() => undefined);
    try {
      return await retry();
    } catch {
      // Still not enough. The stashes next.
    }
    const swept = await session().get(null).catch(() => ({}));
    const stashes = Object.entries(swept ?? {})
      .map(([key, value]) => ({ key, value, tab: /^jh-branched:(\d+)$/.exec(key)?.[1] }))
      .filter(({ value, tab }) => tab !== undefined && (value?.trail?.pages ?? []).some((p) => p?.html))
      .sort((a, b) => (a.value.at ?? 0) - (b.value.at ?? 0));
    for (const { key, tab } of stashes) {
      /*
       * In that tab's turn, which is the one `remember` writes the stash in
       * and `keepTogether` reads it in — except this tab's own, whose turn is
       * the one this is running in, and a tab that is itself making room,
       * which is never waited on (see `makingRoom`).
       */
      const strip = () => stripStash(key);
      let stripped;
      if (trailKey(Number(tab)) === own) stripped = await strip();
      else if (makingRoom.has(trailKey(Number(tab)))) continue;
      else stripped = await inTurn(trailKey(Number(tab)), strip).catch(() => false);
      if (!stripped) continue;
      try {
        return await retry();
      } catch {
        // Still not enough. The next oldest.
      }
    }
    const all = await session().get(null).catch(() => ({}));
    const others = Object.entries(all ?? {})
      .map(([key, value]) => ({ key, value, tab: /^trail:(\d+)$/.exec(key)?.[1] }))
      .filter(({ key, value, tab }) => tab !== undefined && key !== own && (value?.pages ?? []).some((p) => p?.html))
      .sort((a, b) => (a.value.at ?? 0) - (b.value.at ?? 0));
    for (const { key, tab } of others) {
      if (makingRoom.has(key)) continue;
      const { written } = await changeTrail(Number(tab), (trail) => {
        const pages = trail.pages ?? [];
        if (!pages.some((p) => p?.html)) return null;
        return {
          ...trail,
          pages: pages.map((p) => (p?.html ? { ...p, html: '' } : p)),
          // Said on that tab's card too, when somebody goes back to it.
          textDropped: Boolean(pages[0]?.html) || trail.textDropped,
        };
      }).catch(() => ({ written: null }));
      if (!written) continue;
      try {
        return await retry();
      } catch {
        // Still not enough. The next oldest.
      }
    }
    return null;
  } finally {
    makingRoom.delete(own);
  }
}

/**
 * A branch stash without its pages' markup. Answers whether it wrote one.
 *
 * What it costs: putting the application back (`keepTogether`) brings back
 * its pages, its writing, its tailored resume and its save as before, but not
 * the posting's text, which is what the letter and the answers are written
 * from on the pages after it. So the stash says so (`textDropped`), the
 * merged trail carries that, and the card says "The posting text could not be
 * kept", as it does for a trail of its own that lost it. Opening the posting
 * again reads it afresh.
 */
async function stripStash(key) {
  const held = (await session().get(key).catch(() => ({})))[key];
  const pages = held?.trail?.pages ?? [];
  if (!pages.some((p) => p?.html)) return false;
  const trail = {
    ...held.trail,
    pages: pages.map((p) => (p?.html ? { ...p, html: '' } : p)),
    textDropped: Boolean(pages[0]?.html) || held.trail.textDropped,
  };
  // Its own `at` kept: the age `keepTogether` and the sweep judge it by.
  return session()
    .set({ [key]: { ...held, trail } })
    .then(() => true)
    .catch(() => false);
}

/* ------------------------------------------------------------------ *
 * Saying, anywhere you go, that an application is open                 *
 * ------------------------------------------------------------------ */

/** Named for the tab, so a later write moves it rather than adding another. See `markTab`. */
const expiryAlarm = (tabId) => `jh-trail-expires:${tabId}`;

chrome.alarms?.onAlarm?.addListener(({ name }) => {
  const tabId = /^jh-trail-expires:(\d+)$/.exec(name)?.[1];
  if (tabId !== undefined) markTab(Number(tabId)).catch(() => undefined);
});

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
      chrome.alarms?.clear(expiryAlarm(tabId)).catch(() => undefined);
      await chrome.action.setBadgeText({ tabId, text: '' });
      await chrome.action.setTitle({ tabId, title: 'JobHelper' });
      return;
    }
    /*
     * And drawn again the moment it stops being true.
     *
     * The trail is current for `TRAIL_STALE_MS` from its last write, and this
     * was only ever redrawn by a write or a navigation. A tab left on the
     * company's About page for an afternoon went on saying "your writing is
     * being held" hours after `readTrail` had started answering with nothing
     * — the letter out of reach of every page and every button, and the
     * tooltip promising the opposite. An alarm, because the worker is not
     * awake two hours later to notice and a timer would die with it.
     */
    chrome.alarms
      ?.create(expiryAlarm(tabId), { when: (held.at ?? Date.now()) + TRAIL_STALE_MS + 1 })
      .catch(() => undefined);

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
    /*
     * Not "tailored", which the popup stopped saying for the reason it gives
     * in `showOpenApplication`: any proposal at all has a spec, and a proposal
     * is the resume exactly as it is kept until somebody ticks something.
     */
    else if (held.work?.spec) parts.push('the resume for it is ready');
    /*
     * And when the posting itself is not being held. The letter and the
     * answers are written from it, so that is worth knowing before writing
     * them rather than after. See `writeTrail`.
     */
    if (held.textDropped) parts.push(POSTING_TEXT_DROPPED);

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
  // Decided inside the turn, so a page of this tab's own landing at the same
  // moment is not written over by the opener's.
  let inherited = false;
  const { written } = await changeTrail(tabId, async () => {
    const theirs = await inheritance(tabId, openerTabId);
    inherited = Boolean(theirs);
    return theirs ? { ...theirs, at: Date.now() } : null;
  });
  /*
   * And the opener's filings of the copy with it.
   *
   * The trail carries the card's work, and in it the write of the copy that
   * work was built on (`filed`) — but the list `ownWrite` follows from that
   * write stayed with the opener, under its own tab id. So the form page's
   * card, built on the opener's first stage and refused over its second (a
   * stage the card before it sent just as Apply was pressed), asked this tab
   * whether that write was its own, found nothing to follow, and was told
   * no: it took its own copy for an edit made in ResumeM-M and put it over
   * the switch just made on the form page. Measured with the real worker in
   * node. Copied once, with the trail, for the same reason the trail is:
   * from then on the two tabs file their own copies.
   */
  if (!inherited || !written) return;
  await changeStored(filedKey(tabId), async (stored) => {
    if (await tabClosed(tabId)) return null;
    const theirs = (await session().get(filedKey(openerTabId)).catch(() => ({})))[filedKey(openerTabId)];
    if (!Array.isArray(theirs) || theirs.length === 0) return null;
    return [...theirs, ...(Array.isArray(stored) ? stored : [])].slice(-FILINGS_KEPT);
  });
}

/** What `inheritIfNew` would copy into this tab, or null. Reads only. */
async function inheritance(tabId, openerTabId) {
  if (tabId === undefined || openerTabId === undefined) return null;
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
  if (mine.pages.length > 0 || mine.cleared) return null;

  const theirs = await readTrail(openerTabId);
  if (theirs.pages.length === 0) return null;

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
  return applying ? theirs : null;
}

/**
 * The resume this tab's application was switched to, if it was.
 *
 * The card's "Start from" picker used to write the one setting every tab
 * shares, so switching it on one application changed where every other tab,
 * and every posting after it, started from. It is kept with the application
 * instead: the card saves it with its work, and it follows that work to the
 * form, into a tab Apply opened, and nowhere else. See `analyze`.
 */
async function heldBase(tab) {
  const trail = (await inheritance(tab?.id, tab?.openerTabId)) ?? (await readTrail(tab?.id));
  return trail.work?.baseResumeId ?? null;
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
  const next = settingWrites.then(async () => {
    const patch = change(await getSettings());
    if (patch) await chrome.storage.sync.set(patch);
  });
  /*
   * The queue goes on past a refused write; the caller hears about it. Both
   * used to be the same swallowed promise, so a write `chrome.storage.sync`
   * refused (8KB per item: a long enough `mutedHosts`) came back as success,
   * and the popup said "Muted <host>." for a site that was not muted.
   */
  settingWrites = next.catch(() => undefined);
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

/**
 * Run `step` once every change already queued on `key` has finished, and
 * hand back what it answers — or what it throws. The chain itself never
 * breaks: a step that fails is the caller's to hear about, and the next one
 * still runs. See `changeStored` and `changeTrail`, which are this with the
 * reading and the writing filled in.
 *
 * A step must never wait on another step for the same key, or the two wait
 * on each other for ever. Nothing does: a trail step parks under orphan keys
 * and reads other tabs' trails, and no orphan step touches a trail.
 */
function inTurn(key, step) {
  const run = (frameWrites.get(key) ?? Promise.resolve()).then(step);
  const slot = run.catch(() => undefined);
  frameWrites.set(key, slot);
  slot.finally(() => {
    // Only the last change queued clears the slot, or a change queued while
    // this one was running would be dropped from the chain.
    if (frameWrites.get(key) === slot) frameWrites.delete(key);
  });
  return run;
}

function changeStored(key, change) {
  return inTurn(key, async () => {
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
  }).catch(() => false);
}

/**
 * One writer at a time for one tab's trail.
 *
 * Every handler that wrote the trail read it, built the next one and wrote it
 * back whole, three turns apart, and the card sends several of them at once:
 * the keeper's `saveWork` every two seconds, `expectContinuation` the moment
 * Apply is pressed, `analyze` landing whenever the store answers. Measured in
 * node with the real worker: a save and a press sent together both answered
 * `{ok: true}`, and the trail came back holding the expectation and no work —
 * the letter written over by a copy of the trail from before it, which is
 * exactly the half-written letter this file exists to keep.
 *
 * So the read is made inside the turn, on the trail as the last writer left
 * it. `change` is given that trail and answers the next one, or null to leave
 * it alone; it must not hold the turn across a request to the store, which is
 * why `analyze` asks the store first and only then comes here to merge. What
 * comes back is `{ before, written }`: the trail it was given, and what was
 * stored — lighter than asked, or null when nothing was (`writeTrail`).
 *
 * And never into a tab that has closed. See `tabClosed`.
 */
function changeTrail(tabId, change) {
  return inTurn(trailKey(tabId), async () => {
    if (await tabClosed(tabId)) return { before: { pages: [] }, written: null, closed: true };
    const before = await readTrail(tabId);
    const next = await change(before);
    if (!next) return { before, written: null };
    return { before, written: await writeTrail(tabId, next) };
  });
}

/*
 * Tabs that have closed, so that nothing written late can bring their
 * application back.
 *
 * An AI pass takes minutes and the tab it was for can be closed in the middle
 * of it. `onRemoved` parks the writing and removes the trail — and then the
 * pass came back, `remember` read an empty trail and wrote a new one, page
 * markup and all, under a tab id Chrome will never use again. Measured with
 * the real worker: `trail:7` was gone after the close and back, at 300kB,
 * once the reply landed, and nothing ever removed it. The keeper's last
 * `saveWork`, sent from `pagehide`, does the same thing more cheaply.
 *
 * In memory for the common case and in session storage for a worker that was
 * stopped in between. Tab ids are not reused within a browser session, which
 * is as long as session storage lives; the marks are swept with the orphans
 * once nothing could still be in flight for them.
 */
const closedKey = (tabId) => `jh-closed:${tabId}`;
const closedTabs = new Set();

async function tabClosed(tabId) {
  if (tabId === undefined) return false;
  if (closedTabs.has(tabId)) return true;
  const key = closedKey(tabId);
  return Boolean((await session().get(key).catch(() => ({})))[key]);
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
  if (tabId === undefined || !frameId || (await tabClosed(tabId))) return;
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
const holding = new Map();
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
   * And only for an application, never for a list of them. A resume built on
   * a careers home or a board's search results is somebody looking, and it
   * filed "Epic — Careers" and "Intel — Intel Careers" as rows in the tracker.
   * The work is still kept in the tab as before; a row is held once the
   * application has a posting or a form in it. See `onlyLists`.
   */
  if (onlyLists(trail)) return;

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
  // The write already in flight, handed to whoever else asks — a send waiting
  // on its save has to wait on this, not on a call that returned at once.
  if (holding.has(key)) return holding.get(key);
  const run = filingOut(tabId, holdTheSpace(key, save, company, role, trail, work, tabId));
  holding.set(key, run);
  return run;
}

/**
 * This worker, as against the one before it.
 *
 * `holdTheSpace` marks a space as held before its POST goes and unmarks it if
 * the POST fails — and a worker stopped mid-POST runs neither half. Measured:
 * the POST never answered, no row was opened, and after the restart every
 * later save found the mark and sent nothing, so the application had no draft
 * in the editor until its form was filled in. A mark still pending from a
 * worker that no longer exists is an attempt that died, and is made again;
 * if that one had in fact landed, the second is a merge of the same spec.
 */
const THIS_WORKER = `${Date.now()}-${Math.random()}`;

/**
 * A filing of the card's copy that the store refused, handed back as an
 * answer rather than thrown.
 *
 * The card sends the write of the copy its own was built on (`basedOn`), and
 * the store refuses it when an edit made in ResumeM-M has landed since — the
 * moment between the card looking and the card writing, which looking could
 * never close. What is there now comes back with it, and the card takes that
 * edit rather than failing (see `fileTheCopy` in the card).
 */
function filingRefused(err) {
  if (err?.conflict) return { conflict: err.conflict, error: err.message };
  /*
   * And a stage refused because the application has gone out: nothing was
   * written, and nothing is wrong, so the card is told rather than shown an
   * error. See `AlreadySent` in ResumeM-M.
   */
  if (err?.kind === 'already-sent' && err.maybe) {
    /*
     * Or that it may have: a sent application only the names tie to this
     * posting. Not sent as far as anybody knows, so the card asks, and says
     * which one; confirmed, the stage goes again with `evenIfSent` and the
     * store files a new application beside it.
     */
    return { alreadySent: true, maybe: true, application: err.application ?? null, error: err.message };
  }
  if (err?.kind === 'already-sent') return { alreadySent: true, error: err.message };
  throw err;
}

/*
 * The writes of its copy this tab's cards have made, and those still out.
 *
 * A card files its copy based on the write it knows of, and is refused over
 * any other — including a write of its own it never heard back about: the
 * keeper's, which answers nobody, and a stage the card on the page before
 * sent just before the tab moved on, answered to a card that no longer
 * exists. Measured in tests/carrying.mjs: the form page's card, carrying the
 * posting page's knowledge from before that page's stage came back, was
 * refused over it, took its own copy for an edit made in ResumeM-M, compiled
 * and staged again — and that stage landed after Submit. So every filing is
 * noted here, per tab, as the write it was based on and the write it made,
 * and `ownWrite` follows them from the card's to the one it was refused over.
 */
const filedKey = (tabId) => `filedCopies:${tabId}`;
const FILINGS_KEPT = 30;
const filingsOut = new Map();
function filingOut(tabId, run) {
  if (tabId === undefined) return run;
  const out = filingsOut.get(tabId) ?? new Set();
  out.add(run);
  filingsOut.set(tabId, out);
  run.catch(() => undefined).finally(() => {
    out.delete(run);
    if (out.size === 0 && filingsOut.get(tabId) === out) filingsOut.delete(tabId);
  });
  return run;
}
async function noteFiled(tabId, id, basedOn, version) {
  if (tabId === undefined || !id || version === undefined || basedOn === undefined) return;
  /*
   * Through the chain, like every other list in session storage.
   *
   * A stage and a bundle sent back to back — which is what Submit does — come
   * back close together, and each read the list, added its own filing and
   * wrote the list back. Measured: the second write landed on the first, the
   * stage's filing was gone, and `ownWrite` then answered `own: false` about
   * the card's own bundle, so the card took its own write for an edit made in
   * ResumeM-M.
   */
  await changeStored(filedKey(tabId), async (stored) => {
    if (await tabClosed(tabId)) return null;
    return [...(Array.isArray(stored) ? stored : []), { id, basedOn, version }].slice(-FILINGS_KEPT);
  });
}
/** A filing of the copy, noted and tracked. See `filingOut`. */
function filing(tab, payload, run) {
  return filingOut(
    tab?.id,
    run.then(async (reply) => {
      if (reply && !reply.conflict && !reply.alreadySent) {
        await noteFiled(tab?.id, reply.draft?.resumeId ?? payload?.spec?.id, payload?.basedOn, reply.resumeVersion);
      }
      return reply;
    }),
  );
}

/** The write `holdASpace` guards: one per key at a time. */
async function holdTheSpace(key, save, company, role, trail, work, tabId) {
  try {
    const held = (await session().get(key).catch(() => ({})))[key];
    if (held && !(held.pending && held.pending !== THIS_WORKER)) return;
    await session().set({ [key]: { at: Date.now(), pending: THIS_WORKER } }).catch(() => undefined);
    // Settled either way the store answers, so no later worker takes it for
    // an attempt that died.
    const settled = () => session().set({ [key]: { at: Date.now() } }).catch(() => undefined);
    try {
      const body = {
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
        /*
         * Filed only over the write of the copy the card built on, and
         * only where there is none when the card knows of none. This
         * files the card's copy with nobody watching, and filed over an
         * edit made in ResumeM-M since, it wrote the edit away; filed over
         * a stage the card made meanwhile, it put an older copy back.
         */
        ...(work.spec ? { basedOn: work.filed?.id === work.spec.id && work.filed.version !== undefined ? work.filed.version : null } : {}),
        coverLetterRequired: Boolean(work.letter?.trim()) || undefined,
      };
      const post = (sent) =>
        serverFetch('/api/workspace', { method: 'POST', timeoutMs: SLOW_TIMEOUT_MS, save, body: JSON.stringify(sent) });
      const reply = await post(body).catch((err) => {
        if (!err?.conflict) throw err;
        /*
         * Refused: the store's copy is newer than the one the card built on.
         * The space is held without it — the copy is there already, and the
         * card takes the edit (see `fileTheCopy` in the card).
         */
        const { spec: _copy, basedOn: _on, ...without } = body;
        return post(without).then(() => null);
      });
      /*
       * And what it filed, for the card: its next filing is based on the
       * write before this one, is refused over this one, and has to be able
       * to tell this write — its own copy — from an edit made in ResumeM-M.
       * See `ownWrite`.
       */
      if (reply && body.spec) await noteFiled(tabId, reply.draft?.resumeId ?? body.spec.id, body.basedOn, reply.resumeVersion);
      await settled();
    } catch (err) {
      /*
       * A refusal stands. The store has looked at this company and role and
       * said it is not a job — "Indeed — Now Hiring: 300 Software Intern
       * Jobs" — and the answer will be the same next time, so the key stays
       * and this pair is not asked about again. Dropping it would put the
       * write on every keeper tick for as long as the tab is open.
       */
      if (err?.kind === 'not-a-job') return settled();
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
  return {
    role: last.role ?? null,
    company: last.company ?? null,
    // The requisition the store cut off the title, so two under one title
    // stay two to `sameJob`. Only when the page carried one.
    ...(last.requisition ? { requisition: last.requisition } : {}),
  };
}

/**
 * The same name in a sentence, the way the card's heading and the toolbar
 * already say it: "Platform Engineer at Helios".
 */
function sayJob(job) {
  /*
   * With the requisition when the park has one: two of them under one title
   * are told apart by nothing else, and "Software Engineer Intern at
   * Coinbase" said of the other one's letter, on that title's page, says
   * nothing.
   */
  const requisition = String(job?.requisition ?? '').trim();
  const titled = job?.role?.trim();
  const role = titled && requisition ? `${titled} (${requisition})` : titled;
  const company = job?.company?.trim();
  if (role && company) return `${role} at ${company}`;
  return role || company || null;
}

async function remember(tab, page) {
  await inheritIfNew(tab?.id, tab?.openerTabId);
  /*
   * The judgement and the write in one turn of `changeTrail`, on the trail as
   * it is when the turn comes. The store has already been asked by then —
   * `analyze` does that before calling this — so nothing here waits on the
   * network while other writers of this tab wait on it. Judged before the
   * turn, a `saveWork` or an Apply press landing meanwhile was written over by
   * the copy this had read.
   */
  let joins = false;
  let next = null;
  const { before: trail, written } = await changeTrail(tab?.id, async (trail) => {
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
    joins = verdict === 'same';
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
      // And the requisition cut off it, when the analysis read one: see `sameJob`.
      ...(page.requisition ? { requisition: page.requisition } : {}),
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
    next = {
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
    return next;
  });

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
  /*
   * And what was stored is `written`, not `next`: lighter than asked when
   * storage was full, and marked when the posting's text could not be kept.
   */
  const stored = written ?? trail;
  await markTab(tab?.id, stored);
  return { ...summarise(stored), startedFresh: !joins };
}


/**
 * Saves still being written, by tab, until the draft each may open has been
 * asked for. A send waits on its tab's; see `applicationSent`.
 */
const savesInFlight = new Map();

/**
 * How long a send waits for that save before being recorded regardless.
 *
 * Ten seconds, not three. The save's draft request commits the tailored
 * resume before it opens the draft, and a commit on a busy machine is slow:
 * measured with the wait cut to 300ms, the draft landed 47–182ms after the
 * send on an idle machine, and at three seconds under the parallel runner it
 * still landed after it now and then ("embedded-apply", 228–399ms late).
 * Nothing waits on this but the record of the send — the form has gone.
 */
const SEND_WAITS_FOR_SAVE_MS = 10_000;

/**
 * How long after the application was last worked on a page saying it was
 * received still counts as saying so about that one. An hour: a long form is
 * written in one sitting, and a tab come back to the next day on another
 * posting's confirmation is not this application's.
 */
const RECEIPT_WINDOW_MS = 60 * 60 * 1000;

/**
 * What `saveWork` does, returning the draft-opening write it started so the
 * handler can say when it has settled.
 */
async function keepWork({ work, page }, tab) {
  // The guards are judged on the trail as it is in the turn, not as it was
  // when the message arrived. See `changeTrail`.
  let next = null;
  const { before: trail, written } = await changeTrail(tab?.id, (trail) => {
    // Only the application this tab is actually on. Without this a card left
    // open on another posting would keep writing its work over this one's.
    if (page && trail.pages.length > 0 && !sameApplication(trail, page)) return null;
    // And nothing at all into a tab that was told to start fresh, until it
    // has read a page of its own. See `clearTrail`: the card's keeper is
    // still running when that button is pressed.
    if (trail.cleared && trail.pages.length === 0) return null;
    // And never nothing over something: a card that failed to analyse its page
    // has an empty state, and saving it threw away the resume built on the
    // page before.
    if (!worthKeeping(work) && worthKeeping(trail.work)) return null;

    // Stamped, because `at` is what says the trail is still current — work
    // written without it reads back as a trail from another sitting.
    next = { ...trail, work, at: Date.now() };
    return next;
  });
  if (!next) return { reply: { ok: false } };
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
  // Handed back rather than awaited here: the keeper does not wait on it,
  // and a send does, through `savesInFlight`.
  return { reply: { ok: written !== null }, holding: holdASpace(next, tab?.id) };
}

const handlers = {
  async saveBugReport(payload) { return saveBugReport(payload, serverFetch); },
  /*
   * The error log. `logEvents` is the content script and the card telling
   * the buffer what went wrong on the page; the rest are the popup's form.
   */
  async logEvents({ events } = {}, tab) {
    let kept = 0;
    for (const e of (Array.isArray(events) ? events : []).slice(0, 20)) {
      if (!e || typeof e.message !== 'string' || !e.message.trim()) continue;
      const kind = ['content-error', 'card-error', 'card-status', 'card-step'].includes(e.kind) ? e.kind : 'content';
      noteEvent(kind, ['error', 'warn', 'info'].includes(e.level) ? e.level : 'error', e.message.slice(0, 1000), {
        host: (() => {
          try {
            return new URL(tab?.url ?? '').host || null;
          } catch {
            return null;
          }
        })(),
      });
      kept++;
    }
    return { kept };
  },
  async saveErrorLog(payload) {
    const result = await saveErrorLog(payload ?? {}, {
      serverFetch,
      storage: chrome.storage.local,
      events: (minutes) => workerLog.since(minutes),
      versions: { extensionVersion: chrome.runtime.getManifest().version, extensionBuild: await extensionBuild() },
    });
    if (!result.sent) errorLogsMaybeQueued = true;
    return result;
  },
  /** What is waiting to be sent, after trying to send it. */
  async errorLogQueue() {
    if ((await queuedErrorLogs(chrome.storage.local)) === 0) {
      // Nothing to send; but one refused earlier — sent from the background — is still to be said.
      return { queued: 0, sent: 0, refused: [], lastError: null, refusedEntries: await refusedErrorLogs(chrome.storage.local) };
    }
    return sendQueuedErrorLogs(serverFetch, chrome.storage.local);
  },
  /** The refused entries have been seen, or their text copied: let go of them. */
  async dismissRefusedErrorLogs({ ids } = {}) {
    return { left: await dismissRefusedErrorLogs(chrome.storage.local, Array.isArray(ids) ? ids.map(String) : null) };
  },
  async openErrorLog() {
    return openErrorLogForm();
  },
  /*
   * The same form, from the card's "Log an error" (step 4, "Fill in and
   * file"), started with a few words saying where it came from.
   *
   * The card runs in pages that are not ours, so this is held to less than
   * `openErrorLog`, which stays the extension's own pages' alone: the card in
   * the top frame only (where it is drawn; a frame of the page has no card),
   * once in two seconds at most, and nothing taken but a short draft —
   * `cardDraft` makes it one line of at most 300 characters, and any other
   * field in the message (a screenshot, an entry) is never read. The card
   * sends it only from a press a person made: it refuses untrusted events at
   * its root (see `refuseUntrusted` in card.js).
   */
  async openErrorLogFromCard(payload, tab, sender) {
    if (!tab || sender?.frameId !== 0) throw new Error('The error log opens from the card on the page, or from the popup.');
    const now = Date.now();
    if (now - cardLogOpenedAt < CARD_LOG_EVERY_MS) throw new Error('The error-log form is already opening.');
    cardLogOpenedAt = now;
    return openErrorLogForm({ draft: cardDraft(payload?.draft) });
  },
  async listBugReports() { return listBugReports(); },
  async syncBugReport({ id }) { return syncBugReport(id, serverFetch); },
  async clearBugReport({ id, discard }) { return clearBugReport(id, { discard: discard === true }); },
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

  /**
   * A frame's page emptied what Autofill had filled, and it was filled in
   * again. Told to the top frame, where the card is, as a drop is.
   */
  async refilledInFrame({ names }, tab, sender) {
    const tabId = tab?.id ?? sender?.tab?.id;
    if (tabId === undefined) return false;
    await chrome.tabs
      .sendMessage(tabId, { type: 'jh-frame-refilled', payload: { names: Array.isArray(names) ? names : [] } }, { frameId: 0 })
      .catch(() => undefined);
    return true;
  },

  /** Fill the form in every sub-frame from the same profile. */
  async fillFrames({ fields, history = [], education = [] }, tab) {
    if (tab?.id === undefined) return { frames: [] };
    const replies = await askFrames(tab.id, { type: 'jh-frame-fill', payload: { fields, history, education } });
    return { frames: replies.map(({ frameId, data }) => ({ frameId, ...data })) };
  },

  /** Put an answer into a field that lives in one particular frame. */
  async insertInFrame({ frameId, fieldId, text, question }, tab) {
    if (tab?.id === undefined) return false;
    const reply = await chrome.tabs
      .sendMessage(tab.id, { type: 'jh-frame-insert', payload: { fieldId, text, question } }, { frameId })
      .catch(() => null);
    return Boolean(reply?.ok && reply.data);
  },

  /** Bring a field the Autofill note names into view, in the frame it lives in. */
  async showInFrame({ frameId, fieldId }, tab) {
    if (tab?.id === undefined) return false;
    const reply = await chrome.tabs
      .sendMessage(tab.id, { type: 'jh-frame-show', payload: { fieldId } }, { frameId })
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
  async saveWork(payload, tab) {
    /*
     * Registered before the first await, so a send that follows on the heels
     * of this save — the content script flushes the work and reports the send
     * in the same breath — finds it here and waits for it. See
     * `applicationSent`.
     */
    const tabId = tab?.id;
    let release;
    const settled = new Promise((r) => (release = r));
    savesInFlight.set(tabId, settled);
    const free = () => {
      release();
      if (savesInFlight.get(tabId) === settled) savesInFlight.delete(tabId);
    };
    try {
      const { reply, holding } = await keepWork(payload, tab);
      if (holding) holding.catch(() => undefined).finally(free);
      else free();
      return reply;
    } catch (err) {
      free();
      throw err;
    }
  },

  /** The work from the pages before this one, if this page continues them. */
  async takeWork({ page }, tab) {
    /*
     * And behind every change queued on the opener's trail, when Apply
     * opened this page in a tab of its own. The save the posting's card
     * makes as Apply is pressed lands on the opener's trail, not this one,
     * so waiting on this tab's queue alone let `inheritIfNew` copy the
     * opener's work from before that save: the spec without its render, and
     * the new tab drew no resume. Waited on here, outside any step of either
     * trail, so neither queue is ever made to wait on the other.
     */
    if (tab?.openerTabId !== undefined) await inTurn(trailKey(tab.openerTabId), () => undefined);
    await inheritIfNew(tab?.id, tab?.openerTabId);
    /*
     * Behind every change already queued on this tab's trail, not beside
     * them. The page before this one saves its work as it leaves — the
     * render it just compiled among it — and that save can still be in the
     * queue when the next page asks: read past it, this handed back the
     * work from a tick before, with the spec but no render, and the form
     * page drew no resume at all until Build was pressed again. Waiting on
     * an empty step is safe: it is not itself a step that waits on another.
     */
    if (tab?.id !== undefined) await inTurn(trailKey(tab.id), () => undefined);
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
    const openTabs = new Set(
      held.length > 0 ? ((await chrome.tabs.query({}).catch(() => [])) ?? []).map((t) => t.id) : [],
    );
    const rescued = pickParked(held, looking, tab?.id, openTabs);
    if (rescued) {
      const fresh = Date.now() - (rescued.at ?? 0) < TRAIL_STALE_MS;
      /*
       * Claimed in a turn of its own before anything is written, so that of
       * two tabs which both picked this entry only one carries it on. The
       * other answers as though nothing had been parked: the entry is still
       * in storage for the moment it takes the winner to drop it, and it is
       * not this tab's. See `claimPark`.
       */
      if (rescued.work && fresh && !(await claimPark(rescued, tab?.id))) return { work: trail.work ?? null };
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
          // Onto the trail as it is in the turn, so whatever landed since it
          // was read above is kept alongside. See `changeTrail`.
          const into = await changeTrail(tab.id, (now) => ({
            ...now,
            work: rescued.work,
            save: rescued.save ?? now.save,
            at: Date.now(),
          }));
          /*
           * Not written — the tab closed while this was going on, which
           * `changeTrail` declines to write into, or there was no room — and
           * the parks were dropped all the same: the letter was then nowhere,
           * and the claim kept every other tab from asking. Kept where they
           * are, the claim let go, the next tab on the application gets it.
           */
          if (into.closed || !into.written) {
            await releaseClaim(rescued);
            return { work: trail.work ?? null };
          }
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
        /*
         * And in the branch that did check, whenever the check was the loose
         * one. `pickParked` no longer hands over a park naming another role
         * than the page's (`sameJob`), so what is left to name is a park or a
         * page with no role, matched on the employer alone — another job's
         * letter as often as not on a board that keeps every posting at one
         * address. Named, it is a letter somebody can see is not this one's.
         * Only a match on both roles, or this tab's own park with nothing to
         * check it against, goes unnamed.
         */
        const sure = Boolean(looking?.role?.trim() && rescued.job?.role?.trim()) && sameJob(rescued.job, looking, { ownPark: mine });
        return {
          work: rescued.work,
          recovered: mine ? 'job' : true,
          recoveredFor: sure || (mine && !looking) ? undefined : sayJob(rescued.job) ?? undefined,
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
  async expectContinuation({ to, from }, tab) {
    let elsewhere = false;
    // In the turn: pressed at the same moment the keeper saves, which is
    // what pressing Apply does, the two used to cost each other their write.
    await changeTrail(tab?.id, (trail) => {
      /*
       * Not when it was pressed on another job's page than the application this
       * tab holds.
       *
       * On a board that swaps postings in place the tab's application stays on
       * the job read before until the card has read the new one — and a press
       * in that window promised the old job's application a next page that
       * belongs to the new one. The tab Apply opened inherited it whole: Exegy's
       * resume and letter on Kodiak's Greenhouse form, staged there and filed on
       * Exegy's row under Kodiak's address. So the press is recorded as what it
       * is — this application was left from that site — which takes back any
       * expectation it had (so a tab opened now inherits nothing; see
       * `inheritance`) and stops the site's referrer vouching for the page it
       * leads to. See `pressedOnAnotherJob` and `judgeApplication`.
       */
      if (from && pressedOnAnotherJob(trail, from)) {
        elsewhere = true;
        return { ...trail, expecting: undefined, strayed: { from, at: Date.now() } };
      }
      // A new tab inherits this tab's trail, expectation and all, so an Apply
      // button that opens one lands already knowing where it came from.
      return { ...trail, expecting: { to, at: Date.now() }, strayed: undefined, at: Date.now() };
    });
    return elsewhere ? { ok: true, elsewhere: true } : { ok: true };
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
   * Where the page belongs is still `sameApplication`'s judgement, made
   * later with the page read; this only says there is something here to be
   * judged against — or, with `carriesOn`, that this page is plainly the next
   * page of it: pressed into from the posting, or further down the posting's
   * own address. That is the case "something written" missed: somebody who
   * presses Apply at once has written nothing, and the first form page of an
   * Oracle application is an email box under the posting's title, scoring
   * under the threshold. See `carriesOn` in trail.js for why the looser joins
   * — a referrer, a link — are not enough to read a page on.
   */
  /*
   * And "something written" is only half of it: the page still has to be
   * reached from the application, by the joins `sameApplication` accepts — the
   * same site and the same posting, a referrer from a site already in it,
   * Apply pressed to here, a link on a page already held.
   *
   * It used to be enough on its own, for any page the tab went on to. And
   * the card writes on its own: a posting with a form stages its files as
   * soon as it knows what the form wants, and the answer bank's matches fill
   * the questions in, so looking at a posting was "something written". The
   * next page in that tab — a chat client opened from the address bar,
   * nothing to do with the job — was then read whole and sent to be
   * analysed, and so was every page after it for the trail's two hours.
   * Measured in the hunt's `carry.mjs`. Nothing joins a page like that to
   * the application, and nothing here now reads it.
   */
  async openHere({ page } = {}, tab) {
    await inheritIfNew(tab?.id, tab?.openerTabId);
    const trail = await readTrail(tab?.id);
    return {
      open: (trail?.pages ?? []).length > 0,
      made: madeSomething(trail?.work) && Boolean(page?.url) && sameApplication(trail, page),
      carriesOn: Boolean(page && carriesOn(trail, page)),
      job: nameOfTrail(trail),
    };
  },

  /**
   * Whether this tab has an application under way at all. Reads only — no
   * inheriting, unlike `openHere` — because it is asked by every page as it
   * loads, to decide whether to watch for a receipt; see `wantReceipt` in
   * content.js.
   */
  /*
   * And only for a page on a site the application has been through, or the
   * one it expects next — the same test `applicationSentHere` puts a receipt
   * to, by root host, with the origins a frame sits under counted as its own.
   *
   * Any page at all used to be told yes for as long as the tab had a trail,
   * so every page and every frame opened in it for the next two hours ran
   * the receipt watcher, a quarter of an hour each of reading a page's text
   * on every change to it — a chat client's endless updates included — to
   * find a receipt that would then have been refused for being on another
   * site. Measured in the hunt's `carry.mjs`.
   */
  async applicationInTab({ url, above = [] } = {}, tab) {
    const trail = await readTrail(tab?.id);
    if (!(trail?.pages ?? []).length) return { open: false };
    const been = new Set(
      [...trail.pages.map((p) => p.url), trail.expecting?.to].map((u) => rootOf(hostOf(u))).filter(Boolean),
    );
    const here = [url ?? tab?.url, ...(Array.isArray(above) ? above : [])].map((u) => rootOf(hostOf(u))).filter(Boolean);
    return { open: here.some((r) => been.has(r)) };
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
    let held = null;
    let merged = null;
    let gone = false;
    /*
     * The stash, the live trail and the merge in one turn: the live half is
     * the one the keeper is still saving into, and a save landing between
     * the read and the write was the writing this button promises to keep.
     */
    await changeTrail(id, async (now) => {
      held = (await session().get(key).catch(() => ({})))[key];
      if (!held?.trail) {
        gone = true;
        return null;
      }
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
        gone = true;
        return null;
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
      merged = {
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
      return merged;
    });
    if (gone || !merged) return { ok: false, gone: true };
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
    const ours = (p) => p.tab === id && (leftJob ? sameJob(p.job, leftJob, { ownPark: true }) : !p.job);
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
    await changeTrail(id, (trail) => ({ ...trail, branchedFrom: undefined, at: Date.now() }));
    await session().remove(branchKey(id)).catch(() => undefined);
    return { ok: true };
  },

  async clearTrail({ tabId, keep } = {}, tab, sender) {
    const id = whichTab(tabId, tab, sender);
    let next = null;
    /*
     * Parked and emptied in one turn, so a save the keeper lands meanwhile is
     * either parked with the rest or refused by the mark below — never written
     * back over the emptied trail, and never lost. See `changeTrail`.
     */
    await changeTrail(id, async (trail) => {
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
        next = { pages: [], cleared: Date.now(), at: Date.now() };
        return next;
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
      next = { pages: held, save: trail.save, at: Date.now() };
      return next;
    });

    if (!next || next.pages.length === 0) {
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
    await markTab(id, next);
    return summarise(next);
  },

  /** Drop one page the user says does not belong. */
  async forgetPage({ url }, tab) {
    let next = null;
    const { before } = await changeTrail(tab?.id, (trail) => {
      next = { ...trail, pages: trail.pages.filter((p) => p.url !== url), at: Date.now() };
      return next;
    });
    const shown = next ?? before;
    await markTab(tab?.id, shown);
    return summarise(shown);
  },

  async ping() {
    // Through serverFetch, so a closed server reads as the same sentence the
    // card gives — with the button that fixes it. The popup is where someone
    // goes to check the connection, and it was the one place that answered
    // with a raw browser string: "Failed to fetch".
    const health = await serverFetch('/health');
    // Up, and not ours yet: the one thing to say is how to pair.
    if (health?.paired === false) throw notPaired((await getSettings()).serverUrl);
    return health;
  },

  /**
   * Pair with ResumeM-M, with the code its editor is showing.
   *
   * The token it hands back is what every request carries from then on, kept
   * for that server's address only. The server's refusals — a wrong code, one
   * that has run out — are already sentences, and are passed on as they are.
   */
  async pair({ code } = {}) {
    return pairOnce(code);
  },

  /*
   * The same, from the code box on a job page's card.
   *
   * `pair` is for the extension's own pages, and a card runs in whatever
   * page it is on. What lets the card have this too is that the page cannot
   * reach the box: the card's root is closed and refuses every event a
   * person did not raise (see `refuseUntrusted` in card.js), so a page can
   * neither read the code typed there nor press Pair to spend this
   * extension's tries. A code is one use, made in the editor, and pairs
   * this extension with the server it is already set to — there is nothing
   * in it a page could point elsewhere. Only from a tab's top frame, which
   * is where the card is.
   */
  async pairFromCard({ code } = {}, tab, sender) {
    if (!tab || sender?.frameId !== 0) throw new Error('Pairing is done from the card on the page, or from the popup.');
    return pairOnce(code);
  },

  /*
   * "Not now" on the card's code box, for this tab: the box stays down on
   * every page the tab goes to until it is asked for again, or something
   * pairs. Read with no `later`, it only says which it is.
   */
  async pairLater({ later } = {}, tab) {
    if (typeof tab?.id !== 'number') return { later: false };
    const key = `${PAIR_LATER_PREFIX}${tab.id}`;
    if (later === true) await session().set({ [key]: Date.now() }).catch(() => undefined);
    else if (later === false) await session().remove(key).catch(() => undefined);
    else return { later: Boolean((await session().get(key).catch(() => ({})))[key]) };
    return { later: later === true };
  },

  /**
   * "Get a code": the editor, in a new tab beside this one, at its pairing
   * section with a code already made. The address is the worker's to build,
   * from the server it is set to; the card names nothing.
   */
  async openPairCode(_payload, tab) {
    const { serverUrl } = await getSettings();
    const opened = await chrome.tabs.create({
      url: pairCodeUrl(serverUrl),
      ...(typeof tab?.index === 'number' ? { index: tab.index + 1 } : {}),
      ...(typeof tab?.id === 'number' ? { openerTabId: tab.id } : {}),
    });
    return { id: opened.id };
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
        headers: await pairingHeaders(serverUrl),
      });
      if (!res.ok) throw new Error(`the server answered ${res.status}`);
      server = await res.json();
    } catch {
      return { active: false, useAi, reachable: false, serverEnabled: false, state: 'offline' };
    }

    // Not paired, so the server said nothing about its AI. Not "no AI set
    // up", which would send somebody off to set up what is already there.
    if (server?.paired === false) return { active: false, useAi, reachable: true, serverEnabled: false, state: 'not-paired' };

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
  async setAiEnabled({ enabled }, tab) {
    await serverFetch('/api/config', {
      method: 'PUT',
      // Every write the card makes says which save it means. See `saveFor`.
      save: await saveFor(tab?.id),
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
    }).catch((error) => {
      // Said in words: Chrome's own is "Resource::kQuotaBytesPerItem quota
      // exceeded", which tells nobody that the list of muted sites is full.
      // Only that one, and only for a mute: Chrome's limit on writes a
      // minute is a "quota" too, and an unmute refused by it was told there
      // was no room for another muted site — which unmuting does not need.
      if (muted && /QUOTA_BYTES|kQuotaBytes/.test(error?.message ?? '')) {
        throw new Error('Chrome’s synced settings have no room for another muted site. Unmute a site you no longer need muted (open it, then this popup), and try again.');
      }
      throw error;
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
  async analyze({ url, title, html, pages, framed, useAi, tailor, baseResumeId: chosen }, tab) {
    const settings = await getSettings();
    /*
     * Which resume to start from: the one this card was just switched to,
     * then the one this application was switched to, and only then the
     * default in the popup. The last is marked as a default so the store
     * will not start this posting from a copy made for another one. See
     * `heldBase`, and `standingBase` in ResumeM-M.
     */
    const held = chosen ? null : await heldBase(tab);
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
    const ask = (base) => stoppably(tab, 'rebuild', (signal) =>
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
          baseResumeId: base ?? settings.baseResumeId,
          baseIsDefault: !base,
          tailor: mode,
          // Older servers read this and know nothing of `tailor`.
          useAi: mode === 'ai',
        }),
      }),
    );
    let result = await ask(chosen ?? held);

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
      const remembered = await remember(tab, {
        save: result?.save,
        url,
        title,
        company: result.job?.company,
        role: result.job?.title,
        requisition: result.job?.requisition,
        kind: result.kind,
        // The frames are part of the page: a posting inside an embed is an
        // empty shell at the top level, and the next page would be written
        // from the shell.
        html: [html, ...(framed ?? []).map((f) => f.html)].join('\n').slice(0, 400_000),
      });
      /*
       * And a page that turned out to start a new application in this tab
       * was read from the last one's resume. Only now is that known, so it
       * is read again from the default; if that fails, what was read stands.
       */
      if (held && remembered?.startedFresh) result = (await ask(null).catch(() => null)) ?? result;
    }
    return { ...result, trail: summarise(await readTrail(tab?.id)) };
  },

  /** Compile a proposed spec so the user can look at it before committing. */
  /** One short string that moves whenever anything in the save changes. */
  async revision() {
    return serverFetch('/api/revision');
  },

  /** Whether the resume the card holds is still what the store would give it. */
  async fresh({ spec }) {
    return serverFetch('/api/extension/fresh', { method: 'POST', body: JSON.stringify({ spec }) });
  },

  /*
   * Stoppable, like the other long runs. A compile is seconds when it works,
   * but one that hangs had nothing to let go of it but the ten-minute
   * deadline, and for those ten minutes the card's compile lane was held:
   * "Build resume" read "Compiling…" and there was no way out short of
   * closing the card. See `stoppable`.
   */
  async render({ spec }, tab) {
    const result = await stoppably(tab, 'render', (signal) =>
      serverFetch('/api/render', {
        method: 'POST',
        timeoutMs: SLOW_TIMEOUT_MS,
        signal,
        body: JSON.stringify({ spec }),
      }),
    );
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
  async renderLetter({ body, company, role, resumeId, spec }, tab) {
    // Stoppable for the same reason as `render`.
    const result = await stoppably(tab, 'renderLetter', (signal) =>
      serverFetch('/api/render/letter', {
        method: 'POST',
        timeoutMs: SLOW_TIMEOUT_MS,
        signal,
        body: JSON.stringify({ body, company, role, ...(spec ? writingFrom(spec) : { resumeId }) }),
      }),
    );
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
        ...writingFrom(spec),
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
  async addVariant({ entryId, bulletId, variant }, tab) {
    return serverFetch(`/api/entries/${encodeURIComponent(entryId)}/bullets/${encodeURIComponent(bulletId)}/variants`, {
      method: 'POST',
      // The entry is the save's: a phrasing kept after the editor switched
      // saves belongs in the one the proposal was built from, or nowhere.
      save: await saveFor(tab?.id),
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
    const save = await saveOrRefuse(tab?.id);
    return filing(
      tab,
      payload,
      serverFetch('/api/applications/bundle', {
        method: 'POST',
        timeoutMs: SLOW_TIMEOUT_MS,
        save,
        body: JSON.stringify({ ...payload, status: 'applying' }),
      }).catch(filingRefused),
    );
  },

  async bundle(payload, tab) {
    const save = await saveOrRefuse(tab?.id);
    return filing(
      tab,
      payload,
      serverFetch('/api/applications/bundle', {
        method: 'POST',
        timeoutMs: SLOW_TIMEOUT_MS,
        save,
        body: JSON.stringify(payload),
      }).catch(filingRefused),
    );
  },

  /**
   * Whether the write of the copy a card was refused over is this tab's own:
   * reached from the write the card built on (`from`) through filings this
   * tab made (`to`). See `filedKey`. After any filing still out, since the
   * store writes the copy well before the reply to it comes back.
   */
  async ownWrite({ id, from, to }, tab) {
    const out = [...(filingsOut.get(tab?.id) ?? [])];
    if (out.length) await Promise.race([Promise.allSettled(out), new Promise((r) => setTimeout(r, SLOW_TIMEOUT_MS))]);
    const key = filedKey(tab?.id);
    const list = ((await session().get(key).catch(() => ({})))[key] ?? []).filter((f) => f.id === id);
    let at = from ?? null;
    for (let step = 0; step <= list.length && at !== to; step++) {
      const next = list.find((f) => f.basedOn === at);
      if (!next) break;
      at = next.version;
    }
    return { own: at === to };
  },

  /**
   * Fetch a compiled PDF as bytes, so the card can draw it on the page it is
   * sitting on. The fetch has to happen here: a job board served over https
   * cannot pull http://127.0.0.1 itself, and the whole point is not to send
   * the user to another tab to look at their own resume.
   */
  async pdfBytes({ url }) {
    const { serverUrl } = await getSettings();
    /*
     * From the store and nowhere else.
     *
     * This is asked by the card, so by the page the card is on, and it was a
     * fetch of any address at all with the extension's host access — the
     * loopback ports included — handed back as bytes. The card only ever asks
     * for a path the store gave it, or the same path spelled out in full.
     */
    const base = serverUrl.replace(/\/$/, '');
    if (typeof url !== 'string' || !url) throw new Error('No PDF address was given.');
    const absolute = url.startsWith('/') && !url.startsWith('//') ? `${base}${url}` : url;
    let wanted;
    try {
      wanted = new URL(absolute);
    } catch {
      throw new Error('That is not an address for a PDF.');
    }
    const store = new URL(`${base}/`);
    if (wanted.origin !== store.origin || !wanted.pathname.startsWith(store.pathname)) {
      throw new Error('PDFs are only fetched from ResumeM-M.');
    }
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
      res = await fetch(absolute, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: await pairingHeaders(serverUrl) });
    } catch (cause) {
      const failed = new Error('ResumeM-M did not answer with the PDF. Check it is still running, then try again.', {
        cause,
      });
      failed.jobhelper = { fix: 'start-server', serverUrl };
      throw failed;
    }
    if (res.status === 403 && (await res.clone().json().catch(() => null))?.kind === 'not-paired') throw notPaired(serverUrl);
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
    const spec = trail?.work?.spec;
    /*
     * The resume itself, not only its `choices`: a form's work-history blocks
     * want the jobs it lists and the lines it prints for each, which the
     * wordings alone cannot say. The card's resume where there is one, and
     * otherwise the one picked in the popup — a form reached before any card
     * was put up is still being filled for somebody's resume.
     */
    const settings = spec ? null : await getSettings().catch(() => null);
    const which = spec ? writingFrom(spec) : settings?.baseResumeId ? { resumeId: settings.baseResumeId } : {};
    return serverFetch('/api/autofill', { method: 'POST', body: JSON.stringify(which) });
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

    /*
     * With the row each came from, so that an answer changed after it was
     * filled goes back onto that row. See `FROM_BANK` in autofill.js.
     */
    const answers = (reply?.matches ?? [])
      .filter((m) => m?.confident && m.answer)
      .map((m) => ({ question: m.question, answer: m.answer, ...(m.item?.id ? { itemId: m.item.id } : {}) }));
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
  async attachments({ application, claim = false }, tab) {
    const { serverUrl } = await getSettings();
    /*
     * `claim` gives this application the plain names in the shared folder,
     * and is sent only for what somebody did — Attach, copying or opening
     * the folder. See `/attachments` in ResumeM-M.
     */
    const query = application ? `?application=${encodeURIComponent(application)}${claim ? '&claim=1' : ''}` : '';
    const list = await serverFetch(
      `/api/attachments${query}`,
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
        const res = await fetch(`${base}${item.url}`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: await pairingHeaders(serverUrl),
        });
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
  async answerQuestion({ question, force, job, limit, spec, draft, feedback }, tab) {
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
          /*
           * The resume this answer goes beside, so the prompt can show it as
           * what the reader already has. Without it the answer was written
           * with no idea which lines were already on the page — and retold
           * one of them. See `writingFrom`.
           */
          ...(spec ? writingFrom(spec) : {}),
          // A redraft told what to change: the answer in the box, and what
          // they said about it. See `whatToChange` in ResumeM-M.
          ...revision({ draft, feedback }),
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
  async rememberChoice({ question, answer }, tab) {
    if (!question?.trim() || !answer?.trim()) return { ok: false };
    return serverFetch('/api/answers/save', {
      method: 'POST',
      /*
       * Into the bank of the save this application belongs to. Sent without
       * it, an answer kept after the editor switched saves went into the
       * other save's bank with a 200. No save known sends no header, as
       * before. See `saveFor`.
       */
      save: await saveFor(tab?.id),
      body: JSON.stringify({ question, answer, label: 'Chosen on a form' }),
    });
  },

  /**
   * What was typed into a form's short boxes, kept when it was sent or left.
   *
   * The same bank and the same route as `rememberChoice`, labelled for where
   * it came from, and one after another: each save reads the bank and writes
   * it back whole, so two at once can each write over the other's.
   *
   * `itemId` is the row a box was filled from, when it was, so that changing
   * what was filled replaces that row's answer rather than starting another
   * one under the second form's wording. As with choices, the refusal
   * happened on the page — see `worthRememberingTyped`.
   */
  async rememberTyped({ answers }, tab) {
    let kept = 0;
    // Asked once: every answer here belongs to the same application.
    const save = await saveFor(tab?.id);
    for (const { question, answer, itemId } of Array.isArray(answers) ? answers : []) {
      if (!question?.trim() || !answer?.trim()) continue;
      const reply = await serverFetch('/api/answers/save', {
        method: 'POST',
        save,
        body: JSON.stringify({ question, answer, label: 'Typed on a form', ...(itemId ? { itemId } : {}) }),
      }).catch(() => null);
      if (reply?.ok) kept++;
    }
    return { ok: true, kept };
  },

  /*
   * The three messages a form in a frame needs in order to keep what was
   * typed in it the way the top page does. See `watchFrameForm` in
   * content.js. The frame saves its own answers through `rememberTyped` and
   * `rememberChoice`. These three only carry what the frame cannot know or
   * cannot show: who the page is applying to, and the card's list of what
   * will be kept, in both directions.
   */

  /** Who the top document says this tab is applying to. */
  async companyHere(_payload, tab) {
    if (tab?.id === undefined) return { company: '' };
    const reply = await chrome.tabs
      .sendMessage(tab.id, { type: 'jh-company-here' }, { frameId: 0 })
      .catch(() => null);
    return { company: reply?.ok ? (reply.data?.company ?? '') : '' };
  },

  /** A frame's list of what it will keep, handed to the card in the top document. */
  async typedInFrame({ answers }, tab, sender) {
    if (tab?.id === undefined || !sender?.frameId) return { ok: false };
    await noteFrame(tab.id, sender.frameId);
    await chrome.tabs
      .sendMessage(
        tab.id,
        { type: 'jh-frame-typed', payload: { frameId: sender.frameId, answers: Array.isArray(answers) ? answers : [] } },
        { frameId: 0 },
      )
      .catch(() => undefined);
    return { ok: true };
  },

  /**
   * A frame's "was that the send?", put to the card in the top document: a
   * Submit pressed on a hiring system's host with no form recognised. Only
   * relayed — the answer, if it is yes, comes back as `applicationSentHere`.
   * See `askIfSent` in content.js.
   */
  async askIfSentInFrame({ note, url }, tab, sender) {
    if (tab?.id === undefined || !sender?.frameId) return { ok: false };
    await chrome.tabs
      .sendMessage(tab.id, { type: 'jh-ask-if-sent', payload: { note: String(note ?? ''), url: String(url ?? '') } }, { frameId: 0 })
      .catch(() => undefined);
    return { ok: true };
  },

  /** "Don't keep" pressed on the card, for an answer typed in a frame. */
  async dontKeepInFrames({ question }, tab) {
    if (tab?.id === undefined || !question) return { ok: false };
    await askFrames(tab.id, { type: 'jh-frame-dont-keep', payload: { question } });
    return { ok: true };
  },

  async saveAnswer({ question, answer, itemId, label }, tab) {
    return serverFetch('/api/answers/save', {
      method: 'POST',
      save: await saveFor(tab?.id),
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
          // A tailored spec exists only in the card until the folder is
          // built, so the store has never seen it: see `writingFrom`.
          ...writingFrom(spec),
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
  async coverLetter({ spec, job, draft, feedback }, tab) {
    return stoppably(tab, 'coverLetter', (signal) =>
      serverFetch('/api/ai/cover-letter', {
        method: 'POST',
        signal,
        timeoutMs: SLOW_TIMEOUT_MS,
        body: JSON.stringify({
          ...writingFrom(spec),
          ...revision({ draft, feedback }),
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

  async saveLetter({ body, job, applicationId }, tab) {
    const save = await saveFor(tab?.id);
    /*
     * The store's own id for this employer, role and day, which is the id
     * filing the application puts its letter under — asked rather than
     * worked out, so the two cannot drift. A store too old to answer gets its
     * rule worked out here (see `letterId`), and is looked at before it is
     * written to, below. The PUT merges over a letter already filed under the
     * id, so its link to the application is kept.
     *
     * Asked with the application the card has for this page and the page's
     * address, which is all this knows about which application it is. By
     * the name alone the store handed back the name another application's
     * letter was filed under — a second job with the same title on the same
     * day — and this wrote over it. Told which, the store answers with this
     * application's own letter, or a name no other application's letter
     * has, and says which application it found. That goes with the save,
     * which the store refuses (409) if the letter under the name turns out
     * to be another application's.
     */
    const query = new URLSearchParams();
    if (job?.company) query.set('company', job.company);
    if (job?.title) query.set('role', job.title);
    if (applicationId) query.set('applicationId', applicationId);
    if (job?.url) query.set('url', job.url);
    const asked = await serverFetch(`/api/letters/id?${query}`, { save }).catch(() => null);
    const named = typeof asked?.id === 'string' && asked.id ? asked.id : undefined;
    let id = named;
    let linked = named && typeof asked?.applicationId === 'string' && asked.applicationId ? asked.applicationId : undefined;
    /** What a letter already filed under the id keeps when this one is saved over it. */
    let kept = {};
    if (!named) {
      /*
       * A store too old to name the id: it answered 404, or a page that is
       * not JSON. Its PUT replaces the letter whole, so saving under the id
       * worked out here wrote straight over a letter already filed there —
       * measured on one, the letter filed with the application, its link to
       * the application, its tags and its date all replaced by this card's
       * draft. So what is there is looked at first, in the list that store
       * does have.
       *
       * One that belongs to an application is that application's record of
       * what was sent, and is left alone: this goes beside it, under the
       * next `-2`, `-3` that no application's letter has — the server's own
       * rule (`unclaimedLetterId`). Not the next name nobody has: that one
       * is this card's own letter from the save before, so every "Save to
       * store" for a sent application made another letter, `-2`, `-3`,
       * `-4`, one per press. Anything under the name it lands on is the same
       * letter saved before, and keeps what this does not know about it.
       * Even a letter filed with this card's own application is skipped: on
       * this store a PUT replaces it whole, and that letter is what was sent.
       */
      const fallback = letterId(job?.company, job?.title);
      const letters = await serverFetch('/api/letters', { save });
      const all = Array.isArray(letters) ? letters : [];
      const byId = new Map(all.filter((l) => typeof l?.id === 'string').map((l) => [l.id, l]));
      const claimed = (name) => {
        const by = byId.get(name)?.applicationId;
        return typeof by === 'string' && by !== '';
      };
      id = fallback;
      for (let n = 2; claimed(id); n++) id = `${fallback}-${n}`;
      const there = byId.get(id);
      if (there) {
        kept = Object.fromEntries(
          ['applicationId', 'tags', 'voice', 'createdAt'].filter((k) => there[k] !== undefined).map((k) => [k, there[k]]),
        );
      }
    }
    return serverFetch(`/api/letters/${encodeURIComponent(id)}`, {
      method: 'PUT',
      save,
      body: JSON.stringify({
        id,
        title: `${job?.title ?? 'Role'} — ${job?.company ?? 'Unknown'}`,
        company: job?.company,
        role: job?.title,
        createdAt: new Date().toISOString(),
        body,
        ...(linked ? { applicationId: linked } : {}),
        ...kept,
      }),
    });
  },

  /**
   * Hand the application over to ResumeM-M and return a link straight to it.
   * A browser sidebar is fine for picking a resume and wrong for writing three
   * paragraphs; this is the door between the two.
   */
  async openWorkspace(payload, tab) {
    // The same rule as `bundle`: this writes a space, a tracker row and a
    // tailored resume into a save, and it has to be the save the proposal
    // was built from.
    const save = await saveOrRefuse(tab?.id);
    const result = await filing(
      tab,
      payload,
      serverFetch('/api/workspace', { method: 'POST', timeoutMs: SLOW_TIMEOUT_MS, save, body: JSON.stringify(payload) }).catch(
        filingRefused,
      ),
    );
    if (result.conflict) return result;
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
    // something. See `awayKey`.
    if (typeof tab?.id === 'number') await session().set({ [awayKey(tab.id)]: { at: Date.now() } }).catch(() => undefined);
    return { id: opened.id };
  },

  /**
   * The resume editor beside the page, in the browser's side panel.
   *
   * `sidePanel.open` is refused unless it answers a click, and the click
   * reaches here as this message: measured in Chromium, called before
   * anything is awaited it opens, and called after even a resolved promise
   * or a half-second timer it is refused ("may only be called in response to
   * a user gesture"). So it is the first thing this does, and it must stay
   * that way — nothing awaited above it.
   *
   * Where the panel cannot open — an older Chrome, a browser without it, a
   * click that arrived too late — the same page opens as a small window
   * instead, which follows the tab it was opened from in the same way.
   */
  async openPanel(_payload, tab) {
    const opening =
      chrome.sidePanel?.open && typeof tab?.windowId === 'number'
        ? chrome.sidePanel.open({ windowId: tab.windowId })
        : Promise.reject(new Error('No side panel in this browser'));
    try {
      await opening;
      return { opened: 'panel' };
    } catch (err) {
      return { opened: 'window', id: await openPanelWindow(tab), why: String(err?.message ?? err) };
    }
  },

  /**
   * Which resume the card on this tab is working with.
   *
   * Kept per tab, with the page it was said on and the save the application
   * was built from, for the panel to read (see `panelFor`). The panel is an
   * extension page and cannot ask the card itself.
   */
  async panelTarget(payload, tab) {
    if (typeof tab?.id !== 'number') return { kept: false };
    const text = (v) => (typeof v === 'string' && v.length < 400 ? v : null);
    const target = {
      copyId: text(payload.copyId),
      copyLabel: text(payload.copyLabel),
      baseId: text(payload.baseId),
      baseLabel: text(payload.baseLabel),
      company: text(payload.company),
      role: text(payload.role),
      url: String(tab.url ?? '').split('#')[0],
      save: (await saveFor(tab.id)) ?? null,
      at: Date.now(),
    };
    /*
     * And not for a tab that has closed. A closing page's card says which
     * resume it is on as the page goes, and that message can land after
     * `onRemoved` has swept the tab's keys: it wrote this one back, for a tab
     * id Chrome will never use again, and nothing ever removed it. Asked
     * after `saveFor`, the last wait before the write. See `tabClosed`.
     */
    if (await tabClosed(tab.id)) return { kept: false };
    await session().set({ [panelKey(tab.id)]: target });
    return { kept: true };
  },

  /**
   * What the side panel should show for a tab.
   *
   * The card's word if the tab is still on that application — the trail says
   * so across the pages it spans, and the page it was said on is enough for
   * a posting whose trail has not been written yet. Otherwise nothing, and
   * the panel shows the resume every tailoring starts from, and says so.
   */
  async panelFor({ tabId }) {
    const settings = await getSettings();
    const answer = { settings: { serverUrl: settings.serverUrl, baseResumeId: settings.baseResumeId } };
    if (typeof tabId !== 'number') return { ...answer, target: null, application: false };
    const [trail, stored, tab] = await Promise.all([
      readTrail(tabId),
      session().get(panelKey(tabId)).catch(() => ({})),
      chrome.tabs.get(tabId).catch(() => null),
    ]);
    const target = stored?.[panelKey(tabId)] ?? null;
    const application = (trail.pages ?? []).length > 0;
    const here = String(tab?.url ?? '').split('#')[0];
    const current = target && (application || target.url === here) ? target : null;
    return { ...answer, target: current, application, save: trail.save ?? current?.save ?? null };
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
  async applicationSentHere({ note, url, receipt = false, above = [], confirmed = false, company = '', role = '' }, tab) {
    /*
     * A receipt is often the page after the form, and the form's last save
     * of the work is sent as it unloads — so the two cross: measured on the
     * send walk, a press two seconds after the build reached the receipt
     * before that save had written the trail, found no work to file it
     * under, and the application stayed at Applying. Registered the moment
     * it arrives, so waiting for it here is waiting for the right thing.
     */
    /*
     * And a receipt from a frame has the form's page still around it, holding
     * the card: that page is asked to save first, as a send from a frame is
     * (see `applicationSent`), because the work it last saved may not yet
     * say which job this is.
     */
    const inFrame = above.length > 0;
    let saving = receipt || confirmed ? savesInFlight.get(tab?.id) : null;
    if ((confirmed || (receipt && inFrame)) && !saving && tab?.id !== undefined) {
      await chrome.tabs.sendMessage(tab.id, { type: 'jh-flush-work' }, { frameId: 0 }).catch(() => undefined);
      saving = savesInFlight.get(tab.id);
    }
    if (saving) await Promise.race([saving, new Promise((r) => setTimeout(r, SEND_WAITS_FOR_SAVE_MS))]);
    const trail = await readTrail(tab?.id);
    /*
     * A page saying it has received an application is evidence about the
     * application this tab is on only if the tab is still on it: the same
     * sitting, and a site that application has already been through. The
     * receipt is often on a page the card never looked at — a Greenhouse
     * confirmation inside Stripe's page, Workday's dialog — so it names
     * nothing itself. The top page is asked only when the receipt is in a
     * frame, where the top page is still the one the application was built
     * on; a receipt that replaced the page would be asking the confirmation
     * itself, which has nothing true to say about which job it was.
     *
     * `above` is the origins the frame sits under, so a receipt drawn in an
     * embed is judged by the careers site around it.
     */
    if (receipt) {
      /*
       * And, failing both, what the trail wrote down about the form's page
       * when it was read — the page itself, not a save of the card's work,
       * so it is there even when the press came before the keeper's first
       * tick. Measured under the parallel runner: a receipt two seconds after
       * the build, no save of the work anywhere yet, and the application left
       * at Applying beside a confirmation page. Not reproduced on demand by
       * the suite: the save the form makes as it unloads usually lands first,
       * and a test that could not tell this line from its absence was taken
       * out rather than kept as false comfort.
       */
      // Never the receipt itself, which the trail may have read as a page of
      // its own: a confirmation is not evidence of which job it confirms.
      const read = [...(trail?.pages ?? [])].reverse().find((p) => p.company && p.role && p.url !== url);
      const named =
        trail?.work?.spec?.generatedFor ??
        (inFrame && tab?.id !== undefined ? await askThePage(tab.id) : null) ??
        (read ? { company: read.company, role: read.role } : null);
      if (!named?.company || !named?.role) return { ok: false };
      if (!(Date.now() - (trail.at ?? 0) <= RECEIPT_WINDOW_MS)) return { ok: false };
      const been = new Set((trail.pages ?? []).map((p) => rootOf(hostOf(p.url))).filter(Boolean));
      const here = [url, ...above].map((u) => rootOf(hostOf(u))).filter(Boolean);
      if (!here.some((r) => been.has(r))) return { ok: false };
      return handlers.applicationSent({ company: named.company, role: named.role, url, note }, tab);
    }
    /*
     * "Yes" on the card's "Did you just send your application to …?" — a
     * Submit in a frame that could not tell for itself (see `askIfSent` in
     * content.js). Filed under the tab's work and nothing else, and only when
     * that work is the job the question named.
     *
     * The question can be answered a while after the press, on a card that
     * is not the one that was up when it was asked: a single-page board that
     * moved on to the next posting put it on that posting's card, and "Yes"
     * filed the posting being looked at as sent. So no asking the page, as
     * the automatic path below does — the page answers for whatever it shows
     * now, which is exactly the job the question may not have been about —
     * and a question that named a different job from the work is refused.
     * The work was flushed with the answer and waited for above, so a tab
     * with work has it written by now.
     */
    if (confirmed) {
      const work = trail?.work?.spec?.generatedFor;
      if (!work?.company || !work?.role) return { ok: false };
      if (String(company ?? '').trim() && employerKey(company) !== employerKey(work.company)) return { ok: false };
      if (String(role ?? '').trim() && titleKey(role) !== titleKey(work.role)) return { ok: false };
      return handlers.applicationSent({ company: work.company, role: work.role, url, note }, tab);
    }
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
    /*
     * After the save the content script flushed on its way here, and the
     * draft that save opens.
     *
     * The two leave the page together, and they raced: the send could be
     * filed before the draft existed, and the draft then opened a moment
     * later. Measured in tests/sending.mjs, the draft landed anywhere from
     * before the send to 1.5 seconds after it under the parallel runner —
     * which is why the check there failed now and then. Waiting here makes
     * the order the one it was always meant to be. Bounded, because a store
     * slow to open a draft is still no reason to hold up recording the send.
     */
    /*
     * And where no save came with it, the top frame is asked for one. A form
     * inside an iframe reports its send from that frame's script, which runs
     * no keeper and so flushes nothing — the card and its keeper are in the
     * top frame — and a send that beat the keeper's next tick was filed with
     * no draft yet, the draft following it by up to a tick (measured in
     * tests/sending.mjs: "embedded-apply", 348ms after).
     */
    let saving = savesInFlight.get(tab?.id);
    if (!saving && tab?.id !== undefined) {
      // Its `saveWork` is sent before this answer, so by the time the answer
      // is back the save is registered and can be waited on like any other.
      await chrome.tabs.sendMessage(tab.id, { type: 'jh-flush-work' }, { frameId: 0 }).catch(() => undefined);
      saving = savesInFlight.get(tab.id);
    }
    if (saving) await Promise.race([saving, new Promise((r) => setTimeout(r, SEND_WAITS_FOR_SAVE_MS))]);
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

  async trackStatus({ id, status, note }, tab) {
    return serverFetch(`/api/applications/${encodeURIComponent(id)}/status`, {
      method: 'POST',
      // The tracker row is the save's; see `/extension/sent` above.
      save: await saveFor(tab?.id),
      body: JSON.stringify({ status, note }),
    });
  },
};

/*
 * Messages only the extension's own pages send.
 *
 * Every other message is the card's, and the card runs in whatever page it is
 * on — so anything that page's own script could reach by impersonating it is
 * reachable by every site there is. These are the ones nothing in a page has
 * any business sending: the settings, which include where page content is
 * sent (the popup); the bug reports, which hold screenshots of whatever was on
 * screen (the report page); and the panel's view of a named tab (the panel).
 */
const OWN_PAGES_ONLY = new Set([
  'setSettings',
  // Pairing replaces the token every request to ResumeM-M carries. The popup
  // asks for it; a page, through the card, has no business to.
  'pair',
  'saveBugReport',
  'clearBugReport',
  // The error log's form: an entry may hold screenshots of whatever was on screen.
  'saveErrorLog',
  'errorLogQueue',
  'dismissRefusedErrorLogs',
  // The card has its own way to the form, held to less: `openErrorLogFromCard`.
  'openErrorLog',
  'syncBugReport',
  'listBugReports',
  'panelFor',
]);
const fromOwnPage = (sender) => Boolean(sender?.url?.startsWith(chrome.runtime.getURL('')));

/*
 * What a prerendered document may say before anybody can see it.
 *
 * Chrome renders a link it expects you to follow in the background, content
 * scripts and all, and `sender.tab` on its messages is the tab it will be
 * shown in — which is the tab you are looking at, on another page. So the
 * prerendered page's `analyze` wrote its job into the visible tab's trail,
 * branching it and parking the work of the page actually on screen, for a
 * link nobody had clicked. Measured in Chromium with an "immediate"
 * speculation rule on a posting. The content script now waits for
 * `prerenderingchange` before it starts; this is the same rule on this side,
 * for any older copy of it still running in a page.
 *
 * A frame announcing itself is the one exception, because it announces once,
 * on load, and a frame refused here would be missing when the page it is in
 * is shown. It writes nothing but a frame id.
 */
const PRERENDER_ALLOWED = new Set(['frameReady']);

/**
 * The actions worth a line in the error log when they run, under the names a
 * person would give them. Every other message is noted only when it fails.
 */
const ACTIONS = {
  analyze: 'analyze',
  stage: 'stage',
  bundle: 'stage',
  autofillData: 'fill',
  fillFrames: 'fill',
  attachInFrames: 'attach',
  applicationSent: 'send',
  applicationSentHere: 'send',
  writeApplication: 'write',
  coverLetter: 'cover letter',
  answerQuestion: 'answer',
  saveLetter: 'save letter',
  saveAnswer: 'save answer',
  render: 'render',
  pair: 'pair',
};
/** Never noted: the error log's own messages, and a page announcing itself. */
const NOT_NOTED = new Set(['logEvents', 'saveErrorLog', 'errorLogQueue', 'dismissRefusedErrorLogs', 'frameReady', 'ping', 'getSettings', 'getTrail']);
function noteAction(type, ok, ms, err) {
  if (NOT_NOTED.has(type) && ok) return;
  if (!ok && type === 'logEvents') return;
  const named = ACTIONS[type];
  if (ok && !named) return;
  const stopped = Boolean(err?.jobhelper?.stopped);
  noteEvent(
    'action',
    ok || stopped ? 'info' : 'error',
    ok ? `${named} (${type}) worked, in ${ms} ms` : `${named ?? type} (${type}) ${stopped ? 'was stopped' : `failed: ${err?.message ?? 'no reason given'}`}`,
    { action: type, ok, ms },
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = message?.type;
  // Own properties only: `toString` or `constructor` is not a message.
  const handler = typeof type === 'string' && Object.hasOwn(handlers, type) ? handlers[type] : null;
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown message "${type}"` });
    return false;
  }
  if (OWN_PAGES_ONLY.has(type) && !fromOwnPage(sender)) {
    sendResponse({ ok: false, error: `"${type}" is only accepted from JobHelper’s own pages.` });
    return false;
  }
  if (sender?.documentLifecycle === 'prerender' && !PRERENDER_ALLOWED.has(type)) {
    sendResponse({ ok: false, error: 'This page has not been shown yet.', fix: { prerendering: true } });
    return false;
  }
  // Which tab asked. The trail is per tab, and this is the only place that
  // knows which one — it used to be thrown away. The frame matters too, now
  // that the form is often not in the page the card is sitting on.
  const started = Date.now();
  handler(message.payload ?? {}, sender?.tab, sender)
    .then((data) => {
      // Which action ran, and that it worked — its name only. See `noteAction`.
      noteAction(type, true, Date.now() - started);
      sendResponse({ ok: true, data });
    })
    // The marker travels with the message: a card on a job page cannot see an
    // Error object, only what crosses as JSON.
    .catch((err) => {
      noteAction(type, false, Date.now() - started, err);
      sendResponse({ ok: false, error: err.message, fix: err.jobhelper });
    });
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
 * builder tab, which is how people actually come back.
 *
 * In session storage, not in a Set. The Set was kept on the reasoning that a
 * worker asleep long enough to forget it means a trip too old to mention —
 * but Chrome stops the worker after half a minute without an event, and the
 * tab left behind has its timers throttled to about one a minute after five,
 * so the card's keeper stops keeping it awake. Adding a phrasing takes longer
 * than that. Measured with the worker stopped while the builder was open: back
 * on the posting, nothing said the match was out of date. The age limit is
 * the trail's own, which is what "too old to mention" always meant.
 */
const awayKey = (tabId) => `jh-away:${tabId}`;

/** What the card on a tab told the side panel to show. See `panelTarget`. */
const panelKey = (tabId) => `jh-panel:${tabId}`;

/**
 * The side panel's page in a window of its own, for where the panel will not
 * open. One of them: asked again, the one already open comes forward and is
 * pointed at the window the request came from.
 */
async function openPanelWindow(tab) {
  const url = chrome.runtime.getURL(
    `src/panel/panel.html${typeof tab?.windowId === 'number' ? `?window=${tab.windowId}` : ''}`,
  );
  const { 'jh-panel-window': open } = await session().get('jh-panel-window').catch(() => ({}));
  if (typeof open === 'number') {
    const existing = await chrome.windows.get(open, { populate: true }).catch(() => null);
    if (existing) {
      const shown = existing.tabs?.[0];
      if (shown && shown.url !== url) await chrome.tabs.update(shown.id, { url }).catch(() => undefined);
      await chrome.windows.update(open, { focused: true }).catch(() => undefined);
      return open;
    }
  }
  const { 'jh-panel-prefs': prefs } = await chrome.storage.local.get('jh-panel-prefs').catch(() => ({}));
  const made = await chrome.windows.create({
    url,
    type: 'popup',
    width: Math.max(320, Math.min(900, Number(prefs?.window?.width) || 420)),
    height: Math.max(120, Math.min(1400, Number(prefs?.window?.height) || 820)),
  });
  await session().set({ 'jh-panel-window': made.id }).catch(() => undefined);
  return made.id;
}

chrome.tabs?.onActivated?.addListener(async ({ tabId }) => {
  const key = awayKey(tabId);
  const away = (await session().get(key).catch(() => ({})))[key];
  if (!away) return;
  await session().remove(key).catch(() => undefined);
  if (Date.now() - (away.at ?? 0) > TRAIL_STALE_MS) return;
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

/** Everything kept under one tab's id, which goes when the tab does. */
const tabKeys = (tabId) => [
  trailKey(tabId),
  framesKey(tabId),
  filedKey(tabId),
  branchKey(tabId),
  awayKey(tabId),
  panelKey(tabId),
];
const TAB_KEYED = /^(?:trail|frames|filedCopies|jh-branched|jh-away|jh-panel):(\d+)$/;

async function sweepOrphans() {
  const all = await session().get(null).catch(() => ({}));
  /*
   * And whatever is still filed under a tab that no longer exists.
   *
   * `onRemoved` takes a tab's keys with it, but only the ones that exist when
   * it runs, and a worker that was stopped when a tab closed never hears of
   * it at all. A trail can be up to five pages of markup, so one left behind
   * costs as much as a live application. Read after the keys, so a tab that
   * opens in between has no key in what was read to be mistaken for dead.
   */
  const deadTabs = [];
  const tabKeyed = Object.keys(all ?? {}).filter((key) => TAB_KEYED.test(key));
  if (tabKeyed.length > 0) {
    const open = await chrome.tabs?.query?.({}).catch(() => null);
    if (Array.isArray(open)) {
      const ids = new Set(open.map((t) => t.id));
      deadTabs.push(...tabKeyed.filter((key) => !ids.has(Number(TAB_KEYED.exec(key)[1]))));
    }
  }
  /*
   * The closed-tab marks outlive anything that could still be in flight for
   * them — the longest request is `SLOW_TIMEOUT_MS` — and after that a late
   * write is caught by the sweep above instead.
   */
  const oldMarks = Object.entries(all ?? {})
    .filter(
      ([key, value]) =>
        // And the claim marks, by the same clock: past it the entry a mark
        // names is too old to be handed over by `takeWork` anyway.
        (key.startsWith('jh-closed:') || key.startsWith('jh-claimed:')) && Date.now() - (value?.at ?? 0) > TRAIL_STALE_MS,
    )
    .map(([key]) => key);
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

  const doomed = [...expired, ...surplus, ...deadTabs, ...oldMarks];
  if (doomed.length > 0) await session().remove(doomed).catch(() => undefined);
}

chrome.tabs?.onRemoved?.addListener(async (tabId) => {
  // Marked before anything else, so a write still in flight for this tab
  // finds it closed rather than bringing its trail back. See `tabClosed`.
  closedTabs.add(tabId);
  await session().set({ [closedKey(tabId)]: { at: Date.now() } }).catch(() => undefined);
  try {
    // In turn, after any write already queued for it: a last `saveWork` sent
    // from `pagehide` is the newest copy of the letter there is.
    const trail = await inTurn(trailKey(tabId), () => readTrail(tabId));
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
      /*
       * From which tab, too, although it is gone: two tabs closed on the same
       * posting are two letters, and `parkWork` keeps one per tab per job.
       */
      const entry = { work: trail.work, save: trail.save, job: nameOfTrail(trail), tab: tabId, at: Date.now() };
      for (const url of where) await parkWork(url, entry);
    }
  } catch {
    // Storage full, or the trail already gone. Losing the rescue copy is not
    // worth failing the cleanup that follows.
  }
  // The branch stash goes with the tab it belonged to. It holds a whole
  // trail, first page's markup and all, and nothing else ever removed it.
  session()
    .remove(tabKeys(tabId))
    .catch(() => undefined);
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

/**
 * The keyboard command (Alt+Shift+E; see manifest.json) and its message: the
 * popup, opened on the error-log form. `openPopup` needs a focused browser
 * window and a recent Chrome; where it cannot, the same page opens in a small
 * window of its own, already on the form.
 */
async function openErrorLogForm({ draft = '' } = {}) {
  const at = Date.now();
  // A draft only for this opening: one left from an earlier press is not this one's.
  await chrome.storage.session.set({ [OPEN_FORM_KEY]: at }).catch(() => undefined);
  await (draft
    ? chrome.storage.session.set({ [OPEN_FORM_DRAFT_KEY]: { text: draft, at } })
    : chrome.storage.session.remove(OPEN_FORM_DRAFT_KEY)
  ).catch(() => undefined);
  try {
    await chrome.action.openPopup();
    return { opened: 'popup' };
  } catch {
    await chrome.windows.create({ url: chrome.runtime.getURL('src/popup/popup.html#log-error'), type: 'popup', width: 380, height: 680 });
    return { opened: 'window' };
  }
}
/** The card's "Log an error": when it last opened the form, and how often it may. See `openErrorLogFromCard`. */
let cardLogOpenedAt = 0;
const CARD_LOG_EVERY_MS = 2000;
chrome.commands?.onCommand.addListener((command) => {
  if (command === 'log-error') openErrorLogForm().catch((err) => noteEvent('worker-error', 'error', `The error-log form would not open: ${err?.message ?? err}`));
});

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.sync.get(NEVER_CHOSEN);
  const seeded = NEVER_CHOSEN.filter((key) => key in stored);
  if (seeded.length > 0) await chrome.storage.sync.remove(seeded);
});
