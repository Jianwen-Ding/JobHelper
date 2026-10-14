/**
 * JobHelper's half of ResumeM-M's error log.
 *
 * ResumeM-M keeps an error log in a git repository of its own: an entry is
 * somebody's few words about what went wrong, the screenshots they pasted,
 * and what each part of the program noticed in the minutes before. This is
 * what the extension notices, and how it sends an entry.
 *
 * What it notices (kept by the service worker; see `createLogBuffer`):
 *
 * - the worker's own errors, and every call to ResumeM-M that failed — its
 *   route without the query, its status, what the server said;
 * - errors in the extension's own code on the page, which the content script
 *   forwards, and the red strip the card shows;
 * - which actions ran (analyze, stage, fill, send…) and whether they worked.
 *
 * Never a field's value, an answer, a letter, a resume or a prompt: an
 * action is its name and its outcome, a request is its route. The server
 * scrubs every line again on the way in (contact details, tokens) before
 * anything is written.
 *
 * An entry the server cannot take right now — not running, not paired yet —
 * is kept in `chrome.storage.local` (a few at most) and sent the next time it
 * answers. See `saveErrorLog` and `sendQueuedErrorLogs`.
 */

import { screenshotIsValid } from './bug-reports.js';

/** As ResumeM-M's own: fifteen minutes or two thousand events, whichever is less. */
export const KEEP_MS = 15 * 60 * 1000;
export const KEEP_EVENTS = 2000;
/** The windows an entry may ask for. */
export const WINDOWS = [2, 10, 30];
export const DEFAULT_WINDOW = 10;
/** As the server allows: 8 MB of screenshots together, ten at most. */
export const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const MAX_SCREENSHOTS = 10;
/** How many unsent entries the browser keeps while ResumeM-M cannot be reached. */
export const QUEUE_MAX = 5;
export const QUEUE_KEY = 'jh-error-log-queue';
/** Where the worker's buffer outlives the worker. See `createLogBuffer`. */
export const BUFFER_KEY = 'jh-log-buffer';
/** How many of the buffer's events outlive the worker. */
export const PERSIST_EVENTS = 500;
/** Set by the keyboard command, read by the popup: open on the form. */
export const OPEN_FORM_KEY = 'jh-open-error-log';

/** A window as asked for: 1 to 30 whole minutes, the default for anything else. */
export function windowMinutes(asked) {
  const n = typeof asked === 'string' && asked.trim() !== '' ? Number(asked) : asked;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULT_WINDOW;
  return Math.min(30, Math.max(1, Math.round(n)));
}

