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

/** Message handlers, one per action the content script or popup can request. */
const handlers = {
  async ping() {
    const { serverUrl } = await getSettings();
    const res = await fetch(`${serverUrl.replace(/\/$/, '')}/health`);
    return res.json();
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

  /** Analyse a page and get back a proposed tailored resume spec. */
  async analyze({ url, title, html }) {
    const { baseResumeId, useAi } = await getSettings();
    return serverFetch('/api/extension/analyze', {
      method: 'POST',
      body: JSON.stringify({ url, title, html, baseResumeId, useAi }),
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

  async autofillData() {
    return serverFetch('/api/autofill');
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