/** The route of an address, without its query or fragment — where a token or a code would be. */
export function routeOf(path) {
  return String(path ?? '').split(/[?#]/)[0];
}

/**
 * A bounded buffer of what happened, oldest first.
 *
 * The service worker is stopped after half a minute with nothing to do, and
 * what it held in memory goes with it — which is most of what an error log
 * is for, since the error is usually noticed a minute after it happened. So
 * when `storage` is given (session storage: about this sitting, emptied when
 * the browser closes), the buffer is written there a moment after each
 * change and read back when the worker starts again.
 */
export function createLogBuffer({ storage = null, key = BUFFER_KEY, now = Date.now, keepMs = KEEP_MS, keepEvents = KEEP_EVENTS } = {}) {
  let events = [];
  let saving = null;
  const trim = () => {
    const oldest = now() - keepMs;
    let drop = 0;
    while (drop < events.length && Date.parse(events[drop].at) < oldest) drop++;
    drop = Math.max(drop, events.length - keepEvents);
    if (drop > 0) events.splice(0, drop);
  };
  const save = () => {
    if (!storage || saving) return;
    saving = setTimeout(() => {
      saving = null;
      // The newest few hundred only: session storage is shared with every tab's trail, which needs the room more.
      Promise.resolve(storage.set({ [key]: events.slice(-PERSIST_EVENTS) })).catch(() => undefined);
    }, 250);
  };
  const loaded = storage
    ? Promise.resolve(storage.get(key))
        .then((stored) => {
          const before = Array.isArray(stored?.[key]) ? stored[key].filter((e) => e && typeof e.at === 'string') : [];
          // What was kept, then whatever was noticed while it was being read.
          events = [...before, ...events].sort((a, b) => a.at.localeCompare(b.at));
          trim();
        })
        .catch(() => undefined)
    : Promise.resolve();
  return {
    loaded,
    push({ kind, level = 'error', message, detail, source = 'jobhelper' }) {
      if (!message) return;
      events.push({
        at: new Date(now()).toISOString(),
        source,
        kind: String(kind ?? 'event').slice(0, 32),
        level: ['error', 'warn', 'info'].includes(level) ? level : 'error',
        message: String(message).slice(0, 2000),
        ...(detail ? { detail } : {}),
      });
      trim();
      save();
    },
    async since(minutes) {
      await loaded;
      trim();
      const from = now() - minutes * 60 * 1000;
      return events.filter((e) => Date.parse(e.at) >= from);
    },
    get size() {
      return events.length;
    },
  };
}

/** How many bytes a base64 data URL holds, without decoding it. */
export const bytesIn = (dataUrl) => Math.floor(((dataUrl.length - dataUrl.indexOf(',') - 1) * 3) / 4);

/** Why a list of screenshots will not do, or null when it will. */
export function screenshotsProblem(screenshots) {
  if (!Array.isArray(screenshots) || screenshots.length > MAX_SCREENSHOTS) return `Add at most ${MAX_SCREENSHOTS} screenshots.`;
  if (!screenshots.every(screenshotIsValid)) return 'One of the screenshots is not the PNG, JPEG or WebP image it says it is. Remove it and add it again.';
  if (screenshots.reduce((n, s) => n + bytesIn(s), 0) > MAX_SCREENSHOT_BYTES) return 'The screenshots come to more than 8 MB together. Remove one.';
  return null;
}

/**
 * Whether a failed send is worth trying again later: ResumeM-M not running
 * or not answering, failing inside, or not paired with this JobHelper yet —
 * everything but the server reading the entry and refusing it.
 */
export function worthKeeping(err) {
  const status = typeof err?.status === 'number' ? err.status : null;
  if (status === null) return true;
  if (err.kind === 'not-paired' || err.jobhelper?.fix === 'pair') return true;
  return status >= 500 || status === 409;
}

async function readQueue(storage) {
  try {
    const { [QUEUE_KEY]: queue } = await storage.get(QUEUE_KEY);
    return Array.isArray(queue) ? queue : [];
  } catch {
    return [];
  }
}

/*
 * One change to the queue at a time: a send finishing while another entry
 * is being queued must not write back a list without it.
 */
let turns = Promise.resolve();
function inTurn(step) {
  const turn = turns.then(step);
  turns = turn.catch(() => undefined);
  return turn;
}

/**
 * Keep an entry for later, the newest `QUEUE_MAX`. When the browser will not
 * hold it with its screenshots, it is kept without them, and says so.
 */
export function queueErrorLog(entry, storage) {
  return inTurn(async () => {
    const queue = await readQueue(storage);
    // The oldest go first when there are too many: the newest is what was just seen.
    const dropped = Math.max(0, queue.length + 1 - QUEUE_MAX);
    const without = { ...entry, screenshots: [], droppedScreenshots: entry.screenshots?.length ?? 0 };
    for (const attempt of entry.screenshots?.length ? [entry, without] : [entry]) {
      const next = [...queue, attempt].slice(-QUEUE_MAX);
      try {
        await storage.set({ [QUEUE_KEY]: next });
        return { queued: next.length, screenshotsKept: !attempt.droppedScreenshots, dropped };
      } catch (err) {
        if (!/quota/i.test(err?.message ?? '') || attempt !== entry) throw err;
      }
    }
    throw new Error('The browser has no room to keep this entry.');
  });
}

/** How many entries are waiting to be sent. */
export async function queuedErrorLogs(storage) {
  return (await readQueue(storage)).length;
}

/** The body ResumeM-M's `POST /api/error-log` takes, from an entry as the browser keeps it. */
function bodyOf(entry) {
  const dropped = entry.droppedScreenshots
    ? `\n\n(${entry.droppedScreenshots} screenshot${entry.droppedScreenshots === 1 ? '' : 's'} could not be kept while ResumeM-M was out of reach.)`
    : '';
  return JSON.stringify({ ...entry, description: `${entry.description}${dropped}` });
}

let sending = null;

/**
 * Send whatever is waiting, oldest first, and stop at the first that cannot
 * go yet. One at a time, however many things ask. An entry the server reads
 * and refuses is let go of — it would be refused again every time — and the
 * refusal is the answer's `refused`.
 */
export function sendQueuedErrorLogs(serverFetch, storage) {
  sending ??= (async () => {
    let sent = 0;
    const refused = [];
    let lastError = null;
    try {
      for (;;) {
        const [first] = await readQueue(storage);
        if (!first) break;
        try {
          await serverFetch('/api/error-log', { method: 'POST', body: bodyOf(first), timeoutMs: 60_000 });
          sent++;
        } catch (err) {
          if (worthKeeping(err)) {
            lastError = err.message;
            break;
          }
          refused.push(err.message);
        }
        await inTurn(async () => {
          const queue = await readQueue(storage);
          await storage.set({ [QUEUE_KEY]: queue.filter((e) => e.id !== first.id) });
        });
      }
    } finally {
      sending = null;
    }
    return { sent, refused, lastError, queued: await queuedErrorLogs(storage) };
  })();
  return sending;
}

/**
 * Log an error: send it to ResumeM-M now, or keep it to send later.
 *
 * `events` is the worker's buffer for the window asked for. The answer says
 * which happened: `{ sent: true, receipt }`, or `{ queued: n, why }` with the
 * reason it could not go — or it throws, for an entry that could never go
 * (no description, a screenshot that is not an image).
 */
export async function saveErrorLog({ description, minutes, screenshots = [], page = null }, { serverFetch, storage, events, versions = {} }) {
  const said = typeof description === 'string' ? description.trim() : '';
  if (!said) throw new Error('Say in a few words what went wrong.');
  if (said.length > 4000) throw new Error('Keep the description under 4,000 characters; put the rest in a screenshot.');
  const problem = screenshotsProblem(screenshots);
  if (problem) throw new Error(problem);
  const window = windowMinutes(minutes);
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    description: said,
    minutes: window,
    screenshots,
    page: page && typeof page === 'object' ? { url: String(page.url ?? '').slice(0, 2000), title: String(page.title ?? '').slice(0, 300) } : null,
    events: await events(window),
    ...versions,
  };
  try {
    const receipt = await serverFetch('/api/error-log', { method: 'POST', body: bodyOf(entry), timeoutMs: 60_000 });
    return { sent: true, receipt };
  } catch (err) {
    if (!worthKeeping(err)) throw err;
    const kept = await queueErrorLog(entry, storage);
    return { sent: false, queued: kept.queued, screenshotsKept: kept.screenshotsKept, why: err.message, fix: err.jobhelper ?? null };
  }
}
